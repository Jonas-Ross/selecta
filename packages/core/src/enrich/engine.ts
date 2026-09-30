import { withOperation } from '../operations/lock.js';
// Chunks of 25 tracks; per-chunk failure skips and continues, never retries within a run.

import type { SelectaCache } from '../cache/index.js';
import type {
  AudioFeaturesRow,
  FeatureSource,
  FeatureStatus,
  PendingTrack,
} from '../types/cache.js';
import { BridgeError, trackNotFoundError } from '../types/errors.js';
import { createSources, withUserAgent, type FetchLike, type Sources } from './sources.js';
import { analyzeTracks, toFeaturesRow, type MetrognomeDeps } from './metrognome.js';
import { blankFeatures } from '../cache/audio_features.js';

const CHUNK_SIZE = 25;

export type EnrichmentProgress = {
  processed: number;
  enriched: number; // landed a new value in storage (post gap-fill merge)
  returned: number; // status 'ok' from the source, whether or not it landed
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

// source picks the pass: 'catalog' queries the metadata services, 'analysis'
// runs metrognome over the tracks' store previews. Each keeps its own terminal
// record, so analysis still reaches tracks the catalogs had nothing for.
export type EnrichOptions = (
  | { limit: number; trackIds?: undefined }
  | {
      trackIds: string[];
      limit?: undefined;
    }
) & { source?: FeatureSource };

// Injection points for tests plus the progress/failure hooks the CLI uses;
// production defaults to the real fetch/clock/timer.
export type EnrichDeps = {
  fetchLike?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  // `current` names the track being worked on: counters settle a chunk at a
  // time, so it is what moves between them on a live display.
  onProgress?: (progress: EnrichmentProgress, current: string | null) => void;
  onChunkError?: (message: string, trackCount: number) => void;
  // Moment-to-moment narration of every request and chunk (see SourceDeps.trace).
  trace?: (line: string) => void;
  // Binary path and spawn override for the analysis pass.
  metrognome?: MetrognomeDeps;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function enrichPendingTracks(
  cache: SelectaCache,
  opts: EnrichOptions,
  deps: EnrichDeps = {},
): Promise<EnrichmentSummary> {
  return withOperation(cache, 'enrich', async () => {
    const source = opts.source ?? 'catalog';
    const selection = selectTargets(cache, opts, source);
    const now = deps.now ?? (() => new Date());
    const tally = createTally(selection.alreadyAttempted, deps);

    // Before the first request, so a caller showing progress has a line up
    // during the startup stall rather than after it.
    tally.report();

    if (source === 'catalog') await runCatalogPass(cache, selection.pending, tally, deps, now);
    else await runAnalysisPass(cache, selection.pending, tally, deps, now);

    return {
      ...tally.progress,
      pendingRemaining: cache.countPendingEnrichment(source),
      errors: tally.errors,
      ...(selection.requestedIds != null
        ? {
            alreadyAttempted: selection.alreadyAttempted.length,
            outcomes: selection.requestedIds.map((id) => tally.outcomes.get(id)!),
          }
        : {}),
    };
  });
}

type Tally = ReturnType<typeof createTally>;

type PriorAttempt = { trackPersistentId: string; existingResult: EnrichmentResult };

/** Run-wide counters, per-track outcomes and the caller's progress hooks. */
function createTally(alreadyAttempted: PriorAttempt[], deps: EnrichDeps) {
  const progress: EnrichmentProgress = {
    processed: 0,
    enriched: 0,
    returned: 0,
    noData: 0,
    noMatch: 0,
    skipped: 0,
  };
  const errors: string[] = [];
  let current: string | null = null;
  const outcomes = new Map<string, TargetedEnrichmentOutcome>(
    alreadyAttempted.map(({ trackPersistentId, existingResult }) => [
      trackPersistentId,
      { trackPersistentId, outcome: 'already_attempted', existingResult },
    ]),
  );

  return {
    progress,
    errors,
    outcomes,

    /** Name the track now being worked on, without settling anything. */
    touch(label: string): void {
      current = label;
      deps.onProgress?.({ ...progress }, current);
    },

    /** Record one track's terminal outcome; landed only applies to 'ok'. */
    settle(trackPersistentId: string, status: FeatureStatus, landed: boolean): void {
      progress.processed += 1;

      if (status === 'ok') {
        progress.returned += 1;

        if (landed) progress.enriched += 1;
      } else if (status === 'no_data') progress.noData += 1;
      else progress.noMatch += 1;

      outcomes.set(trackPersistentId, {
        trackPersistentId,
        outcome: resultForStatus(status),
      });
    },

    /** Leave tracks pending for a later run and report why, once per message. */
    skip(trackPersistentIds: readonly string[], message: string): void {
      progress.skipped += trackPersistentIds.length;

      for (const id of trackPersistentIds) {
        outcomes.set(id, { trackPersistentId: id, outcome: 'skipped' });
      }

      if (!errors.includes(message)) errors.push(message);

      deps.onChunkError?.(message, trackPersistentIds.length);
      deps.onProgress?.({ ...progress }, current);
    },

    report(): void {
      deps.onProgress?.({ ...progress }, current);
    },
  };
}

/** MusicBrainz → AcousticBrainz → Deezer, 25 tracks at a time. */
async function runCatalogPass(
  cache: SelectaCache,
  pending: PendingTrack[],
  tally: Tally,
  deps: EnrichDeps,
  now: () => Date,
): Promise<void> {
  const trace = deps.trace ?? (() => {});
  const sources = createSources({
    fetchLike: deps.fetchLike ?? withUserAgent(fetch),
    sleep: deps.sleep ?? defaultSleep,
    nowMs: () => now().getTime(),
    trace: deps.trace,
    cooldown: {
      get: (host) => cache.getSourceCooldown(host),
      set: (host, until) => cache.setSourceCooldown(host, until),
    },
  });
  const totalChunks = Math.ceil(pending.length / CHUNK_SIZE);

  for (let i = 0; i < pending.length; i += CHUNK_SIZE) {
    const chunk = pending.slice(i, i + CHUNK_SIZE);

    trace(`— chunk ${i / CHUNK_SIZE + 1}/${totalChunks}: ${chunk.length} tracks —`);
    let rows: AudioFeaturesRow[];

    try {
      rows = await resolveChunk(sources, chunk, now().toISOString(), tally.touch);
    } catch (err) {
      // Only source failures are skippable; anything else is a bug and rethrows.
      if (!(err instanceof BridgeError) || err.errorCode !== 'enrichment_error') throw err;

      tally.skip(
        chunk.map((track) => track.persistentId),
        err.message,
      );
      continue;
    }

    const landed = cache.saveAudioFeatures(rows);
    const counts = { ok: 0, no_data: 0, no_match: 0 };

    for (const row of rows) {
      counts[row.status] += 1;
      tally.settle(row.trackPersistentId, row.status, landed.get(row.trackPersistentId) ?? false);
    }

    trace(`chunk saved — ${counts.ok} ok, ${counts.no_data} no_data, ${counts.no_match} no_match`);
    tally.report();
  }
}

/**
 * metrognome over the whole backlog: one process, queries down its stdin,
 * results saved in chunks as they stream back. A failure ends the run rather
 * than skipping a chunk — there is one pipe, not one request per track — so
 * everything unsettled stays pending for a later run.
 */
async function runAnalysisPass(
  cache: SelectaCache,
  pending: PendingTrack[],
  tally: Tally,
  deps: EnrichDeps,
  now: () => Date,
): Promise<void> {
  if (pending.length === 0) return;

  const trace = deps.trace ?? (() => {});
  const unsettled = new Set(pending.map((track) => track.persistentId));
  const labels = new Map(pending.map((track) => [track.persistentId, trackLabel(track)]));
  const buffered: AudioFeaturesRow[] = [];

  const flush = (): void => {
    if (buffered.length === 0) return;

    const landed = cache.saveAudioFeatures(buffered);

    for (const row of buffered) {
      unsettled.delete(row.trackPersistentId);
      tally.settle(row.trackPersistentId, row.status, landed.get(row.trackPersistentId) ?? false);
    }

    buffered.length = 0;
    trace(`saved ${tally.progress.processed}/${pending.length} analyzed`);
    tally.report();
  };

  trace(`analyzing ${pending.length} tracks via metrognome`);

  try {
    await analyzeTracks(
      pending.map((track) => ({
        clientRef: track.persistentId,
        artist: track.artist ?? '',
        title: track.title ?? '',
      })),
      (analysis) => {
        const row = toFeaturesRow(analysis, now().toISOString());
        const label = labels.get(analysis.query.client_ref ?? '');

        // Results stream one at a time but save 25 at a time.
        if (label != null) tally.touch(label);

        // A non-terminal failure (transport, cache, a bug) says nothing about
        // the track, so it is left pending rather than recorded.
        if (row != null && unsettled.has(row.trackPersistentId)) buffered.push(row);

        if (buffered.length >= CHUNK_SIZE) flush();
      },
      deps.metrognome,
    );
  } catch (err) {
    if (!(err instanceof BridgeError) || err.errorCode !== 'enrichment_error') throw err;

    flush();
    tally.skip([...unsettled], err.message);

    return;
  }

  flush();

  // Results that arrived without a usable terminal verdict.
  if (unsettled.size > 0) {
    tally.skip([...unsettled], 'metrognome returned no terminal result for these tracks');
  }
}

/** What a progress display calls a track. */
function trackLabel(track: PendingTrack): string {
  return [track.title, track.artist].filter(Boolean).join(' — ') || track.persistentId;
}

function resultForStatus(status: FeatureStatus): EnrichmentResult {
  return status === 'ok' ? 'enriched' : status;
}

function selectTargets(
  cache: SelectaCache,
  opts: EnrichOptions,
  source: FeatureSource,
): {
  pending: PendingTrack[];
  requestedIds?: string[];
  alreadyAttempted: { trackPersistentId: string; existingResult: EnrichmentResult }[];
} {
  if (opts.trackIds == null) {
    return {
      pending: cache.getTracksPendingEnrichment(source, opts.limit),
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
    // Terminal is per source: a track the catalogs exhausted is still a
    // candidate for analysis, and vice versa.
    const attempted =
      source === 'catalog'
        ? cache.getAudioFeatures(id)?.catalogStatus
        : cache.getAudioFeatures(id)?.analysisStatus;

    if (attempted != null) {
      alreadyAttempted.push({ trackPersistentId: id, existingResult: resultForStatus(attempted) });
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
  onTrack: (label: string) => void,
): Promise<AudioFeaturesRow[]> {
  // Tracks with no artist/title stay at the blank row's no_match without any network.
  const rows: AudioFeaturesRow[] = chunk.map((track) =>
    blankFeatures(track.persistentId, fetchedAt),
  );
  const provenance: Provenance[] = rows.map(() => ({}));

  await matchViaMusicBrainz(sources, chunk, rows, onTrack);
  await applyAcousticBrainzFeatures(sources, rows, provenance);
  await fillDeezerBpm(sources, chunk, rows, provenance, onTrack);
  finalizeRows(rows, provenance);

  return rows;
}

async function matchViaMusicBrainz(
  sources: Sources,
  chunk: PendingTrack[],
  rows: AudioFeaturesRow[],
  onTrack: (label: string) => void,
): Promise<void> {
  for (const [i, track] of chunk.entries()) {
    const target = matchTarget(track);

    onTrack(trackLabel(track));

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
  onTrack: (label: string) => void,
): Promise<void> {
  for (const [i, track] of chunk.entries()) {
    const row = rows[i]!;
    const target = matchTarget(track);

    if (row.bpm != null || !target) continue;

    onTrack(trackLabel(track));

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
    row.catalogStatus = row.status;
    row.sources = hasData ? provenance[i]! : null;
  }
}
