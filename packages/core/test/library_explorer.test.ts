import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleLibraryExplorer } from '../src/tools/library_explorer.js';
import { handleLibraryOverview } from '../src/tools/library_overview.js';
import { handleSearch } from '../src/tools/search.js';
import { SelectaCache } from '../src/cache/index.js';
import { BridgeError } from '../src/types/errors.js';
import type { LibrarySnapshot } from '../src/types/bridge.js';
import { makeToolDeps } from './helpers.js';
import fixture from './fixtures/library.json' with { type: 'json' };

const caches: SelectaCache[] = [];

function setup() {
  const deps = makeToolDeps();

  caches.push(deps.cacheInstance);

  return deps;
}

afterEach(() => {
  for (const cache of caches.splice(0)) cache.close();

  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function explore(deps: ReturnType<typeof setup>, input: object = {}) {
  const result = await handleLibraryExplorer(input, deps);

  if ('error' in result) throw new Error(result.hint);

  return result;
}

describe('library explorer', () => {
  it.each([
    {},
    { genre: 'trip-hop' },
    { loved: true },
    { max_plays: 0 },
    { added_after: '2024-02-01' },
    { year_min: 1990, year_max: 1999 },
    { query: 'Massive', loved: true },
    { genre: 'Trip-Hop', max_plays: 0 },
    { in_playlist: 'P-NIGHT', exclude_tracks: ['T-TEARDROP'] },
  ])('shares search and overview semantics for %j', async (filters) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-09T00:00:00Z'));
    const deps = setup();
    const page = await explore(deps, { filters, sort: 'least_played' });
    const search = await handleSearch({ ...filters, sort: 'least_played' }, deps);
    const overview = await handleLibraryOverview(filters, deps);

    expect(page.total_matches).toBe((search as { total_matches: number }).total_matches);
    expect(page.tracks).toEqual((search as { tracks: unknown[] }).tracks);
    expect(page.overview).toEqual(overview);
    expect(page.filters).toEqual(filters);

    for (const method of Object.values(deps.bridge)) expect(method).not.toHaveBeenCalled();
  });

  it.each(['recently_added', 'least_played', 'most_played'])(
    'pages every owned ID exactly once under tied %s values',
    async (sort) => {
      const deps = setup();
      const snapshot: LibrarySnapshot = {
        ...fixture,
        playlists: [],
        tracks: Array.from({ length: 123 }, (_, i) => ({
          ...fixture.tracks[0],
          persistentId: `COPY-${String(i).padStart(3, '0')}`,
        })),
      };

      deps.cacheInstance.refreshFromSnapshot(snapshot, { durationMs: 1 });
      const ids: string[] = [];
      let offset: number | null = 0;

      while (offset !== null) {
        const page = await explore(deps, { sort, offset });

        expect(page.tracks.length).toBeLessThanOrEqual(25);
        expect(page.total_matches).toBe(123);
        expect(page.overview.total_tracks).toBe(123);
        ids.push(...page.tracks.map((t) => t.persistent_id));
        offset = page.next_offset;
      }

      expect(ids).toEqual(snapshot.tracks.map((t) => t.persistentId));
      const emptyPage = await explore(deps, { offset: 200 });

      expect(emptyPage.tracks).toEqual([]);
      expect(emptyPage.next_offset).toBeNull();
      expect(emptyPage.total_matches).toBe(123);
    },
  );

  it('bounds distributions without hiding raw genre variants, missing facts or overflow', async () => {
    const deps = setup();
    const tracks = Array.from({ length: 75 }, (_, i) => ({
      ...fixture.tracks[0],
      persistentId: `G-${i}`,
      genre: `Genre ${i}`,
      year: 1000 + i * 10,
    }));

    deps.cacheInstance.refreshFromSnapshot(
      {
        ...fixture,
        playlists: [],
        tracks: [
          ...tracks,
          { persistentId: 'UNKNOWN' },
          { persistentId: 'CASE-A', genre: 'Hip-Hop' },
          { persistentId: 'CASE-B', genre: 'hip-hop' },
        ],
      },
      { durationMs: 1 },
    );
    const page = await explore(deps);

    expect(page.overview.genres).toHaveLength(50);
    expect(page.overview.genres_other).toEqual({ distinct: 27, tracks: 27 });
    expect(page.overview.decades).toHaveLength(30);
    expect(page.decades_other).toEqual({ distinct: 45, tracks: 45 });
    expect(page.missing).toEqual({ genre: 1, year: 3 });
    const cases = await explore(deps, { filters: { genre: 'Hip-Hop' } });

    expect(cases.total_matches).toBe(2);
    expect(cases.overview.genres.map((g) => g.name)).toEqual(['Hip-Hop', 'hip-hop']);
  });

  it('reports an unpopulated cache and an empty filtered slice separately', async () => {
    const deps = setup();
    const empty = SelectaCache.open(':memory:');

    caches.push(empty);
    const unpopulated = await explore({ ...deps, cache: () => empty });

    expect(unpopulated.overview.cache_age_hours).toBeNull();
    expect(unpopulated.total_matches).toBe(0);
    expect(unpopulated.missing).toEqual({ genre: 0, year: 0 });
    const filtered = await explore(deps, { filters: { query: 'nonexistentrecord' } });

    expect(filtered.total_matches).toBe(0);
    expect(filtered.overview.cache_age_hours).not.toBeNull();
  });

  it.each([
    { limit: 51 },
    { offset: -1 },
    { offset: 1.5 },
    { sort: 'random' },
    { filters: { notes: 'favorite' } },
    { filters: { year_min: 2000, year_max: 1990 } },
  ])('rejects invalid input before opening the cache: %j', async (input) => {
    const deps = setup();
    const cache = vi.fn(() => {
      throw new Error('must not open');
    });

    expect(await handleLibraryExplorer(input, { ...deps, cache })).toMatchObject({
      error: 'validation_error',
    });
    expect(cache).not.toHaveBeenCalled();
  });

  it('returns a cache error without a bridge call or retry', async () => {
    const deps = setup();
    const cache = vi.fn(() => {
      throw new BridgeError('cache_unavailable', 'broken fixture');
    });

    expect(await handleLibraryExplorer({}, { ...deps, cache })).toMatchObject({
      error: 'cache_unavailable',
    });
    expect(cache).toHaveBeenCalledTimes(1);
  });

  it('reads page, aggregate and freshness in one read transaction', async () => {
    const deps = setup();
    const cache = deps.cacheInstance;
    const overview = cache.getOverview.bind(cache);
    const search = cache.searchTracks.bind(cache);
    const freshness = cache.getCacheAgeHours.bind(cache);

    vi.spyOn(cache, 'getOverview').mockImplementation((...args) => {
      expect(cache.db.inTransaction).toBe(true);

      return overview(...args);
    });
    vi.spyOn(cache, 'searchTracks').mockImplementation((...args) => {
      expect(cache.db.inTransaction).toBe(true);

      return search(...args);
    });
    vi.spyOn(cache, 'getCacheAgeHours').mockImplementation(() => {
      expect(cache.db.inTransaction).toBe(true);

      return freshness();
    });
    await explore(deps);
    expect(cache.db.inTransaction).toBe(false);
  });
});

it('keeps alternate copy reporting intact when the cache pages deduplicated rows', () => {
  const deps = setup();

  deps.cacheInstance.refreshFromSnapshot(
    {
      ...fixture,
      tracks: [...fixture.tracks, { ...fixture.tracks[0], persistentId: 'COPY' }],
    } as LibrarySnapshot,
    { durationMs: 1 },
  );
  const all = deps.cacheInstance.searchTracks({ dedupe: true, sort: 'most_played' });
  const page = deps.cacheInstance.searchTracks({
    dedupe: true,
    sort: 'most_played',
    limit: 1,
    offset: 1,
  });

  expect(page.total).toBe(all.total);
  expect(page.rows).toEqual(all.rows.slice(1, 2));
  expect(page.rows[0].alternateIds).toHaveLength(1);
});
