// Cache layer against in-memory SQLite, seeded through the production write
// path (refreshFromSnapshot) — no bespoke seeding.

import { describe, it, expect, beforeEach } from 'vitest';
import { SelectaCache } from '../src/cache/index.js';
import { openDatabase } from '../src/cache/db.js';
import { BridgeError } from '../src/types/errors.js';
import type { LibrarySnapshot } from '../src/types/bridge.js';
import { featuresRow } from './helpers.js';
import fixture from './fixtures/library.json' with { type: 'json' };

const snapshot = fixture as LibrarySnapshot;

function freshCache(): SelectaCache {
  return SelectaCache.open(':memory:');
}

function refreshed(): SelectaCache {
  const cache = freshCache();
  cache.refreshFromSnapshot(snapshot, { durationMs: 1234 });
  return cache;
}

describe('openDatabase', () => {
  it('throws cache_unavailable when the path cannot be created', () => {
    expect(() => openDatabase('/dev/null/selecta/library.db')).toThrow(BridgeError);
    try {
      openDatabase('/dev/null/selecta/library.db');
    } catch (err) {
      expect((err as BridgeError).errorCode).toBe('cache_unavailable');
    }
  });
});

describe('refreshFromSnapshot', () => {
  let cache: SelectaCache;
  beforeEach(() => {
    cache = refreshed();
  });

  it('reports snapshot counts', () => {
    const result = cache.refreshFromSnapshot(snapshot, { durationMs: 1 });
    expect(result.trackCount).toBe(6);
    expect(result.playlistCount).toBe(4);
  });

  it('normalizes track rows: booleans to 0/1, floats rounded, absent to NULL', () => {
    const row = cache.db
      .prepare('SELECT * FROM tracks WHERE persistent_id = ?')
      .get('T-TEARDROP') as Record<string, unknown>;
    expect(row.title).toBe('Teardrop');
    expect(row.loved).toBe(1);
    expect(row.disliked).toBe(0);
    expect(row.duration_seconds).toBe(331); // 330.5 rounded
    expect(row.rating).toBe(100);
    expect(row.location_kind).toBe('local');
    expect(row.bpm).toBeNull();
  });

  it('applies defaults to a bare track: counts 0, everything else NULL', () => {
    const row = cache.db
      .prepare('SELECT * FROM tracks WHERE persistent_id = ?')
      .get('T-BARE') as Record<string, unknown>;
    expect(row.play_count).toBe(0);
    expect(row.skip_count).toBe(0);
    expect(row.loved).toBe(0);
    expect(row.title).toBeNull();
    expect(row.rating).toBeNull();
  });

  it('stores playlist membership in order', () => {
    const rows = cache.db
      .prepare(
        'SELECT track_persistent_id AS id FROM playlist_tracks WHERE playlist_persistent_id = ? ORDER BY position',
      )
      .all('P-LATENIGHT') as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual(['T-TEARDROP', 'T-GLORYBOX', 'T-ROADS']);
  });

  it('stores playlist rows including kind and parent', () => {
    const row = cache.db
      .prepare('SELECT * FROM playlists WHERE persistent_id = ?')
      .get('P-LATENIGHT') as Record<string, unknown>;
    expect(row.name).toBe('Late Night');
    expect(row.kind).toBe('user');
    expect(row.parent_persistent_id).toBe('P-MOODS');
  });

  it('makes tracks findable via FTS after refresh', () => {
    const rows = cache.db
      .prepare(
        'SELECT t.persistent_id AS id FROM tracks_fts f JOIN tracks t ON t.rowid = f.rowid WHERE tracks_fts MATCH ?',
      )
      .all('teardrop') as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual(['T-TEARDROP']);
  });

  it('upserts on re-refresh: changed metadata lands, no duplicate rows', () => {
    const changed: LibrarySnapshot = {
      ...snapshot,
      tracks: snapshot.tracks.map((t) =>
        t.persistentId === 'T-TEARDROP' ? { ...t, playCount: 43 } : t,
      ),
    };
    cache.refreshFromSnapshot(changed, { durationMs: 1 });
    const rows = cache.db
      .prepare('SELECT play_count AS plays FROM tracks WHERE persistent_id = ?')
      .all('T-TEARDROP') as { plays: number }[];
    expect(rows).toEqual([{ plays: 43 }]);
  });

  it('prunes tracks, playlists, and memberships absent from the new snapshot', () => {
    const smaller: LibrarySnapshot = {
      capturedAt: snapshot.capturedAt,
      tracks: snapshot.tracks.filter((t) => t.persistentId !== 'T-MIDNIGHT'),
      playlists: snapshot.playlists.filter((p) => p.persistentId !== 'P-RECENT'),
    };
    cache.refreshFromSnapshot(smaller, { durationMs: 1 });

    const track = cache.db
      .prepare('SELECT 1 FROM tracks WHERE persistent_id = ?')
      .get('T-MIDNIGHT');
    expect(track).toBeUndefined();

    const playlist = cache.db
      .prepare('SELECT 1 FROM playlists WHERE persistent_id = ?')
      .get('P-RECENT');
    expect(playlist).toBeUndefined();

    const memberships = cache.db
      .prepare('SELECT 1 FROM playlist_tracks WHERE playlist_persistent_id = ?')
      .all('P-RECENT');
    expect(memberships).toEqual([]);

    // FTS no longer matches the pruned track.
    const fts = cache.db
      .prepare('SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH ?')
      .all('midnight');
    expect(fts).toEqual([]);
  });

  it('returns the same refreshedAt it stores in refresh_log', () => {
    const result = cache.refreshFromSnapshot(snapshot, { durationMs: 1 });
    const row = cache.db
      .prepare('SELECT refreshed_at AS at FROM refresh_log ORDER BY refreshed_at DESC LIMIT 1')
      .get() as { at: string };
    expect(row.at).toBe(result.refreshedAt);
  });

  it('appends a refresh_log entry with counts and duration', () => {
    const row = cache.db
      .prepare(
        'SELECT duration_ms AS ms, track_count AS tracks, playlist_count AS playlists FROM refresh_log ORDER BY refreshed_at DESC LIMIT 1',
      )
      .get() as { ms: number; tracks: number; playlists: number };
    expect(row).toEqual({ ms: 1234, tracks: 6, playlists: 4 });
  });
});

describe('audio features', () => {
  let cache: SelectaCache;
  beforeEach(() => {
    cache = refreshed();
  });

  it('round-trips a row, including the JSON sources map', () => {
    const row = featuresRow();
    cache.saveAudioFeatures([row]);
    expect(cache.getAudioFeatures('T-TEARDROP')).toEqual(row);
    expect(cache.getAudioFeatures('T-ANGEL')).toBeNull();
  });

  it('rides every track projection, enriched bpm shadowing the native tag', () => {
    cache.saveAudioFeatures([featuresRow()]);
    const track = cache.getTrack('T-TEARDROP')!;
    expect(track.bpm).toBe(78.42);
    expect(track.musicalKey).toBe('A minor');
    expect(track.danceability).toBe(0.618);
    // Unenriched: native tag where present, else null.
    expect(cache.getTrack('T-GLORYBOX')!.bpm).toBe(95);
    expect(cache.getTrack('T-ANGEL')!.bpm).toBeNull();
  });

  it('survives a full library refresh untouched', () => {
    cache.saveAudioFeatures([featuresRow()]);
    cache.refreshFromSnapshot(snapshot, { durationMs: 1 });
    expect(cache.getAudioFeatures('T-TEARDROP')).toEqual(featuresRow());
    expect(cache.getTrack('T-TEARDROP')!.bpm).toBe(78.42);
  });

  it('is pruned when its track leaves the library', () => {
    cache.saveAudioFeatures([featuresRow()]);
    const without = {
      ...snapshot,
      tracks: snapshot.tracks.filter((t) => t.persistentId !== 'T-TEARDROP'),
    };
    cache.refreshFromSnapshot(without, { durationMs: 1 });
    expect(cache.getAudioFeatures('T-TEARDROP')).toBeNull();
  });

  it('filters search by effective bpm: enriched wins over native, unknown never matches', () => {
    // T-GLORYBOX carries a native tag of 95 from the fixture.
    let { rows } = cache.searchTracks({ bpmMin: 90, bpmMax: 100 });
    expect(rows.map((r) => r.persistentId)).toEqual(['T-GLORYBOX']);

    // An enriched value overrides the native tag...
    cache.saveAudioFeatures([featuresRow({ trackPersistentId: 'T-GLORYBOX', bpm: 120 })]);
    rows = cache.searchTracks({ bpmMin: 90, bpmMax: 100 }).rows;
    expect(rows).toEqual([]);
    rows = cache.searchTracks({ bpmMin: 115, bpmMax: 125 }).rows;
    expect(rows.map((r) => r.persistentId)).toEqual(['T-GLORYBOX']);

    // ...and tracks with no tempo at all never match a bpm filter.
    rows = cache.searchTracks({ bpmMin: 1 }).rows;
    expect(rows.map((r) => r.persistentId)).toEqual(['T-GLORYBOX']);
  });

  it('counts withBpm across native and enriched tempos in overview stats', () => {
    expect(cache.getOverview({}).withBpm).toBe(1); // native T-GLORYBOX
    cache.saveAudioFeatures([featuresRow()]);
    expect(cache.getOverview({}).withBpm).toBe(2);
  });
});

describe('getCacheAgeHours', () => {
  it('returns null before any refresh', () => {
    expect(freshCache().getCacheAgeHours()).toBeNull();
  });

  it('returns ~0 right after a refresh', () => {
    const age = refreshed().getCacheAgeHours();
    expect(age).not.toBeNull();
    expect(age!).toBeGreaterThanOrEqual(0);
    expect(age!).toBeLessThan(0.01);
  });
});

describe('searchTracks guards', () => {
  it('rejects sort playlist_order without inPlaylist (plain-library consumers)', () => {
    // The tool layer returns a structured validation_error first; this guards
    // cache-as-library callers against a cryptic unbound-parameter sqlite error.
    expect(() => refreshed().searchTracks({ sort: 'playlist_order' })).toThrow(/inPlaylist/);
  });
});

describe('overviewStats', () => {
  it('aggregates the whole library', () => {
    const stats = refreshed().getOverview({});
    expect(stats.totalTracks).toBe(6);
    expect(stats.totalRuntimeSeconds).toBe(1563); // 331+379+305+304+244, T-BARE null → 0
    expect(stats.artistsTotal).toBe(3);
    expect(stats.loved).toBe(2);
    expect(stats.disliked).toBe(0);
    expect(stats.rated).toBe(2);
    expect(stats.unrated).toBe(4);
    expect(stats.neverPlayed).toBe(1); // only T-BARE has play_count 0
    expect(stats.local).toBe(2);
    expect(stats.cloud).toBe(3);
    expect(stats.unknownLocation).toBe(1); // T-BARE has no location_kind
    expect(stats.earliestAdded).toBe('2024-01-10T08:00:00.000Z');
    expect(stats.latestAdded).toBe('2025-11-05T08:00:00.000Z');
  });

  it('orders genres by count then name, skipping tracks with no genre', () => {
    expect(refreshed().getOverview({}).genres).toEqual([
      { name: 'Trip-Hop', count: 4 },
      { name: 'Electronic', count: 1 },
    ]);
  });

  it('buckets years into decades, ascending', () => {
    expect(refreshed().getOverview({}).decades).toEqual([
      { decade: 1990, count: 4 },
      { decade: 2010, count: 1 },
    ]);
  });

  it('ranks artists by track count, breaking ties by name', () => {
    expect(refreshed().getOverview({}).topArtists).toEqual([
      { name: 'Massive Attack', trackCount: 2 },
      { name: 'Portishead', trackCount: 2 },
      { name: 'M83', trackCount: 1 },
    ]);
  });

  it('reports a rating histogram on the 0..100 scale, descending', () => {
    expect(refreshed().getOverview({}).ratingHistogram).toEqual([
      { rating: 100, count: 1 },
      { rating: 80, count: 1 },
    ]);
  });

  it('scopes every aggregate to a filtered slice', () => {
    const stats = refreshed().getOverview({ artist: 'Portishead' });
    expect(stats.totalTracks).toBe(2);
    expect(stats.totalRuntimeSeconds).toBe(609);
    expect(stats.artistsTotal).toBe(1);
    expect(stats.genres).toEqual([{ name: 'Trip-Hop', count: 2 }]);
    expect(stats.loved).toBe(1);
    expect(stats.rated).toBe(0);
    expect(stats.ratingHistogram).toEqual([]);
  });

  it('scopes by playlist membership (follows the resolve path)', () => {
    expect(refreshed().getOverview({ inPlaylist: 'P-LATENIGHT' }).totalTracks).toBe(3);
  });

  it('returns zeros and empty groups on a never-refreshed cache', () => {
    const stats = freshCache().getOverview({});
    expect(stats.totalTracks).toBe(0);
    expect(stats.totalRuntimeSeconds).toBe(0);
    expect(stats.artistsTotal).toBe(0);
    expect(stats.neverPlayed).toBe(0);
    expect(stats.genres).toEqual([]);
    expect(stats.decades).toEqual([]);
    expect(stats.topArtists).toEqual([]);
    expect(stats.ratingHistogram).toEqual([]);
    expect(stats.earliestAdded).toBeNull();
    expect(stats.latestAdded).toBeNull();
  });
});

// iCloud-echo reconciliation (docs/music-app.md, iCloud sync): creation
// receipts + planSyncReconciliation + the apply helpers.
describe('sync reconciliation', () => {
  const CREATED_ID = 'P-CREATED';
  const TRACKS = ['T-TEARDROP', 'T-ROADS'];
  const NAME = 'Rearview';

  // A snapshot as the next refresh would see it: the fixture library plus the
  // given variants of the playlist Selecta created.
  function snapshotWith(
    ...copies: { id: string; name?: string; tracks?: string[] }[]
  ): LibrarySnapshot {
    return {
      ...snapshot,
      playlists: [
        ...snapshot.playlists,
        ...copies.map((c) => ({
          persistentId: c.id,
          name: c.name ?? NAME,
          kind: 'user' as const,
          trackPersistentIds: c.tracks ?? TRACKS,
        })),
      ],
    };
  }

  function cacheAfterCreate(): SelectaCache {
    const cache = refreshed();
    cache.upsertPlaylistAfterWrite({ persistentId: CREATED_ID, trackCount: TRACKS.length }, NAME, TRACKS);
    cache.recordPlaylistCreation(CREATED_ID, NAME, TRACKS);
    return cache;
  }

  it('plans nothing when the created playlist survives cleanly (LOW BEAMS case)', () => {
    const cache = cacheAfterCreate();
    cache.refreshFromSnapshot(snapshotWith({ id: CREATED_ID }), { durationMs: 1 });
    expect(cache.planSyncReconciliation({ windowMinutes: 60 })).toEqual([]);
  });

  it('plans a rekey when iCloud reassigned the ID (DASH CAM case)', () => {
    const cache = cacheAfterCreate();
    cache.refreshFromSnapshot(snapshotWith({ id: 'P-REKEYED' }), { durationMs: 1 });
    expect(cache.planSyncReconciliation({ windowMinutes: 60 })).toEqual([
      { kind: 'rekey', createdId: CREATED_ID, name: NAME, fromId: CREATED_ID, toId: 'P-REKEYED' },
    ]);
  });

  it('plans deleting the created copy, keeping the iCloud twin (REARVIEW case)', () => {
    const cache = cacheAfterCreate();
    cache.refreshFromSnapshot(snapshotWith({ id: CREATED_ID }, { id: 'P-ECHO' }), {
      durationMs: 1,
    });
    expect(cache.planSyncReconciliation({ windowMinutes: 60 })).toEqual([
      { kind: 'duplicate', createdId: CREATED_ID, name: NAME, keepId: 'P-ECHO', deleteIds: [CREATED_ID] },
    ]);
  });

  it('plans no deletes when two receipts share name and sequence (reciprocal-echo ambiguity)', () => {
    // Two intentional same-name same-sequence creations in-window: each looks
    // like the other's echo. A naive plan would delete BOTH (reciprocal data
    // loss) — the planner must stand down on ambiguous groups.
    const cache = refreshed();
    for (const id of ['P-FIRST', 'P-SECOND']) {
      cache.upsertPlaylistAfterWrite({ persistentId: id, trackCount: TRACKS.length }, NAME, TRACKS);
      cache.recordPlaylistCreation(id, NAME, TRACKS);
    }
    cache.refreshFromSnapshot(snapshotWith({ id: 'P-FIRST' }, { id: 'P-SECOND' }), {
      durationMs: 1,
    });
    expect(cache.planSyncReconciliation({ windowMinutes: 60 })).toEqual([]);
  });

  it('never touches same-name twins with no creation receipt (legacy Relax/Workout dupes)', () => {
    const cache = refreshed();
    cache.refreshFromSnapshot(
      snapshotWith({ id: 'P-RELAX-1', name: 'Relax' }, { id: 'P-RELAX-2', name: 'Relax' }),
      { durationMs: 1 },
    );
    expect(cache.planSyncReconciliation({ windowMinutes: 60 })).toEqual([]);
  });

  it('ignores receipts older than the window', () => {
    const cache = cacheAfterCreate();
    cache.refreshFromSnapshot(snapshotWith({ id: CREATED_ID }, { id: 'P-ECHO' }), {
      durationMs: 1,
    });
    const later = new Date(Date.now() + 2 * 3_600_000);
    expect(cache.planSyncReconciliation({ windowMinutes: 60, now: later })).toEqual([]);
  });

  it('ignores copies whose track sequence no longer matches the receipt', () => {
    const cache = cacheAfterCreate();
    // The "twin" was edited (extra track) — order/content mismatch, hands off.
    cache.refreshFromSnapshot(
      snapshotWith({ id: CREATED_ID }, { id: 'P-EDITED', tracks: [...TRACKS, 'T-ANGEL'] }),
      { durationMs: 1 },
    );
    expect(cache.planSyncReconciliation({ windowMinutes: 60 })).toEqual([]);
  });

  it('applyDuplicateRemoval drops the deleted copy and remaps the receipt', () => {
    const cache = cacheAfterCreate();
    cache.refreshFromSnapshot(snapshotWith({ id: CREATED_ID }, { id: 'P-ECHO' }), {
      durationMs: 1,
    });
    cache.applyDuplicateRemoval(CREATED_ID, CREATED_ID, 'P-ECHO');

    const rows = cache.listPlaylists({ nameQuery: NAME });
    expect(rows.map((p) => p.persistentId)).toEqual(['P-ECHO']);
    // The creation-time ID stays resolvable: searches against it hit the survivor.
    const { rows: tracks } = cache.searchTracks({ inPlaylist: CREATED_ID });
    expect(tracks.map((t) => t.persistentId).sort()).toEqual([...TRACKS].sort());
  });

  it('applyRekey keeps the creation-time ID resolvable after an iCloud rekey', () => {
    const cache = cacheAfterCreate();
    cache.refreshFromSnapshot(snapshotWith({ id: 'P-REKEYED' }), { durationMs: 1 });
    cache.applyRekey(CREATED_ID, 'P-REKEYED');

    const { rows } = cache.searchTracks({ inPlaylist: CREATED_ID });
    expect(rows.map((t) => t.persistentId).sort()).toEqual([...TRACKS].sort());
  });

  it('getOverview scopes by a creation-time ID after a rekey (resolve path)', () => {
    const cache = cacheAfterCreate();
    cache.refreshFromSnapshot(snapshotWith({ id: 'P-REKEYED' }), { durationMs: 1 });
    cache.applyRekey(CREATED_ID, 'P-REKEYED');

    // The canonical-ID overview test exercises the no-op resolve; this covers
    // the receipt-follow branch getOverview shares with searchTracks.
    expect(cache.getOverview({ inPlaylist: CREATED_ID }).totalTracks).toBe(TRACKS.length);
  });

  it('getRecentCreationNames lists only in-window names', () => {
    const cache = cacheAfterCreate();
    expect(cache.getRecentCreationNames(60)).toEqual([NAME]);
    expect(cache.getRecentCreationNames(60, new Date(Date.now() + 2 * 3_600_000))).toEqual([]);
  });
});
