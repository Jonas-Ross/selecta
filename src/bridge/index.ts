// Public typed API for the bridge layer. Tools depend on the `Bridge` type;
// nothing outside src/bridge/ touches osascript or JXA.
//
// M1 (this milestone) implements only readPlaylist. The remaining methods
// throw not_implemented until their milestones land (cache read M2, writes M5).

import { runJxa } from './jxa.js';
import { buildReadPlaylistScript } from './scripts/read_playlist.js';
import {
  buildListLibraryTrackIdsScript,
  buildReadLibraryScript,
} from './scripts/read_library.js';
import {
  buildFindPlaylistByNameScript,
  buildListPlaylistsByNameScript,
} from './scripts/find_playlist_by_name.js';
import {
  buildCreatePlaylistScript,
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
import { BridgeError } from '../types/errors.js';
import {
  type Bridge,
  type LibrarySnapshot,
  type PlaylistEditResult,
  type PlaylistWriteResult,
  type RawPlaylist,
} from '../types/bridge.js';

// Validate the JXA payload at the bridge boundary so a shape mismatch surfaces
// as a structured jxa_error rather than a silent bad cast downstream.
function isRawPlaylist(value: unknown): value is RawPlaylist {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.persistentId === 'string' &&
    typeof v.name === 'string' &&
    typeof v.kind === 'string' &&
    Array.isArray(v.trackPersistentIds) &&
    v.trackPersistentIds.every((id) => typeof id === 'string')
  );
}

// Same boundary-validation idea for the full snapshot: cheap structural checks
// (every track has a string persistentId; playlists pass the RawPlaylist check)
// so a JXA shape drift surfaces as jxa_error, not a corrupt cache.
function isLibrarySnapshot(value: unknown): value is LibrarySnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.capturedAt === 'string' &&
    Array.isArray(v.tracks) &&
    v.tracks.every(
      (t) =>
        typeof t === 'object' &&
        t !== null &&
        typeof (t as Record<string, unknown>).persistentId === 'string',
    ) &&
    Array.isArray(v.playlists) &&
    v.playlists.every(isRawPlaylist)
  );
}

export const bridge: Bridge = {
  async readPlaylist(persistentId: string): Promise<RawPlaylist> {
    const result = await runJxa(buildReadPlaylistScript({ persistentId }));
    if (!isRawPlaylist(result)) {
      throw new BridgeError('jxa_error', 'JXA returned an unexpected RawPlaylist shape.');
    }
    return result;
  },
  async readLibrary(): Promise<LibrarySnapshot> {
    const result = await runJxa(buildReadLibraryScript());
    if (!isLibrarySnapshot(result)) {
      throw new BridgeError('jxa_error', 'JXA returned an unexpected LibrarySnapshot shape.');
    }
    return result;
  },
  async createPlaylist(input): Promise<PlaylistWriteResult> {
    return parseWriteResult(await runJxa(buildCreatePlaylistScript(input)));
  },
  async replacePlaylist(input): Promise<PlaylistWriteResult> {
    return parseWriteResult(await runJxa(buildReplacePlaylistScript(input)));
  },
  async deletePlaylistById(persistentId): Promise<number> {
    return parseDeleteResult(await runJxa(buildDeletePlaylistByIdScript({ persistentId })));
  },
  async addPlaylistTracks(input): Promise<PlaylistEditResult> {
    return parseEditResult(await runJxa(buildAddTracksScript(input)), 'add');
  },
  async removePlaylistTracks(input): Promise<PlaylistEditResult> {
    return parseEditResult(await runJxa(buildRemoveTracksScript(input)), 'remove');
  },
  async reorderPlaylistTracks(input): Promise<PlaylistEditResult> {
    return parseEditResult(await runJxa(buildReorderTracksScript(input)), 'reorder');
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
        `The live playlist has changed since the cache was built (has ${String(v.liveTrackCount)} tracks) — run refresh_library, re-read the order via search with in_playlist + sort playlist_order, and recompute the permutation.`,
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

function isPlaylistEditResult(v: Record<string, unknown>): v is PlaylistEditResult & Record<string, unknown> {
  return (
    typeof v.persistentId === 'string' &&
    typeof v.trackCount === 'number' &&
    isIdArray(v.trackPersistentIds) &&
    isIdArray(v.preEditTrackPersistentIds) &&
    (v.removedCount === undefined || typeof v.removedCount === 'number') &&
    (v.movedCount === undefined || typeof v.movedCount === 'number')
  );
}

function parseDeleteResult(result: unknown): number {
  if (typeof result === 'object' && result !== null) {
    const deleted = (result as Record<string, unknown>).deleted;
    if (typeof deleted === 'number') return deleted;
  }
  throw new BridgeError('jxa_error', 'JXA returned an unexpected delete result shape.');
}

// The write scripts return { missingTrackIds } without touching Music.app when
// any requested ID is absent from the live library — i.e. the cache is stale.
function parseWriteResult(result: unknown): PlaylistWriteResult {
  if (typeof result === 'object' && result !== null) {
    const v = result as Record<string, unknown>;
    if (Array.isArray(v.missingTrackIds)) {
      const missing = v.missingTrackIds as string[];
      throw new BridgeError(
        'track_not_found',
        `Music.app has no tracks with persistent IDs: ${missing.join(', ')}`,
        'These IDs are in the cache but not the live library — the cache is stale. Run refresh_library and re-resolve the tracks.',
      );
    }
    if (typeof v.persistentId === 'string' && typeof v.trackCount === 'number') {
      return { persistentId: v.persistentId, trackCount: v.trackCount };
    }
  }
  throw new BridgeError('jxa_error', 'JXA returned an unexpected PlaylistWriteResult shape.');
}

// Test-support: the library's track persistent IDs in one bulk Apple event —
// the integration suite uses this to pick seed tracks without paying for a
// full readLibrary snapshot.
export async function listLibraryTrackIds(): Promise<string[]> {
  const result = await runJxa(buildListLibraryTrackIdsScript());
  if (!Array.isArray(result) || !result.every((id) => typeof id === 'string')) {
    throw new BridgeError('jxa_error', 'JXA returned an unexpected track-id list shape.');
  }
  return result;
}

// Test-support: resolve a playlist's persistent ID by name. Used by the opt-in
// integration test; kept in the bridge layer so no JXA leaks elsewhere.
export async function findPlaylistByName(name: string): Promise<string | null> {
  return (await runJxa(buildFindPlaylistByNameScript({ name }))) as string | null;
}

// Test-support: delete every playlist with this name (integration-test/smoke
// cleanup only — v1 has no playlist deletion in the Bridge interface). By name
// because iCloud sync reassigns fresh playlist persistent IDs; see the script.
export async function deletePlaylistsByName(name: string): Promise<number> {
  return parseDeleteResult(await runJxa(buildDeletePlaylistsByNameScript({ name })));
}

// Test/diagnostic support: every playlist with this name (ID + track count).
// The echo-verification script polls this to watch a sync echo arrive.
export async function listPlaylistsByName(
  name: string,
): Promise<{ persistentId: string; trackCount: number }[]> {
  return (await runJxa(buildListPlaylistsByNameScript({ name }))) as {
    persistentId: string;
    trackCount: number;
  }[];
}
