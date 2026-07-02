// remove_tracks — delete entries from an existing user playlist and patch the
// cache surgically from the post-edit order the bridge reads back. The first
// irreversible operation in the tool surface: removed entries can't be
// restored by Selecta, so the description tells the model to confirm first.

import { z } from 'zod';
import type { SelectaError } from '../types/errors.js';
import {
  parseInput,
  resolveEditablePlaylist,
  toErrorEnvelope,
  validationError,
  type ToolDeps,
} from './common.js';

export const removeTracksInputShape = {
  playlist_id: z
    .string()
    .min(1)
    .describe('Playlist persistent ID (from list_playlists). Must be a plain user playlist.'),
  track_ids: z
    .array(z.string().min(1))
    .max(500)
    .optional()
    .describe('Track persistent IDs to remove — EVERY occurrence of each.'),
  positions: z
    .array(z.number().int().min(0))
    .max(500)
    .optional()
    .describe(
      '0-based playlist positions to remove — targets a single occurrence of a duplicated track. All positions refer to the order BEFORE any removal.',
    ),
};

const RemoveTracksInput = z.strictObject(removeTracksInputShape);

export type RemoveTracksOutput = {
  playlist_id: string;
  name: string;
  track_count: number;
  removed_count: number;
};

export const REMOVE_TRACKS_DESCRIPTION = `Remove entries from a user playlist in Music.app, by track persistent ID (removes EVERY occurrence) and/or by 0-based position (removes that occurrence only — see current order via search with in_playlist + sort playlist_order). The tracks stay in the library; only the playlist entries go. IRREVERSIBLE — Selecta cannot restore removed entries, so confirm with the user before calling. Only plain user playlists are editable (playlist_not_editable otherwise). Fails with playlist_not_found / track_not_found / validation_error (position out of range) without removing anything — don't retry with the same input; re-check the playlist via search, or refresh_library if the cache is stale.`;

export async function handleRemoveTracks(
  raw: unknown,
  deps: ToolDeps,
): Promise<RemoveTracksOutput | SelectaError> {
  const parsed = parseInput(RemoveTracksInput, raw);
  if (!parsed.ok) return parsed.error;
  const { playlist_id, track_ids, positions } = parsed.data;
  if ((track_ids?.length ?? 0) === 0 && (positions?.length ?? 0) === 0) {
    return validationError('Provide track_ids and/or positions — at least one, non-empty.');
  }

  try {
    const cache = deps.cache();
    const target = resolveEditablePlaylist(cache, playlist_id);
    if (!target.ok) return target.error;

    // Pre-flight against the cached membership so model mistakes surface
    // before any Apple event; the bridge re-checks against the live playlist.
    const cachedIds = cache.getPlaylistTrackIds(target.playlist.persistentId);
    const inPlaylist = new Set(cachedIds);
    const absent = (track_ids ?? []).filter((id) => !inPlaylist.has(id));
    if (absent.length > 0) {
      return {
        error: 'track_not_found',
        hint: `Not in playlist "${target.playlist.name}": ${absent.join(', ')}. Check its contents via search with in_playlist; if the library changed, run refresh_library.`,
      };
    }
    const outOfRange = (positions ?? []).filter((p) => p >= cachedIds.length);
    if (outOfRange.length > 0) {
      return validationError(
        `Positions out of range: ${outOfRange.join(', ')} — "${target.playlist.name}" has ${cachedIds.length} tracks.`,
      );
    }

    const result = await deps.bridge.removePlaylistTracks({
      playlistId: target.playlist.persistentId,
      trackIds: track_ids,
      positions,
    });
    cache.patchPlaylistMembership(result.persistentId, result.trackPersistentIds);
    return {
      playlist_id: result.persistentId,
      name: target.playlist.name,
      track_count: result.trackCount,
      removed_count: result.removedCount ?? 0,
    };
  } catch (err) {
    return toErrorEnvelope(err);
  }
}
