// Bridge integration test — exercises the real osascript/JXA path against a
// live Music.app. Opt-in via the `integration` tag: excluded from the default
// `npm test`, run only with `npm run test:integration` (--tagsFilter=integration).
//
// Setup: create a user playlist named exactly "Selecta Test" in Music.app with a
// few tracks. The test resolves its persistent ID by name (no hardcoded ID),
// then reads it back and asserts the RawPlaylist contract shape.

import { describe, it, expect } from 'vitest';
import { bridge, findPlaylistByName } from '../../src/bridge/index.js';

describe('bridge readPlaylist against real Music.app', { tags: ['integration'] }, () => {
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
