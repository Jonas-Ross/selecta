// Public typed API for the bridge layer. Tools depend on the `Bridge` type;
// nothing outside src/bridge/ touches osascript or JXA.
//
// M1 (this milestone) implements only readPlaylist. The remaining methods
// throw not_implemented until their milestones land (cache read M2, writes M5).

import { runJxa as runUncheckedJxa } from './jxa.js';
import { z } from 'zod';
import * as schemas from './schemas.js';
import { parsePayload } from '../types/validation.js';

async function runJxa<T>(script: string, schema: z.ZodType<T>): Promise<T> {
  const result = parsePayload(schema, await runUncheckedJxa(script), 'Music.app', 'jxa_error');
  const partial = schemas.partialWriteResult.safeParse(result);
  if (partial.success) {
    const receipt = partial.data.partialWrite;
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
  return result;
}
import { buildReadPlaylistScript } from './scripts/read_playlist.js';
import { buildListLibraryTrackIdsScript, buildReadLibraryScript } from './scripts/read_library.js';
import {
  buildFindPlaylistByNameScript,
  buildListPlaylistsByNameScript,
} from './scripts/find_playlist_by_name.js';
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
import { BridgeError } from '../types/errors.js';
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
    return parseWriteResult(await runJxa(buildCreatePlaylistScript(input), schemas.write));
  },
  async clonePlaylist(input): Promise<PlaylistCloneResult> {
    return parseCloneResult(
      await runJxa(buildClonePlaylistScript(input), schemas.clone),
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
    const written = parseWriteResult(result);
    const created = (result as Record<string, unknown> | null)?.created;
    if (typeof created !== 'boolean') {
      throw new BridgeError('jxa_error', 'JXA returned an unexpected PlaylistReplaceResult shape.');
    }
    return { ...written, created };
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
      isLovedState,
      input.trackIds,
    );
  },
  async setTrackRating(input): Promise<TrackSignalResult<TrackRatingState>> {
    return parseSignalResult(
      await runJxa(buildSetRatingScript(input), schemas.ratingResult),
      isRatingState,
      input.trackIds,
    );
  },
};

// The edit scripts return a guard sentinel — without touching Music.app — when
// the target playlist or a referenced track/position doesn't hold live. Each
// maps to a structured error; the model decides what to do next.
function parseEditResult(result: unknown, op: 'add' | 'remove' | 'reorder'): PlaylistEditResult {
  if (typeof result === 'object' && result !== null) {
    const v = result as Record<string, unknown>;
    if (v.playlistNotFound === true) {
      throw new BridgeError(
        'playlist_not_found',
        'Music.app has no playlist with that persistent ID.',
        'The playlist is in the cache but not the live library — the cache is stale. Run refresh_library and re-resolve the playlist.',
      );
    }
    if (v.notEditable === true) {
      throw new BridgeError('playlist_not_editable', 'Target is not a plain user playlist.');
    }
    if (Array.isArray(v.missingTrackIds)) {
      const missing = v.missingTrackIds as string[];
      throw new BridgeError(
        'track_not_found',
        `Music.app: ${missing.join(', ')} — ${op === 'add' ? 'not in the live library' : 'no occurrence in the live playlist'}.`,
        op === 'add'
          ? 'These IDs are in the cache but not the live library — the cache is stale. Run refresh_library and re-resolve the tracks.'
          : 'These tracks are not in the playlist in Music.app — the cache is stale. Run refresh_library and re-check the playlist contents.',
      );
    }
    if (Array.isArray(v.invalidPositions)) {
      throw new BridgeError(
        'validation_error',
        `Positions out of range live: ${(v.invalidPositions as number[]).join(', ')}.`,
        `The playlist has ${String(v.liveTrackCount)} tracks in Music.app — the cache is stale. Run refresh_library and re-check positions.`,
      );
    }
    if (v.orderDrifted === true) {
      throw new BridgeError(
        'validation_error',
        'Playlist order in Music.app differs from the expected order.',
        `The live playlist has changed since the cache was built (has ${String(v.liveTrackCount)} tracks) — run refresh_library, re-read the order via search with in_playlist + sort playlist_order, and recompute the edit using playlist_positions.`,
      );
    }
    if (v.invalidOrder === true) {
      throw new BridgeError(
        'validation_error',
        'order must be a complete permutation of 0..liveTrackCount-1.',
        `The playlist has ${String(v.liveTrackCount)} tracks in Music.app — recompute a permutation covering every index exactly once.`,
      );
    }
    if (isPlaylistEditResult(v)) return v;
  }
  throw new BridgeError('jxa_error', 'JXA returned an unexpected PlaylistEditResult shape.');
}

function isIdArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((id) => typeof id === 'string');
}

function isAmbiguousSource(value: unknown): value is { name: string; persistentIds: string[] } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === 'string' && isIdArray(v.persistentIds);
}

function isPlaylistEditResult(
  v: Record<string, unknown>,
): v is PlaylistEditResult & Record<string, unknown> {
  return (
    typeof v.persistentId === 'string' &&
    typeof v.trackCount === 'number' &&
    isIdArray(v.trackPersistentIds) &&
    isIdArray(v.preEditTrackPersistentIds) &&
    (v.removedCount === undefined || typeof v.removedCount === 'number') &&
    (v.movedCount === undefined || typeof v.movedCount === 'number')
  );
}

// Shared handling for the RESOLVE_TRACKS sentinel: scripts that resolve
// tracks return { missingTrackIds } — without writing anything — when any
// requested ID is absent from the live library (stale cache).
function throwIfMissingTracks(v: Record<string, unknown>): void {
  if (Array.isArray(v.missingTrackIds)) {
    const missing = v.missingTrackIds as string[];
    throw new BridgeError(
      'track_not_found',
      `Music.app has no tracks with persistent IDs: ${missing.join(', ')}`,
      'These IDs are in the cache but not the live library — the cache is stale. Run refresh_library and re-resolve the tracks.',
    );
  }
}

function parseSignalResult<State extends { persistentId: string }>(
  result: unknown,
  isState: (t: unknown) => t is State,
  requestedIds: string[],
): TrackSignalResult<State> {
  if (typeof result === 'object' && result !== null) {
    const v = result as Record<string, unknown>;
    throwIfMissingTracks(v);
    if (
      Array.isArray(v.tracks) &&
      v.tracks.every(isState) &&
      Array.isArray(v.preWriteTracks) &&
      v.preWriteTracks.every(isState)
    ) {
      const expected = [...new Set(requestedIds)];
      for (const rows of [v.tracks, v.preWriteTracks]) {
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
      return { tracks: v.tracks, preWriteTracks: v.preWriteTracks };
    }
  }
  throw new BridgeError('jxa_error', 'JXA returned an unexpected TrackSignalResult shape.');
}

function isLovedState(t: unknown): t is TrackLovedState {
  if (typeof t !== 'object' || t === null) return false;
  const s = t as Record<string, unknown>;
  return typeof s.persistentId === 'string' && typeof s.loved === 'boolean';
}

function isRatingState(t: unknown): t is TrackRatingState {
  if (typeof t !== 'object' || t === null) return false;
  const s = t as Record<string, unknown>;
  return typeof s.persistentId === 'string' && (typeof s.rating === 'number' || s.rating === null);
}

function parseDeleteResult(result: unknown): number {
  if (typeof result === 'object' && result !== null) {
    const v = result as Record<string, unknown>;
    if (v.notEditable === true) {
      throw new BridgeError('playlist_not_editable', 'Target is not a plain user playlist.');
    }
    if (typeof v.deleted === 'number') return v.deleted;
  }
  throw new BridgeError('jxa_error', 'JXA returned an unexpected delete result shape.');
}

function parseWriteResult(result: unknown): PlaylistWriteResult {
  if (typeof result === 'object' && result !== null) {
    const v = result as Record<string, unknown>;
    throwIfMissingTracks(v);
    if (
      typeof v.persistentId === 'string' &&
      typeof v.trackCount === 'number' &&
      isIdArray(v.trackPersistentIds)
    ) {
      return {
        persistentId: v.persistentId,
        trackCount: v.trackCount,
        trackPersistentIds: v.trackPersistentIds,
      };
    }
  }
  throw new BridgeError('jxa_error', 'JXA returned an unexpected PlaylistWriteResult shape.');
}

function parseCloneResult(result: unknown, reservedSourceName?: string): PlaylistCloneResult {
  if (typeof result === 'object' && result !== null) {
    const v = result as Record<string, unknown>;
    if (v.playlistNotFound === true && reservedSourceName !== undefined) {
      throw new BridgeError(
        'playlist_not_found',
        `Music.app has neither that persistent ID nor a plain user playlist named "${reservedSourceName}".`,
        `The "${reservedSourceName}" slot no longer exists in Music.app. Call preview_playlist again to rebuild it, then clone that result. Nothing was created.`,
      );
    }
    if (v.playlistNotFound === true) {
      throw new BridgeError(
        'playlist_not_found',
        'Music.app has no source playlist with that persistent ID.',
        'The source playlist is not in the live library — run refresh_library and re-resolve it via list_playlists.',
      );
    }
    if (isAmbiguousSource(v.ambiguousSource)) {
      const { name, persistentIds } = v.ambiguousSource;
      throw new BridgeError(
        'validation_error',
        `Music.app has ${persistentIds.length} plain user playlists named "${name}": ${persistentIds.join(', ')}.`,
        `The "${name}" slot is ambiguous — Selecta will not guess which copy the user auditioned. Run refresh_library and clone the intended copy by its list_playlists ID, or delete the extra copy with delete_playlist and retry. Nothing was created.`,
      );
    }
    if (v.sourceNotUser === true && typeof v.sourceKind === 'string') {
      throw new BridgeError(
        'playlist_not_editable',
        `Source is a ${v.sourceKind} playlist, not a plain user playlist.`,
        'Clone only a non-empty plain user playlist; generated, smart, subscription, special, and folder sources are intentionally rejected.',
      );
    }
    if (typeof v.invalidSourceTrackCount === 'number') {
      throw new BridgeError(
        'validation_error',
        `Source playlist has ${v.invalidSourceTrackCount} live entries; expected 1-${PLAYLIST_WRITE_TRACK_LIMIT}.`,
        `Choose a non-empty plain user playlist with at most ${PLAYLIST_WRITE_TRACK_LIMIT} entries. Nothing was created.`,
      );
    }
    if (isIdArray(v.missingTrackIds)) {
      throw new BridgeError(
        'track_not_found',
        `Live source playlist contains unavailable track IDs: ${v.missingTrackIds.join(', ')}`,
        'Remove or replace the unavailable entries in the source playlist before trying again. refresh_library cannot repair entries missing from the live library; do not retry the same source unchanged.',
      );
    }
    if (
      typeof v.persistentId === 'string' &&
      typeof v.trackCount === 'number' &&
      typeof v.sourcePersistentId === 'string' &&
      typeof v.sourceName === 'string' &&
      isIdArray(v.sourceTrackPersistentIds) &&
      isIdArray(v.trackPersistentIds)
    ) {
      return {
        persistentId: v.persistentId,
        trackCount: v.trackCount,
        trackPersistentIds: v.trackPersistentIds,
        sourcePersistentId: v.sourcePersistentId,
        sourceName: v.sourceName,
        sourceTrackPersistentIds: v.sourceTrackPersistentIds,
      };
    }
  }
  throw new BridgeError('jxa_error', 'JXA returned an unexpected PlaylistCloneResult shape.');
}

// Test-support: the library's track persistent IDs in one bulk Apple event —
// the integration suite uses this to pick seed tracks without paying for a
// full readLibrary snapshot.
export async function listLibraryTrackIds(): Promise<string[]> {
  const result = await runJxa(buildListLibraryTrackIdsScript(), schemas.ids);
  if (!Array.isArray(result) || !result.every((id) => typeof id === 'string')) {
    throw new BridgeError('jxa_error', 'JXA returned an unexpected track-id list shape.');
  }
  return result;
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

// Test/diagnostic support: every playlist with this name (ID + track count).
// The echo-verification script polls this to watch a sync echo arrive.
export async function listPlaylistsByName(
  name: string,
): Promise<{ persistentId: string; trackCount: number }[]> {
  return runJxa(buildListPlaylistsByNameScript({ name }), schemas.namedPlaylists);
}
