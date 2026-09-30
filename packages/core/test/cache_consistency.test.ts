import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SelectaCache } from '../src/cache/index.js';
import { openDatabase } from '../src/cache/db.js';
import { handleSearch } from '../src/tools/search.js';
import { handleLibraryOverview } from '../src/tools/library_overview.js';
import { handleInspectTracklist } from '../src/tools/inspect_tracklist.js';
import { handleGetTrackContext } from '../src/tools/get_track_context.js';
import type { LibrarySnapshot } from '../src/types/bridge.js';
import { makeBridge } from './helpers.js';
import fixture from './fixtures/library.json' with { type: 'json' };

const snapshot = fixture as LibrarySnapshot;
const cleanups: (() => void)[] = [];

afterEach(() => {
  vi.restoreAllMocks();

  for (const cleanup of cleanups.splice(0)) cleanup();

  vi.useRealTimers();
});

function concurrentCache(initial: LibrarySnapshot = snapshot) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-10T12:00:00.000Z'));
  const directory = mkdtempSync(join(tmpdir(), 'selecta-read-snapshot-'));
  const path = join(directory, 'library.db');
  const writer = SelectaCache.open(path);

  writer.refreshFromSnapshot(initial, { durationMs: 1 });
  writer.db.prepare('UPDATE refresh_log SET refreshed_at = ?').run('2026-09-09T12:00:00.000Z');
  const db = openDatabase(path);
  const prepare = db.prepare.bind(db);
  const trackReads: unknown[] = [];
  let trackStatementsPrepared = 0;
  let afterRead: { matches: (sql: string) => boolean; run: () => void } | undefined;

  // Commit through a second WAL connection only after a reader statement has
  // completed. This fixes the interleaving without sleeps or production hooks.
  vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
    const statement = prepare(sql);
    const isTrackLookup = /WHERE\s+t\.persistent_id\s*=\s*\?/.test(sql);

    if (isTrackLookup) trackStatementsPrepared += 1;

    if (statement.reader) {
      for (const method of ['get', 'all'] as const) {
        const read = statement[method].bind(statement);

        vi.spyOn(statement, method).mockImplementation((...params: unknown[]) => {
          const result = read(...params);

          if (isTrackLookup) trackReads.push(params[0]);

          if (afterRead?.matches(sql)) {
            const callback = afterRead.run;

            afterRead = undefined;
            callback();
          }

          return result;
        });
      }
    }

    return statement;
  });

  const reader = new SelectaCache(db);

  cleanups.push(() => {
    reader.close();
    writer.close();
    rmSync(directory, { recursive: true, force: true });
  });

  return {
    reader,
    writer,
    trackReads,
    preparedTrackStatements: () => trackStatementsPrepared,
    deps: { cache: () => reader, bridge: makeBridge() },
    refreshAfterNextRead(
      matches: (sql: string) => boolean = () => true,
      replacement: LibrarySnapshot = { ...snapshot, tracks: [], playlists: [] },
    ) {
      const refresh = vi.fn(() => {
        writer.refreshFromSnapshot(replacement, { durationMs: 1 });
      });

      afterRead = { matches, run: refresh };

      return refresh;
    },
  };
}

describe('compound cache read snapshots', () => {
  it('keeps search rows, total, playlist positions and freshness together during refresh', async () => {
    const cache = concurrentCache();
    const input = { in_playlist: 'P-LATENIGHT', sort: 'playlist_order' };
    const expected = await handleSearch(input, cache.deps);
    const refresh = cache.refreshAfterNextRead((sql) => sql.includes('COUNT('));

    expect(await handleSearch(input, cache.deps)).toEqual(expected);
    expect(refresh).toHaveBeenCalledOnce();
    expect(cache.writer.searchTracks({}).total).toBe(0);
  });

  it.each([false, true])(
    'keeps unscoped search rows and totals together (dedupe=%s)',
    async (dedupe) => {
      const cache = concurrentCache();
      const expected = await handleSearch({ dedupe }, cache.deps);
      const refresh = cache.refreshAfterNextRead();

      expect(await handleSearch({ dedupe }, cache.deps)).toEqual(expected);
      expect(refresh).toHaveBeenCalledOnce();
    },
  );

  it('keeps freshness with rows when refresh commits after position retrieval', async () => {
    const cache = concurrentCache();
    const input = { in_playlist: 'P-LATENIGHT', sort: 'playlist_order' };
    const expected = await handleSearch(input, cache.deps);
    const refresh = cache.refreshAfterNextRead((sql) =>
      /SELECT track_persistent_id AS id/.test(sql),
    );

    expect(await handleSearch(input, cache.deps)).toEqual(expected);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('keeps overview totals, distributions and freshness together during refresh', async () => {
    const cache = concurrentCache();
    const expected = await handleLibraryOverview({}, cache.deps);
    const refresh = cache.refreshAfterNextRead();

    expect(await handleLibraryOverview({}, cache.deps)).toEqual(expected);
    expect(refresh).toHaveBeenCalledOnce();
    expect(cache.writer.searchTracks({}).total).toBe(0);
  });

  it('resolves inspection occurrences and freshness before a concurrent removal', async () => {
    const cache = concurrentCache();
    const input = { track_ids: ['T-TEARDROP', 'T-ANGEL', 'T-TEARDROP', 'T-BARE'] };
    const expected = await handleInspectTracklist(input, cache.deps);
    const refresh = cache.refreshAfterNextRead();

    expect(await handleInspectTracklist(input, cache.deps)).toEqual(expected);
    expect(refresh).toHaveBeenCalledOnce();
    expect(cache.writer.getTrack('T-TEARDROP')).toBeNull();
  });

  it.each([
    { track_id: 'T-TEARDROP', compact: true },
    { seed_ids: ['T-TEARDROP', 'T-ANGEL'], compact: true },
    { track_id: 'T-TEARDROP' },
    { seed_ids: ['T-TEARDROP', 'T-ANGEL', 'T-TEARDROP'] },
    { track_id: 'T-TEARDROP', exclude_playlist_ids: ['P-TRIPHOP'] },
  ])('keeps context validation and facts together for %j', async (input) => {
    const cache = concurrentCache();
    const expected = await handleGetTrackContext(input, cache.deps);
    const refresh = cache.refreshAfterNextRead();

    expect(await handleGetTrackContext(input, cache.deps)).toEqual(expected);
    expect(refresh).toHaveBeenCalledOnce();
    expect(cache.writer.getTrack('T-TEARDROP')).toBeNull();
  });
});

describe('ordered reads and search occurrence contracts', () => {
  it('reads each of 500 distinct inspection IDs once using one prepared lookup', async () => {
    const ids = Array.from({ length: 500 }, (_, index) => `T-${index}`);
    const cache = concurrentCache({
      ...snapshot,
      tracks: ids.map((persistentId) => ({ persistentId })),
      playlists: [],
    });
    const result = await handleInspectTracklist({ track_ids: ids }, cache.deps);

    expect(result).toMatchObject({ track_count: 500 });
    expect(cache.trackReads).toEqual(ids);
    expect(cache.preparedTrackStatements()).toBe(1);
  });

  it('does not read repeated inspection occurrences twice', async () => {
    const cache = concurrentCache();
    const ids = ['T-BARE', 'T-ANGEL', 'T-BARE', 'T-ANGEL'];
    const result = await handleInspectTracklist({ track_ids: ids }, cache.deps);

    expect(result).toMatchObject({
      tracks: ids.map((persistent_id) => ({ persistent_id })),
      duplicate_ids: [
        { persistent_id: 'T-BARE', count: 2, positions: [0, 2] },
        { persistent_id: 'T-ANGEL', count: 2, positions: [1, 3] },
      ],
    });
    expect(cache.trackReads).toEqual(['T-BARE', 'T-ANGEL']);
  });

  it.each([false, true])(
    'preserves aliases, alternate IDs and filtered position gaps (compact=%s)',
    async (compact) => {
      const cache = concurrentCache({
        ...snapshot,
        tracks: [
          { persistentId: 'A', title: 'Same', artist: 'Artist', year: 2000, loved: true },
          { persistentId: 'B', title: 'Same', artist: 'Artist', year: 2001 },
          { persistentId: 'C', title: 'Filtered', artist: 'Other' },
        ],
        playlists: [{ persistentId: 'OLD', name: 'Mix', kind: 'user', trackPersistentIds: [] }],
      });
      const ids = ['MISSING', 'B', 'C', 'A', 'B'];

      cache.writer.recordPlaylistCreation('OLD', 'Mix', []);
      cache.writer.applyLiveRekey('OLD', { persistentId: 'CURRENT', name: 'Mix', trackIds: ids });
      const input = {
        in_playlist: 'OLD',
        artist: 'Artist',
        sort: 'playlist_order',
        dedupe: true,
        compact,
      };
      const expected = await handleSearch(input, cache.deps);

      expect(expected).toMatchObject({
        tracks: [{ alternate_ids: ['B'], playlist_positions: [1, 3, 4] }],
        total_matches: 1,
      });
      const refresh = cache.refreshAfterNextRead((sql) => sql.includes('COUNT('));

      expect(await handleSearch(input, cache.deps)).toEqual(expected);
      expect(refresh).toHaveBeenCalledOnce();
    },
  );

  it('keeps an empty search result consistent during concurrent population', async () => {
    const cache = concurrentCache({ ...snapshot, tracks: [], playlists: [] });
    const refresh = cache.refreshAfterNextRead(() => true, snapshot);

    expect(await handleSearch({}, cache.deps)).toMatchObject({
      tracks: [],
      total_matches: 0,
      cache_age_hours: 24,
    });
    expect(refresh).toHaveBeenCalledOnce();
    expect(cache.writer.searchTracks({}).total).toBe(snapshot.tracks.length);
  });

  it.each(['remove', 'populate'])(
    'reports unique missing IDs from the same snapshot during %s',
    async (change) => {
      const cache = concurrentCache();
      const input = { track_ids: ['T-BARE', 'UNKNOWN', 'T-ANGEL', 'UNKNOWN', 'ALSO-UNKNOWN'] };
      const expected = await handleInspectTracklist(input, cache.deps);

      expect(expected).toMatchObject({ error: 'track_not_found' });
      const replacement =
        change === 'remove'
          ? { ...snapshot, tracks: [], playlists: [] }
          : {
              ...snapshot,
              tracks: [
                ...snapshot.tracks,
                { persistentId: 'UNKNOWN' },
                { persistentId: 'ALSO-UNKNOWN' },
              ],
            };
      const refresh = cache.refreshAfterNextRead(() => true, replacement);

      expect(await handleInspectTracklist(input, cache.deps)).toEqual(expected);
      expect(refresh).toHaveBeenCalledOnce();
    },
  );
});

describe('snapshot facade contracts', () => {
  it('returns resolved occurrences and unique misses together, including null metadata', () => {
    const cache = concurrentCache();
    const refresh = cache.refreshAfterNextRead();
    const result = cache.reader.resolveTracks([
      'UNKNOWN',
      'T-BARE',
      'T-ANGEL',
      'UNKNOWN',
      'T-BARE',
      'OTHER',
    ]);

    expect(result.missingIds).toEqual(['UNKNOWN', 'OTHER']);
    expect(result.rows.map((row) => row.persistentId)).toEqual(['T-BARE', 'T-ANGEL', 'T-BARE']);
    expect(result.rows[0]).toMatchObject({
      title: null,
      artist: null,
      durationSeconds: null,
      bpm: null,
      musicalKey: null,
    });
    expect(result.cacheAgeHours).toBe(24);
    expect(cache.trackReads).toEqual(['UNKNOWN', 'T-BARE', 'T-ANGEL', 'OTHER']);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('resolves an empty list and reports never-populated freshness without a track lookup', () => {
    const cache = SelectaCache.open(':memory:');

    cleanups.push(() => cache.close());
    const read = vi.spyOn(cache, 'getTrack');

    expect(cache.resolveTracks([])).toEqual({ rows: [], missingIds: [], cacheAgeHours: null });
    expect(read).not.toHaveBeenCalled();
    expect(cache.searchSnapshot({})).toMatchObject({ rows: [], total: 0, cacheAgeHours: null });
    expect(cache.overviewSnapshot({})).toMatchObject({
      stats: { totalTracks: 0 },
      cacheAgeHours: null,
    });
  });

  it('resolves excluded aliases and canonical IDs once as the same source playlist', async () => {
    const cache = concurrentCache();
    const ids = snapshot.playlists.find(
      (playlist) => playlist.persistentId === 'P-TRIPHOP',
    )!.trackPersistentIds;

    cache.writer.recordPlaylistCreation('P-TRIPHOP', 'Trip Hop Essentials', ids);
    cache.writer.applyLiveRekey('P-TRIPHOP', {
      persistentId: 'NEW',
      name: 'Trip Hop Essentials',
      trackIds: ids,
    });
    const input = {
      track_id: 'T-TEARDROP',
      exclude_playlist_ids: ['P-TRIPHOP', 'NEW', 'P-TRIPHOP'],
    };
    const expected = await handleGetTrackContext(input, cache.deps);

    expect(expected).toMatchObject({ source_playlists: { considered: 2, excluded: 1 } });
    const refresh = cache.refreshAfterNextRead();

    expect(await handleGetTrackContext(input, cache.deps)).toEqual(expected);
    expect(refresh).toHaveBeenCalledOnce();
  });
});
