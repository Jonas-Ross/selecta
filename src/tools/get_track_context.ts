// get_track_context — the curatorial graph walk: seed +
// same-artist tracks + containing playlists + co-occurring tracks from the
// user's own playlists. With seed_ids, one aggregated co-occurrence view
// across the whole seed set instead of N single-seed calls.

import { z } from 'zod';
import type { SelectaError } from '../types/errors.js';
import type {
  CoOccurrenceFilters,
  PlaylistRef,
  SourcePlaylistAudit,
} from '../types/cache.js';
import {
  missingTrackIdsError,
  parseInput,
  toApiTrack,
  toCompactApiTrack,
  toErrorEnvelope,
  roundedCacheAge,
  validationError,
  type ApiTrack,
  type ToolDeps,
} from './common.js';

const MAX_SEEDS = 20;
const MAX_EXCLUDED_PLAYLISTS = 500;

export const getTrackContextInputShape = {
  track_id: z
    .string()
    .min(1)
    .optional()
    .describe('Single seed track persistent ID (from search results).'),
  seed_ids: z
    .array(z.string().min(1))
    .min(1)
    .max(MAX_SEEDS)
    .optional()
    .describe(
      `Seed track persistent IDs (up to ${MAX_SEEDS}) — returns co-occurrence aggregated across the set.`,
    ),
  exclude_playlist_ids: z
    .array(z.string().min(1))
    .max(MAX_EXCLUDED_PLAYLISTS)
    .optional()
    .describe(
      `Plain user-playlist IDs to omit from co-occurrence facts (max ${MAX_EXCLUDED_PLAYLISTS}). No automatic utility detection or weighting.`,
    ),
  max_playlist_tracks: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Omit source playlists above this factual cached track count before aggregation. No hidden default.',
    ),
  compact: z
    .boolean()
    .optional()
    .describe(
      'Use for broad discovery: returns smaller seed and candidate track shapes while preserving IDs, signal, audio features, co-occurrence metadata, and source-playlist audit fields. Default false returns full tracks.',
    ),
};

const GetTrackContextInput = z.strictObject(getTrackContextInputShape);

export type TrackContextOutput = {
  seed: ApiTrack;
  // The seed's play_history windows (issue #31), newest first: what changed
  // between consecutive refreshes. Sparse — rows exist only where a counter
  // moved; empty until refreshes have bracketed some listening.
  play_history: { at: string; plays: number; skips: number }[];
  same_artist: ApiTrack[];
  appearing_in_playlists: PlaylistRef[];
  co_occurring_tracks: (ApiTrack & {
    shared_playlist_count: number;
    shared_playlist_names: string[];
  })[];
  source_playlists: SourcePlaylistAudit;
  cache_age_hours: number | null;
};

export type MultiSeedContextOutput = {
  seeds: ApiTrack[];
  co_occurring_tracks: (ApiTrack & {
    total_shared_playlist_count: number;
    seeds_matched: number;
    shared_playlist_names: string[];
  })[];
  source_playlists: SourcePlaylistAudit;
  cache_age_hours: number | null;
};

const SAME_ARTIST_CAP = 30;
const CO_OCCURRENCE_CAP = 50;
const MULTI_CO_OCCURRENCE_CAP = 100;
const PLAY_HISTORY_CAP = 12;

export const GET_TRACK_CONTEXT_DESCRIPTION = `Curatorial context from the user's own (hand-made) playlists — the strongest "belongs together" signal available. Exactly one of track_id / seed_ids. Single seed (track_id): the seed with signal, its play_history (per-refresh play/skip deltas, newest first, up to ${PLAY_HISTORY_CAP} windows — recent-rotation evidence; empty just means no refresh bracketed any listening yet), up to ${SAME_ARTIST_CAP} same-artist tracks (by play count), the playlists containing it, and up to ${CO_OCCURRENCE_CAP} co-occurring tracks ranked by shared-playlist count. Multiple seeds (seed_ids, up to ${MAX_SEEDS}): one call instead of N — up to ${MULTI_CO_OCCURRENCE_CAP} candidates, each with total_shared_playlist_count (co-occurrence summed across the seed set) and seeds_matched (how many seeds it appears alongside); seeds themselves are excluded, and same_artist/appearing_in_playlists are single-seed only. Set compact true for broad single- or multi-seed discovery: it keeps track IDs, identity, comparison signal, audio features, shared-playlist counts/names, seed matches, and source_playlists audit data while omitting secondary track fields; omit it for full tracks. Compact mode never changes ranking or silently truncates results. exclude_playlist_ids and max_playlist_tracks are optional factual source-playlist filters chosen by you and applied before aggregation; there is no automatic utility detection, hidden threshold, weighting, or similarity score. source_playlists audits user playlists containing a seed before filters (considered) and removed by either filter (excluded); shared_playlist_names contains included sources only. Counts are library facts, not a recommendation — ranking is yours. All tracks carry enriched audio features (bpm, musical_key, danceability) where known — use them to judge tempo/key fit around the seeds. Call after resolving seeds via search and playlist IDs via list_playlists. On track_not_found or an unknown excluded playlist ID the cache may be stale; consider refresh_library.`;

type ContextFiltersInput = {
  exclude_playlist_ids?: string[];
  max_playlist_tracks?: number;
};

function summarizeIds(ids: string[]): string {
  const more = ids.length > 5 ? ` (+${ids.length - 5} more)` : '';
  return `${ids.slice(0, 5).join(', ')}${more}`;
}

function resolveCoOccurrenceFilters(
  input: ContextFiltersInput,
  deps: ToolDeps,
): CoOccurrenceFilters | SelectaError {
  const cache = deps.cache();
  const requestedIds = [...new Set(input.exclude_playlist_ids ?? [])];
  const resolvedIds = requestedIds.map((id) => cache.resolvePlaylistId(id));
  const playlists = resolvedIds.map((id) => cache.getPlaylist(id));
  const missingIds = requestedIds.filter((_, i) => playlists[i] === null);
  if (missingIds.length > 0) {
    return validationError(
      `exclude_playlist_ids not in the cache: ${summarizeIds(missingIds)}. Use IDs from list_playlists; if the library changed, run refresh_library.`,
    );
  }
  const nonUserIds = requestedIds.filter((_, i) => playlists[i]!.kind !== 'user');
  if (nonUserIds.length > 0) {
    return validationError(
      `exclude_playlist_ids must name user playlists: ${summarizeIds(nonUserIds)}. Smart, subscription, folder, and special playlists never contribute to co-occurrence.`,
    );
  }
  return {
    excludePlaylistIds: [...new Set(resolvedIds)],
    maxPlaylistTracks: input.max_playlist_tracks,
  };
}

function multiSeedContext(
  seed_ids: string[],
  filters: CoOccurrenceFilters,
  compact: boolean,
  deps: ToolDeps,
): MultiSeedContextOutput | SelectaError {
  const cache = deps.cache();
  const seedIds = [...new Set(seed_ids)];
  const seedRows = seedIds.map((id) => cache.getTrack(id));
  if (seedRows.includes(null)) return missingTrackIdsError(cache, seedIds)!;
  const coOccurrence = cache.getCoOccurrence(seedIds, filters, MULTI_CO_OCCURRENCE_CAP);
  return {
    seeds: seedRows.map((row) => {
      const track = toApiTrack(row!);
      return compact ? toCompactApiTrack(track) : track;
    }),
    co_occurring_tracks: coOccurrence.tracks.map((t) => {
      const track = toApiTrack(t);
      return {
        ...(compact ? toCompactApiTrack(track) : track),
        total_shared_playlist_count: t.totalSharedPlaylistCount,
        seeds_matched: t.seedsMatched,
        shared_playlist_names: t.sharedPlaylistNames,
      };
    }),
    source_playlists: coOccurrence.sourcePlaylists,
    cache_age_hours: roundedCacheAge(deps),
  };
}

export async function handleGetTrackContext(
  raw: unknown,
  deps: ToolDeps,
): Promise<TrackContextOutput | MultiSeedContextOutput | SelectaError> {
  const parsed = parseInput(GetTrackContextInput, raw);
  if (!parsed.ok) return parsed.error;
  const { track_id, seed_ids } = parsed.data;
  if ((track_id == null) === (seed_ids == null)) {
    return validationError('provide exactly one of track_id / seed_ids');
  }

  try {
    const filters = resolveCoOccurrenceFilters(parsed.data, deps);
    if ('error' in filters) return filters;
    const compact = parsed.data.compact === true;
    if (seed_ids != null) return multiSeedContext(seed_ids, filters, compact, deps);

    const cache = deps.cache();
    const seed = cache.getTrack(track_id!);
    if (!seed) {
      return {
        error: 'track_not_found',
        hint: `No track with persistent ID ${track_id} in the cache. Cache may be stale — try refresh_library.`,
      };
    }

    const sameArtist =
      seed.artist != null
        ? cache
            .getTracksByArtist(seed.artist, SAME_ARTIST_CAP + 1)
            .filter((t) => t.persistentId !== seed.persistentId)
            .slice(0, SAME_ARTIST_CAP)
        : [];

    const coOccurrence = cache.getCoOccurrence(
      [seed.persistentId],
      filters,
      CO_OCCURRENCE_CAP,
    );
    return {
      seed: compact ? toCompactApiTrack(toApiTrack(seed)) : toApiTrack(seed),
      play_history: cache
        .getTrackPlayHistory(seed.persistentId, PLAY_HISTORY_CAP)
        .map((w) => ({ at: w.refreshedAt, plays: w.playCountDelta, skips: w.skipCountDelta })),
      same_artist: sameArtist.map((row) => {
        const track = toApiTrack(row);
        return compact ? toCompactApiTrack(track) : track;
      }),
      appearing_in_playlists: cache.getPlaylistsContainingTrack(seed.persistentId),
      co_occurring_tracks: coOccurrence.tracks.map((t) => {
        const track = toApiTrack(t);
        return {
          ...(compact ? toCompactApiTrack(track) : track),
          shared_playlist_count: t.totalSharedPlaylistCount,
          shared_playlist_names: t.sharedPlaylistNames,
        };
      }),
      source_playlists: coOccurrence.sourcePlaylists,
      cache_age_hours: roundedCacheAge(deps),
    };
  } catch (err) {
    return toErrorEnvelope(err);
  }
}
