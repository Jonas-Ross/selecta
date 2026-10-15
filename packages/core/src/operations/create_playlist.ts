import type {
  CreatePlaylistInput,
  CreationObservation,
  CreationOutcome,
} from '../types/playlist_creation.js';
import type { SelectaCache } from '../cache/index.js';
import { PLAYLIST_WRITE_TRACK_LIMIT, type Bridge } from '../types/bridge.js';
import type { PlaylistRow } from '../types/cache.js';
import { BridgeError, toErrorEnvelope, type SelectaError } from '../types/errors.js';
import { OperationCleanupError, withOperation } from './lock.js';
import { PREVIEW_PLAYLIST_NAME } from './playlist.js';
import { missingTrackIdsError, resolvePlaylist } from './resources.js';

export function persistenceFailure(observed: CreationObservation, error: unknown): CreationOutcome {
  return {
    status: 'persistence_failed',
    observed,
    error: {
      error: 'cache_unavailable',
      partial_write: {
        playlist_id: observed.playlist.persistentId,
        observed_track_ids: observed.playlist.trackPersistentIds,
      },
      hint: `Music.app returned the playlist, but local persistence failed: ${String(error)}. Inspect this target and run refresh_library to reconcile the cache; do not repeat the write.`,
    },
  };
}

/** One write attempt, retaining its settled outcome even if lock cleanup fails. */
export async function createPlaylist(
  input: CreatePlaylistInput,
  deps: { cache: () => SelectaCache; bridge: Bridge },
): Promise<CreationOutcome> {
  return settleUnderLock(deps.cache, 'Creation', (cache) =>
    createUnderLock(input, cache, deps.bridge),
  );
}

/** Runs one Music.app write under the Music lock; a lock cleanup failure never hides its outcome. */
export async function settleUnderLock(
  open: () => SelectaCache,
  what: 'Creation' | 'Update',
  write: (cache: SelectaCache) => Promise<CreationOutcome>,
): Promise<CreationOutcome> {
  // release() runs in finally and can replace the callback's return value.
  let settled: CreationOutcome | undefined;

  try {
    const cache = open();

    return await withOperation(cache, 'music', async () => {
      settled = await write(cache);

      return settled;
    });
  } catch (error) {
    if (settled) {
      const lockPath = error instanceof OperationCleanupError ? error.lockPath : undefined;
      const cleanupHint =
        error instanceof OperationCleanupError
          ? `${error.message}. ${error.recoveryHint}`
          : `Local operation cleanup failed: ${String(error)}.`;

      if (settled.status === 'observed_success')
        return {
          ...settled,
          status: 'committed_cleanup_failed',
          lockPath,
          error: {
            error: 'operation_cleanup_failed',
            partial_write: {
              playlist_id: settled.observed.playlist.persistentId,
              observed_track_ids: settled.observed.playlist.trackPersistentIds,
            },
            hint: `${what} committed to Music.app and the cache${what === 'Creation' ? ', including its receipt and any note' : ''}. ${cleanupHint} No refresh or repeat ${what.toLowerCase()} is needed for this committed result.`,
          },
        };

      return {
        ...settled,
        lockPath,
        error: {
          ...settled.error,
          hint: `${settled.error.hint} ${cleanupHint}`,
        },
      };
    }

    return {
      status: 'rejected_before_write',
      error: toErrorEnvelope(error, {
        error: 'cache_unavailable',
        hint: `${what} was rejected before calling Music.app.`,
      }),
    };
  }
}

async function createUnderLock(
  input: CreatePlaylistInput,
  cache: SelectaCache,
  bridge: Bridge,
): Promise<CreationOutcome> {
  let attempted = false;
  let observed: CreationObservation | undefined;

  try {
    const { name, description, note } = input;

    if (input.trackIds !== undefined) {
      const error = missingTrackIdsError(cache, input.trackIds);

      if (error) return { status: 'rejected_before_write', error };

      attempted = true;
      const playlist = await bridge.createPlaylist({
        name,
        trackIds: input.trackIds,
        description,
      });

      observed = { playlist, name, expectedTrackIds: input.trackIds };
    } else {
      const requestedId = input.sourcePlaylistId;
      const source = resolvePlaylist(cache, requestedId);
      const cached = source.ok ? source.playlist : null;
      const reservedPreview =
        cached !== null
          ? cached.kind === 'user' && cached.name === PREVIEW_PLAYLIST_NAME
          : cache.getCreationName(requestedId) === PREVIEW_PLAYLIST_NAME;

      if (!source.ok && !reservedPreview)
        return { status: 'rejected_before_write', error: source.error };

      if (cached !== null) {
        const error = cachedSourceError(cached);

        if (error) return { status: 'rejected_before_write', error };
      }

      const cachedId = cached?.persistentId ?? cache.resolvePlaylistId(requestedId);

      attempted = true;
      const playlist = await bridge.clonePlaylist({
        name,
        sourcePlaylistId: cachedId,
        description,
        ...(reservedPreview ? { reservedSourceName: PREVIEW_PLAYLIST_NAME } : {}),
      });

      observed = {
        playlist,
        name,
        expectedTrackIds: playlist.sourceTrackPersistentIds,
        source: {
          playlistId: playlist.sourcePersistentId,
          name: playlist.sourceName,
          trackIds: playlist.sourceTrackPersistentIds,
          requestedId,
          cachedId,
        },
      };
    }

    // No SQLite transaction spans the external call. Destination, receipt,
    // note and any source alias are committed together from the readback.
    const storedNote = cache.persistPlaylistCreation({
      playlist: observed.playlist,
      name,
      note,
      ...(observed.source && observed.source.playlistId !== observed.source.cachedId
        ? {
            rekey: {
              staleId: observed.source.cachedId,
              live: {
                persistentId: observed.source.playlistId,
                name: observed.source.name,
                trackIds: observed.source.trackIds,
              },
            },
          }
        : {}),
    });

    return { status: 'observed_success', observed, ...(storedNote ? { note: storedNote } : {}) };
  } catch (error) {
    if (observed) return persistenceFailure(observed, error);

    return attemptFailure(error, attempted, 'Creation');
  }
}

/** Sorts a failed bridge attempt into proven-pre-write or uncertain; only a validated guard proves no write. */
export function attemptFailure(
  error: unknown,
  attempted: boolean,
  what: 'Creation' | 'Update',
): CreationOutcome {
  const preWrite =
    !attempted ||
    (error instanceof BridgeError && error.writePhase === 'not_started' && !error.partialWrite);
  const envelope = toErrorEnvelope(
    error,
    attempted
      ? {
          error: 'jxa_error',
          hint: `Music.app ${what.toLowerCase()} outcome is unknown. Inspect Music.app; do not repeat the write.`,
        }
      : { error: 'cache_unavailable', hint: `${what} was rejected before calling Music.app.` },
  );

  // These read-oriented defaults suggest retrying; a write needs inspection
  // first because an executor error carries no event-phase evidence.
  const failureHint =
    envelope.error === 'music_app_not_running'
      ? `Music.app was unavailable during the ${what.toLowerCase()} attempt.`
      : envelope.error === 'automation_permission_denied'
        ? `Music.app automation was denied during the ${what.toLowerCase()} attempt.`
        : envelope.hint;

  return {
    status: preWrite ? 'rejected_before_write' : 'write_uncertain',
    error: !preWrite
      ? {
          ...envelope,
          hint: `${failureHint} ${what} may have started. Inspect Music.app; do not repeat the write.`,
        }
      : envelope,
  };
}

function cachedSourceError(source: PlaylistRow): SelectaError | null {
  if (source.kind !== 'user')
    return {
      error: 'playlist_not_editable',
      hint: `"${source.name}" is a ${source.kind} playlist. Clone sources must be plain user playlists so externally changing curation does not become user co-occurrence signal.`,
    };

  if (source.trackCount < 1)
    return {
      error: 'validation_error',
      hint: `Source playlist "${source.name}" is empty. Clone sources must contain 1-${PLAYLIST_WRITE_TRACK_LIMIT} entries.`,
    };

  if (source.trackCount > PLAYLIST_WRITE_TRACK_LIMIT)
    return {
      error: 'validation_error',
      hint: `Source playlist "${source.name}" has ${source.trackCount} cached entries; the maximum is ${PLAYLIST_WRITE_TRACK_LIMIT}.`,
    };

  return null;
}
