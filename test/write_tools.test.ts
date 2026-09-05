// Write-side tool handlers: bridge mocked, cache real (in-memory, production
// write path). Asserts the surgical cache patch and the no-write-on-bad-input
// guarantees.

import { describe, it, expect, vi } from 'vitest';
import { SelectaCache } from '../src/cache/index.js';
import { handleCreatePlaylist, type CreatePlaylistOutput } from '../src/tools/create_playlist.js';
import {
  handlePreviewPlaylist,
  PREVIEW_PLAYLIST_NAME,
  type PreviewPlaylistOutput,
} from '../src/tools/preview_playlist.js';
import { handleGetTrackContext, type TrackContextOutput } from '../src/tools/get_track_context.js';
import type { ToolDeps } from '../src/tools/common.js';
import {
  PLAYLIST_WRITE_TRACK_LIMIT,
  type Bridge,
  type LibrarySnapshot,
  type RawPlaylist,
} from '../src/types/bridge.js';
import { BridgeError } from '../src/types/errors.js';
import { asError, makeBridge } from './helpers.js';
import fixture from './fixtures/library.json' with { type: 'json' };

const snapshot = fixture as LibrarySnapshot;

function makeDeps(
  bridgeOverrides: Partial<Bridge> = {},
  library: LibrarySnapshot = snapshot,
): ToolDeps & { cacheInstance: SelectaCache } {
  const cache = SelectaCache.open(':memory:');
  cache.refreshFromSnapshot(library, { durationMs: 1 });
  let replaceCalls = 0;
  const bridge = makeBridge({
    createPlaylist: vi.fn().mockImplementation(async (input: { trackIds: string[] }) => ({
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
    // The slot is created on the first call and found by name after that —
    // the same distinction the live script reports.
    replacePlaylist: vi.fn().mockImplementation(async (input: { trackIds: string[] }) => ({
      persistentId: 'P-PREVIEW',
      trackCount: input.trackIds.length,
      created: ++replaceCalls === 1,
    })),
    deletePlaylistById: vi.fn().mockResolvedValue(1),
    ...bridgeOverrides,
  });
  return { cache: () => cache, bridge, cacheInstance: cache };
}

function withSourcePlaylist(source: RawPlaylist): LibrarySnapshot {
  return {
    ...snapshot,
    playlists: [
      ...snapshot.playlists.filter((p) => p.persistentId !== source.persistentId),
      source,
    ],
  };
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

  it.each([
    ['smart', 'Generated Mix'],
    ['subscription', 'Apple Music Mix'],
    ['special', 'Generated Station'],
    ['folder', 'Folder'],
  ] as const)('rejects a cached %s source before any bridge call', async (kind, sourceName) => {
    const sourceId = `P-${kind.toUpperCase()}`;
    const deps = makeDeps(
      {},
      withSourcePlaylist({
        persistentId: sourceId,
        name: sourceName,
        kind,
        trackPersistentIds: ['T-TEARDROP'],
      }),
    );

    const err = asError(
      await handleCreatePlaylist({ name: 'x', source_playlist_id: sourceId }, deps),
    );
    expect(err.error).toBe('playlist_not_editable');
    expect(err.hint).toContain(kind);
    expect(deps.bridge.clonePlaylist).not.toHaveBeenCalled();
  });

  it('rejects an empty cached user source before any bridge call', async () => {
    const deps = makeDeps(
      {},
      withSourcePlaylist({
        persistentId: 'P-EMPTY',
        name: 'Empty Draft',
        kind: 'user',
        trackPersistentIds: [],
      }),
    );

    const err = asError(
      await handleCreatePlaylist({ name: 'x', source_playlist_id: 'P-EMPTY' }, deps),
    );
    expect(err.error).toBe('validation_error');
    expect(err.hint).toContain('empty');
    expect(deps.bridge.clonePlaylist).not.toHaveBeenCalled();
  });

  it(`accepts a cached user source at the ${PLAYLIST_WRITE_TRACK_LIMIT}-entry limit`, async () => {
    const trackIds = Array<string>(PLAYLIST_WRITE_TRACK_LIMIT).fill('T-TEARDROP');
    const deps = makeDeps(
      {
        clonePlaylist: vi.fn().mockResolvedValue({
          persistentId: 'P-LIMIT-CLONE',
          trackCount: trackIds.length,
          sourcePersistentId: 'P-LIMIT',
          sourceName: 'At Limit',
          sourceTrackPersistentIds: trackIds,
        }),
      },
      withSourcePlaylist({
        persistentId: 'P-LIMIT',
        name: 'At Limit',
        kind: 'user',
        trackPersistentIds: trackIds,
      }),
    );

    const out = (await handleCreatePlaylist(
      { name: 'Limit Clone', source_playlist_id: 'P-LIMIT' },
      deps,
    )) as CreatePlaylistOutput;
    expect(out.track_count).toBe(PLAYLIST_WRITE_TRACK_LIMIT);
    expect(deps.bridge.clonePlaylist).toHaveBeenCalledOnce();
  });

  it(`rejects a cached source above ${PLAYLIST_WRITE_TRACK_LIMIT} entries`, async () => {
    const trackIds = Array<string>(PLAYLIST_WRITE_TRACK_LIMIT + 1).fill('T-TEARDROP');
    const deps = makeDeps(
      {},
      withSourcePlaylist({
        persistentId: 'P-TOO-LARGE',
        name: 'Too Large',
        kind: 'user',
        trackPersistentIds: trackIds,
      }),
    );

    const err = asError(
      await handleCreatePlaylist({ name: 'x', source_playlist_id: 'P-TOO-LARGE' }, deps),
    );
    expect(err.error).toBe('validation_error');
    expect(err.hint).toContain(String(PLAYLIST_WRITE_TRACK_LIMIT));
    expect(deps.bridge.clonePlaylist).not.toHaveBeenCalled();
  });

  // Reserved preview slot (#44): the first-ever preview is a fresh playlist,
  // so iCloud may rekey its ID while the user auditions. The receipt ID must
  // keep cloning the LIVE slot; arbitrary IDs stay strictly ID-based.
  describe('reserved preview source across an iCloud rekey', () => {
    const LIVE_ORDER = ['T-MIDNIGHT', 'T-GLORYBOX']; // user reordered while auditioning

    // The bridge as Music.app would answer after the rekey: the preview's
    // creation-time ID is gone, the slot lives on under P-PREVIEW-2.
    function rekeyedClone() {
      return vi
        .fn()
        .mockImplementation(
          async (input: { sourcePlaylistId: string; reservedSourceName?: string }) => {
            if (
              input.sourcePlaylistId === 'P-PREVIEW-2' ||
              input.reservedSourceName === PREVIEW_PLAYLIST_NAME
            ) {
              return {
                persistentId: 'P-FINAL',
                trackCount: LIVE_ORDER.length,
                sourcePersistentId: 'P-PREVIEW-2',
                sourceName: PREVIEW_PLAYLIST_NAME,
                sourceTrackPersistentIds: LIVE_ORDER,
              };
            }
            throw new BridgeError('playlist_not_found', 'gone live');
          },
        );
    }

    async function depsAfterFirstPreview(clonePlaylist = rekeyedClone()) {
      const deps = makeDeps({ clonePlaylist });
      const preview = (await handlePreviewPlaylist(
        { track_ids: ['T-GLORYBOX', 'T-MIDNIGHT'] },
        deps,
      )) as PreviewPlaylistOutput;
      expect(preview.playlist_id).toBe('P-PREVIEW');
      return deps;
    }

    it('clones the live slot by reserved name when the receipt ID is gone live', async () => {
      const deps = await depsAfterFirstPreview();
      const out = (await handleCreatePlaylist(
        { name: 'Approved', source_playlist_id: 'P-PREVIEW' },
        deps,
      )) as CreatePlaylistOutput;

      expect(deps.bridge.clonePlaylist).toHaveBeenCalledWith({
        name: 'Approved',
        sourcePlaylistId: 'P-PREVIEW',
        reservedSourceName: PREVIEW_PLAYLIST_NAME,
      });
      expect(out).toEqual({
        playlist_id: 'P-FINAL',
        name: 'Approved',
        track_count: 2,
        source: {
          playlist_id: 'P-PREVIEW-2',
          name: PREVIEW_PLAYLIST_NAME,
          track_count: 2,
          rekeyed_from: 'P-PREVIEW',
        },
      });
      // Exact live-order handoff: the destination holds what the user
      // auditioned, not the order the cache remembered from the preview call.
      expect(deps.cacheInstance.getPlaylistTrackIds('P-FINAL')).toEqual(LIVE_ORDER);
    });

    it('aliases the stale ID to the live slot and mirrors the live order', async () => {
      const deps = await depsAfterFirstPreview();
      await handleCreatePlaylist({ name: 'Approved', source_playlist_id: 'P-PREVIEW' }, deps);

      const cache = deps.cacheInstance;
      expect(cache.resolvePlaylistId('P-PREVIEW')).toBe('P-PREVIEW-2');
      const rows = cache.listPlaylists({ nameQuery: PREVIEW_PLAYLIST_NAME });
      expect(rows.map((p) => p.persistentId)).toEqual(['P-PREVIEW-2']);
      expect(cache.getPlaylistTrackIds('P-PREVIEW-2')).toEqual(LIVE_ORDER);
      // The original receipt ID keeps working for reads too.
      const { rows: tracks } = cache.searchTracks({ inPlaylist: 'P-PREVIEW' });
      expect(tracks.map((t) => t.persistentId).sort()).toEqual([...LIVE_ORDER].sort());
    });

    it('still resolves the receipt ID after a refresh pruned the stale row', async () => {
      const deps = await depsAfterFirstPreview();
      // A refresh that saw the rekeyed slot with a different sequence: the
      // exact-sequence reconciler stands down, the stale row is pruned, and
      // only the preview receipt remembers P-PREVIEW.
      deps.cacheInstance.refreshFromSnapshot(
        withSourcePlaylist({
          persistentId: 'P-PREVIEW-2',
          name: PREVIEW_PLAYLIST_NAME,
          kind: 'user',
          trackPersistentIds: LIVE_ORDER,
        }),
        { durationMs: 1 },
      );
      expect(deps.cacheInstance.getPlaylist('P-PREVIEW')).toBeNull();

      const out = (await handleCreatePlaylist(
        { name: 'Approved', source_playlist_id: 'P-PREVIEW' },
        deps,
      )) as CreatePlaylistOutput;
      expect(out.source).toMatchObject({ playlist_id: 'P-PREVIEW-2', rekeyed_from: 'P-PREVIEW' });
      expect(deps.bridge.clonePlaylist).toHaveBeenCalledWith(
        expect.objectContaining({ reservedSourceName: PREVIEW_PLAYLIST_NAME }),
      );
    });

    it.each([
      ['missing', 'playlist_not_found', 'Call preview_playlist again'],
      ['ambiguous', 'validation_error', 'ambiguous: P-A, P-B'],
    ] as const)('reports a %s slot before anything is created', async (_case, code, hint) => {
      const deps = await depsAfterFirstPreview(
        vi.fn().mockRejectedValue(new BridgeError(code, 'refused live', hint)),
      );
      const err = asError(
        await handleCreatePlaylist({ name: 'Approved', source_playlist_id: 'P-PREVIEW' }, deps),
      );
      expect(err).toEqual({ error: code, hint });
      expect(deps.cacheInstance.listPlaylists({ nameQuery: 'Approved' })).toEqual([]);
      // No hidden aliasing on failure: the cache still says what it said.
      expect(deps.cacheInstance.resolvePlaylistId('P-PREVIEW')).toBe('P-PREVIEW');
    });

    it('reports diverged twins as ambiguous instead of cloning the untouched one', async () => {
      // iCloud twinned the first-ever preview under two new IDs; the user
      // reordered only the copy they auditioned (P-AUDITIONED). The receipt
      // must not alias to the untouched twin, so the clone reaches the name
      // path and refuses with both IDs.
      const twins: Record<string, string[]> = {
        'P-TWIN': ['T-GLORYBOX', 'T-MIDNIGHT'],
        'P-AUDITIONED': LIVE_ORDER,
      };
      const deps = await depsAfterFirstPreview(
        vi
          .fn()
          .mockImplementation(
            async (input: { sourcePlaylistId: string; reservedSourceName?: string }) => {
              const live = twins[input.sourcePlaylistId];
              if (live) {
                return {
                  persistentId: 'P-FINAL',
                  trackCount: live.length,
                  sourcePersistentId: input.sourcePlaylistId,
                  sourceName: PREVIEW_PLAYLIST_NAME,
                  sourceTrackPersistentIds: live,
                };
              }
              if (input.reservedSourceName === PREVIEW_PLAYLIST_NAME) {
                throw new BridgeError(
                  'validation_error',
                  'two copies',
                  'ambiguous: P-TWIN, P-AUDITIONED',
                );
              }
              throw new BridgeError('playlist_not_found', 'gone live');
            },
          ),
      );
      const cache = deps.cacheInstance;
      cache.refreshFromSnapshot(
        {
          ...snapshot,
          playlists: [
            ...snapshot.playlists,
            ...Object.entries(twins).map(([persistentId, trackPersistentIds]) => ({
              persistentId,
              name: PREVIEW_PLAYLIST_NAME,
              kind: 'user' as const,
              trackPersistentIds,
            })),
          ],
        },
        { durationMs: 1 },
      );
      expect(
        cache.planSyncReconciliation({
          windowMinutes: 60,
          reservedSlotNames: [PREVIEW_PLAYLIST_NAME],
        }),
      ).toEqual([
        { kind: 'ambiguous', name: PREVIEW_PLAYLIST_NAME, playlistIds: ['P-AUDITIONED', 'P-TWIN'] },
      ]);
      expect(cache.resolvePlaylistId('P-PREVIEW')).toBe('P-PREVIEW');

      const err = asError(
        await handleCreatePlaylist({ name: 'Approved', source_playlist_id: 'P-PREVIEW' }, deps),
      );
      expect(err.error).toBe('validation_error');
      expect(err.hint).toContain('P-TWIN, P-AUDITIONED');
      expect(deps.bridge.clonePlaylist).toHaveBeenCalledWith(
        expect.objectContaining({
          sourcePlaylistId: 'P-PREVIEW',
          reservedSourceName: PREVIEW_PLAYLIST_NAME,
        }),
      );
      expect(cache.listPlaylists({ nameQuery: 'Approved' })).toEqual([]);
    });

    it('never offers the reserved name for an arbitrary source ID', async () => {
      const deps = makeDeps();
      await handleCreatePlaylist({ name: 'Copy', source_playlist_id: 'P-LATENIGHT' }, deps);
      expect(deps.bridge.clonePlaylist).toHaveBeenCalledWith(
        expect.not.objectContaining({ reservedSourceName: expect.anything() }),
      );
    });

    it('treats a user playlist merely named like the preview as the slot only when cached as user kind', async () => {
      // A smart playlist wearing the reserved name is not the slot.
      const deps = makeDeps(
        {},
        withSourcePlaylist({
          persistentId: 'P-SMART-PREVIEW',
          name: PREVIEW_PLAYLIST_NAME,
          kind: 'smart',
          trackPersistentIds: ['T-TEARDROP'],
        }),
      );
      const err = asError(
        await handleCreatePlaylist({ name: 'x', source_playlist_id: 'P-SMART-PREVIEW' }, deps),
      );
      expect(err.error).toBe('playlist_not_editable');
      expect(deps.bridge.clonePlaylist).not.toHaveBeenCalled();
    });
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
    const err = asError(await handleCreatePlaylist({ name: 'x', track_ids: ['T-TEARDROP'] }, deps));
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

  it('records a creation receipt only when the slot was actually created', async () => {
    const deps = makeDeps();
    await handlePreviewPlaylist({ track_ids: ['T-ANGEL'] }, deps);
    expect(deps.cacheInstance.getCreationName('P-PREVIEW')).toBe(PREVIEW_PLAYLIST_NAME);

    // An overwrite of the existing slot creates nothing — no new receipt, and
    // the first one keeps its original sequence.
    await handlePreviewPlaylist({ track_ids: ['T-GLORYBOX', 'T-MIDNIGHT'] }, deps);
    const receipts = deps.cacheInstance.db
      .prepare('SELECT track_ids_json AS t FROM playlist_creations')
      .all() as { t: string }[];
    expect(receipts).toEqual([{ t: JSON.stringify(['T-ANGEL']) }]);
  });

  it('maps a not-running bridge failure to the envelope', async () => {
    const deps = makeDeps({
      replacePlaylist: vi.fn().mockRejectedValue(new BridgeError('music_app_not_running', 'down')),
    });
    const err = asError(await handlePreviewPlaylist({ track_ids: ['T-ANGEL'] }, deps));
    expect(err.error).toBe('music_app_not_running');
    expect(err.hint).toContain('open it');
  });
});
