// Write-side tool handlers: bridge mocked, cache real (in-memory, production
// write path). Asserts the surgical cache patch and the no-write-on-bad-input
// guarantees.

import { describe, it, expect, vi } from 'vitest';
import { SelectaCache } from '../src/cache/index.js';
import {
  handleCreatePlaylist,
  type CreatePlaylistOutput,
} from '../src/tools/create_playlist.js';
import {
  handlePreviewPlaylist,
  PREVIEW_PLAYLIST_NAME,
  type PreviewPlaylistOutput,
} from '../src/tools/preview_playlist.js';
import { handleGetTrackContext, type TrackContextOutput } from '../src/tools/get_track_context.js';
import type { ToolDeps } from '../src/tools/common.js';
import type { Bridge, LibrarySnapshot } from '../src/types/bridge.js';
import { BridgeError } from '../src/types/errors.js';
import { asError, makeBridge } from './helpers.js';
import fixture from './fixtures/library.json' with { type: 'json' };

const snapshot = fixture as LibrarySnapshot;

function makeDeps(bridgeOverrides: Partial<Bridge> = {}): ToolDeps & { cacheInstance: SelectaCache } {
  const cache = SelectaCache.open(':memory:');
  cache.refreshFromSnapshot(snapshot, { durationMs: 1 });
  const bridge = makeBridge({
    createPlaylist: vi
      .fn()
      .mockImplementation(async (input: { trackIds: string[] }) => ({
        persistentId: 'P-NEW',
        trackCount: input.trackIds.length,
      })),
    clonePlaylist: vi.fn().mockResolvedValue({
      persistentId: 'P-CLONE',
      trackCount: 3,
      sourcePersistentId: 'P-LATENIGHT',
      sourceName: 'Late Night',
      sourceTrackPersistentIds: ['T-ROADS', 'T-TEARDROP', 'T-GLORYBOX'],
    }),
    replacePlaylist: vi
      .fn()
      .mockImplementation(async (input: { trackIds: string[] }) => ({
        persistentId: 'P-PREVIEW',
        trackCount: input.trackIds.length,
      })),
    deletePlaylistById: vi.fn().mockResolvedValue(1),
    ...bridgeOverrides,
  });
  return { cache: () => cache, bridge, cacheInstance: cache };
}

describe('create_playlist', () => {
  it('creates via the bridge and patches the cache surgically', async () => {
    const deps = makeDeps();
    const out = (await handleCreatePlaylist(
      { name: 'late night teardrop', track_ids: ['T-TEARDROP', 'T-ROADS'], description: 'd' },
      deps,
    )) as CreatePlaylistOutput;

    expect(out).toEqual({ playlist_id: 'P-NEW', name: 'late night teardrop', track_count: 2 });
    expect(deps.bridge.createPlaylist).toHaveBeenCalledWith({
      name: 'late night teardrop',
      trackIds: ['T-TEARDROP', 'T-ROADS'],
      description: 'd',
    });

    // Cache patched: playlist visible, membership ordered, counted as a user
    // playlist in co-occurrence — without any readLibrary call.
    const row = deps.cacheInstance.listPlaylists({ nameQuery: 'late night teardrop' })[0]!;
    expect(row.kind).toBe('user');
    expect(row.trackCount).toBe(2);
    const ctx = (await handleGetTrackContext({ track_id: 'T-ROADS' }, deps)) as TrackContextOutput;
    const cooc = ctx.co_occurring_tracks.find((t) => t.persistent_id === 'T-TEARDROP');
    expect(cooc!.shared_playlist_count).toBe(2); // Late Night + the new one
    expect(deps.bridge.readLibrary).not.toHaveBeenCalled();
  });

  it('records a creation receipt for refresh-time echo reconciliation', async () => {
    const deps = makeDeps();
    await handleCreatePlaylist({ name: 'Rearview', track_ids: ['T-TEARDROP'] }, deps);
    expect(deps.cacheInstance.getRecentCreationNames(60)).toContain('Rearview');
  });

  it('clones a live source snapshot without resending track IDs', async () => {
    const deps = makeDeps();
    const out = (await handleCreatePlaylist(
      {
        name: 'Approved Sequence',
        source_playlist_id: 'P-LATENIGHT',
        description: 'auditioned first',
      },
      deps,
    )) as CreatePlaylistOutput;

    expect(deps.bridge.clonePlaylist).toHaveBeenCalledWith({
      name: 'Approved Sequence',
      sourcePlaylistId: 'P-LATENIGHT',
      description: 'auditioned first',
    });
    expect(deps.bridge.createPlaylist).not.toHaveBeenCalled();
    expect(out).toEqual({
      playlist_id: 'P-CLONE',
      name: 'Approved Sequence',
      track_count: 3,
      source: {
        playlist_id: 'P-LATENIGHT',
        name: 'Late Night',
        track_count: 3,
      },
    });
    // The bridge's live snapshot wins over the source order in the cache.
    expect(deps.cacheInstance.getPlaylistTrackIds('P-CLONE')).toEqual([
      'T-ROADS',
      'T-TEARDROP',
      'T-GLORYBOX',
    ]);
    expect(deps.cacheInstance.getRecentCreationNames(60)).toContain('Approved Sequence');
  });

  it('requires exactly one of track_ids or source_playlist_id', async () => {
    const deps = makeDeps();

    for (const input of [
      { name: 'Neither' },
      { name: 'Both', track_ids: ['T-TEARDROP'], source_playlist_id: 'P-LATENIGHT' },
    ]) {
      const err = asError(await handleCreatePlaylist(input, deps));
      expect(err.error).toBe('validation_error');
      expect(err.hint).toContain('exactly one');
    }
    expect(deps.bridge.createPlaylist).not.toHaveBeenCalled();
    expect(deps.bridge.clonePlaylist).not.toHaveBeenCalled();
  });

  it('rejects an unknown source before any bridge call', async () => {
    const deps = makeDeps();
    const err = asError(
      await handleCreatePlaylist({ name: 'x', source_playlist_id: 'P-NOPE' }, deps),
    );
    expect(err.error).toBe('playlist_not_found');
    expect(err.hint).toContain('P-NOPE');
    expect(deps.bridge.clonePlaylist).not.toHaveBeenCalled();
  });

  it('propagates an unreadable live source without patching the cache', async () => {
    const deps = makeDeps({
      clonePlaylist: vi
        .fn()
        .mockRejectedValue(new BridgeError('playlist_not_found', 'gone live', 'stale source')),
    });
    const err = asError(
      await handleCreatePlaylist(
        { name: 'Should Not Exist', source_playlist_id: 'P-LATENIGHT' },
        deps,
      ),
    );
    expect(err.error).toBe('playlist_not_found');
    expect(deps.cacheInstance.listPlaylists({ nameQuery: 'Should Not Exist' })).toEqual([]);
  });

  it('rejects unknown track IDs before any bridge call', async () => {
    const deps = makeDeps();
    const err = asError(
      await handleCreatePlaylist({ name: 'x', track_ids: ['T-TEARDROP', 'T-FAKE'] }, deps),
    );
    expect(err.error).toBe('track_not_found');
    expect(err.hint).toContain('T-FAKE');
    expect(deps.bridge.createPlaylist).not.toHaveBeenCalled();
  });

  it('rejects an empty track list as validation_error', async () => {
    const deps = makeDeps();
    const err = asError(await handleCreatePlaylist({ name: 'x', track_ids: [] }, deps));
    expect(err.error).toBe('validation_error');
  });

  it('propagates a stale-cache bridge failure without patching the cache', async () => {
    const deps = makeDeps({
      createPlaylist: vi
        .fn()
        .mockRejectedValue(new BridgeError('track_not_found', 'missing live', 'stale')),
    });
    const err = asError(
      await handleCreatePlaylist({ name: 'x', track_ids: ['T-TEARDROP'] }, deps),
    );
    expect(err.error).toBe('track_not_found');
    expect(deps.cacheInstance.listPlaylists({ nameQuery: 'x' })).toEqual([]);
  });
});

describe('preview_playlist', () => {
  it('overwrites the dedicated preview slot and patches the cache', async () => {
    const deps = makeDeps();
    const out = (await handlePreviewPlaylist(
      { track_ids: ['T-GLORYBOX', 'T-MIDNIGHT'] },
      deps,
    )) as PreviewPlaylistOutput;
    expect(out).toEqual({ playlist_id: 'P-PREVIEW', track_count: 2 });
    expect(deps.bridge.replacePlaylist).toHaveBeenCalledWith({
      name: PREVIEW_PLAYLIST_NAME,
      trackIds: ['T-GLORYBOX', 'T-MIDNIGHT'],
    });

    // Second preview replaces the membership of the SAME cached playlist.
    await handlePreviewPlaylist({ track_ids: ['T-ANGEL'] }, deps);
    const rows = deps.cacheInstance.listPlaylists({ nameQuery: PREVIEW_PLAYLIST_NAME });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.trackCount).toBe(1);
  });

  it('maps a not-running bridge failure to the envelope', async () => {
    const deps = makeDeps({
      replacePlaylist: vi
        .fn()
        .mockRejectedValue(new BridgeError('music_app_not_running', 'down')),
    });
    const err = asError(await handlePreviewPlaylist({ track_ids: ['T-ANGEL'] }, deps));
    expect(err.error).toBe('music_app_not_running');
    expect(err.hint).toContain('open it');
  });
});
