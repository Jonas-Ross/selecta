// Public typed API for the bridge layer. Tools depend on the `Bridge` type;
// nothing outside src/bridge/ touches osascript or JXA.
//
// M1 (this milestone) implements only readPlaylist. The remaining methods
// throw not_implemented until their milestones land (cache read M2, writes M5).

import { runJxa } from './jxa.js';
import { buildReadPlaylistScript } from './scripts/read_playlist.js';
import { buildReadLibraryScript } from './scripts/read_library.js';
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
import { BridgeError } from '../types/errors.js';
import {
  type Bridge,
  type LibrarySnapshot,
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
};

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
