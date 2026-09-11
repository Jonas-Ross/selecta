import { afterEach, describe, expect, it, vi } from 'vitest';
import { roundCacheAge } from '../src/tools/freshness.js';
import { capDistribution } from '../src/domain/distributions.js';
import { RECENT_WINDOW_DAYS, recentSinceIso } from '../src/domain/recent_activity.js';
import { recentSinceIso as queryCutoff } from '../src/cache/queries.js';
import { summarizeIds, trackNotFoundError } from '../src/types/errors.js';
import { handleGetTrackContext } from '../src/tools/get_track_context.js';
import { handleLibraryOverview } from '../src/tools/library_overview.js';
import { handleLibraryExplorer } from '../src/tools/library_explorer.js';
import { asError, makeToolDeps } from './helpers.js';

afterEach(() => vi.restoreAllMocks());

describe('bounded response summaries', () => {
  it.each([
    [[], ''],
    [['a'], 'a'],
    [['a', 'b', 'c', 'd', 'e'], 'a, b, c, d, e'],
    [['a', 'b', 'c', 'd', 'e', 'f'], 'a, b, c, d, e (+1 more)'],
    [['a', 'b', 'c', 'd', 'e', 'f', 'g'], 'a, b, c, d, e (+2 more)'],
  ] as const)('formats IDs at the abbreviation boundary: %j', (ids, expected) => {
    expect(summarizeIds([...ids])).toBe(expected);
    expect(trackNotFoundError([...ids]).hint).toBe(
      `Not in the cache: ${expected}. Use persistent IDs exactly as returned by search/get_track_context; if the library changed, run refresh_library.`,
    );
  });

  it('uses the same abbreviation without changing the excluded-playlist error hint', async () => {
    const deps = makeToolDeps();

    try {
      const result = await handleGetTrackContext(
        { track_id: 'T-TEARDROP', exclude_playlist_ids: ['a', 'b', 'c', 'd', 'e', 'f'] },
        deps,
      );

      expect(asError(result).hint).toBe(
        'exclude_playlist_ids not in the cache: a, b, c, d, e (+1 more). Use IDs from list_playlists; if the library changed, run refresh_library.',
      );
    } finally {
      deps.cacheInstance.close();
    }
  });

  it('preserves distribution order and sums tail weights without merging labels', () => {
    const buckets = [
      { name: 'hip-hop', count: 2 },
      { name: 'Hip-Hop', count: 5 },
      { name: 'Other', count: 3 },
    ];

    expect(capDistribution(buckets, 1)).toEqual({
      shown: [{ name: 'hip-hop', count: 2 }],
      other: { distinct: 2, tracks: 8 },
    });
    expect(capDistribution(buckets, 3)).toEqual({
      shown: buckets,
      other: { distinct: 0, tracks: 0 },
    });
    expect(capDistribution([], 30)).toEqual({ shown: [], other: { distinct: 0, tracks: 0 } });
  });

  it.each([0, 29, 30, 31, 49, 50, 51])(
    'keeps genre omission and decade zero summaries at %i buckets',
    async (count) => {
      const deps = makeToolDeps();

      try {
        deps.cacheInstance.refreshFromSnapshot(
          {
            capturedAt: '2026-09-10T00:00:00.000Z',
            playlists: [],
            tracks: Array.from({ length: count }, (_, i) => ({
              persistentId: `T-${i}`,
              genre: `Genre ${i}`,
              year: 1000 + i * 10,
            })),
          },
          { durationMs: 1 },
        );
        const result = await handleLibraryExplorer({}, deps);

        if ('error' in result) throw new Error(result.hint);

        expect(result.overview.genres.length).toBe(Math.min(count, 50));

        if (count <= 50) expect(result.overview).not.toHaveProperty('genres_other');
        else expect(result.overview.genres_other).toEqual({ distinct: 1, tracks: 1 });

        expect(result.overview.decades.length).toBe(Math.min(count, 30));
        expect(result.decades_other).toEqual({
          distinct: Math.max(0, count - 30),
          tracks: Math.max(0, count - 30),
        });
      } finally {
        deps.cacheInstance.close();
      }
    },
  );
});

describe('shared recent window', () => {
  it.each([
    ['2026-09-10T12:34:56.789Z', '2026-08-11T12:34:56.789Z'],
    ['2026-03-15T07:00:00.123Z', '2026-02-13T07:00:00.123Z'],
    ['2024-03-15T00:00:00.000Z', '2024-02-14T00:00:00.000Z'],
  ])('preserves an exact rolling 30 days from %s', (now, expected) => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(now));
    expect(RECENT_WINDOW_DAYS).toBe(30);
    expect(recentSinceIso()).toBe(expected);
    expect(queryCutoff()).toBe(expected);
  });

  it('shares the exact cutoff across overview, explorer and recent-play sorting', async () => {
    const now = '2026-09-10T12:34:56.789Z';
    const cutoff = '2026-08-11T12:34:56.789Z';

    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(now));
    const deps = makeToolDeps();

    try {
      const insert = deps.cacheInstance.db.prepare(
        'INSERT INTO play_history (track_persistent_id, refreshed_at, play_count_delta, skip_count_delta) VALUES (?, ?, ?, ?)',
      );

      insert.run('T-ROADS', '2026-08-11T12:34:56.788Z', 99, 99);
      insert.run('T-TEARDROP', cutoff, 3, 1);
      insert.run('T-ANGEL', '2026-08-11T12:34:56.790Z', 5, 2);

      for (const result of [
        await handleLibraryOverview({}, deps),
        await handleLibraryExplorer({}, deps),
      ]) {
        if ('error' in result) throw new Error(result.hint);

        const overview = 'overview' in result ? result.overview : result;

        expect(overview.recent_activity).toEqual({
          window_days: 30,
          since: cutoff,
          tracks_played: 2,
          total_plays: 8,
          total_skips: 3,
        });
      }

      expect(
        deps.cacheInstance
          .searchTracks({ sort: 'recent_plays' })
          .rows.slice(0, 2)
          .map((row) => row.persistentId),
      ).toEqual(['T-ANGEL', 'T-TEARDROP']);
    } finally {
      deps.cacheInstance.close();
    }
  });
});

it.each([
  [null, null],
  [0, 0],
  [1.234, 1.23],
  [1.236, 1.24],
] as const)('rounds captured cache age %s without reading another snapshot', (age, expected) => {
  expect(roundCacheAge(age)).toBe(expected);
});
