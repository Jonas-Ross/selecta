// get_track_context — the curatorial graph walk: seed +
// same-artist tracks + containing playlists + co-occurring tracks from the
// user's own playlists.

import { z } from 'zod';
import type { SelectaError } from '../types/errors.js';
import type { PlaylistRef } from '../types/cache.js';
import {
  parseInput,
  toApiTrack,
  toErrorEnvelope,
  roundedCacheAge,
  type ApiTrack,
  type ToolDeps,
} from './common.js';

export const getTrackContextInputShape = {
  track_id: z.string().min(1).describe('Track persistent ID (from search results).'),
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

const SAME_ARTIST_CAP = 30;
const CO_OCCURRENCE_CAP = 50;

export const GET_TRACK_CONTEXT_DESCRIPTION = `Curatorial context for one owned track: the seed with signal, up to ${SAME_ARTIST_CAP} same-artist tracks (by play count), the playlists containing it, and up to ${CO_OCCURRENCE_CAP} tracks that co-occur with it in the user's own (hand-made) playlists, ranked by how many playlists they share — the strongest "belongs together" signal available. Call after resolving a seed track via search. On track_not_found the cache may be stale; consider refresh_library.`;

export async function handleGetTrackContext(
  raw: unknown,
  deps: ToolDeps,
): Promise<TrackContextOutput | SelectaError> {
  const parsed = parseInput(GetTrackContextInput, raw);
  if (!parsed.ok) return parsed.error;

  try {
    const cache = deps.cache();
    const seed = cache.getTrack(parsed.data.track_id);
    if (!seed) {
      return {
        error: 'track_not_found',
        hint: `No track with persistent ID ${parsed.data.track_id} in the cache. Cache may be stale — try refresh_library.`,
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
        .getCoOccurringTracks(seed.persistentId, CO_OCCURRENCE_CAP)
        .map((t) => ({
          ...toApiTrack(t),
          shared_playlist_count: t.sharedPlaylistCount,
          shared_playlist_names: t.sharedPlaylistNames,
        })),
      cache_age_hours: roundedCacheAge(deps),
    };
  } catch (err) {
    return toErrorEnvelope(err);
  }
}
