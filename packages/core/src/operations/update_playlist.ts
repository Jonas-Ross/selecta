import type { SelectaCache } from '../cache/index.js';
import type { Bridge } from '../types/bridge.js';
import type { CreationObservation, CreationOutcome } from '../types/playlist_creation.js';
import { attemptFailure, persistenceFailure, settleUnderLock } from './create_playlist.js';
import { missingTrackIdsError, playlistEditConflictError } from './resources.js';

export type UpdatePlaylistInput = {
  playlistId: string;
  savedName: string;
  name: string;
  trackIds: string[];
  // What this write last left there; anything else means someone changed it since.
  expectedTrackIds: string[];
};

/** Rewrites a playlist Selecta saved, in place. One attempt, never repeated. */
export function updatePlaylist(
  input: UpdatePlaylistInput,
  deps: { cache: () => SelectaCache; bridge: Bridge },
): Promise<CreationOutcome> {
  return settleUnderLock(deps.cache, 'Update', async (cache) => {
    let attempted = false;
    let observed: CreationObservation | undefined;

    try {
      const error =
        playlistEditConflictError(cache, input.playlistId) ??
        missingTrackIdsError(cache, input.trackIds);

      if (error) return { status: 'rejected_before_write', error };

      attempted = true;
      const playlist = await deps.bridge.overwritePlaylist({
        ...input,
        playlistId: cache.resolvePlaylistId(input.playlistId),
      });

      observed = { playlist, name: input.name, expectedTrackIds: input.trackIds };
      cache.upsertPlaylistAfterWrite(playlist, input.name, playlist.trackPersistentIds);

      return { status: 'observed_success', observed };
    } catch (error) {
      if (observed) return persistenceFailure(observed, error);

      return attemptFailure(error, attempted, 'Update');
    }
  });
}
