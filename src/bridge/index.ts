// Public typed API for the bridge layer. Tools depend on the `Bridge` type;
// nothing outside src/bridge/ touches osascript or JXA.
// Implements library reads, playlist writes and edits, and track signal updates.

import { runJxa as runUncheckedJxa } from './jxa.js';
import { z } from 'zod';
import * as schemas from './schemas.js';
import { parsePayload } from '../types/validation.js';

async function runJxa<T>(script: string, schema: z.ZodType<T>): Promise<T> {
  return parsePayload(schema, await runUncheckedJxa(script), 'Music.app', 'jxa_error');
}

/** Preserve diagnostic target evidence when full creation readback is malformed. */
async function runCreationJxa<T>(script: string, schema: z.ZodType<T>): Promise<T> {
  const raw = await runUncheckedJxa(script);

  try {
    return parsePayload(schema, raw, 'Music.app', 'jxa_error');
  } catch (error) {
    const target = schemas.creationFailureTarget.safeParse(raw);

    if (!target.success) throw error;

    const observed = schemas.ids.safeParse(target.data.trackPersistentIds);

    throw new BridgeError(
      'jxa_error',
      'Music.app: invalid payload for creation with known target',
      'The creation response was invalid but includes a target ID. Inspect this playlist and refresh_library; do not repeat the write.',
      {
        playlist_id: target.data.persistentId,
        ...(observed.success ? { observed_track_ids: observed.data } : {}),
      },
    );
  }
}

import { buildReadPlaylistScript } from './scripts/read_playlist.js';
import { buildListLibraryTrackIdsScript, buildReadLibraryScript } from './scripts/read_library.js';
import { buildFindPlaylistByNameScript } from './scripts/find_playlist_by_name.js';
import {
  buildCreatePlaylistScript,
  buildClonePlaylistScript,
  buildReplacePlaylistScript,
} from './scripts/write_playlist.js';
import {
  buildDeletePlaylistByIdScript,
  buildDeletePlaylistsByNameScript,
} from './scripts/delete_playlist.js';
import {
  buildAddTracksScript,
  buildRemoveTracksScript,
  buildReorderTracksScript,
} from './scripts/edit_playlist.js';
import { buildSetLovedScript, buildSetRatingScript } from './scripts/track_signal.js';
import { BridgeError, preWriteError } from '../types/errors.js';
import {
  type Bridge,
  type LibrarySnapshot,
  PLAYLIST_WRITE_TRACK_LIMIT,
  type PlaylistCloneResult,
  type PlaylistEditResult,
  type PlaylistReplaceResult,
  type PlaylistWriteResult,
  type RawPlaylist,
  type TrackLovedState,
  type TrackRatingState,
  type TrackSignalResult,
} from '../types/bridge.js';

export const bridge: Bridge = {
  async readPlaylist(persistentId: string): Promise<RawPlaylist> {
    const result = await runJxa(buildReadPlaylistScript({ persistentId }), schemas.playlist);

    return result;
  },
  async readLibrary(): Promise<LibrarySnapshot> {
    const result = await runJxa(buildReadLibraryScript(), schemas.snapshot);

    return result;
  },
  async createPlaylist(input): Promise<PlaylistWriteResult> {
    return parseWriteResult(await runCreationJxa(buildCreatePlaylistScript(input), schemas.write));
  },
  async clonePlaylist(input): Promise<PlaylistCloneResult> {
    return parseCloneResult(
      await runCreationJxa(buildClonePlaylistScript(input), schemas.clone),
      input.reservedSourceName,
    );
  },
  async replacePlaylist(input): Promise<PlaylistReplaceResult> {
    const result = await runJxa(buildReplacePlaylistScript(input), schemas.replace);

    if ('ambiguousPreview' in result)
      throw new BridgeError(
        'validation_error',
        'Preview slot is ambiguous',
        'Multiple Selecta Preview playlists exist. Ask the user which copy to keep before overwriting a preview.',
      );

    if ('missingTrackIds' in result) throwMissingTracks(result.missingTrackIds);

    if ('partialWrite' in result) throwPartialWrite(result.partialWrite);

    return result;
  },
  async deletePlaylistById(persistentId): Promise<number> {
    return parseDeleteResult(
      await runJxa(buildDeletePlaylistByIdScript({ persistentId }), schemas.deleted),
    );
  },
  async addPlaylistTracks(input): Promise<PlaylistEditResult> {
    return parseEditResult(await runJxa(buildAddTracksScript(input), schemas.edit), 'add');
  },
  async removePlaylistTracks(input): Promise<PlaylistEditResult> {
    return parseEditResult(await runJxa(buildRemoveTracksScript(input), schemas.edit), 'remove');
  },
  async reorderPlaylistTracks(input): Promise<PlaylistEditResult> {
    return parseEditResult(await runJxa(buildReorderTracksScript(input), schemas.edit), 'reorder');
  },
  async setTrackLoved(input): Promise<TrackSignalResult<TrackLovedState>> {
    return parseSignalResult(
      await runJxa(buildSetLovedScript(input), schemas.lovedResult),
      input.trackIds,
    );
  },
  async setTrackRating(input): Promise<TrackSignalResult<TrackRatingState>> {
    return parseSignalResult(
      await runJxa(buildSetRatingScript(input), schemas.ratingResult),
      input.trackIds,
    );
  },
};

// The edit scripts return a guard sentinel — without touching Music.app — when
// the target playlist or a referenced track/position doesn't hold live. Each
// maps to a structured error; the model decides what to do next.
function parseEditResult(
  result: z.infer<typeof schemas.edit>,
  op: 'add' | 'remove' | 'reorder',
): PlaylistEditResult {
  if ('playlistNotFound' in result) {
    throw new BridgeError(
      'playlist_not_found',
      'Music.app has no playlist with that persistent ID.',
      'The playlist is in the cache but not the live library — the cache is stale. Run refresh_library and re-resolve the playlist.',
    );
  }

  if ('notEditable' in result) {
    throw new BridgeError('playlist_not_editable', 'Target is not a plain user playlist.');
  }

  if ('missingTrackIds' in result) {
    const missing = result.missingTrackIds;

    throw new BridgeError(
      'track_not_found',
      `Music.app: ${missing.join(', ')} — ${op === 'add' ? 'not in the live library' : 'no occurrence in the live playlist'}.`,
      op === 'add'
        ? 'These IDs are in the cache but not the live library — the cache is stale. Run refresh_library and re-resolve the tracks.'
        : 'These tracks are not in the playlist in Music.app — the cache is stale. Run refresh_library and re-check the playlist contents.',
    );
  }

  if ('invalidPositions' in result) {
    throw new BridgeError(
      'validation_error',
      `Positions out of range live: ${result.invalidPositions.join(', ')}.`,
      `The playlist has ${String(result.liveTrackCount)} tracks in Music.app — the cache is stale. Run refresh_library and re-check positions.`,
    );
  }

  if ('orderDrifted' in result) {
    throw new BridgeError(
      'validation_error',
      'Playlist order in Music.app differs from the expected order.',
      `The live playlist has changed since the cache was built (has ${String(result.liveTrackCount)} tracks) — run refresh_library, re-read the order via search with in_playlist + sort playlist_order, and recompute the edit using playlist_positions.`,
    );
  }

  if ('invalidOrder' in result) {
    throw new BridgeError(
      'validation_error',
      'order must be a complete permutation of 0..liveTrackCount-1.',
      `The playlist has ${String(result.liveTrackCount)} tracks in Music.app — recompute a permutation covering every index exactly once.`,
    );
  }

  return result;
}

// Shared handling for the RESOLVE_TRACKS sentinel: scripts that resolve
// tracks return { missingTrackIds } — without writing anything — when any
// requested ID is absent from the live library (stale cache).
function throwMissingTracks(missing: string[], writePhase?: 'not_started'): never {
  const message = `Music.app has no tracks with persistent IDs: ${missing.join(', ')}`;
  const hint =
    'These IDs are in the cache but not the live library — the cache is stale. Run refresh_library and re-resolve the tracks.';

  if (writePhase === 'not_started') throw preWriteError('track_not_found', message, hint);

  throw new BridgeError('track_not_found', message, hint);
}

function parseSignalResult(
  result: z.infer<typeof schemas.lovedResult>,
  requestedIds: string[],
): TrackSignalResult<TrackLovedState>;
function parseSignalResult(
  result: z.infer<typeof schemas.ratingResult>,
  requestedIds: string[],
): TrackSignalResult<TrackRatingState>;

function parseSignalResult(
  result: z.infer<typeof schemas.lovedResult> | z.infer<typeof schemas.ratingResult>,
  requestedIds: string[],
): TrackSignalResult<TrackLovedState> | TrackSignalResult<TrackRatingState> {
  if ('missingTrackIds' in result) throwMissingTracks(result.missingTrackIds);

  const expected = [...new Set(requestedIds)];

  for (const rows of [result.tracks, result.preWriteTracks]) {
    if (
      rows.length !== expected.length ||
      new Set(rows.map((row) => row.persistentId)).size !== expected.length ||
      rows.some((row) => !expected.includes(row.persistentId))
    ) {
      throw new BridgeError(
        'jxa_error',
        'Signal readback IDs differ from requested IDs',
        'Signal write outcome is incomplete or unexpected. Inspect the tracks and refresh_library before retrying.',
      );
    }
  }

  return result;
}

function parseDeleteResult(result: z.infer<typeof schemas.deleted>): number {
  if ('notEditable' in result) {
    throw new BridgeError('playlist_not_editable', 'Target is not a plain user playlist.');
  }

  return result.deleted;
}

function throwPartialWrite(
  receipt: z.infer<typeof schemas.partialWriteResult>['partialWrite'],
): never {
  throw new BridgeError(
    'jxa_error',
    'Playlist write or readback failed after selecting the target',
    `Playlist ${receipt.persistentId} may be partially written. Do not repeat the create or overwrite blindly. Inspect Music.app and run refresh_library before deciding how to recover.`,
    {
      playlist_id: receipt.persistentId,
      ...(receipt.trackPersistentIds ? { observed_track_ids: receipt.trackPersistentIds } : {}),
    },
  );
}

function parseWriteResult(result: z.infer<typeof schemas.write>): PlaylistWriteResult {
  if ('missingTrackIds' in result) throwMissingTracks(result.missingTrackIds, 'not_started');

  if ('partialWrite' in result && result.partialWrite !== undefined)
    throwPartialWrite(result.partialWrite);

  return result;
}

function parseCloneResult(
  result: z.infer<typeof schemas.clone>,
  reservedSourceName?: string,
): PlaylistCloneResult {
  if ('partialWrite' in result && result.partialWrite !== undefined)
    throwPartialWrite(result.partialWrite);

  if ('playlistNotFound' in result && reservedSourceName !== undefined) {
    throw preWriteError(
      'playlist_not_found',
      `Music.app has neither that persistent ID nor a plain user playlist named "${reservedSourceName}".`,
      `The "${reservedSourceName}" slot no longer exists in Music.app. Call preview_playlist again to rebuild it, then clone that result. Nothing was created.`,
    );
  }

  if ('playlistNotFound' in result) {
    throw preWriteError(
      'playlist_not_found',
      'Music.app has no source playlist with that persistent ID.',
      'The source playlist is not in the live library — run refresh_library and re-resolve it via list_playlists.',
    );
  }

  if ('ambiguousSource' in result) {
    const { name, persistentIds } = result.ambiguousSource;

    throw preWriteError(
      'validation_error',
      `Music.app has ${persistentIds.length} plain user playlists named "${name}": ${persistentIds.join(', ')}.`,
      `The "${name}" slot is ambiguous — Selecta will not guess which copy the user auditioned. Run refresh_library and clone the intended copy by its list_playlists ID, or delete the extra copy with delete_playlist and retry. Nothing was created.`,
    );
  }

  if ('sourceNotUser' in result) {
    throw preWriteError(
      'playlist_not_editable',
      `Source is a ${result.sourceKind} playlist, not a plain user playlist.`,
      'Clone only a non-empty plain user playlist; generated, smart, subscription, special, and folder sources are intentionally rejected.',
    );
  }

  if ('invalidSourceTrackCount' in result) {
    throw preWriteError(
      'validation_error',
      `Source playlist has ${result.invalidSourceTrackCount} live entries; expected 1-${PLAYLIST_WRITE_TRACK_LIMIT}.`,
      `Choose a non-empty plain user playlist with at most ${PLAYLIST_WRITE_TRACK_LIMIT} entries. Nothing was created.`,
    );
  }

  if ('missingTrackIds' in result) {
    throw preWriteError(
      'track_not_found',
      `Live source playlist contains unavailable track IDs: ${result.missingTrackIds.join(', ')}`,
      'Remove or replace the unavailable entries in the source playlist before trying again. refresh_library cannot repair entries missing from the live library; do not retry the same source unchanged.',
    );
  }

  return result;
}

// Test-support: the library's track persistent IDs in one bulk Apple event —
// the integration suite uses this to pick seed tracks without paying for a
// full readLibrary snapshot.
export async function listLibraryTrackIds(): Promise<string[]> {
  return runJxa(buildListLibraryTrackIdsScript(), schemas.ids);
}

// Test-support: resolve a playlist's persistent ID by name. Used by the opt-in
// integration test; kept in the bridge layer so no JXA leaks elsewhere.
export async function findPlaylistByName(name: string): Promise<string | null> {
  return runJxa(buildFindPlaylistByNameScript({ name }), schemas.id.nullable());
}

// Test-support: delete every playlist with this name (integration-test/smoke
// cleanup only — production deletion goes through deletePlaylistById). By name
// because iCloud sync reassigns fresh playlist persistent IDs; see the script.
export async function deletePlaylistsByName(name: string): Promise<number> {
  return parseDeleteResult(
    await runJxa(buildDeletePlaylistsByNameScript({ name }), schemas.deleted),
  );
}
