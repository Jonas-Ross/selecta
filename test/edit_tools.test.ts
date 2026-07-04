// Playlist-mutation tool handlers (add_tracks / remove_tracks /
// reorder_tracks / delete_playlist): bridge mocked, cache real (in-memory,
// production write path). Asserts the surgical cache patch from the bridge's
// result and the no-write-on-bad-input guarantees.

import { describe, it, expect, vi } from 'vitest';
import { SelectaCache } from '../src/cache/index.js';
import { handleAddTracks, type AddTracksOutput } from '../src/tools/add_tracks.js';
import { handleRemoveTracks, type RemoveTracksOutput } from '../src/tools/remove_tracks.js';
import { handleReorderTracks, type ReorderTracksOutput } from '../src/tools/reorder_tracks.js';
import { handleDeletePlaylist, type DeletePlaylistOutput } from '../src/tools/delete_playlist.js';
import type { ToolDeps } from '../src/tools/common.js';
import type { Bridge, LibrarySnapshot, PlaylistEditResult } from '../src/types/bridge.js';
import { BridgeError } from '../src/types/errors.js';
import { asError, makeBridge } from './helpers.js';
import fixture from './fixtures/library.json' with { type: 'json' };

const snapshot = fixture as LibrarySnapshot;

// P-TRIPHOP (user): [T-TEARDROP, T-ANGEL, T-GLORYBOX]; P-RECENT is smart.

function makeDeps(
  bridgeOverrides: Partial<Bridge> = {},
): ToolDeps & { cacheInstance: SelectaCache } {
  const cache = SelectaCache.open(':memory:');
  cache.refreshFromSnapshot(snapshot, { durationMs: 1 });
  return { cache: () => cache, bridge: makeBridge(bridgeOverrides), cacheInstance: cache };
}

function editResult(
  ids: string[],
  extra: Pick<PlaylistEditResult, 'removedCount' | 'movedCount'> = {},
): PlaylistEditResult {
  return {
    persistentId: 'P-TRIPHOP',
    trackCount: ids.length,
    trackPersistentIds: ids,
    preEditTrackPersistentIds: ['T-TEARDROP', 'T-ANGEL', 'T-GLORYBOX'],
    ...extra,
  };
}

describe('add_tracks', () => {
  it('appends via the bridge and patches the cache from the post-edit order', async () => {
    const finalIds = ['T-TEARDROP', 'T-ANGEL', 'T-GLORYBOX', 'T-ROADS', 'T-MIDNIGHT'];
    const deps = makeDeps({
      addPlaylistTracks: vi.fn().mockResolvedValue(editResult(finalIds)),
    });
    const out = (await handleAddTracks(
      { playlist_id: 'P-TRIPHOP', track_ids: ['T-ROADS', 'T-MIDNIGHT'] },
      deps,
    )) as AddTracksOutput;

    expect(out).toEqual({ playlist_id: 'P-TRIPHOP', name: 'Trip Hop Essentials', track_count: 5 });
    expect(deps.bridge.addPlaylistTracks).toHaveBeenCalledWith({
      playlistId: 'P-TRIPHOP',
      trackIds: ['T-ROADS', 'T-MIDNIGHT'],
      position: undefined,
    });
    expect(deps.cacheInstance.getPlaylistTrackIds('P-TRIPHOP')).toEqual(finalIds);
    expect(deps.bridge.readLibrary).not.toHaveBeenCalled();
  });

  it('passes a positional insert through and stores the bridge order verbatim', async () => {
    // Bridge is the ground truth — even if it reports an order the tool
    // wouldn't have predicted, the cache must store what Music.app has.
    const finalIds = ['T-TEARDROP', 'T-ROADS', 'T-ANGEL', 'T-GLORYBOX'];
    const deps = makeDeps({
      addPlaylistTracks: vi.fn().mockResolvedValue(editResult(finalIds)),
    });
    const out = (await handleAddTracks(
      { playlist_id: 'P-TRIPHOP', track_ids: ['T-ROADS'], position: 1 },
      deps,
    )) as AddTracksOutput;

    expect(out.track_count).toBe(4);
    expect(deps.bridge.addPlaylistTracks).toHaveBeenCalledWith({
      playlistId: 'P-TRIPHOP',
      trackIds: ['T-ROADS'],
      position: 1,
    });
    expect(deps.cacheInstance.getPlaylistTrackIds('P-TRIPHOP')).toEqual(finalIds);
  });

  it('rejects an unknown playlist before any bridge call', async () => {
    const deps = makeDeps();
    const err = asError(
      await handleAddTracks({ playlist_id: 'P-NOPE', track_ids: ['T-ROADS'] }, deps),
    );
    expect(err.error).toBe('playlist_not_found');
    expect(err.hint).toContain('P-NOPE');
    expect(deps.bridge.addPlaylistTracks).not.toHaveBeenCalled();
  });

  it('rejects a smart playlist as playlist_not_editable', async () => {
    const deps = makeDeps();
    const err = asError(
      await handleAddTracks({ playlist_id: 'P-RECENT', track_ids: ['T-ROADS'] }, deps),
    );
    expect(err.error).toBe('playlist_not_editable');
    expect(err.hint).toContain('smart');
    expect(deps.bridge.addPlaylistTracks).not.toHaveBeenCalled();
  });

  it('rejects unknown track IDs before any bridge call', async () => {
    const deps = makeDeps();
    const err = asError(
      await handleAddTracks({ playlist_id: 'P-TRIPHOP', track_ids: ['T-FAKE'] }, deps),
    );
    expect(err.error).toBe('track_not_found');
    expect(err.hint).toContain('T-FAKE');
    expect(deps.bridge.addPlaylistTracks).not.toHaveBeenCalled();
  });

  it('propagates a bridge failure without patching the cache', async () => {
    const deps = makeDeps({
      addPlaylistTracks: vi
        .fn()
        .mockRejectedValue(new BridgeError('playlist_not_found', 'gone live', 'stale')),
    });
    const err = asError(
      await handleAddTracks({ playlist_id: 'P-TRIPHOP', track_ids: ['T-ROADS'] }, deps),
    );
    expect(err.error).toBe('playlist_not_found');
    expect(deps.cacheInstance.getPlaylistTrackIds('P-TRIPHOP')).toEqual([
      'T-TEARDROP',
      'T-ANGEL',
      'T-GLORYBOX',
    ]);
  });
});

describe('remove_tracks', () => {
  it('removes by track id and patches the cache from the post-edit order', async () => {
    const deps = makeDeps({
      removePlaylistTracks: vi
        .fn()
        .mockResolvedValue(editResult(['T-TEARDROP', 'T-GLORYBOX'], { removedCount: 1 })),
    });
    const out = (await handleRemoveTracks(
      { playlist_id: 'P-TRIPHOP', track_ids: ['T-ANGEL'] },
      deps,
    )) as RemoveTracksOutput;

    expect(out).toEqual({
      playlist_id: 'P-TRIPHOP',
      name: 'Trip Hop Essentials',
      track_count: 2,
      removed_count: 1,
    });
    expect(deps.bridge.removePlaylistTracks).toHaveBeenCalledWith({
      playlistId: 'P-TRIPHOP',
      trackIds: ['T-ANGEL'],
      positions: undefined,
    });
    expect(deps.cacheInstance.getPlaylistTrackIds('P-TRIPHOP')).toEqual([
      'T-TEARDROP',
      'T-GLORYBOX',
    ]);
  });

  it('removes by position', async () => {
    const deps = makeDeps({
      removePlaylistTracks: vi
        .fn()
        .mockResolvedValue(editResult(['T-ANGEL', 'T-GLORYBOX'], { removedCount: 1 })),
    });
    const out = (await handleRemoveTracks(
      { playlist_id: 'P-TRIPHOP', positions: [0] },
      deps,
    )) as RemoveTracksOutput;
    expect(out.removed_count).toBe(1);
    expect(deps.cacheInstance.getPlaylistTrackIds('P-TRIPHOP')).toEqual([
      'T-ANGEL',
      'T-GLORYBOX',
    ]);
  });

  it('requires track_ids and/or positions', async () => {
    const deps = makeDeps();
    expect(asError(await handleRemoveTracks({ playlist_id: 'P-TRIPHOP' }, deps)).error).toBe(
      'validation_error',
    );
    expect(
      asError(
        await handleRemoveTracks({ playlist_id: 'P-TRIPHOP', track_ids: [], positions: [] }, deps),
      ).error,
    ).toBe('validation_error');
    expect(deps.bridge.removePlaylistTracks).not.toHaveBeenCalled();
  });

  it('rejects tracks that are not in the playlist before any bridge call', async () => {
    const deps = makeDeps();
    // T-MIDNIGHT exists in the library but not in P-TRIPHOP.
    const err = asError(
      await handleRemoveTracks({ playlist_id: 'P-TRIPHOP', track_ids: ['T-MIDNIGHT'] }, deps),
    );
    expect(err.error).toBe('track_not_found');
    expect(err.hint).toContain('Trip Hop Essentials');
    expect(deps.bridge.removePlaylistTracks).not.toHaveBeenCalled();
  });

  it('rejects out-of-range positions before any bridge call', async () => {
    const deps = makeDeps();
    const err = asError(
      await handleRemoveTracks({ playlist_id: 'P-TRIPHOP', positions: [3] }, deps),
    );
    expect(err.error).toBe('validation_error');
    expect(err.hint).toContain('3');
    expect(deps.bridge.removePlaylistTracks).not.toHaveBeenCalled();
  });

  it('rejects a non-user playlist as playlist_not_editable', async () => {
    const deps = makeDeps();
    const err = asError(
      await handleRemoveTracks({ playlist_id: 'P-MOODS', positions: [0] }, deps),
    );
    expect(err.error).toBe('playlist_not_editable');
    expect(deps.bridge.removePlaylistTracks).not.toHaveBeenCalled();
  });

  it('propagates a stale-cache bridge failure without patching the cache', async () => {
    const deps = makeDeps({
      removePlaylistTracks: vi
        .fn()
        .mockRejectedValue(new BridgeError('track_not_found', 'no live occurrence')),
    });
    const err = asError(
      await handleRemoveTracks({ playlist_id: 'P-TRIPHOP', track_ids: ['T-ANGEL'] }, deps),
    );
    expect(err.error).toBe('track_not_found');
    expect(deps.cacheInstance.getPlaylistTrackIds('P-TRIPHOP')).toEqual([
      'T-TEARDROP',
      'T-ANGEL',
      'T-GLORYBOX',
    ]);
  });
});

describe('reorder_tracks', () => {
  it('reorders via the bridge and patches the cache from the post-edit order', async () => {
    const permuted = ['T-GLORYBOX', 'T-TEARDROP', 'T-ANGEL'];
    const deps = makeDeps({
      reorderPlaylistTracks: vi.fn().mockResolvedValue(editResult(permuted, { movedCount: 3 })),
    });
    const out = (await handleReorderTracks(
      { playlist_id: 'P-TRIPHOP', order: [2, 0, 1] },
      deps,
    )) as ReorderTracksOutput;

    expect(out).toEqual({
      playlist_id: 'P-TRIPHOP',
      name: 'Trip Hop Essentials',
      track_count: 3,
      moved_count: 3,
    });
    expect(deps.bridge.reorderPlaylistTracks).toHaveBeenCalledWith({
      playlistId: 'P-TRIPHOP',
      order: [2, 0, 1],
      expectedTrackIds: ['T-TEARDROP', 'T-ANGEL', 'T-GLORYBOX'],
    });
    expect(deps.cacheInstance.getPlaylistTrackIds('P-TRIPHOP')).toEqual(permuted);
  });

  it('rejects an order whose length does not match the cached track count', async () => {
    const deps = makeDeps();
    const err = asError(
      await handleReorderTracks({ playlist_id: 'P-TRIPHOP', order: [0, 1] }, deps),
    );
    expect(err.error).toBe('validation_error');
    expect(err.hint).toContain('2');
    expect(err.hint).toContain('3');
    expect(err.hint).toContain('Trip Hop Essentials');
    expect(deps.bridge.reorderPlaylistTracks).not.toHaveBeenCalled();
  });

  it('rejects a non-permutation with a duplicated index', async () => {
    const deps = makeDeps();
    const err = asError(
      await handleReorderTracks({ playlist_id: 'P-TRIPHOP', order: [0, 0, 1] }, deps),
    );
    expect(err.error).toBe('validation_error');
    expect(err.hint).toContain('duplicated: 0');
    expect(deps.bridge.reorderPlaylistTracks).not.toHaveBeenCalled();
  });

  it('names duplicate playlist entries on a count mismatch instead of blaming the cache', async () => {
    // search shows one row per distinct track, so a model following the
    // advertised workflow sends a 2-entry order for this 3-entry playlist —
    // the hint must name the real problem, not send it to refresh_library.
    const deps = makeDeps();
    deps.cacheInstance.patchPlaylistMembership('P-TRIPHOP', [
      'T-TEARDROP',
      'T-ANGEL',
      'T-TEARDROP',
    ]);
    const err = asError(
      await handleReorderTracks({ playlist_id: 'P-TRIPHOP', order: [0, 1] }, deps),
    );
    expect(err.error).toBe('validation_error');
    expect(err.hint).toContain('3 entries, 2 distinct tracks');
    expect(err.hint).not.toContain('refresh_library');
    expect(deps.bridge.reorderPlaylistTracks).not.toHaveBeenCalled();
  });

  it('rejects a non-permutation with an out-of-range index', async () => {
    const deps = makeDeps();
    const err = asError(
      await handleReorderTracks({ playlist_id: 'P-TRIPHOP', order: [0, 1, 3] }, deps),
    );
    expect(err.error).toBe('validation_error');
    expect(err.hint).toContain('3');
    expect(deps.bridge.reorderPlaylistTracks).not.toHaveBeenCalled();
  });

  it('rejects an unknown playlist before any bridge call', async () => {
    const deps = makeDeps();
    const err = asError(
      await handleReorderTracks({ playlist_id: 'P-NOPE', order: [0] }, deps),
    );
    expect(err.error).toBe('playlist_not_found');
    expect(err.hint).toContain('P-NOPE');
    expect(deps.bridge.reorderPlaylistTracks).not.toHaveBeenCalled();
  });

  it('rejects a smart playlist as playlist_not_editable', async () => {
    const deps = makeDeps();
    const err = asError(
      await handleReorderTracks({ playlist_id: 'P-RECENT', order: [0] }, deps),
    );
    expect(err.error).toBe('playlist_not_editable');
    expect(deps.bridge.reorderPlaylistTracks).not.toHaveBeenCalled();
  });

  it('still calls the bridge for an identity permutation, so the drift guard runs', async () => {
    const identity = ['T-TEARDROP', 'T-ANGEL', 'T-GLORYBOX'];
    const deps = makeDeps({
      reorderPlaylistTracks: vi.fn().mockResolvedValue(editResult(identity, { movedCount: 0 })),
    });
    const out = (await handleReorderTracks(
      { playlist_id: 'P-TRIPHOP', order: [0, 1, 2] },
      deps,
    )) as ReorderTracksOutput;

    expect(deps.bridge.reorderPlaylistTracks).toHaveBeenCalledWith({
      playlistId: 'P-TRIPHOP',
      order: [0, 1, 2],
      expectedTrackIds: identity,
    });
    expect(out.moved_count).toBe(0);
  });

  it('propagates a bridge drift rejection without patching the cache', async () => {
    const deps = makeDeps({
      reorderPlaylistTracks: vi
        .fn()
        .mockRejectedValue(new BridgeError('validation_error', 'live order drifted')),
    });
    const err = asError(
      await handleReorderTracks({ playlist_id: 'P-TRIPHOP', order: [2, 0, 1] }, deps),
    );
    expect(err.error).toBe('validation_error');
    expect(deps.cacheInstance.getPlaylistTrackIds('P-TRIPHOP')).toEqual([
      'T-TEARDROP',
      'T-ANGEL',
      'T-GLORYBOX',
    ]);
  });
});

describe('delete_playlist', () => {
  it('deletes via the bridge and drops the playlist cache rows, keeping the tracks', async () => {
    const deps = makeDeps({ deletePlaylistById: vi.fn().mockResolvedValue(1) });

    const out = (await handleDeletePlaylist(
      { playlist_id: 'P-TRIPHOP' },
      deps,
    )) as DeletePlaylistOutput;

    expect(deps.bridge.deletePlaylistById).toHaveBeenCalledWith('P-TRIPHOP');
    expect(out).toEqual({
      playlist_id: 'P-TRIPHOP',
      name: 'Trip Hop Essentials',
      deleted: true,
      track_count: 3,
    });
    expect(deps.cacheInstance.getPlaylist('P-TRIPHOP')).toBeNull();
    expect(deps.cacheInstance.getPlaylistTrackIds('P-TRIPHOP')).toEqual([]);
    // The tracks and the other playlists survive — deletion is playlist-only.
    expect(deps.cacheInstance.getTrack('T-TEARDROP')).not.toBeNull();
    expect(deps.cacheInstance.getPlaylist('P-LATENIGHT')).not.toBeNull();
  });

  it('rejects an unknown playlist before any bridge call', async () => {
    const deps = makeDeps();
    const err = asError(await handleDeletePlaylist({ playlist_id: 'P-NOPE' }, deps));
    expect(err.error).toBe('playlist_not_found');
    expect(deps.bridge.deletePlaylistById).not.toHaveBeenCalled();
  });

  it('rejects a smart playlist as playlist_not_editable before any bridge call', async () => {
    const deps = makeDeps();
    const err = asError(await handleDeletePlaylist({ playlist_id: 'P-RECENT' }, deps));
    expect(err.error).toBe('playlist_not_editable');
    expect(deps.bridge.deletePlaylistById).not.toHaveBeenCalled();
  });

  it('maps a live miss (deleted: 0) to playlist_not_found and keeps the cache row', async () => {
    const deps = makeDeps({ deletePlaylistById: vi.fn().mockResolvedValue(0) });
    const err = asError(await handleDeletePlaylist({ playlist_id: 'P-TRIPHOP' }, deps));
    expect(err.error).toBe('playlist_not_found');
    expect(err.hint).toContain('refresh_library');
    expect(deps.cacheInstance.getPlaylist('P-TRIPHOP')).not.toBeNull();
  });

  it('propagates a bridge failure without touching the cache', async () => {
    const deps = makeDeps({
      deletePlaylistById: vi
        .fn()
        .mockRejectedValue(new BridgeError('playlist_not_editable', 'not a user playlist')),
    });
    const err = asError(await handleDeletePlaylist({ playlist_id: 'P-TRIPHOP' }, deps));
    expect(err.error).toBe('playlist_not_editable');
    expect(deps.cacheInstance.getPlaylist('P-TRIPHOP')).not.toBeNull();
  });
});
