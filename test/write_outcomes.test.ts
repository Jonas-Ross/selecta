import { runInNewContext } from 'node:vm';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { bridge } from '../src/bridge/index.js';
import { runJxa } from '../src/bridge/jxa.js';
import {
  buildCreatePlaylistScript,
  buildReplacePlaylistScript,
} from '../src/bridge/scripts/write_playlist.js';
import { handleCreatePlaylist } from '../src/tools/create_playlist.js';
import { handlePreviewPlaylist } from '../src/tools/preview_playlist.js';
import { handleSetLoved } from '../src/tools/set_loved.js';
import { handleSetRating } from '../src/tools/set_rating.js';
import { makeToolDeps } from './helpers.js';

vi.mock('../src/bridge/jxa.js', () => ({ runJxa: vi.fn() }));
afterEach(() => vi.clearAllMocks());
const A = 'T-TEARDROP';
const B = 'T-ROADS';

describe('observed write outcomes', () => {
  it.each(['create', 'preview', 'clone'])(
    'caches observed destination order for %s, including count drift',
    async (mode) => {
      vi.mocked(runJxa).mockResolvedValue({
        persistentId: 'P-NEW',
        trackCount: 3,
        trackPersistentIds: [B, A, A],
        created: true,
        sourcePersistentId: 'P-LATENIGHT',
        sourceName: 'Late Night',
        sourceTrackPersistentIds: [A, B],
      });
      const deps = makeToolDeps(bridge);
      try {
        const result =
          mode === 'preview'
            ? await handlePreviewPlaylist({ track_ids: [A, B] }, deps)
            : await handleCreatePlaylist(
                {
                  name: 'Mix',
                  ...(mode === 'clone'
                    ? { source_playlist_id: 'P-LATENIGHT' }
                    : { track_ids: [A, B] }),
                },
                deps,
              );
        expect(result).toMatchObject({
          playlist_id: 'P-NEW',
          track_count: 3,
          order_matches_request: false,
        });
        expect(deps.cacheInstance.getPlaylistTrackIds('P-NEW')).toEqual([B, A, A]);
        if (mode === 'clone') expect(result).toMatchObject({ source: { track_count: 2 } });
      } finally {
        deps.cacheInstance.close();
      }
    },
  );

  it('keeps a rekeyed clone source separate from a drifted destination', async () => {
    const deps = makeToolDeps(bridge);
    try {
      deps.cacheInstance.upsertPlaylistAfterWrite(
        { persistentId: 'OLD', trackCount: 2 },
        'Selecta Preview',
        [A, B],
      );
      vi.mocked(runJxa).mockResolvedValue({
        persistentId: 'DEST',
        trackCount: 1,
        trackPersistentIds: [B],
        sourcePersistentId: 'SOURCE',
        sourceName: 'Selecta Preview',
        sourceTrackPersistentIds: [A, B],
      });
      const result = await handleCreatePlaylist({ name: 'Mix', source_playlist_id: 'OLD' }, deps);
      expect(result).toMatchObject({
        track_count: 1,
        source: { track_count: 2, rekeyed_from: 'OLD' },
      });
      expect(deps.cacheInstance.getPlaylistTrackIds('SOURCE')).toEqual([A, B]);
      expect(deps.cacheInstance.getPlaylistTrackIds('DEST')).toEqual([B]);
    } finally {
      deps.cacheInstance.close();
    }
  });

  it('reports the observed favorite and rating when Music.app did not retain the request', async () => {
    const deps = makeToolDeps(bridge);
    try {
      vi.mocked(runJxa).mockResolvedValue({
        tracks: [{ persistentId: A, loved: false }],
        preWriteTracks: [{ persistentId: A, loved: false }],
      });
      expect(await handleSetLoved({ track_ids: [A], loved: true }, deps)).toEqual({
        updated: 0,
        loved: true,
        mismatches: [{ track_id: A, loved: false }],
      });
      expect(deps.cacheInstance.getTrack(A)!.loved).toBe(0);
      vi.mocked(runJxa).mockResolvedValue({
        tracks: [{ persistentId: A, rating: 40 }],
        preWriteTracks: [{ persistentId: A, rating: 40 }],
      });
      expect(await handleSetRating({ track_ids: [A], rating: 5 }, deps)).toEqual({
        updated: 0,
        rating: 5,
        mismatches: [{ track_id: A, rating: 2 }],
      });
      expect(deps.cacheInstance.getTrack(A)!.rating).toBe(40);
      vi.mocked(runJxa).mockResolvedValue({
        tracks: [{ persistentId: A, rating: null }],
        preWriteTracks: [{ persistentId: A, rating: 40 }],
      });
      expect(await handleSetRating({ track_ids: [A], rating: 0 }, deps)).toEqual({
        updated: 1,
        rating: 0,
      });
    } finally {
      deps.cacheInstance.close();
    }
  });

  it('rejects a structurally valid but incomplete signal readback', async () => {
    vi.mocked(runJxa).mockResolvedValue({ tracks: [], preWriteTracks: [] });
    await expect(bridge.setTrackLoved({ trackIds: [A], loved: true })).rejects.toMatchObject({
      errorCode: 'jxa_error',
    });
  });

  it.each([true, false])(
    'preserves partial-write identity when readback available=%s',
    async (readable) => {
      // Exercise generated control flow with a throwing adapter; this does not simulate iCloud.
      let writes = 0;
      let reads = 0;
      const playlist = {
        persistentID: () => 'P-PARTIAL',
        tracks: {
          persistentID: () => {
            reads++;
            if (!readable) throw Error('read failed');
            return [A];
          },
        },
      };
      const music = {
        make: vi.fn(() => playlist),
        libraryPlaylists: [
          {
            tracks: {
              whose: () => () => [
                {
                  duplicate: () => {
                    if (++writes === 2) throw Error('write failed');
                  },
                },
              ],
            },
          },
        ],
      };
      const raw = JSON.parse(
        runInNewContext(buildCreatePlaylistScript({ name: 'Mix', trackIds: [A, B] }), {
          Application: () => music,
        }),
      );
      expect(raw).toEqual({
        partialWrite: {
          persistentId: 'P-PARTIAL',
          ...(readable ? { trackPersistentIds: [A] } : {}),
        },
      });
      vi.mocked(runJxa).mockResolvedValue(raw);
      const deps = makeToolDeps(bridge);
      try {
        expect(await handleCreatePlaylist({ name: 'Mix', track_ids: [A, B] }, deps)).toMatchObject({
          error: 'jxa_error',
          partial_write: {
            playlist_id: 'P-PARTIAL',
            ...(readable ? { observed_track_ids: [A] } : {}),
          },
        });
        expect(music.make).toHaveBeenCalledOnce();
        expect(reads).toBe(1);
        expect(deps.cacheInstance.getPlaylist('P-PARTIAL')).toBeNull();
      } finally {
        deps.cacheInstance.close();
      }
    },
  );

  it.each([false, true])(
    'reads a known empty destination without the failing bulk getter (mutation failed=%s)',
    (failed) => {
      const bulkRead = vi.fn(() => {
        throw Error('empty collection');
      });
      const playlist = {
        persistentID: () => 'EMPTY',
        tracks: { length: 0, persistentID: bulkRead },
      };
      const music = {
        make: () => playlist,
        libraryPlaylists: [
          {
            tracks: {
              whose: () => () => [
                {
                  duplicate: () => {
                    if (failed) throw Error('first add failed');
                  },
                },
              ],
            },
          },
        ],
      };
      const raw = JSON.parse(
        runInNewContext(buildCreatePlaylistScript({ name: 'Mix', trackIds: [A] }), {
          Application: () => music,
        }),
      );
      expect(raw).toEqual(
        failed
          ? { partialWrite: { persistentId: 'EMPTY', trackPersistentIds: [] } }
          : { persistentId: 'EMPTY', trackCount: 0, trackPersistentIds: [] },
      );
      expect(bulkRead).not.toHaveBeenCalled();
    },
  );

  it('refuses ambiguous preview slots before clearing either playlist', async () => {
    const slot = { smart: () => false, class: () => 'userPlaylist' };
    const music = {
      userPlaylists: { whose: () => () => [slot, slot] },
      libraryPlaylists: [{ tracks: { whose: () => () => [{}] } }],
      delete: vi.fn(),
    };
    const raw = JSON.parse(
      runInNewContext(buildReplacePlaylistScript({ name: 'Selecta Preview', trackIds: [A] }), {
        Application: () => music,
      }),
    );
    vi.mocked(runJxa).mockResolvedValue(raw);
    await expect(
      bridge.replacePlaylist({ name: 'Selecta Preview', trackIds: [A] }),
    ).rejects.toMatchObject({ errorCode: 'validation_error' });
    expect(music.delete).not.toHaveBeenCalled();
  });
});
