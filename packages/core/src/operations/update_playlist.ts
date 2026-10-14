import { RECONCILE_WINDOW_MINUTES, type SelectaCache } from '../cache/index.js';
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

      const playlistId = cache.resolvePlaylistId(input.playlistId);

      attempted = true;
      const playlist = await deps.bridge.overwritePlaylist({
        ...input,
        playlistId,
        // A playlist the cache knows under its own ID is another playlist, never a rekey,
        // whatever it is called now.
        knownIds: cache.getPlaylistIds().filter((id) => id !== playlistId),
        // Only a fresh playlist's ID rotates; past refresh's window a name match could be a copy.
        followRekey: cache.isRecentCreation(playlistId, RECONCILE_WINDOW_MINUTES),
      });

      observed = { playlist, name: input.name, expectedTrackIds: input.trackIds };
      cache.persistPlaylistUpdate({ playlist, name: input.name, staleId: playlistId });

      return { status: 'observed_success', observed };
    } catch (error) {
      if (observed) return persistenceFailure(observed, error);

      return attemptFailure(error, attempted, 'Update');
    }
  });
}
