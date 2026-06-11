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
