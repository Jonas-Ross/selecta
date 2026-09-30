import { z } from 'zod';
import { OperationCleanupError, withOperation } from '../operations/lock.js';
import { PLAYLIST_WRITE_TRACK_LIMIT } from '../types/bridge.js';
import { parseInput } from './errors.js';
import { toErrorEnvelope, type SelectaError } from '../types/errors.js';
import type { ToolDeps } from './deps.js';

export const openPreviewInputShape = {
  track_ids: z
    .array(z.string().min(1))
    .min(1)
    .max(PLAYLIST_WRITE_TRACK_LIMIT)
    .describe('Expected complete preview order, including repeated track IDs.'),
};
const Input = z.strictObject(openPreviewInputShape);

export const OPEN_PREVIEW_DESCRIPTION = `Open the existing Selecta Preview playlist in Music.app for auditioning, only on user request. Does not start playback or replace contents. Supply the exact current draft order in track_ids, including repeats. Resolves exactly one reserved-name plain user playlist live; missing, ambiguous, or different contents fail before opening. On mismatch, reconcile the preview and draft before another explicit Open; never overwrite the slot just to recover from this error. No library refresh or retries. Permanent Save remains separate.`;

export async function handleOpenPreview(raw: unknown, deps: ToolDeps) {
  const parsed = parseInput(Input, raw);

  if (!parsed.ok) return parsed.error;

  let settled:
    | { playlist_id: string; track_count: number; opened: true }
    | SelectaError
    | undefined;

  try {
    return await withOperation(deps.cache(), 'music', async () => {
      try {
        const result = await deps.bridge.openPreview({ expectedTrackIds: parsed.data.track_ids });

        settled = {
          playlist_id: result.persistentId,
          track_count: result.trackCount,
          opened: true,
        };
      } catch (error) {
        settled = toErrorEnvelope(error, {
          error: 'jxa_error',
          hint: 'Could not confirm opening Selecta Preview.',
        });
      }

      return settled;
    });
  } catch (error) {
    if (error instanceof OperationCleanupError) {
      const outcomeHint =
        settled && 'opened' in settled
          ? 'Selecta Preview opened in Music.app.'
          : (settled?.hint ?? 'Open outcome unconfirmed.');

      return {
        ...settled,
        error: settled && 'error' in settled ? settled.error : 'operation_cleanup_failed',
        hint: `${outcomeHint} ${error.message}. ${error.recoveryHint}`,
        lock_path: error.lockPath,
      };
    }

    return toErrorEnvelope(error, {
      error: 'cache_unavailable',
      hint: 'Could not acquire the Music operation lock.',
    });
  }
}
