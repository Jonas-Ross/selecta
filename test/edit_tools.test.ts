// Playlist-edit tool handlers (add_tracks / remove_tracks): bridge mocked,
// cache real (in-memory, production write path). Asserts the surgical
// membership patch from the bridge's post-edit order and the no-write-on-
// bad-input guarantees.

import { describe, it, expect, vi } from 'vitest';
import { SelectaCache } from '../src/cache/index.js';
import { handleAddTracks, type AddTracksOutput } from '../src/tools/add_tracks.js';
import { handleRemoveTracks, type RemoveTracksOutput } from '../src/tools/remove_tracks.js';
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

function editResult(ids: string[], removedCount?: number): PlaylistEditResult {
  return {
    persistentId: 'P-TRIPHOP',
    trackCount: ids.length,
    trackPersistentIds: ids,
    preEditTrackPersistentIds: ['T-TEARDROP', 'T-ANGEL', 'T-GLORYBOX'],
    ...(removedCount != null ? { removedCount } : {}),
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
        .mockResolvedValue(editResult(['T-TEARDROP', 'T-GLORYBOX'], 1)),
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
        .mockResolvedValue(editResult(['T-ANGEL', 'T-GLORYBOX'], 1)),
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
