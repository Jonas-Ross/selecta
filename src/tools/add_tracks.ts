// add_tracks — append/insert tracks into an existing user playlist and patch
// the cache surgically from the post-edit order the bridge reads back.

import { z } from 'zod';
import type { SelectaError } from '../types/errors.js';
import {
  missingTrackIdsError,
  parseInput,
  resolveEditablePlaylist,
  toErrorEnvelope,
  type ToolDeps,
} from './common.js';

export const addTracksInputShape = {
  playlist_id: z
    .string()
    .min(1)
    .describe('Playlist persistent ID (from list_playlists). Must be a plain user playlist.'),
  track_ids: z
    .array(z.string().min(1))
    .min(1)
    .max(500)
    .describe('Track persistent IDs to add, in the order they should appear.'),
  position: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      '0-based index to insert at (0 = start). Omitted or past the end = append. See current order via search with in_playlist + sort playlist_order.',
    ),
};

const AddTracksInput = z.strictObject(addTracksInputShape);

export type AddTracksOutput = {
  playlist_id: string;
  name: string;
  track_count: number;
};

export const ADD_TRACKS_DESCRIPTION = `Add owned tracks to an existing user playlist in Music.app, appending or inserting at a 0-based position. This writes to the user's library. Tracks already in the playlist are added AGAIN (Music.app allows duplicate entries) — check the playlist first via search with in_playlist if that's not wanted. Only plain user playlists are editable: smart/subscription/folder targets fail with playlist_not_editable. Fails with playlist_not_found or track_not_found (nothing is written) on unknown IDs — re-resolve via list_playlists/search, or refresh_library if the cache is stale. Inserting far from the end of a very large playlist is slow (one Music.app event per displaced track).`;

export async function handleAddTracks(
  raw: unknown,
  deps: ToolDeps,
): Promise<AddTracksOutput | SelectaError> {
  const parsed = parseInput(AddTracksInput, raw);
  if (!parsed.ok) return parsed.error;
  const { playlist_id, track_ids, position } = parsed.data;

  try {
    const cache = deps.cache();
    const target = resolveEditablePlaylist(cache, playlist_id);
    if (!target.ok) return target.error;
    const cacheMiss = missingTrackIdsError(cache, track_ids);
    if (cacheMiss) return cacheMiss;

    const result = await deps.bridge.addPlaylistTracks({
      playlistId: target.playlist.persistentId,
      trackIds: track_ids,
      position,
    });
    cache.patchPlaylistMembership(result.persistentId, result.trackPersistentIds);
    return {
      playlist_id: result.persistentId,
      name: target.playlist.name,
      track_count: result.trackCount,
    };
  } catch (err) {
    return toErrorEnvelope(err);
  }
}
