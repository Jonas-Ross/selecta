// Public typed API for the cache layer. Tools depend on this facade; nothing
// outside src/cache/ writes SQL. Usable as a plain Node library without MCP.

import type { Database } from 'better-sqlite3';
import type { LibrarySnapshot } from '../types/bridge.js';
import { openDatabase } from './db.js';
import { createQueries, type Queries } from './queries.js';

export { defaultDbPath } from './db.js';

export type RefreshResult = {
  trackCount: number;
  playlistCount: number;
  refreshedAt: string;
};

export class SelectaCache {
  private readonly queries: Queries;

  // The raw handle is exposed for tests and debugging only — production reads
  // go through the named methods below.
  constructor(public readonly db: Database) {
    this.queries = createQueries(db);
  }

  static open(path?: string): SelectaCache {
    return new SelectaCache(openDatabase(path));
  }

  /**
   * Replace the cache contents with a library snapshot, atomically:
   * upsert all tracks and playlists, replace memberships, prune rows absent
   * from the snapshot, rebuild FTS, append a refresh_log entry. After commit
   * the cache reflects the snapshot exactly (docs/contracts.md §3).
   */
  refreshFromSnapshot(
    snapshot: LibrarySnapshot,
    opts: { durationMs: number; notes?: string },
  ): RefreshResult {
    const q = this.queries;
    const run = this.db.transaction(() => {
      for (const track of snapshot.tracks) q.upsertTrack(track);
      for (const playlist of snapshot.playlists) q.upsertPlaylist(playlist);
      for (const playlist of snapshot.playlists) {
        q.replacePlaylistMembership(playlist.persistentId, playlist.trackPersistentIds);
      }
      q.pruneTracksNotIn(new Set(snapshot.tracks.map((t) => t.persistentId)));
      q.prunePlaylistsNotIn(new Set(snapshot.playlists.map((p) => p.persistentId)));
      q.rebuildFts();
      q.appendRefreshLog({
        durationMs: opts.durationMs,
        trackCount: snapshot.tracks.length,
        playlistCount: snapshot.playlists.length,
        notes: opts.notes,
      });
    });
    run();
    return {
      trackCount: snapshot.tracks.length,
      playlistCount: snapshot.playlists.length,
      refreshedAt: new Date().toISOString(),
    };
  }

  getCacheAgeHours(): number | null {
    return this.queries.getCacheAgeHours();
  }

  close(): void {
    this.db.close();
  }
}
