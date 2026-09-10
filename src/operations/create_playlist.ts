import type { SelectaCache } from '../cache/index.js';
import {
  PLAYLIST_WRITE_TRACK_LIMIT,
  type Bridge,
  type PlaylistWriteResult,
} from '../types/bridge.js';
import type { NoteRow, PlaylistRow } from '../types/cache.js';
import { BridgeError, defaultHints, type SelectaError } from '../types/errors.js';
import { withOperation } from './lock.js';
import { PREVIEW_PLAYLIST_NAME } from './playlist.js';
import { missingTrackIdsError, resolvePlaylist } from './resources.js';

export type CreatePlaylistInput = {
  name: string;
  description?: string;
  note?: string;
} & (
  | { trackIds: string[]; sourcePlaylistId?: never }
  | { sourcePlaylistId: string; trackIds?: never }
);

export type CreationObservation = {
  playlist: PlaylistWriteResult;
  name: string;
  expectedTrackIds: string[];
  source?: {
    playlistId: string;
    name: string;
    trackIds: string[];
    requestedId: string;
    cachedId: string;
  };
};

export type CreationOutcome =
  | { status: 'rejected_before_write'; error: SelectaError }
  | { status: 'write_uncertain'; error: SelectaError }
  | { status: 'observed_success'; observed: CreationObservation; note?: NoteRow }
  | { status: 'persistence_failed'; observed: CreationObservation; error: SelectaError };

function errorEnvelope(error: unknown, fallback: SelectaError): SelectaError {
  if (!(error instanceof BridgeError))
    return { ...fallback, hint: `${fallback.hint} ${String(error)}` };

  return {
    error: error.errorCode,
    hint: error.hint ?? defaultHints[error.errorCode],
    ...(error.partialWrite ? { partial_write: error.partialWrite } : {}),
  };
}

function persistenceFailure(observed: CreationObservation, error: unknown): CreationOutcome {
  return {
    status: 'persistence_failed',
    observed,
    error: {
      error: 'cache_unavailable',
      partial_write: {
        playlist_id: observed.playlist.persistentId,
        observed_track_ids: observed.playlist.trackPersistentIds,
      },
      hint: `Music.app returned the playlist, but local persistence or operation finalization failed: ${String(error)}. Inspect this target and run refresh_library to reconcile the cache; do not repeat the write.`,
    },
  };
}

/** One write attempt, retaining its settled outcome even if lock cleanup fails. */
export async function createPlaylist(
  input: CreatePlaylistInput,
  deps: { cache: () => SelectaCache; bridge: Bridge },
): Promise<CreationOutcome> {
  let settled: CreationOutcome | undefined;

  try {
    const cache = deps.cache();

    return await withOperation(cache, 'music', async () => {
      settled = await createUnderLock(input, cache, deps.bridge);

      return settled;
    });
  } catch (error) {
    if (settled) {
      if ('observed' in settled) return persistenceFailure(settled.observed, error);

      return {
        ...settled,
        error: {
          ...settled.error,
          hint: `${settled.error.hint} Local operation finalization also failed: ${String(error)}. Inspect the operation lock before further writes.`,
        },
      };
    }

    return {
      status: 'rejected_before_write',
      error: errorEnvelope(error, {
        error: 'cache_unavailable',
        hint: 'Creation was rejected before calling Music.app.',
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

    const preWrite =
      !attempted ||
      (error instanceof BridgeError && error.writePhase === 'not_started' && !error.partialWrite);
    const envelope = errorEnvelope(
      error,
      attempted
        ? {
            error: 'jxa_error',
            hint: 'Music.app creation outcome is unknown. Inspect Music.app; do not repeat the write.',
          }
        : { error: 'cache_unavailable', hint: 'Creation was rejected before calling Music.app.' },
    );

    return {
      status: preWrite ? 'rejected_before_write' : 'write_uncertain',
      error: !preWrite
        ? {
            ...envelope,
            hint: `${envelope.hint} Creation may have started. Inspect Music.app; do not repeat the write.`,
          }
        : envelope,
    };
  }
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
