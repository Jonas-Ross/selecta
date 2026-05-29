// Public typed API for the bridge layer. Tools depend on the `Bridge` type;
// nothing outside src/bridge/ touches osascript or JXA.
//
// M1 (this milestone) implements only readPlaylist. The remaining methods
// throw not_implemented until their milestones land (cache read M2, writes M5).

import { runJxa } from './jxa.js';
import { buildReadPlaylistScript } from './scripts/read_playlist.js';
import { buildFindPlaylistByNameScript } from './scripts/find_playlist_by_name.js';
import { BridgeError, type Bridge, type RawPlaylist } from './types.js';

function notImplemented(method: string): never {
  throw new BridgeError(
    'not_implemented',
    `Bridge.${method} is not implemented yet in the current milestone.`,
  );
}

// Validate the JXA payload at the bridge boundary so a shape mismatch surfaces
// as a structured jxa_error rather than a silent bad cast downstream.
function isRawPlaylist(value: unknown): value is RawPlaylist {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.persistentId === 'string' &&
    typeof v.name === 'string' &&
    typeof v.kind === 'string' &&
    Array.isArray(v.trackPersistentIds)
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
  async readLibrary() {
    return notImplemented('readLibrary');
  },
  async createPlaylist() {
    return notImplemented('createPlaylist');
  },
  async replacePlaylist() {
    return notImplemented('replacePlaylist');
  },
};

// Test-support: resolve a playlist's persistent ID by name. Used by the opt-in
// integration test; kept in the bridge layer so no JXA leaks elsewhere.
export async function findPlaylistByName(name: string): Promise<string | null> {
  return (await runJxa(buildFindPlaylistByNameScript({ name }))) as string | null;
}

export * from './types.js';
