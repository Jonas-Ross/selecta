// Public typed API for the cache layer. Tools depend on this facade; nothing
// outside src/cache/ writes SQL. Usable as a plain Node library without MCP.

import type { Database } from 'better-sqlite3';
import type { LibrarySnapshot, PlaylistWriteResult } from '../types/bridge.js';
import type {
  CoOccurringTrack,
  PlaylistRef,
  PlaylistRow,
  SearchFilters,
  TrackRow,
} from '../types/cache.js';
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
      for (const playlist of snapshot.playlists) {
        q.upsertPlaylist(playlist);
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

  searchTracks(filters: SearchFilters): { rows: TrackRow[]; total: number } {
    return this.queries.searchTracks(filters);
  }

  listPlaylists(filters: { kind?: PlaylistRow['kind']; nameQuery?: string }): PlaylistRow[] {
    return this.queries.listPlaylists(filters);
  }

  getTrack(persistentId: string): TrackRow | null {
    return this.queries.getTrack(persistentId);
  }

  getTracksByArtist(artist: string, limit?: number): TrackRow[] {
    return this.queries.getTracksByArtist(artist, limit);
  }

  getPlaylistsContainingTrack(trackPersistentId: string): PlaylistRef[] {
    return this.queries.getPlaylistsContainingTrack(trackPersistentId);
  }

  getCoOccurringTracks(trackPersistentId: string, limit?: number): CoOccurringTrack[] {
    return this.queries.getCoOccurringTracks(trackPersistentId, limit);
  }

  /**
   * Surgical patch after a successful playlist write (docs/design.md §Decisions):
   * upsert the playlist row and replace its membership so the cache doesn't
   * desync — WITHOUT a full reread. Tracks are untouched, so no FTS work.
   */
  upsertPlaylistAfterWrite(result: PlaylistWriteResult, name: string, trackIds: string[]): void {
    const run = this.db.transaction(() => {
      this.queries.upsertPlaylist({
        persistentId: result.persistentId,
        name,
        kind: 'user',
        trackPersistentIds: trackIds,
      });
      this.queries.replacePlaylistMembership(result.persistentId, trackIds);
    });
    run();
  }

  close(): void {
    this.db.close();
  }
}
