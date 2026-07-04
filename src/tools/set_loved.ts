// set_loved — favorite/unfavorite tracks in Music.app and patch the cached
// signal from the post-write values the bridge reads back.

import { z } from 'zod';
import type { SelectaError } from '../types/errors.js';
import { missingTrackIdsError, parseInput, toErrorEnvelope, type ToolDeps } from './common.js';

export const setLovedInputShape = {
  track_ids: z
    .array(z.string().min(1))
    .min(1)
    .max(500)
    .describe('Track persistent IDs (from search/get_track_context).'),
  loved: z.boolean().describe('true = favorite ("love"), false = remove the favorite.'),
};

const SetLovedInput = z.strictObject(setLovedInputShape);

export type SetLovedOutput = {
  updated: number;
  loved: boolean;
};

export const SET_LOVED_DESCRIPTION = `Favorite ("love") or unfavorite tracks in the user's Music.app library — the write-back for the loved flag search returns. Applies ONE value to every track_id; split calls to mix values. This writes to the user's library; reversible (call again with the opposite value). Fails with track_not_found (nothing written) on unknown IDs — use persistent IDs exactly as returned by search, or run refresh_library if the library changed.`;

export async function handleSetLoved(
  raw: unknown,
  deps: ToolDeps,
): Promise<SetLovedOutput | SelectaError> {
  const parsed = parseInput(SetLovedInput, raw);
  if (!parsed.ok) return parsed.error;
  const { track_ids, loved } = parsed.data;

  try {
    const cache = deps.cache();
    const cacheMiss = missingTrackIdsError(cache, track_ids);
    if (cacheMiss) return cacheMiss;

    const result = await deps.bridge.setTrackLoved({ trackIds: track_ids, loved });
    cache.patchTrackSignal(result.tracks);
    return { updated: result.tracks.length, loved };
  } catch (err) {
    return toErrorEnvelope(err);
  }
}
