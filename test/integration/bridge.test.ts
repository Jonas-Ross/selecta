// Bridge integration test — exercises the real osascript/JXA path against a
// live Music.app. Opt-in: runs only with SELECTA_INTEGRATION=1, and only via
// `npm run test:integration` (excluded from the default unit run).
//
// Setup: create a user playlist named exactly "Selecta Test" in Music.app with a
// few tracks. The test resolves its persistent ID by name (no hardcoded ID),
// then reads it back and asserts the RawPlaylist contract shape.

import { describe, it, expect } from 'vitest';
import { bridge, findPlaylistByName } from '../../src/bridge/index.js';

const enabled = process.env.SELECTA_INTEGRATION === '1';

describe.runIf(enabled)('bridge readPlaylist against real Music.app', { tags: ['integration'] }, () => {
  it('round-trips the "Selecta Test" playlist and its track persistent IDs', async () => {
    const id = await findPlaylistByName('Selecta Test');
    expect(
      id,
      'Create a playlist named "Selecta Test" in Music.app before running integration tests.',
    ).toBeTruthy();

    const playlist = await bridge.readPlaylist(id!);

    expect(playlist.persistentId).toBe(id);
    expect(playlist.name).toBe('Selecta Test');
    // The documented fixture is a user playlist with a few tracks.
    expect(playlist.kind).toBe('user');
    expect(Array.isArray(playlist.trackPersistentIds)).toBe(true);
    expect(playlist.trackPersistentIds.length).toBeGreaterThan(0);
    for (const trackId of playlist.trackPersistentIds) {
      expect(typeof trackId).toBe('string');
      expect(trackId.length).toBeGreaterThan(0);
    }
  });
});
