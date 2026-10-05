import type { Draft, PreviewState } from '../drafts/contracts.js';
import type { DraftStore } from '../drafts/store.js';
import type { PlaylistReplaceResult } from '../types/bridge.js';
import type { ToolDeps } from '../tools/deps.js';
import { toErrorEnvelope, type SelectaError } from '../types/errors.js';
import { OperationCleanupError, withOperation } from './lock.js';
import { PREVIEW_PLAYLIST_NAME } from './playlist.js';
import { missingTrackIdsError } from './resources.js';

export type PreviewAttempt = {
  playlist_id?: string;
  track_count?: number;
  observed_track_ids?: string[];
  order_matches_request?: boolean;
  error?: SelectaError['error'];
  hint?: string;
  partial_write?: SelectaError['partial_write'];
  lock_path?: string;
};

export type PreviewSync = { preview?: PreviewState; preview_result?: PreviewAttempt };

/** Caller owns the Music lock and durable claim. Never retries; preserves readback. */
export async function replacePreview(
  trackIds: string[],
  expectedTrackIds: string[] | undefined,
  deps: ToolDeps,
): Promise<PreviewAttempt> {
  let observed: PlaylistReplaceResult | undefined;

  try {
    observed = await deps.bridge.replacePlaylist({
      name: PREVIEW_PLAYLIST_NAME,
      trackIds,
      ...(expectedTrackIds === undefined ? {} : { expectedTrackIds }),
    });
    const cache = deps.cache();

    cache.upsertPlaylistAfterWrite(observed, PREVIEW_PLAYLIST_NAME, observed.trackPersistentIds);

    if (observed.created)
      cache.recordPlaylistCreation(
        observed.persistentId,
        PREVIEW_PLAYLIST_NAME,
        observed.trackPersistentIds,
      );

    return receipt(observed, trackIds);
  } catch (error) {
    return {
      ...(observed ? receipt(observed, trackIds) : {}),
      ...toErrorEnvelope(error, {
        error: observed ? 'cache_unavailable' : 'jxa_error',
        hint: 'Preview outcome needs inspection. Keep the local draft and do not repeat the write automatically.',
      }),
      ...(observed
        ? {
            partial_write: {
              playlist_id: observed.persistentId,
              observed_track_ids: observed.trackPersistentIds,
            },
          }
        : {}),
    };
  }
}

function receipt(observed: PlaylistReplaceResult, requested: string[]): PreviewAttempt {
  return {
    playlist_id: observed.persistentId,
    track_count: observed.trackCount,
    observed_track_ids: observed.trackPersistentIds,
    order_matches_request:
      JSON.stringify(observed.trackPersistentIds) === JSON.stringify(requested),
  };
}

/**
 * Writes the draft's order into the preview slot under the Music lock, claiming it
 * first. Never throws: the receipt says what Music.app ended up holding.
 */
export async function syncDraftPreview(
  store: DraftStore,
  deps: ToolDeps,
  draft: Draft,
  explicit: boolean,
  expected?: string[],
): Promise<PreviewSync> {
  let claim: PreviewState | undefined;
  let result: PreviewAttempt | undefined;
  let preview: PreviewState | undefined;

  try {
    await withOperation(deps.cache(), 'music', async () => {
      const missing = missingTrackIdsError(
        deps.cache(),
        draft.entries.map((entry) => entry.track_id),
      );

      if (missing) {
        result = missing;

        return;
      }

      claim = store.claimPreview(draft.draft_id, draft.revision, explicit, expected);

      if (!claim) return;

      result = await replacePreview(
        draft.entries.map((entry) => entry.track_id),
        claim.baseline,
        deps,
      );
      const status =
        result.error === 'preview_conflict'
          ? 'conflict'
          : result.error
            ? result.observed_track_ids
              ? 'error'
              : 'uncertain'
            : result.order_matches_request
              ? 'current'
              : 'conflict';

      preview = store.finishPreview(claim, {
        status,
        result,
        baseline: result.observed_track_ids ?? claim.baseline,
        playlist_id: result.playlist_id ?? claim.playlist_id,
      });
    });
  } catch (error) {
    const failure = toErrorEnvelope(error, {
      error: 'cache_unavailable',
      hint: 'Local preview claim/receipt could not be persisted. Inspect the retained result; no automatic retry.',
    });
    const cleanup = error instanceof OperationCleanupError;

    result = {
      ...result,
      ...failure,
      hint: [result?.hint, failure.hint].filter(Boolean).join(' '),
      ...(cleanup
        ? {
            error: 'operation_cleanup_failed',
            lock_path: error.lockPath,
            hint: error.recoveryHint,
          }
        : {}),
    };

    // Retain the settled write receipt in the response even if storage or lock cleanup failed.
    if (claim) {
      preview = { ...(preview ?? claim), status: 'error', result };

      if (cleanup) {
        try {
          preview = store.finishPreview(claim, preview);
        } catch (persistenceError) {
          result.hint = `${result.hint} Cleanup warning could not be persisted: ${String(persistenceError)}.`;
        }
      }
    }
  }

  return { preview, preview_result: result };
}
