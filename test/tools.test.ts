// Tool handlers against in-memory SQLite seeded via the production refresh
// path, with the Bridge interface mocked (docs/contracts.md §5). No Music.app.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SelectaCache } from '../src/cache/index.js';
import { handleSearch, type SearchOutput } from '../src/tools/search.js';
import {
  handleGetTrackContext,
  type TrackContextOutput,
} from '../src/tools/get_track_context.js';
import {
  handleListPlaylists,
  type ListPlaylistsOutput,
} from '../src/tools/list_playlists.js';
import {
  handleLibraryOverview,
  shapeOverview,
  GENRE_CAP,
  type LibraryOverviewOutput,
} from '../src/tools/library_overview.js';
import type { OverviewStats } from '../src/types/cache.js';
import {
  handleRefreshLibrary,
  type RefreshLibraryOutput,
} from '../src/tools/refresh_library.js';
import type { ToolDeps } from '../src/tools/common.js';
import type { Bridge, LibrarySnapshot } from '../src/types/bridge.js';
import { BridgeError, type SelectaError } from '../src/types/errors.js';
import fixture from './fixtures/library.json' with { type: 'json' };

const snapshot = fixture as LibrarySnapshot;

function makeBridge(overrides: Partial<Bridge> = {}): Bridge {
  return {
    readPlaylist: vi.fn().mockRejectedValue(new Error('not used')),
    readLibrary: vi.fn().mockResolvedValue(snapshot),
    createPlaylist: vi.fn().mockRejectedValue(new Error('not used')),
    replacePlaylist: vi.fn().mockRejectedValue(new Error('not used')),
    deletePlaylistById: vi.fn().mockResolvedValue(1),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<Bridge> = {}): ToolDeps {
  const cache = SelectaCache.open(':memory:');
  cache.refreshFromSnapshot(snapshot, { durationMs: 1 });
  return { cache: () => cache, bridge: makeBridge(overrides) };
}

function asError(result: object): SelectaError {
  expect(result).toHaveProperty('error');
  return result as SelectaError;
}

describe('search', () => {
  let deps: ToolDeps;
  beforeEach(() => {
    deps = makeDeps();
  });

  it('matches free text against title via FTS', async () => {
    const out = (await handleSearch({ query: 'teardrop' }, deps)) as SearchOutput;
    expect(out.tracks.map((t) => t.persistent_id)).toEqual(['T-TEARDROP']);
    expect(out.total_matches).toBe(1);
    expect(out.cache_age_hours).not.toBeNull();
  });

  it('surfaces the behavioral signal bundle with star-scale rating', async () => {
    const out = (await handleSearch({ query: 'teardrop' }, deps)) as SearchOutput;
    const signal = out.tracks[0]!.signal;
    expect(signal.play_count).toBe(42);
    expect(signal.skip_count).toBe(1);
    expect(signal.rating).toBe(5); // 100 / 20
    expect(signal.loved).toBe(true);
    expect(signal.last_played).toBe('2026-05-20T22:15:00.000Z');
  });

  it('filters by artist case-insensitively, ordered by play count', async () => {
    const out = (await handleSearch({ artist: 'portishead' }, deps)) as SearchOutput;
    expect(out.tracks.map((t) => t.persistent_id)).toEqual(['T-GLORYBOX', 'T-ROADS']);
  });

  it('combines facets as AND', async () => {
    const out = (await handleSearch(
      { year_min: 1990, year_max: 2000, loved: true },
      deps,
    )) as SearchOutput;
    expect(out.tracks.map((t) => t.persistent_id).sort()).toEqual(['T-GLORYBOX', 'T-TEARDROP']);
  });

  it('filters by playlist membership', async () => {
    const out = (await handleSearch({ in_playlist: 'P-LATENIGHT' }, deps)) as SearchOutput;
    expect(out.tracks).toHaveLength(3);
  });

  it('converts rating_min stars to the internal 0-100 scale', async () => {
    const out = (await handleSearch({ rating_min: 4.5 }, deps)) as SearchOutput;
    expect(out.tracks.map((t) => t.persistent_id)).toEqual(['T-TEARDROP']);
  });

  it('last_played_before includes never-played tracks', async () => {
    const out = (await handleSearch({ last_played_before: '2026-01-01' }, deps)) as SearchOutput;
    // Played long ago: none. Never played: T-ANGEL, T-ROADS, T-BARE.
    expect(out.tracks.map((t) => t.persistent_id).sort()).toEqual([
      'T-ANGEL',
      'T-BARE',
      'T-ROADS',
    ]);
  });

  it('caps results at limit but reports the unbounded total', async () => {
    const out = (await handleSearch({ limit: 2 }, deps)) as SearchOutput;
    expect(out.tracks).toHaveLength(2);
    expect(out.total_matches).toBe(6);
  });

  it('returns an empty result set without error for no matches', async () => {
    const out = (await handleSearch({ query: 'nonexistent zzz' }, deps)) as SearchOutput;
    expect(out.tracks).toEqual([]);
    expect(out.total_matches).toBe(0);
  });

  it('does not choke on FTS metacharacters in the query', async () => {
    const out = (await handleSearch({ query: 'tear"drop AND (x OR y)' }, deps)) as SearchOutput;
    expect(out.tracks).toEqual([]);
  });

  it('rejects year_min > year_max as validation_error', async () => {
    const err = asError(await handleSearch({ year_min: 2000, year_max: 1990 }, deps));
    expect(err.error).toBe('validation_error');
  });

  it('rejects unknown parameters as validation_error', async () => {
    const err = asError(await handleSearch({ vibe: 'late night' }, deps));
    expect(err.error).toBe('validation_error');
  });

  it('sort: least_played orders ascending by play count', async () => {
    const out = (await handleSearch({ sort: 'least_played' }, deps)) as SearchOutput;
    expect(out.tracks.map((t) => t.persistent_id)).toEqual([
      'T-BARE', // 0 plays
      'T-ROADS', // 7
      'T-ANGEL', // 13
      'T-GLORYBOX', // 30
      'T-TEARDROP', // 42
      'T-MIDNIGHT', // 55
    ]);
  });

  it('sort: recently_added orders newest first, undated last', async () => {
    const out = (await handleSearch({ sort: 'recently_added' }, deps)) as SearchOutput;
    expect(out.tracks.map((t) => t.persistent_id)).toEqual([
      'T-MIDNIGHT', // 2025-11-05
      'T-GLORYBOX', // 2024-03-02 (id tiebreak)
      'T-ROADS', // 2024-03-02
      'T-ANGEL', // 2024-01-10 (id tiebreak)
      'T-TEARDROP', // 2024-01-10
      'T-BARE', // no date_added → last
    ]);
  });

  it('sort: random returns the full match set (order unconstrained)', async () => {
    const out = (await handleSearch({ sort: 'random' }, deps)) as SearchOutput;
    expect(out.total_matches).toBe(6);
    expect(out.tracks.map((t) => t.persistent_id).sort()).toEqual([
      'T-ANGEL',
      'T-BARE',
      'T-GLORYBOX',
      'T-MIDNIGHT',
      'T-ROADS',
      'T-TEARDROP',
    ]);
  });

  it('sort overrides relevance ordering even with a free-text query', async () => {
    // Both Dummy tracks match; least_played puts ROADS (7) ahead of GLORYBOX (30).
    const out = (await handleSearch({ query: 'dummy', sort: 'least_played' }, deps)) as SearchOutput;
    expect(out.tracks.map((t) => t.persistent_id)).toEqual(['T-ROADS', 'T-GLORYBOX']);
  });

  it('rejects an unknown sort value as validation_error', async () => {
    const err = asError(await handleSearch({ sort: 'alphabetical' }, deps));
    expect(err.error).toBe('validation_error');
  });

  it('exclude_artists drops matches case-insensitively but keeps artistless tracks', async () => {
    const out = (await handleSearch(
      { exclude_artists: ['massive attack', 'M83'] },
      deps,
    )) as SearchOutput;
    // T-BARE has no artist and must survive an artist exclusion.
    expect(out.tracks.map((t) => t.persistent_id).sort()).toEqual([
      'T-BARE',
      'T-GLORYBOX',
      'T-ROADS',
    ]);
    expect(out.total_matches).toBe(3);
  });

  it('exclude_tracks drops by persistent ID', async () => {
    const out = (await handleSearch(
      { exclude_tracks: ['T-TEARDROP', 'T-BARE'] },
      deps,
    )) as SearchOutput;
    expect(out.tracks.map((t) => t.persistent_id).sort()).toEqual([
      'T-ANGEL',
      'T-GLORYBOX',
      'T-MIDNIGHT',
      'T-ROADS',
    ]);
  });

  it('exclusions AND with positive facets', async () => {
    const out = (await handleSearch(
      { in_playlist: 'P-LATENIGHT', exclude_artists: ['Portishead'] },
      deps,
    )) as SearchOutput;
    const artists = out.tracks.map((t) => t.artist);
    expect(out.tracks.length).toBeGreaterThan(0);
    expect(artists).not.toContain('Portishead');
  });

  it('empty exclusion arrays are a no-op', async () => {
    const out = (await handleSearch(
      { exclude_artists: [], exclude_tracks: [] },
      deps,
    )) as SearchOutput;
    expect(out.total_matches).toBe(6);
  });

  it('rejects an empty string inside exclude_artists as validation_error', async () => {
    const err = asError(await handleSearch({ exclude_artists: [''] }, deps));
    expect(err.error).toBe('validation_error');
  });
});

describe('get_track_context', () => {
  let deps: ToolDeps;
  beforeEach(() => {
    deps = makeDeps();
  });

  it('assembles the full context bundle for a seed', async () => {
    const out = (await handleGetTrackContext(
      { track_id: 'T-TEARDROP' },
      deps,
    )) as TrackContextOutput;

    expect(out.seed.persistent_id).toBe('T-TEARDROP');
    expect(out.same_artist.map((t) => t.persistent_id)).toEqual(['T-ANGEL']);
    expect(out.appearing_in_playlists.map((p) => p.name).sort()).toEqual([
      'Late Night',
      'Trip Hop Essentials',
    ]);

    const cooc = out.co_occurring_tracks;
    expect(cooc[0]!.persistent_id).toBe('T-GLORYBOX'); // shares 2 user playlists
    expect(cooc[0]!.shared_playlist_count).toBe(2);
    expect(cooc[0]!.shared_playlist_names.sort()).toEqual(['Late Night', 'Trip Hop Essentials']);
    expect(cooc.map((t) => t.persistent_id).sort()).toEqual(['T-ANGEL', 'T-GLORYBOX', 'T-ROADS']);
  });

  it('ignores smart-playlist co-occurrence (user playlists only)', async () => {
    const out = (await handleGetTrackContext(
      { track_id: 'T-MIDNIGHT' },
      deps,
    )) as TrackContextOutput;
    // T-MIDNIGHT only shares the smart playlist P-RECENT with T-BARE.
    expect(out.co_occurring_tracks).toEqual([]);
    // But the smart playlist still shows under appearing_in_playlists.
    expect(out.appearing_in_playlists.map((p) => p.name)).toEqual(['Recently Added']);
  });

  it('returns track_not_found for an unknown ID', async () => {
    const err = asError(await handleGetTrackContext({ track_id: 'T-NOPE' }, deps));
    expect(err.error).toBe('track_not_found');
    expect(err.hint).toContain('refresh_library');
  });
});

describe('list_playlists', () => {
  let deps: ToolDeps;
  beforeEach(() => {
    deps = makeDeps();
  });

  it('lists all playlists with counts and parents', async () => {
    const out = (await handleListPlaylists({}, deps)) as ListPlaylistsOutput;
    expect(out.playlists).toHaveLength(4);
    const lateNight = out.playlists.find((p) => p.name === 'Late Night')!;
    expect(lateNight.track_count).toBe(3);
    expect(lateNight.parent_id).toBe('P-MOODS');
    expect(lateNight.kind).toBe('user');
  });

  it('filters by kind and name substring', async () => {
    const byKind = (await handleListPlaylists({ kind: 'user' }, deps)) as ListPlaylistsOutput;
    expect(byKind.playlists.map((p) => p.name).sort()).toEqual([
      'Late Night',
      'Trip Hop Essentials',
    ]);

    const byName = (await handleListPlaylists({ name_query: 'trip' }, deps)) as ListPlaylistsOutput;
    expect(byName.playlists.map((p) => p.name)).toEqual(['Trip Hop Essentials']);
  });
});

describe('library_overview', () => {
  let deps: ToolDeps;
  beforeEach(() => {
    deps = makeDeps();
  });

  it('summarizes the whole library', async () => {
    const out = (await handleLibraryOverview({}, deps)) as LibraryOverviewOutput;
    expect(out.filtered).toBe(false);
    expect(out.total_tracks).toBe(6);
    expect(out.total_runtime_seconds).toBe(1563);
    expect(out.total_runtime_human).toBe('26m');
    expect(out.genres).toEqual([
      { name: 'Trip-Hop', count: 4 },
      { name: 'Electronic', count: 1 },
    ]);
    expect(out.genres_other).toBeUndefined();
    expect(out.decades).toEqual([
      { decade: '1990s', count: 4 },
      { decade: '2010s', count: 1 },
    ]);
    expect(out.top_artists).toEqual([
      { name: 'Massive Attack', track_count: 2 },
      { name: 'Portishead', track_count: 2 },
      { name: 'M83', track_count: 1 },
    ]);
    expect(out.artists_total).toBe(3);
    expect(out.signal).toEqual({
      loved: 2,
      disliked: 0,
      rated: 2,
      unrated: 4,
      never_played: 1,
      rating_histogram: { '5': 1, '4': 1 },
    });
    expect(out.location).toEqual({ local: 2, cloud: 3, unknown: 1 });
    expect(out.date_added_range).toEqual({
      earliest: '2024-01-10T08:00:00.000Z',
      latest: '2025-11-05T08:00:00.000Z',
    });
    expect(out.cache_age_hours).not.toBeNull();
  });

  it('marks filtered slices and scopes the aggregates', async () => {
    const out = (await handleLibraryOverview(
      { artist: 'Portishead' },
      deps,
    )) as LibraryOverviewOutput;
    expect(out.filtered).toBe(true);
    expect(out.total_tracks).toBe(2);
    expect(out.genres).toEqual([{ name: 'Trip-Hop', count: 2 }]);
    expect(out.top_artists).toEqual([{ name: 'Portishead', track_count: 2 }]);
    expect(out.signal.rating_histogram).toEqual({});
  });

  it('reports an empty overview on a never-populated cache', async () => {
    const cache = SelectaCache.open(':memory:');
    const out = (await handleLibraryOverview(
      {},
      { cache: () => cache, bridge: makeBridge() },
    )) as LibraryOverviewOutput;
    expect(out.total_tracks).toBe(0);
    expect(out.total_runtime_human).toBe('0m');
    expect(out.genres).toEqual([]);
    expect(out.location).toEqual({ local: 0, cloud: 0 });
    expect(out.date_added_range).toBeNull();
    expect(out.cache_age_hours).toBeNull();
  });

  it('rejects unknown parameters as validation_error', async () => {
    const err = asError(await handleLibraryOverview({ vibe: 'late night' }, deps));
    expect(err.error).toBe('validation_error');
  });

  it('rejects year_min > year_max as validation_error', async () => {
    const err = asError(await handleLibraryOverview({ year_min: 2000, year_max: 1990 }, deps));
    expect(err.error).toBe('validation_error');
  });

  it('rejects min_plays > max_plays as validation_error', async () => {
    const err = asError(await handleLibraryOverview({ min_plays: 10, max_plays: 1 }, deps));
    expect(err.error).toBe('validation_error');
  });

  it('honors exclusion filters in the aggregates', async () => {
    const out = (await handleLibraryOverview(
      { exclude_artists: ['portishead'], exclude_tracks: ['T-MIDNIGHT'] },
      deps,
    )) as LibraryOverviewOutput;
    expect(out.filtered).toBe(true);
    // 6 tracks minus Portishead's 2 minus T-MIDNIGHT; artistless T-BARE survives.
    expect(out.total_tracks).toBe(3);
    expect(out.top_artists).toEqual([{ name: 'Massive Attack', track_count: 2 }]);
  });
});

// The cap/roll-up and formatting are pure (no DB), so they get unit-tested
// directly with synthetic stats rather than a fixture big enough to trip GENRE_CAP.
describe('shapeOverview', () => {
  function emptyStats(overrides: Partial<OverviewStats> = {}): OverviewStats {
    return {
      totalTracks: 0,
      totalRuntimeSeconds: 0,
      artistsTotal: 0,
      loved: 0,
      disliked: 0,
      rated: 0,
      unrated: 0,
      neverPlayed: 0,
      local: 0,
      cloud: 0,
      missing: 0,
      unknownLocation: 0,
      earliestAdded: null,
      latestAdded: null,
      genres: [],
      decades: [],
      topArtists: [],
      ratingHistogram: [],
      ...overrides,
    };
  }
  const shape = (stats: OverviewStats) => shapeOverview(stats, { filtered: false, cacheAgeHours: 0 });

  it('caps genres and rolls the tail into genres_other', () => {
    const genres = Array.from({ length: GENRE_CAP + 5 }, (_, i) => ({
      name: `g${i}`,
      count: GENRE_CAP + 5 - i,
    }));
    const out = shape(emptyStats({ genres }));
    expect(out.genres).toHaveLength(GENRE_CAP);
    expect(out.genres_other).toEqual({
      distinct: 5,
      tracks: genres.slice(GENRE_CAP).reduce((sum, g) => sum + g.count, 0),
    });
  });

  it('formats whole and half-star ratings', () => {
    const out = shape(
      emptyStats({
        ratingHistogram: [
          { rating: 100, count: 2 },
          { rating: 90, count: 1 },
          { rating: 30, count: 4 },
        ],
      }),
    );
    expect(out.signal.rating_histogram).toEqual({ '5': 2, '4.5': 1, '1.5': 4 });
  });

  it('humanizes runtime across day/hour/minute thresholds', () => {
    const human = (s: number) => shape(emptyStats({ totalRuntimeSeconds: s })).total_runtime_human;
    expect(human(0)).toBe('0m');
    expect(human(1563)).toBe('26m');
    expect(human(3 * 3600 + 25 * 60)).toBe('3h 25m');
    expect(human(2 * 86400 + 5 * 3600)).toBe('2d 5h');
  });

  it('adds missing/unknown to location only when nonzero', () => {
    expect(shape(emptyStats({ local: 1, cloud: 2 })).location).toEqual({ local: 1, cloud: 2 });
    expect(shape(emptyStats({ local: 1, missing: 3, unknownLocation: 2 })).location).toEqual({
      local: 1,
      cloud: 0,
      missing: 3,
      unknown: 2,
    });
  });
});

describe('refresh_library', () => {
  it('rereads via the bridge and reports counts', async () => {
    const cache = SelectaCache.open(':memory:');
    const deps: ToolDeps = { cache: () => cache, bridge: makeBridge() };
    expect(cache.getCacheAgeHours()).toBeNull();

    const out = (await handleRefreshLibrary({}, deps)) as RefreshLibraryOutput;
    expect(out.track_count).toBe(6);
    expect(out.playlist_count).toBe(4);
    expect(Date.parse(out.refreshed_at)).not.toBeNaN();
    expect(cache.getCacheAgeHours()).not.toBeNull();
  });

  it('converts a bridge failure to the structured envelope, no retry', async () => {
    const readLibrary = vi
      .fn()
      .mockRejectedValue(new BridgeError('automation_permission_denied', 'denied'));
    const deps = makeDeps({ readLibrary });

    const err = asError(await handleRefreshLibrary({}, deps));
    expect(err.error).toBe('automation_permission_denied');
    expect(err.hint).toContain('System Settings');
    expect(readLibrary).toHaveBeenCalledTimes(1);
  });
});

// Refresh-time iCloud-echo reconciliation: a recently created playlist that
// comes back twinned in the next snapshot gets its duplicate deleted via the
// bridge, surgically removed from the cache, and reported — never silently.
describe('refresh_library sync reconciliation', () => {
  const TRACKS = ['T-TEARDROP', 'T-ROADS'];

  function echoSnapshot(ids: string[]): LibrarySnapshot {
    return {
      ...snapshot,
      playlists: [
        ...snapshot.playlists,
        ...ids.map((id) => ({
          persistentId: id,
          name: 'Rearview',
          kind: 'user' as const,
          trackPersistentIds: TRACKS,
        })),
      ],
    };
  }

  function depsAfterCreate(overrides: Partial<Bridge> = {}): ToolDeps & {
    cacheInstance: SelectaCache;
  } {
    const cache = SelectaCache.open(':memory:');
    cache.refreshFromSnapshot(snapshot, { durationMs: 1 });
    cache.upsertPlaylistAfterWrite({ persistentId: 'P-CREATED', trackCount: 2 }, 'Rearview', TRACKS);
    cache.recordPlaylistCreation('P-CREATED', 'Rearview', TRACKS);
    return { cache: () => cache, bridge: makeBridge(overrides), cacheInstance: cache };
  }

  it('deletes the echo twin, keeps the iCloud copy, and reports it', async () => {
    const deps = depsAfterCreate({
      readLibrary: vi.fn().mockResolvedValue(echoSnapshot(['P-CREATED', 'P-ECHO'])),
    });

    const out = (await handleRefreshLibrary({}, deps)) as RefreshLibraryOutput;
    expect(deps.bridge.deletePlaylistById).toHaveBeenCalledWith('P-CREATED');
    expect(out.sync_reconciliation!.duplicates_removed).toEqual([
      { name: 'Rearview', deleted_id: 'P-CREATED', kept_id: 'P-ECHO' },
    ]);
    expect(out.playlist_count).toBe(5); // 4 fixture + 1 survivor
    const rows = deps.cacheInstance.listPlaylists({ nameQuery: 'Rearview' });
    expect(rows.map((p) => p.persistentId)).toEqual(['P-ECHO']);
  });

  it('reports a rekey without touching Music.app', async () => {
    const deps = depsAfterCreate({
      readLibrary: vi.fn().mockResolvedValue(echoSnapshot(['P-REKEYED'])),
    });

    const out = (await handleRefreshLibrary({}, deps)) as RefreshLibraryOutput;
    expect(out.sync_reconciliation!.rekeys).toEqual([
      { name: 'Rearview', from_id: 'P-CREATED', to_id: 'P-REKEYED' },
    ]);
    expect(deps.bridge.deletePlaylistById).not.toHaveBeenCalled();
    // The ID create_playlist returned still resolves for searches.
    const { rows } = deps.cacheInstance.searchTracks({ inPlaylist: 'P-CREATED' });
    expect(rows).toHaveLength(2);
  });

  it('surfaces a failed delete as a reconciliation failure, refresh still succeeds', async () => {
    const deps = depsAfterCreate({
      readLibrary: vi.fn().mockResolvedValue(echoSnapshot(['P-CREATED', 'P-ECHO'])),
      deletePlaylistById: vi.fn().mockRejectedValue(new BridgeError('jxa_error', 'boom')),
    });

    const out = (await handleRefreshLibrary({}, deps)) as RefreshLibraryOutput;
    expect(out.sync_reconciliation!.failures).toEqual([
      { name: 'Rearview', playlist_id: 'P-CREATED', error: expect.stringContaining('boom') },
    ]);
    // Cache untouched for the failed delete: both copies still visible.
    expect(deps.cacheInstance.listPlaylists({ nameQuery: 'Rearview' })).toHaveLength(2);
  });

  it('omits sync_reconciliation when there is nothing to reconcile', async () => {
    const deps = makeDeps();
    const out = (await handleRefreshLibrary({}, deps)) as RefreshLibraryOutput;
    expect(out.sync_reconciliation).toBeUndefined();
  });
});
