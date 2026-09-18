// Pure reconciliation of a stored audio_features row with a fresh one. The
// facade loads and writes; the policy lives here.

import type { AudioFeaturesRow, FeatureStatus } from '../types/cache.js';
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
): AudioFeaturesRow {
  if (existing == null) return withCamelot(candidate);

  const merged: AudioFeaturesRow = { ...existing, fetchedAt: candidate.fetchedAt };
  const sources = { ...existing.sources };

  if (merged.bpm == null && candidate.bpm != null) {
    merged.bpm = candidate.bpm;
    merged.bpmConfidence = candidate.bpmConfidence;
    merged.bpmMaturity = candidate.bpmMaturity;

    if (candidate.sources?.bpm != null) sources.bpm = candidate.sources.bpm;
  }

  if (merged.musicalKey == null && candidate.musicalKey != null) {
    merged.musicalKey = candidate.musicalKey;
    merged.keyConfidence = candidate.keyConfidence;
    merged.keyMaturity = candidate.keyMaturity;

    if (candidate.sources?.musicalKey != null) sources.musicalKey = candidate.sources.musicalKey;
  }

  if (merged.danceability == null && candidate.danceability != null) {
    merged.danceability = candidate.danceability;

    if (candidate.sources?.danceability != null)
      sources.danceability = candidate.sources.danceability;
  }

  merged.mbRecordingMbid = existing.mbRecordingMbid ?? candidate.mbRecordingMbid;
  merged.deezerTrackId = existing.deezerTrackId ?? candidate.deezerTrackId;
  merged.catalogStatus = candidate.catalogStatus ?? existing.catalogStatus;
  merged.analysisStatus = candidate.analysisStatus ?? existing.analysisStatus;
  merged.status = bestStatus(merged.catalogStatus, merged.analysisStatus);

  merged.sources = Object.keys(sources).length > 0 ? sources : null;

  return withCamelot(merged);
}

// Camelot is a relabeling of the key, not a second measurement, so it is
// derived from whatever key the row ended up with rather than carried only by
// the source that happened to report one. A key we cannot parse keeps whatever
// its source gave.
function withCamelot(row: AudioFeaturesRow): AudioFeaturesRow {
  return { ...row, camelot: camelotFor(row.musicalKey) ?? row.camelot };
}
