// Bridge integration test — exercises the real osascript/JXA path against a
// live Music.app. Opt-in via the `integration` tag: excluded from the default
// `npm test`, run only with `npm run test:integration` (--tags-filter=integration).
//
// Setup: create a user playlist named exactly "Selecta Test" in Music.app with a
// few tracks. The test resolves its persistent ID by name (no hardcoded ID),
// then reads it back and asserts the RawPlaylist contract shape.

import { describe, it, expect } from 'vitest';
import { bridge, findPlaylistByName } from '../../src/bridge/index.js';

describe('bridge readLibrary against real Music.app', { tags: ['integration'] }, () => {
  it('returns a full snapshot whose user playlists reference library tracks', async () => {
    const snapshot = await bridge.readLibrary();

    expect(snapshot.tracks.length).toBeGreaterThan(0);
    expect(snapshot.playlists.length).toBeGreaterThan(0);
    expect(Date.parse(snapshot.capturedAt)).not.toBeNaN();

    // Special playlists (Library, Music) must be excluded from the snapshot.
    expect(snapshot.playlists.every((p) => p.kind !== 'special')).toBe(true);

    const testPlaylist = snapshot.playlists.find((p) => p.name === 'Selecta Test');
    expect(
      testPlaylist,
      'Create a playlist named "Selecta Test" in Music.app before running integration tests.',
    ).toBeTruthy();
    expect(testPlaylist!.kind).toBe('user');
    expect(testPlaylist!.trackPersistentIds.length).toBeGreaterThan(0);

    // Every user playlist's members must exist in the track snapshot —
    // otherwise the cache would store dangling memberships.
    const trackIds = new Set(snapshot.tracks.map((t) => t.persistentId));
    for (const playlist of snapshot.playlists.filter((p) => p.kind === 'user')) {
      for (const id of playlist.trackPersistentIds) {
        expect(trackIds.has(id), `dangling track ${id} in playlist ${playlist.name}`).toBe(true);
      }
    }
  }, 120_000);
});

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
