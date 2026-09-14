import type { PlaylistReplaceResult } from '../types/bridge.js';
import type { ToolDeps } from '../tools/deps.js';
import { toErrorEnvelope, type SelectaError } from '../types/errors.js';
import { PREVIEW_PLAYLIST_NAME } from './playlist.js';

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
