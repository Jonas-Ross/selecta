import { withOperation } from '../operations/lock.js';
// set_rating — set or clear a star rating on tracks in Music.app and patch
// the cached signal from the post-write values the bridge reads back. Public
// unit is 0–5 stars (halves allowed); Music.app stores stars × 20 (0–100).

import { z } from 'zod';
import type { SelectaError } from '../types/errors.js';
import { missingTrackIdsError, parseInput, toErrorEnvelope, type ToolDeps } from './common.js';

export const setRatingInputShape = {
  track_ids: z
    .array(z.string().min(1))
    .min(1)
    .max(500)
    .describe('Track persistent IDs (from search/get_track_context).'),
  rating: z
    .number()
    .min(0)
    .max(5)
    .multipleOf(0.5)
    .describe('Star rating 0–5, half-stars allowed. 0 clears the rating.'),
};

const SetRatingInput = z.strictObject(setRatingInputShape);

export type SetRatingOutput = {
  updated: number;
  mismatches?: { track_id: string; rating: number | null }[];
  rating: number; // stars, as requested
};

export const SET_RATING_DESCRIPTION = `Set or clear a star rating on tracks in the user's Music.app library — the write-back for the rating search returns. Unit is stars 0–5 (half-stars allowed); 0 clears the rating; Music.app stores stars × 20 internally. Applies ONE rating to every track_id; split calls to mix ratings. This writes to the user's library; reversible. updated counts only tracks whose readback matches the requested value; mismatches reports actual values for the rest. Inspect mismatches before deciding whether to retry. Fails with track_not_found (nothing written) on unknown IDs — use persistent IDs exactly as returned by search, or run refresh_library if the library changed.`;

export async function handleSetRating(
  raw: unknown,
  deps: ToolDeps,
): Promise<SetRatingOutput | SelectaError> {
  const parsed = parseInput(SetRatingInput, raw);
  if (!parsed.ok) return parsed.error;
  const { track_ids, rating } = parsed.data;

  try {
    const cache = deps.cache();
    return await withOperation(cache, 'music', async () => {
      const cacheMiss = missingTrackIdsError(cache, track_ids);
      if (cacheMiss) return cacheMiss;

      // Stars (0–5) → Music.app's 0–100 scale at the boundary.
      const result = await deps.bridge.setTrackRating({ trackIds: track_ids, rating: rating * 20 });
      cache.patchTrackRating(result.tracks);
      const mismatches = result.tracks
        .filter((row) => !((row.rating ?? 0) === rating * 20))
        .map((row) => ({
          track_id: row.persistentId,
          rating: row.rating == null ? null : row.rating / 20,
        }));
      return {
        updated: result.tracks.length - mismatches.length,
        rating,
        ...(mismatches.length ? { mismatches } : {}),
      };
    });
  } catch (err) {
    return toErrorEnvelope(err);
  }
}
