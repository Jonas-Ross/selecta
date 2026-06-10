// preview_playlist — overwrite the single dedicated audition slot in Music.app.

import { z } from 'zod';
import type { SelectaError } from '../types/errors.js';
import {
  missingTrackIdsError,
  toErrorEnvelope,
  validationError,
  type ToolDeps,
} from './common.js';

export const PREVIEW_PLAYLIST_NAME = 'Selecta Preview';

export const previewPlaylistInputShape = {
  track_ids: z
    .array(z.string().min(1))
    .min(1)
    .max(500)
    .describe('Track persistent IDs in the exact order they should play.'),
};

const PreviewPlaylistInput = z.strictObject(previewPlaylistInputShape);

export type PreviewPlaylistOutput = {
  playlist_id: string;
  track_count: number;
};

export const PREVIEW_PLAYLIST_DESCRIPTION = `Overwrite the single "${PREVIEW_PLAYLIST_NAME}" playlist in Music.app with these tracks so the user can audition a draft before committing. The slot is reused on every call (stable playlist, contents replaced) — previous preview contents are discarded without warning. When the user approves, materialize with create_playlist. Same track ID rules as create_playlist: unknown IDs fail with track_not_found and nothing is written.`;

export async function handlePreviewPlaylist(
  raw: unknown,
  deps: ToolDeps,
): Promise<PreviewPlaylistOutput | SelectaError> {
  const parsed = PreviewPlaylistInput.safeParse(raw);
  if (!parsed.success) {
    return validationError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  const { track_ids } = parsed.data;

  try {
    const cacheMiss = missingTrackIdsError(deps.cache(), track_ids);
    if (cacheMiss) return cacheMiss;

    const result = await deps.bridge.replacePlaylist({
      name: PREVIEW_PLAYLIST_NAME,
      trackIds: track_ids,
    });
    deps.cache().upsertPlaylistAfterWrite(result, PREVIEW_PLAYLIST_NAME, track_ids);
    return { playlist_id: result.persistentId, track_count: result.trackCount };
  } catch (err) {
    return toErrorEnvelope(err);
  }
}
