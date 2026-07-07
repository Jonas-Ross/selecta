// get_track_context — the curatorial graph walk: seed +
// same-artist tracks + containing playlists + co-occurring tracks from the
// user's own playlists. With seed_ids, one aggregated co-occurrence view
// across the whole seed set instead of N single-seed calls.

import { z } from 'zod';
import type { SelectaError } from '../types/errors.js';
import type { PlaylistRef } from '../types/cache.js';
import {
  missingTrackIdsError,
  parseInput,
  toApiTrack,
  toErrorEnvelope,
  roundedCacheAge,
  validationError,
  type ApiTrack,
  type ToolDeps,
} from './common.js';

const MAX_SEEDS = 20;

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
};

const GetTrackContextInput = z.strictObject(getTrackContextInputShape);

export type TrackContextOutput = {
  seed: ApiTrack;
  same_artist: ApiTrack[];
  appearing_in_playlists: PlaylistRef[];
  co_occurring_tracks: (ApiTrack & {
    shared_playlist_count: number;
    shared_playlist_names: string[];
  })[];
  cache_age_hours: number | null;
};

export type MultiSeedContextOutput = {
  seeds: ApiTrack[];
  co_occurring_tracks: (ApiTrack & {
    total_shared_playlist_count: number;
    seeds_matched: number;
    shared_playlist_names: string[];
  })[];
  cache_age_hours: number | null;
};

const SAME_ARTIST_CAP = 30;
const CO_OCCURRENCE_CAP = 50;
const MULTI_CO_OCCURRENCE_CAP = 100;

export const GET_TRACK_CONTEXT_DESCRIPTION = `Curatorial context from the user's own (hand-made) playlists — the strongest "belongs together" signal available. Exactly one of track_id / seed_ids. Single seed (track_id): the seed with signal, up to ${SAME_ARTIST_CAP} same-artist tracks (by play count), the playlists containing it, and up to ${CO_OCCURRENCE_CAP} co-occurring tracks ranked by shared-playlist count. Multiple seeds (seed_ids, up to ${MAX_SEEDS}): one call instead of N — up to ${MULTI_CO_OCCURRENCE_CAP} candidates, each with total_shared_playlist_count (co-occurrence summed across the seed set) and seeds_matched (how many seeds it appears alongside); seeds themselves are excluded, and same_artist/appearing_in_playlists are single-seed only. Counts are library facts, not a recommendation — ranking is yours. All tracks carry enriched audio features (bpm, musical_key, danceability) where known — use them to judge tempo/key fit around the seeds. Call after resolving seeds via search. On track_not_found the cache may be stale; consider refresh_library.`;

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
    const cache = deps.cache();

    if (seed_ids != null) {
      const seedIds = [...new Set(seed_ids)];
      const missing = missingTrackIdsError(cache, seedIds);
      if (missing) return missing;
      return {
        seeds: seedIds.map((id) => toApiTrack(cache.getTrack(id)!)),
        co_occurring_tracks: cache
          .getCoOccurringTracks(seedIds, MULTI_CO_OCCURRENCE_CAP)
          .map((t) => ({
            ...toApiTrack(t),
            total_shared_playlist_count: t.totalSharedPlaylistCount,
            seeds_matched: t.seedsMatched,
            shared_playlist_names: t.sharedPlaylistNames,
          })),
        cache_age_hours: roundedCacheAge(deps),
      };
    }

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

    return {
      seed: toApiTrack(seed),
      same_artist: sameArtist.map(toApiTrack),
      appearing_in_playlists: cache.getPlaylistsContainingTrack(seed.persistentId),
      co_occurring_tracks: cache
        .getCoOccurringTracks([seed.persistentId], CO_OCCURRENCE_CAP)
        .map((t) => ({
          ...toApiTrack(t),
          shared_playlist_count: t.totalSharedPlaylistCount,
          shared_playlist_names: t.sharedPlaylistNames,
        })),
      cache_age_hours: roundedCacheAge(deps),
    };
  } catch (err) {
    return toErrorEnvelope(err);
  }
}
