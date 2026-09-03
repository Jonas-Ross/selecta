// The incremental enrichment pass (issues #19 and #37). One call = one
// bounded backlog or targeted run, processed in chunks of 25 tracks
// (AcousticBrainz's bulk-lookup max): per
// chunk, MusicBrainz matches each track (paced per request by the sources),
// two bulk AcousticBrainz calls fetch features for every match at once —
// per-MBID AB lookups take ~60s and are unusable — then Deezer fills bpm
// gaps, and the chunk's rows are saved in one transaction.
//
// A source failure (AB in particular throws intermittent 5xx) SKIPS the
// chunk and continues: nothing is saved for it — so no terminal row is ever
// written from a degraded look — its tracks stay pending for a later run,
// and the skip is reported in the summary (and onChunkError), never
// swallowed. This is failure isolation, not a retry: no request is ever
// reissued within a run. Every saved row — 'no_match' and 'no_data'
// included — is terminal, so the next run starts on fresh tracks and dead
// ends are never retried.

import type { SelectaCache } from '../cache/index.js';
import type { AudioFeaturesRow, PendingTrack } from '../types/cache.js';
import { BridgeError, trackNotFoundError } from '../types/errors.js';
import { createSources, withUserAgent, type FetchLike, type Sources } from './sources.js';

const CHUNK_SIZE = 25;

export type EnrichmentProgress = {
  processed: number;
  enriched: number; // status 'ok'
  noData: number;
  noMatch: number;
  skipped: number; // tracks in chunks that hit a source failure; still pending
};

export type EnrichmentSummary = EnrichmentProgress & {
  pendingRemaining: number;
  errors: string[]; // deduped source-failure messages from skipped chunks
  // Targeted calls return one outcome per distinct requested ID. Backlog
  // calls omit both fields so their existing library/API shape stays stable.
  alreadyAttempted?: number;
  outcomes?: TargetedEnrichmentOutcome[];
};

type EnrichmentResult = 'enriched' | 'no_data' | 'no_match';

export type TargetedEnrichmentOutcome =
  | {
      trackPersistentId: string;
      outcome: EnrichmentResult | 'skipped';
    }
  | {
      trackPersistentId: string;
      outcome: 'already_attempted';
      existingResult: EnrichmentResult;
    };

export type EnrichOptions =
  { limit: number; trackIds?: undefined } | { trackIds: string[]; limit?: undefined };

// Injection points for tests plus the progress/failure hooks the CLI uses;
// production defaults to the real fetch/clock/timer.
export type EnrichDeps = {
  fetchLike?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  onProgress?: (progress: EnrichmentProgress) => void;
  onChunkError?: (message: string, trackCount: number) => void;
  // Moment-to-moment narration of every request and chunk (see SourceDeps.trace).
  trace?: (line: string) => void;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function enrichPendingTracks(
  cache: SelectaCache,
  opts: EnrichOptions,
  deps: EnrichDeps = {},
): Promise<EnrichmentSummary> {
  const selection = selectTargets(cache, opts);
  const now = deps.now ?? (() => new Date());
  const trace = deps.trace ?? (() => {});
  const sources = createSources({
    fetchLike: deps.fetchLike ?? withUserAgent(fetch),
    sleep: deps.sleep ?? defaultSleep,
    nowMs: () => now().getTime(),
    trace: deps.trace,
  });

  const pending = selection.pending;
  const totalChunks = Math.ceil(pending.length / CHUNK_SIZE);
  const progress: EnrichmentProgress = {
    processed: 0,
    enriched: 0,
    noData: 0,
    noMatch: 0,
    skipped: 0,
  };
  const errors: string[] = [];
  const outcomes = new Map<string, TargetedEnrichmentOutcome>(
    selection.alreadyAttempted.map(({ trackPersistentId, existingResult }) => [
      trackPersistentId,
      { trackPersistentId, outcome: 'already_attempted', existingResult },
    ]),
  );
  for (let i = 0; i < pending.length; i += CHUNK_SIZE) {
    const chunk = pending.slice(i, i + CHUNK_SIZE);
    trace(`— chunk ${i / CHUNK_SIZE + 1}/${totalChunks}: ${chunk.length} tracks —`);
    let rows: AudioFeaturesRow[];
    try {
      rows = await resolveChunk(sources, chunk, now().toISOString());
    } catch (err) {
      // Only source failures are skippable; anything else is a bug and rethrows.
      if (!(err instanceof BridgeError) || err.errorCode !== 'enrichment_error') throw err;
      progress.skipped += chunk.length;
      for (const track of chunk) {
        outcomes.set(track.persistentId, {
          trackPersistentId: track.persistentId,
          outcome: 'skipped',
        });
      }
      if (!errors.includes(err.message)) errors.push(err.message);
      deps.onChunkError?.(err.message, chunk.length);
      deps.onProgress?.({ ...progress });
      continue;
    }
    cache.saveAudioFeatures(rows);
    const counts = { ok: 0, no_data: 0, no_match: 0 };
    for (const row of rows) {
      progress.processed += 1;
      counts[row.status] += 1;
      outcomes.set(row.trackPersistentId, {
        trackPersistentId: row.trackPersistentId,
        outcome: resultForStatus(row.status),
      });
      if (row.status === 'ok') progress.enriched += 1;
      else if (row.status === 'no_data') progress.noData += 1;
      else progress.noMatch += 1;
    }
    trace(`chunk saved — ${counts.ok} ok, ${counts.no_data} no_data, ${counts.no_match} no_match`);
    deps.onProgress?.({ ...progress });
  }
  return {
    ...progress,
    pendingRemaining: cache.countPendingEnrichment(),
    errors,
    ...(selection.requestedIds != null
      ? {
          alreadyAttempted: selection.alreadyAttempted.length,
          outcomes: selection.requestedIds.map((id) => outcomes.get(id)!),
        }
      : {}),
  };
}

function resultForStatus(status: AudioFeaturesRow['status']): EnrichmentResult {
  return status === 'ok' ? 'enriched' : status;
}

function selectTargets(
  cache: SelectaCache,
  opts: EnrichOptions,
): {
  pending: PendingTrack[];
  requestedIds?: string[];
  alreadyAttempted: { trackPersistentId: string; existingResult: EnrichmentResult }[];
} {
  if (opts.trackIds == null) {
    return {
      pending: cache.getTracksPendingEnrichment(opts.limit),
      alreadyAttempted: [],
    };
  }

  // The MCP schema rejects duplicates. Keep this guard for direct library
  // callers too, so defensive deduplication can never silently alter a run.
  const requestedIds = [...new Set(opts.trackIds)];
  if (requestedIds.length !== opts.trackIds.length) {
    throw new BridgeError(
      'validation_error',
      'Duplicate targeted-enrichment track IDs',
      'trackIds must contain unique persistent IDs. No external requests were made.',
    );
  }
  const tracks = requestedIds.map((id) => cache.getTrack(id));
  const unknownIds = requestedIds.filter((_, i) => tracks[i] == null);
  if (unknownIds.length > 0) {
    const error = trackNotFoundError(unknownIds, {
      label: 'Unknown enrichment targets',
      consequence: 'No external requests were made.',
    });
    throw new BridgeError(error.error, error.hint, error.hint);
  }

  const pending: PendingTrack[] = [];
  const alreadyAttempted: {
    trackPersistentId: string;
    existingResult: EnrichmentResult;
  }[] = [];
  for (const [i, track] of tracks.entries()) {
    const id = requestedIds[i]!;
    const existing = cache.getAudioFeatures(id);
    if (existing != null) {
      alreadyAttempted.push({
        trackPersistentId: id,
        existingResult: resultForStatus(existing.status),
      });
      continue;
    }
    pending.push({
      persistentId: id,
      title: track!.title,
      artist: track!.artist,
      durationSeconds: track!.durationSeconds,
    });
  }
  return { pending, requestedIds, alreadyAttempted };
}

function matchTarget(
  track: PendingTrack,
): { artist: string; title: string; durationSeconds: number | null } | null {
  if (!track.title?.trim() || !track.artist?.trim()) return null;
  return { artist: track.artist, title: track.title, durationSeconds: track.durationSeconds };
}

// Per-field provenance built up alongside each row, folded in by finalizeRows.
type Provenance = NonNullable<AudioFeaturesRow['sources']>;

/**
 * One chunk through the source chain: per-track MusicBrainz matching, one
 * bulk AcousticBrainz features fetch for all matches, Deezer for bpm the
 * others couldn't supply. Always returns terminal rows; source failures
 * throw BridgeError and abort the chunk.
 */
async function resolveChunk(
  sources: Sources,
  chunk: PendingTrack[],
  fetchedAt: string,
): Promise<AudioFeaturesRow[]> {
  const rows: AudioFeaturesRow[] = chunk.map((track) => ({
    trackPersistentId: track.persistentId,
    bpm: null,
    musicalKey: null,
    danceability: null,
    sources: null,
    mbRecordingMbid: null,
    deezerTrackId: null,
    status: 'no_match', // tracks with no artist/title stay here without any network
    fetchedAt,
  }));
  const provenance: Provenance[] = rows.map(() => ({}));

  await matchViaMusicBrainz(sources, chunk, rows);
  await applyAcousticBrainzFeatures(sources, rows, provenance);
  await fillDeezerBpm(sources, chunk, rows, provenance);
  finalizeRows(rows, provenance);
  return rows;
}

async function matchViaMusicBrainz(
  sources: Sources,
  chunk: PendingTrack[],
  rows: AudioFeaturesRow[],
): Promise<void> {
  for (const [i, track] of chunk.entries()) {
    const target = matchTarget(track);
    if (target) rows[i]!.mbRecordingMbid = await sources.mbFindRecording(target);
  }
}

async function applyAcousticBrainzFeatures(
  sources: Sources,
  rows: AudioFeaturesRow[],
  provenance: Provenance[],
): Promise<void> {
  const mbids = [
    ...new Set(rows.flatMap((r) => (r.mbRecordingMbid != null ? [r.mbRecordingMbid] : []))),
  ];
  if (mbids.length === 0) return;
  const abFeatures = await sources.abLookupFeatures(mbids);
  for (const [i, row] of rows.entries()) {
    const ab = row.mbRecordingMbid != null ? abFeatures.get(row.mbRecordingMbid) : undefined;
    if (!ab) continue;
    if (ab.bpm != null) {
      row.bpm = ab.bpm;
      provenance[i]!.bpm = 'acousticbrainz';
    }
    if (ab.musicalKey != null) {
      row.musicalKey = ab.musicalKey;
      provenance[i]!.musicalKey = 'acousticbrainz';
    }
    if (ab.danceability != null) {
      row.danceability = ab.danceability;
      provenance[i]!.danceability = 'acousticbrainz';
    }
  }
}

async function fillDeezerBpm(
  sources: Sources,
  chunk: PendingTrack[],
  rows: AudioFeaturesRow[],
  provenance: Provenance[],
): Promise<void> {
  for (const [i, track] of chunk.entries()) {
    const row = rows[i]!;
    const target = matchTarget(track);
    if (row.bpm != null || !target) continue;
    const dz = await sources.dzFindTrack(target);
    if (dz != null) {
      row.deezerTrackId = dz.trackId;
      if (dz.bpm != null) {
        row.bpm = dz.bpm;
        provenance[i]!.bpm = 'deezer';
      }
    }
  }
}

/** Terminal status per row: any feature → ok; any match → no_data; else no_match. */
function finalizeRows(rows: AudioFeaturesRow[], provenance: Provenance[]): void {
  for (const [i, row] of rows.entries()) {
    const hasData = row.bpm != null || row.musicalKey != null || row.danceability != null;
    row.status = hasData
      ? 'ok'
      : row.mbRecordingMbid != null || row.deezerTrackId != null
        ? 'no_data'
        : 'no_match';
    row.sources = hasData ? provenance[i]! : null;
  }
}
