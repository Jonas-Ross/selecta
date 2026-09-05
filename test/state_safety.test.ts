import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SelectaCache } from '../src/cache/index.js';
import { createCliProgram } from '../src/cli.js';
import { handleRefreshLibrary } from '../src/tools/refresh_library.js';
import { handleSearch } from '../src/tools/search.js';
import { handleRemoveTracks } from '../src/tools/remove_tracks.js';
import {
  buildAddTracksScript,
  buildRemoveTracksScript,
} from '../src/bridge/scripts/edit_playlist.js';
import { buildReadLibraryScript } from '../src/bridge/scripts/read_library.js';
import { makeBridge } from './helpers.js';
const tracks = [
  { persistentId: 'A', title: 'A', artist: 'Artist', playCount: 100 },
  { persistentId: 'B', title: 'B', artist: 'Artist' },
];
const pl = (id: string, ids = ['A', 'B']) => ({
  persistentId: id,
  name: 'Mix',
  kind: 'user' as const,
  trackPersistentIds: ids,
});
const snapshot = (playlists = [pl('P')]) => ({
  capturedAt: new Date().toISOString(),
  tracks,
  playlists,
});

describe('state safety regressions', () => {
  it('reports every same-name candidate even when only one retains the original sequence', () => {
    const cache = SelectaCache.open(':memory:');
    try {
      cache.refreshFromSnapshot(snapshot(), { durationMs: 1 });
      cache.recordPlaylistCreation('P', 'Mix', ['A', 'B']);
      cache.refreshFromSnapshot(snapshot([pl('FIRST'), pl('SECOND', ['B', 'A'])]), {
        durationMs: 1,
      });
      expect(cache.planSyncReconciliation({ windowMinutes: 60 })).toEqual([
        { kind: 'ambiguous', name: 'Mix', playlistIds: ['FIRST', 'SECOND'] },
      ]);
    } finally {
      cache.close();
    }
  });

  it('preserves intentional copies and their different notes', async () => {
    const c = SelectaCache.open(':memory:');
    try {
      c.refreshFromSnapshot(snapshot([pl('OLD1'), pl('OLD2')]), { durationMs: 1 });
      c.setNote('playlist', 'OLD1', 'historical');
      c.upsertPlaylistAfterWrite({ persistentId: 'NEW', trackCount: 2 }, 'Mix', ['A', 'B']);
      c.recordPlaylistCreation('NEW', 'Mix', ['A', 'B']);
      c.setNote('playlist', 'NEW', 'new');
      const bridge = makeBridge({
        readLibrary: vi.fn().mockResolvedValue(snapshot([pl('OLD1'), pl('OLD2'), pl('NEW')])),
      });
      await handleRefreshLibrary({}, { cache: () => c, bridge });
      expect(bridge.deletePlaylistById).not.toHaveBeenCalled();
      expect(c.listPlaylists({})).toHaveLength(3);
      expect(c.getNote('playlist', 'OLD1')?.body).toBe('historical');
      expect(c.getNote('playlist', 'NEW')?.body).toBe('new');
    } finally {
      c.close();
    }
  });
  it('does not rekey a surviving edited playlist onto another copy', () => {
    const c = SelectaCache.open(':memory:');
    try {
      c.refreshFromSnapshot(snapshot(), { durationMs: 1 });
      c.recordPlaylistCreation('P', 'Mix', ['A', 'B']);
      c.refreshFromSnapshot(snapshot([pl('P', ['B', 'A']), pl('OTHER')]), { durationMs: 1 });
      expect(c.planSyncReconciliation({ windowMinutes: 60 })).toEqual([
        { kind: 'ambiguous', name: 'Mix', playlistIds: ['OTHER', 'P'] },
      ]);
    } finally {
      c.close();
    }
  });
  it('retains a valid counter baseline across missing observations', () => {
    const c = SelectaCache.open(':memory:');
    try {
      c.refreshFromSnapshot(snapshot(), { durationMs: 1 });
      c.refreshFromSnapshot({ ...snapshot(), tracks: [{ persistentId: 'A' }] }, { durationMs: 1 });
      expect(c.getTrack('A')?.playCount).toBe(100);
      c.refreshFromSnapshot(
        { ...snapshot(), tracks: [{ persistentId: 'A', playCount: 101 }] },
        { durationMs: 1 },
      );
      expect(c.getTrackPlayHistory('A', 10).map((h) => h.playCountDelta)).toEqual([1]);
    } finally {
      c.close();
    }
  });
  it('exposes actual entry positions across duplicates and unavailable entries', async () => {
    const c = SelectaCache.open(':memory:');
    try {
      c.refreshFromSnapshot(snapshot([pl('P', ['A', 'MISSING', 'A', 'B'])]), { durationMs: 1 });
      const out = await handleSearch(
        { in_playlist: 'P', sort: 'playlist_order' },
        { cache: () => c, bridge: makeBridge() },
      );
      expect(out).toMatchObject({
        tracks: [
          { persistent_id: 'A', playlist_positions: [0, 2] },
          { persistent_id: 'B', playlist_positions: [3] },
        ],
      });
      const bridge = makeBridge({
        removePlaylistTracks: vi
          .fn()
          .mockRejectedValue(new Error('stop before external operation')),
      });
      await expect(
        handleRemoveTracks({ playlist_id: 'P', positions: [2] }, { cache: () => c, bridge }),
      ).rejects.toThrow('stop');
      expect(bridge.removePlaylistTracks).toHaveBeenCalledWith(
        expect.objectContaining({ expectedTrackIds: ['A', 'MISSING', 'A', 'B'] }),
      );
    } finally {
      c.close();
    }
  });
  it('emits positional guards before mutation and requires user rating provenance', () => {
    const add = buildAddTracksScript({
      playlistId: 'P',
      trackIds: ['A'],
      position: 0,
      expectedTrackIds: ['B'],
    });
    const remove = buildRemoveTracksScript({
      playlistId: 'P',
      positions: [0],
      expectedTrackIds: ['B'],
    });
    expect(add.indexOf('orderDrifted')).toBeLessThan(add.indexOf('.duplicate('));
    expect(remove.indexOf('orderDrifted')).toBeLessThan(remove.indexOf('Music.delete'));
    const read = buildReadLibraryScript();
    expect(read).toContain("bulk('ratingKind')");
    expect(read).toContain("String(col('ratingKind', i)) === 'user'");
    expect(read).not.toContain('catch (e) { return null; }');
  });
  it('CLI refresh reconciles receipt and note just like the MCP operation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'selecta-parity-'));
    const path = join(dir, 'db');
    try {
      const c = SelectaCache.open(path);
      c.refreshFromSnapshot(snapshot(), { durationMs: 1 });
      c.recordPlaylistCreation('P', 'Mix', ['A', 'B']);
      c.setNote('playlist', 'P', 'keep');
      c.close();
      const output: string[] = [];
      await createCliProgram({
        dbPath: path,
        bridge: makeBridge({ readLibrary: vi.fn().mockResolvedValue(snapshot([pl('NEW')])) }),
        writeStdout: (t) => {
          output.push(t);
        },
        logger: { info() {}, error() {}, debug() {} },
      }).parseAsync(['node', 'selecta', 'refresh']);
      expect(JSON.parse(output[0]!).sync_reconciliation.rekeys).toHaveLength(1);
      const updated = SelectaCache.open(path);
      try {
        expect(updated.resolvePlaylistId('P')).toBe('NEW');
        expect(updated.getNote('playlist', 'NEW')?.body).toBe('keep');
      } finally {
        updated.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('playlist name queries treat wildcard characters literally', () => {
    const c = SelectaCache.open(':memory:');
    try {
      c.refreshFromSnapshot(
        snapshot([{ ...pl('P'), name: '100%' }, { ...pl('Q'), name: 'A_B' }, pl('R')]),
        { durationMs: 1 },
      );
      expect(c.listPlaylists({ nameQuery: '%' }).map((p) => p.name)).toEqual(['100%']);
      expect(c.listPlaylists({ nameQuery: '_' }).map((p) => p.name)).toEqual(['A_B']);
    } finally {
      c.close();
    }
  });
});
