// Bridge integration test — exercises the real osascript/JXA path against a
// live Music.app. Opt-in via the `integration` tag: excluded from the default
// `npm test`, run only with `npm run test:integration` (--tags-filter=integration).
//
// Setup: create a user playlist named exactly "Selecta Test" in Music.app with a
// few tracks. The test resolves its persistent ID by name (no hardcoded ID),
// then reads it back and asserts the RawPlaylist contract shape.

import { describe, it, expect, afterEach } from 'vitest';
import { bridge, findPlaylistByName, deletePlaylistsByName } from '../../src/bridge/index.js';

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

    // Playlists MAY reference tracks absent from the library snapshot
    // (unavailable/greyed-out entries are real in the wild) — the cache
    // tolerates dangling memberships because read queries JOIN tracks. But the
    // fixture playlist is hand-made from owned tracks, so it must fully resolve.
    const trackIds = new Set(snapshot.tracks.map((t) => t.persistentId));
    for (const id of testPlaylist!.trackPersistentIds) {
      expect(trackIds.has(id), `dangling track ${id} in Selecta Test`).toBe(true);
    }
  }, 120_000);
});

describe('bridge write paths against real Music.app', { tags: ['integration'] }, () => {
  // Scratch playlists are swept BY NAME after every test, pass or fail: iCloud
  // sync reassigns a fresh playlist's persistent ID (and can resurrect a
  // just-deleted one), so creation-time IDs are unreliable for cleanup. The
  // sweep also collects resurrected copies left by earlier runs.
  const SCRATCH_NAMES = ['Selecta Integration Scratch', 'Selecta Integration Preview Scratch'];
  afterEach(async () => {
    for (const name of SCRATCH_NAMES) {
      await deletePlaylistsByName(name);
    }
  });

  // Two track entries sourced from the fixture playlist. If it holds a single
  // track, use it twice — Music.app allows duplicate entries, and the write
  // paths must preserve them.
  async function testTrackIds(): Promise<string[]> {
    const id = await findPlaylistByName('Selecta Test');
    expect(
      id,
      'Create a playlist named "Selecta Test" in Music.app before running integration tests.',
    ).toBeTruthy();
    const playlist = await bridge.readPlaylist(id!);
    const ids = playlist.trackPersistentIds;
    expect(ids.length).toBeGreaterThan(0);
    return ids.length >= 2 ? ids.slice(0, 2) : [ids[0]!, ids[0]!];
  }

  it('createPlaylist materializes tracks in order and sets the description', async () => {
    const trackIds = await testTrackIds();
    const result = await bridge.createPlaylist({
      name: 'Selecta Integration Scratch',
      trackIds,
      description: 'created by integration test — safe to delete',
    });

    expect(result.trackCount).toBe(2);
    // Immediate readback by the creation-time ID is fine; the iCloud ID
    // reassignment lands later.
    const readBack = await bridge.readPlaylist(result.persistentId);
    expect(readBack.trackPersistentIds).toEqual(trackIds);
    expect(readBack.kind).toBe('user');
  }, 60_000);

  it('replacePlaylist reuses the slot by name: one playlist, contents replaced', async () => {
    const trackIds = await testTrackIds();
    const name = 'Selecta Integration Preview Scratch';

    const first = await bridge.replacePlaylist({ name, trackIds });
    expect(first.trackCount).toBe(2);

    const second = await bridge.replacePlaylist({ name, trackIds: trackIds.slice(0, 1) });
    expect(second.trackCount).toBe(1);

    const readBack = await bridge.readPlaylist(second.persistentId);
    expect(readBack.trackPersistentIds).toEqual(trackIds.slice(0, 1));
    // The real slot invariant: overwriting never creates a second playlist.
    // (Persistent-ID equality across calls is NOT asserted — iCloud sync may
    // reassign a fresh playlist's ID between calls.)
    const dupCheck = await bridge.readLibrary();
    expect(dupCheck.playlists.filter((p) => p.name === name)).toHaveLength(1);
  }, 120_000);

  it('rejects unknown track IDs with track_not_found before writing', async () => {
    await expect(
      bridge.createPlaylist({ name: 'Selecta Should Not Exist', trackIds: ['NOT-A-REAL-ID'] }),
    ).rejects.toMatchObject({ errorCode: 'track_not_found' });
    const leftover = await findPlaylistByName('Selecta Should Not Exist');
    expect(leftover).toBeNull();
  }, 60_000);
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
