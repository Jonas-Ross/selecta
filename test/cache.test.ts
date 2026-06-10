// Cache layer against in-memory SQLite, seeded through the production write
// path (refreshFromSnapshot) — no bespoke seeding (docs/contracts.md §5).

import { describe, it, expect, beforeEach } from 'vitest';
import { SelectaCache } from '../src/cache/index.js';
import { openDatabase } from '../src/cache/db.js';
import { BridgeError } from '../src/types/errors.js';
import type { LibrarySnapshot } from '../src/types/bridge.js';
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

  it('appends a refresh_log entry with counts and duration', () => {
    const row = cache.db
      .prepare(
        'SELECT duration_ms AS ms, track_count AS tracks, playlist_count AS playlists FROM refresh_log ORDER BY refreshed_at DESC LIMIT 1',
      )
      .get() as { ms: number; tracks: number; playlists: number };
    expect(row).toEqual({ ms: 1234, tracks: 6, playlists: 4 });
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
