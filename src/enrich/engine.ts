// The incremental enrichment pass (issue #19). One call = one bounded run,
// processed in chunks of 25 tracks (AcousticBrainz's bulk-lookup max): per
// chunk, MusicBrainz matches each track (paced per request by the sources),
// two bulk AcousticBrainz calls fetch features for every match at once —
// per-MBID AB lookups take ~60s and are unusable — then Deezer fills bpm
// gaps, and the chunk's rows are saved in one transaction. An abort (network
// down, a source rate-limiting) loses at most the in-flight chunk; earlier
// chunks are already durable. Every saved row — 'no_match' and 'no_data'
// included — is terminal, so the next run starts on fresh tracks and dead
// ends are never retried.

import type { SelectaCache } from '../cache/index.js';
import type { AudioFeaturesRow, PendingTrack } from '../types/cache.js';
import { createSources, withUserAgent, type FetchLike, type Sources } from './sources.js';

const CHUNK_SIZE = 25;

export type EnrichmentProgress = {
  processed: number;
  enriched: number; // status 'ok'
  noData: number;
  noMatch: number;
};

export type EnrichmentSummary = EnrichmentProgress & {
  pendingRemaining: number;
};

// Injection points for tests plus the per-chunk progress hook the CLI uses;
// production defaults to the real fetch/clock/timer.
export type EnrichDeps = {
  fetchLike?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  onProgress?: (progress: EnrichmentProgress) => void;
};

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function enrichPendingTracks(
  cache: SelectaCache,
  opts: { limit: number },
  deps: EnrichDeps = {},
): Promise<EnrichmentSummary> {
  const now = deps.now ?? (() => new Date());
  const sources = createSources({
    fetchLike: deps.fetchLike ?? withUserAgent(fetch),
    sleep: deps.sleep ?? defaultSleep,
    nowMs: () => now().getTime(),
  });

  const pending = cache.getTracksPendingEnrichment(opts.limit);
  const progress: EnrichmentProgress = { processed: 0, enriched: 0, noData: 0, noMatch: 0 };
  for (let i = 0; i < pending.length; i += CHUNK_SIZE) {
    const chunk = pending.slice(i, i + CHUNK_SIZE);
    const rows = await resolveChunk(sources, chunk, now().toISOString());
    cache.saveAudioFeatures(rows);
    for (const row of rows) {
      progress.processed += 1;
      if (row.status === 'ok') progress.enriched += 1;
      else if (row.status === 'no_data') progress.noData += 1;
      else progress.noMatch += 1;
    }
    deps.onProgress?.({ ...progress });
  }
  return { ...progress, pendingRemaining: cache.countPendingEnrichment() };
}

function matchTarget(track: PendingTrack): { artist: string; title: string; durationSeconds: number | null } | null {
  if (!track.title?.trim() || !track.artist?.trim()) return null;
  return { artist: track.artist, title: track.title, durationSeconds: track.durationSeconds };
}

/**
 * One chunk through the source chain: per-track MusicBrainz matching, one
 * bulk AcousticBrainz features fetch for all matches, Deezer for bpm the
 * others couldn't supply. Always returns terminal rows; source failures
 * throw BridgeError and abort the run.
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
  const provenance = rows.map(() => ({}) as NonNullable<AudioFeaturesRow['sources']>);

  for (const [i, track] of chunk.entries()) {
    const target = matchTarget(track);
    if (target) rows[i]!.mbRecordingMbid = await sources.mbFindRecording(target);
  }

  const mbids = [...new Set(rows.flatMap((r) => (r.mbRecordingMbid != null ? [r.mbRecordingMbid] : [])))];
  const abFeatures = mbids.length > 0 ? await sources.abLookupFeatures(mbids) : new Map();
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

  for (const [i, row] of rows.entries()) {
    const hasData = row.bpm != null || row.musicalKey != null || row.danceability != null;
    row.status = hasData
      ? 'ok'
      : row.mbRecordingMbid != null || row.deezerTrackId != null
        ? 'no_data'
        : 'no_match';
    row.sources = hasData ? provenance[i]! : null;
  }
  return rows;
}
