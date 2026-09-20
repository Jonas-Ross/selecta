// Pure reconciliation of a stored audio_features row with a fresh one. The
// facade loads and writes; the policy lives here.

import type { AudioFeaturesRow, FeatureSource, FeatureStatus } from '../types/cache.js';
import { camelotFor } from '../domain/camelot.js';

// no_match (nothing identified) < no_data (identified, nothing measured) < ok.
const STATUS_RANK: Record<FeatureStatus, number> = { no_match: 0, no_data: 1, ok: 2 };

/** The row-level status: the best any source achieved for this track. */
export function bestStatus(a: FeatureStatus | null, b: FeatureStatus | null): FeatureStatus {
  if (a == null) return b ?? 'no_match';

  if (b == null) return a;

  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

/** A row with no data and no attempt recorded against either source. */
export function blankFeatures(trackPersistentId: string, fetchedAt: string): AudioFeaturesRow {
  return {
    trackPersistentId,
    bpm: null,
    bpmConfidence: null,
    bpmMaturity: null,
    musicalKey: null,
    camelot: null,
    keyConfidence: null,
    keyMaturity: null,
    danceability: null,
    sources: null,
    mbRecordingMbid: null,
    deezerTrackId: null,
    status: 'no_match',
    catalogStatus: null,
    analysisStatus: null,
    fetchedAt,
  };
}

export type MergeResult = {
  row: AudioFeaturesRow;
  // Whether this candidate actually put a new value in storage — as opposed
  // to being gap-filled away because the other pass already had it. That
  // distinction is what makes an enrichment summary honest: a source can
  // report 'ok' for a track without landing anything here.
  landed: boolean;
};

/**
 * Fold one pass's findings into whatever the other pass already stored.
 *
 * Gap-fill only: a feature already on the row keeps its value, confidence and
 * provenance. The catalogs describe the whole track where analysis hears a
 * 30-second preview, neither has been measured against the other, and
 * overwriting on that basis would be a guess dressed as an improvement.
 * Each pass writes only its own terminal status, so the other's survives.
 */
export function mergeFeatures(
  existing: AudioFeaturesRow | null,
  candidate: AudioFeaturesRow,
): MergeResult {
  if (existing == null) {
    const row = withCamelot(candidate);

    return { row, landed: row.status === 'ok' };
  }

  const merged: AudioFeaturesRow = { ...existing, fetchedAt: candidate.fetchedAt };
  const sources = { ...existing.sources };
  let landed = false;

  if (merged.bpm == null && candidate.bpm != null) {
    merged.bpm = candidate.bpm;
    merged.bpmConfidence = candidate.bpmConfidence;
    merged.bpmMaturity = candidate.bpmMaturity;
    landed = true;

    if (candidate.sources?.bpm != null) sources.bpm = candidate.sources.bpm;
  }

  if (merged.musicalKey == null && candidate.musicalKey != null) {
    merged.musicalKey = candidate.musicalKey;
    merged.keyConfidence = candidate.keyConfidence;
    merged.keyMaturity = candidate.keyMaturity;
    landed = true;

    if (candidate.sources?.musicalKey != null) sources.musicalKey = candidate.sources.musicalKey;
  }

  if (merged.danceability == null && candidate.danceability != null) {
    merged.danceability = candidate.danceability;
    landed = true;

    if (candidate.sources?.danceability != null)
      sources.danceability = candidate.sources.danceability;
  }

  merged.mbRecordingMbid = existing.mbRecordingMbid ?? candidate.mbRecordingMbid;
  merged.deezerTrackId = existing.deezerTrackId ?? candidate.deezerTrackId;
  merged.catalogStatus = candidate.catalogStatus ?? existing.catalogStatus;
  merged.analysisStatus = candidate.analysisStatus ?? existing.analysisStatus;
  merged.status = bestStatus(merged.catalogStatus, merged.analysisStatus);

  merged.sources = Object.keys(sources).length > 0 ? sources : null;

  return { row: withCamelot(merged), landed };
}

/** What a source can contribute, keyed as its provenance is recorded. */
const SOURCE_FIELDS = ['bpm', 'musicalKey', 'danceability'] as const;

export type SourceField = (typeof SOURCE_FIELDS)[number];

// Confidence, maturity and Camelot describe the value they came with, so they
// go when it does.
const CLEARED_WITH: Record<SourceField, readonly (keyof AudioFeaturesRow)[]> = {
  bpm: ['bpm', 'bpmConfidence', 'bpmMaturity'],
  musicalKey: ['musicalKey', 'camelot', 'keyConfidence', 'keyMaturity'],
  danceability: ['danceability'],
};

// Everything the catalog pass can write as provenance (enrich/engine.ts).
// metrognome names its own algorithms, so that side cannot be enumerated —
// but only these two passes write provenance at all, so "not one of ours"
// identifies analysis without selecta holding a table of metrognome versions.
const CATALOG_PROVENANCES: ReadonlySet<string> = new Set(['acousticbrainz', 'deezer']);

/** Which pass wrote a stored provenance value. */
export function sourceForProvenance(provenance: string): FeatureSource {
  return CATALOG_PROVENANCES.has(provenance) ? 'catalog' : 'analysis';
}

// Reported straight to the caller as JSON, so the keys are the CLI's.
export type SupersedeSummary = {
  tracks: number;
  cleared_fields: Partial<Record<SourceField, number>>;
  rows_removed: number;
  // Per named algorithm, which fields it produced and how many tracks carry
  // them. A count alone does not tell a caller whose values are at stake.
  by_provenance: Record<string, Partial<Record<SourceField, number>>>;
};

export type SupersedeResult =
  | { action: 'unchanged' }
  | { action: 'update'; row: AudioFeaturesRow; clearedFields: SourceField[] }
  | { action: 'delete'; clearedFields: SourceField[] };

/** One row's decision, paired with the row as it stands before it. */
export type SupersedeChange = {
  before: AudioFeaturesRow;
  result: Extract<SupersedeResult, { action: 'update' | 'delete' }>;
};

export type SupersedePlan = {
  source: FeatureSource;
  provenances: string[];
  changes: SupersedeChange[];
  // Changes that put a track back in the backlog. Not every change does: a row
  // whose attempt an earlier supersede already cleared is pending already, so
  // counting it again would overstate the work the next enrich faces.
  reopened: number;
  summary: SupersedeSummary;
};

/** The column a source's terminal attempt is recorded in. */
export function statusFieldFor(source: FeatureSource): 'catalogStatus' | 'analysisStatus' {
  return source === 'analysis' ? 'analysisStatus' : 'catalogStatus';
}

/** What a set of decisions adds up to, reported identically dry or applied. */
export function summarizeSupersede(changes: readonly SupersedeChange[]): SupersedeSummary {
  const cleared: SupersedeSummary['cleared_fields'] = {};
  const byProvenance: SupersedeSummary['by_provenance'] = {};
  let rowsRemoved = 0;

  for (const { before, result } of changes) {
    if (result.action === 'delete') rowsRemoved += 1;

    for (const field of result.clearedFields) {
      cleared[field] = (cleared[field] ?? 0) + 1;

      const provenance = before.sources?.[field];

      if (provenance == null) continue;

      const counts = (byProvenance[provenance] ??= {});

      counts[field] = (counts[field] ?? 0) + 1;
    }
  }

  return {
    tracks: changes.length,
    cleared_fields: cleared,
    rows_removed: rowsRemoved,
    by_provenance: byProvenance,
  };
}

/**
 * Drop the values a named algorithm produced and reopen that source's attempt.
 *
 * An estimator that improves leaves worse values behind it, and gap-fill means
 * a better one can never replace them: the field is occupied and the source's
 * attempt is terminal. Clearing both is the only way a later run reaches them.
 * Only fields whose recorded provenance was named are touched, so the other
 * source's contributions and anything a newer algorithm wrote stay put.
 */
export function supersedeFeatures(
  row: AudioFeaturesRow,
  source: FeatureSource,
  provenances: ReadonlySet<string>,
): SupersedeResult {
  const sources = { ...row.sources };
  const clearedFields: SourceField[] = [];
  const next: AudioFeaturesRow = { ...row };

  for (const field of SOURCE_FIELDS) {
    const provenance = sources[field];

    if (provenance == null || !provenances.has(provenance)) continue;

    // Only the reopened source's own values. Clearing the other source's would
    // strand them: its attempt stays terminal, so no later run refetches, and
    // the provenance is gone so a second supersede cannot find the row either.
    if (sourceForProvenance(provenance) !== source) continue;

    for (const dependent of CLEARED_WITH[field]) Object.assign(next, { [dependent]: null });

    delete sources[field];
    clearedFields.push(field);
  }

  if (clearedFields.length === 0) return { action: 'unchanged' };

  next.sources = Object.keys(sources).length > 0 ? sources : null;
  next[statusFieldFor(source)] = null;

  // An emptied row would still carry a row-level status, which reads as
  // "looked and found nothing" where the truth is now "never looked".
  if (next.catalogStatus == null && next.analysisStatus == null && next.sources == null) {
    return { action: 'delete', clearedFields };
  }

  // Both attempts can end up cleared while values an unnamed algorithm wrote
  // survive; bestStatus would then label a row that still stores a bpm as
  // "nothing identified". What is stored was measured, whoever measured it.
  const keepsValue = next.bpm != null || next.musicalKey != null || next.danceability != null;

  next.status =
    keepsValue && next.catalogStatus == null && next.analysisStatus == null
      ? row.status
      : bestStatus(next.catalogStatus, next.analysisStatus);

  return { action: 'update', row: next, clearedFields };
}

// Camelot is a relabeling of the key, not a second measurement, so it is
// derived from whatever key the row ended up with rather than carried only by
// the source that happened to report one. A key we cannot parse keeps whatever
// its source gave.
function withCamelot(row: AudioFeaturesRow): AudioFeaturesRow {
  return { ...row, camelot: camelotFor(row.musicalKey) ?? row.camelot };
}

/** A row left recording no attempt, no value and no provenance. */
function recordsNothing(row: AudioFeaturesRow): boolean {
  return (
    row.catalogStatus == null &&
    row.analysisStatus == null &&
    row.sources == null &&
    SOURCE_FIELDS.every((field) => row[field] == null)
  );
}

// Reported straight to the caller as JSON, so the keys are the CLI's.
export type ReopenSummary = {
  tracks: number;
  rows_removed: number;
  // The terminal status each reopened track carried. A no_match track will
  // likely fail the same way again; an ok one is where a better estimator pays.
  by_status: Partial<Record<FeatureStatus, number>>;
};

export type ReopenResult =
  | { action: 'unchanged' }
  | { action: 'update'; row: AudioFeaturesRow }
  | { action: 'delete' };

/** One row's decision, paired with the row as it stands before it. */
export type ReopenChange = {
  before: AudioFeaturesRow;
  result: Extract<ReopenResult, { action: 'update' | 'delete' }>;
};

export type ReopenPlan = {
  source: FeatureSource;
  field: SourceField;
  changes: ReopenChange[];
  summary: ReopenSummary;
};

/** What a set of decisions adds up to, reported identically dry or applied. */
export function summarizeReopen(
  source: FeatureSource,
  changes: readonly ReopenChange[],
): ReopenSummary {
  const byStatus: ReopenSummary['by_status'] = {};
  let rowsRemoved = 0;

  for (const { before, result } of changes) {
    if (result.action === 'delete') rowsRemoved += 1;

    const status = source === 'analysis' ? before.analysisStatus : before.catalogStatus;

    if (status != null) byStatus[status] = (byStatus[status] ?? 0) + 1;
  }

  return { tracks: changes.length, rows_removed: rowsRemoved, by_status: byStatus };
}

/**
 * Clear one source's terminal attempt for a track holding no value in a field,
 * so a later run reaches it again.
 *
 * The counterpart to superseding. That re-measures a value that exists and is
 * named by its provenance; this reaches the track whose estimate was discarded
 * as uncertain, which stored no value and so left no provenance to name. The
 * attempt is the only thing marking such a track done, so clearing it is the
 * only way back to it.
 */
export function reopenFeatures(
  row: AudioFeaturesRow,
  source: FeatureSource,
  field: SourceField,
): ReopenResult {
  const attempted = source === 'analysis' ? row.analysisStatus : row.catalogStatus;

  // Nothing to reopen where this source never finished, and nothing to gain
  // where the field is already filled — by either source, since gap-fill means
  // a fresh estimate would be discarded anyway.
  if (attempted == null || row[field] != null) return { action: 'unchanged' };

  const next: AudioFeaturesRow = { ...row };

  if (source === 'analysis') next.analysisStatus = null;
  else next.catalogStatus = null;

  // An emptied row would still carry a row-level status, which reads as
  // "looked and found nothing" where the truth is now "never looked".
  if (recordsNothing(next)) return { action: 'delete' };

  next.status = bestStatus(next.catalogStatus, next.analysisStatus);

  return { action: 'update', row: next };
}
