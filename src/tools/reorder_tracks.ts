// reorder_tracks — rearrange an existing user playlist to a new order and
// patch the cache surgically from the post-edit order the bridge reads back.
// `order` is a complete permutation of the playlist's current positions, so
// even a no-op permutation still calls the bridge: the drift guard only runs
// there, and a stale cached order could otherwise scramble the live playlist.

import { z } from 'zod';
import type { SelectaError } from '../types/errors.js';
import {
  parseInput,
  resolveEditablePlaylist,
  toErrorEnvelope,
  validationError,
  type ToolDeps,
} from './common.js';

export const reorderTracksInputShape = {
  playlist_id: z
    .string()
    .min(1)
    .describe('Playlist persistent ID (from list_playlists). Must be a plain user playlist.'),
  order: z
    .array(z.number().int().min(0))
    .min(1)
    .max(1000)
    .describe(
      'Complete new order as a permutation of the playlist\'s current 0-based positions: position i of the result gets the entry currently at order[i]. Get the current order first via search with in_playlist + sort playlist_order.',
    ),
};

const ReorderTracksInput = z.strictObject(reorderTracksInputShape);

export type ReorderTracksOutput = {
  playlist_id: string;
  name: string;
  track_count: number;
  moved_count: number;
};

export const REORDER_TRACKS_DESCRIPTION = `Rearrange the entries of a user playlist in Music.app to a new order. \`order\` must be a complete permutation of the playlist's current 0-based positions — position i of the result gets the entry currently at order[i]. Get the current order first via search with in_playlist + sort playlist_order. CAVEAT: search returns one row per distinct track, so a playlist holding the same track more than once has more entries than search shows — its full entry order isn't discoverable and reordering it fails with validation_error naming the entry and distinct counts. Only plain user playlists are editable (playlist_not_editable otherwise). Selecta verifies the expected order against Music.app before moving anything and fails with validation_error if the playlist changed live — don't retry with the same input; refresh_library, re-read the order via search, and recompute the permutation. Moving entries toward the START of a large playlist is slow (one Music.app event per displaced entry) — reordering toward the tail is cheap. Max 1000 entries per call.`;

// Every index 0..n-1 exactly once. Catches model mistakes (duplicates,
// out-of-range values) before any Apple event.
function permutationDefects(order: number[]): { duplicated: number[]; outOfRange: number[] } {
  const seen = new Set<number>();
  const duplicated = new Set<number>();
  const outOfRange: number[] = [];
  for (const value of order) {
    if (value >= order.length) {
      outOfRange.push(value);
      continue;
    }
    if (seen.has(value)) duplicated.add(value);
    seen.add(value);
  }
  return { duplicated: [...duplicated], outOfRange };
}

export async function handleReorderTracks(
  raw: unknown,
  deps: ToolDeps,
): Promise<ReorderTracksOutput | SelectaError> {
  const parsed = parseInput(ReorderTracksInput, raw);
  if (!parsed.ok) return parsed.error;
  const { playlist_id, order } = parsed.data;

  try {
    const cache = deps.cache();
    const target = resolveEditablePlaylist(cache, playlist_id);
    if (!target.ok) return target.error;

    const cachedIds = cache.getPlaylistTrackIds(target.playlist.persistentId);
    if (order.length !== cachedIds.length) {
      // A count mismatch on a duplicated playlist isn't the model's fault:
      // search shows one row per distinct track, so the true entry order is
      // undiscoverable. Name that instead of sending it to refresh_library.
      const distinct = new Set(cachedIds).size;
      if (distinct !== cachedIds.length) {
        return validationError(
          `"${target.playlist.name}" holds the same track more than once (${cachedIds.length} entries, ${distinct} distinct tracks), and search shows only distinct tracks — its full entry order isn't discoverable, so it can't be reordered. Remove the duplicate entries first (remove_tracks by position) if a reorder is needed.`,
        );
      }
      return validationError(
        `order has ${order.length} entries but "${target.playlist.name}" has ${cachedIds.length} tracks in the cache. Get the current order via search with in_playlist + sort playlist_order; if the count is stale, run refresh_library. A playlist over 1000 tracks can't be reordered in one call.`,
      );
    }

    const { duplicated, outOfRange } = permutationDefects(order);
    if (duplicated.length > 0 || outOfRange.length > 0) {
      const parts: string[] = [];
      if (duplicated.length > 0) parts.push(`duplicated: ${duplicated.join(', ')}`);
      if (outOfRange.length > 0) parts.push(`out of range: ${outOfRange.join(', ')}`);
      return validationError(
        `order must be a permutation of 0..${order.length - 1}, each value exactly once (${parts.join('; ')}).`,
      );
    }

    const result = await deps.bridge.reorderPlaylistTracks({
      playlistId: target.playlist.persistentId,
      order,
      expectedTrackIds: cachedIds,
    });
    cache.patchPlaylistMembership(result.persistentId, result.trackPersistentIds);
    return {
      playlist_id: result.persistentId,
      name: target.playlist.name,
      track_count: result.trackCount,
      moved_count: result.movedCount ?? 0,
    };
  } catch (err) {
    return toErrorEnvelope(err);
  }
}
