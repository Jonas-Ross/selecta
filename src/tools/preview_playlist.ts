import { DraftStore } from '../drafts/store.js';
import { replacePreview, type PreviewAttempt } from '../operations/preview_playlist.js';
import { OperationCleanupError, withOperation } from '../operations/lock.js';
// preview_playlist — overwrite the single dedicated audition slot in Music.app.

import { z } from 'zod';
import { PLAYLIST_WRITE_TRACK_LIMIT } from '../types/bridge.js';
import { toErrorEnvelope, type SelectaError } from '../types/errors.js';
import { apiNoteFromRow, type ApiNote } from '../domain/track_projections.js';
import { missingTrackIdsError } from '../operations/resources.js';
import { parseInput } from './errors.js';
import type { ToolDeps } from './deps.js';

import { PREVIEW_PLAYLIST_NAME } from '../operations/playlist.js';
export { PREVIEW_PLAYLIST_NAME };

export const previewPlaylistInputShape = {
  track_ids: z
    .array(z.string().min(1))
    .min(1)
    .max(PLAYLIST_WRITE_TRACK_LIMIT)
    .describe('Track persistent IDs in the exact order they should play.'),
};

const PreviewPlaylistInput = z.strictObject(previewPlaylistInputShape);

export type PreviewPlaylistOutput = {
  playlist_id: string;
  track_count: number;
  order_matches_request?: boolean;
  note?: ApiNote;
};

export const PREVIEW_PLAYLIST_DESCRIPTION = `Overwrite the single "${PREVIEW_PLAYLIST_NAME}" playlist in Music.app with these tracks so the user can audition a draft before committing. This raw tool disconnects any linked draft preview. For active draft iteration use preview_playlist_draft once, then edit_playlist_draft carries requested track changes through without another confirmation. The slot is reused on every call (stable playlist, contents replaced) — previous preview contents are discarded without warning. When the user approves, pass this result's playlist_id to create_playlist as source_playlist_id; it clones the current live preview order without resending track IDs. That playlist_id stays valid even if iCloud rekeys a first-ever slot while the user auditions — create_playlist re-resolves the slot by its reserved name. Same track ID rules as create_playlist: unknown IDs fail with track_not_found and nothing is written. iCloud sync occasionally twins the slot after creation; this is not a failed call. Multiple slots produce validation_error before any overwrite; refresh_library reports the copies without deleting them, so ask the user which copy to keep. order_matches_request: false means observed destination entries differ from the request; inspect before another edit. partial_write on an error preserves the target ID when population/readback failed; refresh and inspect before retrying. Any set_note memory on the preview slot comes back as note.`;

export async function handlePreviewPlaylist(
  raw: unknown,
  deps: ToolDeps,
): Promise<PreviewPlaylistOutput | SelectaError> {
  const parsed = parseInput(PreviewPlaylistInput, raw);

  if (!parsed.ok) return parsed.error;

  const { track_ids } = parsed.data;

  let settled: PreviewAttempt | undefined;

  try {
    const cache = deps.cache();

    return await withOperation(cache, 'music', async () => {
      const cacheMiss = missingTrackIdsError(cache, track_ids);

      if (cacheMiss) return cacheMiss;

      // Invalidate before the attempt, including uncertain/partial writes.
      (deps.drafts?.() ?? new DraftStore()).unlinkPreview();
      settled = await replacePreview(track_ids, undefined, deps);

      if (settled.error) return settled as SelectaError;

      return {
        playlist_id: settled.playlist_id!,
        track_count: settled.track_count!,
        ...(settled.order_matches_request === false ? { order_matches_request: false } : {}),
        note: apiNoteFromRow(cache.getNote('playlist', settled.playlist_id!)),
      };
    });
  } catch (err) {
    return {
      ...settled,
      ...toErrorEnvelope(err, {
        error: 'cache_unavailable',
        hint: 'Preview failed; inspect the retained receipt before an explicit recovery.',
      }),
      ...(err instanceof OperationCleanupError
        ? {
            error: 'operation_cleanup_failed' as const,
            lock_path: err.lockPath,
            hint: err.recoveryHint,
          }
        : {}),
    };
  }
}
