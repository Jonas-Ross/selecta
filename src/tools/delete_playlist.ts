// delete_playlist — remove an entire user playlist from Music.app and drop its
// cache rows. The heaviest irreversible operation in the tool surface: the
// playlist, its ordering, and its co-occurrence contribution are gone for
// good, so the description tells the model to confirm first.

import { z } from 'zod';
import type { SelectaError } from '../types/errors.js';
import { parseInput, resolveEditablePlaylist, toErrorEnvelope, type ToolDeps } from './common.js';

export const deletePlaylistInputShape = {
  playlist_id: z
    .string()
    .min(1)
    .describe('Playlist persistent ID (from list_playlists). Must be a plain user playlist.'),
};

const DeletePlaylistInput = z.strictObject(deletePlaylistInputShape);

export type DeletePlaylistOutput = {
  playlist_id: string;
  name: string;
  deleted: true;
  track_count: number;
};

export const DELETE_PLAYLIST_DESCRIPTION = `Delete an entire user playlist from Music.app. The tracks stay in the library; the playlist, its ordering, and its description are gone. IRREVERSIBLE — Selecta cannot restore a deleted playlist, so confirm with the user (by playlist NAME, not just ID) before calling. Only plain user playlists can be deleted (playlist_not_editable otherwise — smart/subscription/folder playlists and the Library are off-limits). Fails with playlist_not_found without deleting anything — don't retry with the same input; re-check via list_playlists, or refresh_library if the cache is stale.`;

export async function handleDeletePlaylist(
  raw: unknown,
  deps: ToolDeps,
): Promise<DeletePlaylistOutput | SelectaError> {
  const parsed = parseInput(DeletePlaylistInput, raw);
  if (!parsed.ok) return parsed.error;

  try {
    const cache = deps.cache();
    const target = resolveEditablePlaylist(cache, parsed.data.playlist_id);
    if (!target.ok) return target.error;

    const deleted = await deps.bridge.deletePlaylistById(target.playlist.persistentId);
    if (deleted === 0) {
      return {
        error: 'playlist_not_found',
        hint: `"${target.playlist.name}" is in the cache but not the live library — the cache is stale. Run refresh_library; the playlist may already be gone.`,
      };
    }
    cache.deletePlaylistRow(target.playlist.persistentId);
    return {
      playlist_id: target.playlist.persistentId,
      name: target.playlist.name,
      deleted: true,
      track_count: target.playlist.trackCount,
    };
  } catch (err) {
    return toErrorEnvelope(err);
  }
}
