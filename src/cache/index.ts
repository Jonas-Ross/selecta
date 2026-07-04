// Public typed API for the cache layer. Tools depend on this facade; nothing
// outside src/cache/ writes SQL. Usable as a plain Node library without MCP.

import type { Database } from 'better-sqlite3';
import type { LibrarySnapshot, PlaylistWriteResult } from '../types/bridge.js';
import type {
  CoOccurringTrack,
  OverviewStats,
  PlaylistRef,
  PlaylistRow,
  ReconcileAction,
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
   * the cache reflects the snapshot exactly.
   */
  refreshFromSnapshot(
    snapshot: LibrarySnapshot,
    opts: { durationMs: number; notes?: string },
  ): RefreshResult {
    // One timestamp for both the refresh_log row and the return value.
    const refreshedAt = new Date().toISOString();
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
        refreshedAt,
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
      refreshedAt,
    };
  }

  getCacheAgeHours(): number | null {
    return this.queries.getCacheAgeHours();
  }

  /**
   * Canonicalize an externally supplied playlist ID. A creation-time ID may
   * have been rekeyed by iCloud sync or reconciled away as an echo duplicate;
   * if the literal ID is gone, follow the creation receipt to the canonical
   * ID. Any consumer of model-supplied playlist IDs should route through this.
   */
  resolvePlaylistId(persistentId: string): string {
    if (this.queries.playlistExists(persistentId)) return persistentId;
    return this.queries.resolveCreatedPlaylistId(persistentId) ?? persistentId;
  }

  searchTracks(filters: SearchFilters): { rows: TrackRow[]; total: number } {
    if (filters.inPlaylist != null) {
      filters = { ...filters, inPlaylist: this.resolvePlaylistId(filters.inPlaylist) };
    }
    return this.queries.searchTracks(filters);
  }

  /** Aggregate shape of the library, or of the slice the filters describe. */
  getOverview(filters: SearchFilters): OverviewStats {
    if (filters.inPlaylist != null) {
      filters = { ...filters, inPlaylist: this.resolvePlaylistId(filters.inPlaylist) };
    }
    return this.queries.overviewStats(filters);
  }

  listPlaylists(filters: { kind?: PlaylistRow['kind']; nameQuery?: string }): PlaylistRow[] {
    return this.queries.listPlaylists(filters);
  }

  getPlaylist(persistentId: string): PlaylistRow | null {
    return this.queries.getPlaylist(persistentId);
  }

  /** The playlist's cached track IDs in playlist order (duplicates preserved). */
  getPlaylistTrackIds(persistentId: string): string[] {
    return this.queries.getPlaylistTrackIds(persistentId);
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
   * Surgical patch after a successful playlist write:
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

  /**
   * Surgical patch after an in-place playlist edit: replace the membership
   * with the post-edit order the bridge read back from Music.app. The playlist
   * row itself (name/kind) is unchanged by an edit, so only membership moves.
   */
  patchPlaylistMembership(persistentId: string, trackIds: string[]): void {
    const run = this.db.transaction(() => {
      this.queries.replacePlaylistMembership(persistentId, trackIds);
    });
    run();
  }

  /**
   * Surgical patch after the bridge deleted a playlist: drop its row and
   * membership. Track rows are untouched — only the playlist goes.
   */
  deletePlaylistRow(persistentId: string): void {
    const run = this.db.transaction(() => {
      this.queries.deletePlaylistRow(persistentId);
    });
    run();
  }

  /**
   * Record a creation receipt for a playlist Selecta just created. Drives
   * refresh-time iCloud-echo reconciliation and ID-rekey aliasing.
   */
  recordPlaylistCreation(createdId: string, name: string, trackIds: string[]): void {
    this.queries.recordPlaylistCreation({
      createdId,
      name,
      trackIds,
      createdAt: new Date().toISOString(),
    });
  }

  /** Names of playlists created within the window — the "watch list" for echo logging. */
  getRecentCreationNames(windowMinutes: number, now = new Date()): string[] {
    const since = new Date(now.getTime() - windowMinutes * 60_000).toISOString();
    return [...new Set(this.queries.getCreationsSince(since).map((c) => c.name))];
  }

  /**
   * Compare the just-refreshed cache against recent creation receipts and plan
   * iCloud-sync reconciliation (docs/music-app.md, iCloud sync). Pure
   * read — applying the plan is the caller's job (deletes go through the
   * bridge first). Matching is deliberately conservative: same name, kind
   * 'user', and the EXACT ordered track sequence we created — so intentional
   * same-name playlists and user-edited copies are never touched. Only
   * creations within `windowMinutes` are considered.
   */
  planSyncReconciliation(opts: { windowMinutes: number; now?: Date }): ReconcileAction[] {
    const now = opts.now ?? new Date();
    const since = new Date(now.getTime() - opts.windowMinutes * 60_000).toISOString();
    const creations = this.queries.getCreationsSince(since);
    // Two in-window receipts with the same name + sequence are mutually
    // indistinguishable from each other's echo — each would plan to delete the
    // other's playlist (reciprocal data loss). Ambiguous groups get no
    // destructive actions; rekey remapping below is unaffected.
    const receiptKey = (name: string, trackIdsJson: string): string =>
      JSON.stringify([name, trackIdsJson]);
    const receiptsPerKey = new Map<string, number>();
    for (const c of creations) {
      const key = receiptKey(c.name, JSON.stringify(c.trackIds));
      receiptsPerKey.set(key, (receiptsPerKey.get(key) ?? 0) + 1);
    }
    const actions: ReconcileAction[] = [];
    for (const creation of creations) {
      const wanted = JSON.stringify(creation.trackIds);
      const matchIds = this.queries
        .getUserPlaylistIdsByName(creation.name)
        .filter((id) => JSON.stringify(this.queries.getPlaylistTrackIds(id)) === wanted);
      const currentId = creation.currentPersistentId;
      if (matchIds.length === 1 && matchIds[0] !== currentId) {
        actions.push({
          kind: 'rekey',
          createdId: creation.createdPersistentId,
          name: creation.name,
          fromId: currentId,
          toId: matchIds[0]!,
        });
      } else if (
        matchIds.length >= 2 &&
        receiptsPerKey.get(receiptKey(creation.name, wanted)) === 1
      ) {
        // Keep the iCloud-keyed twin (observed canonical: rekeys survive under
        // the NEW id), i.e. prefer a copy whose ID is not the one we created.
        const keepId = matchIds.find((id) => id !== currentId) ?? matchIds[0]!;
        actions.push({
          kind: 'duplicate',
          createdId: creation.createdPersistentId,
          name: creation.name,
          keepId,
          deleteIds: matchIds.filter((id) => id !== keepId),
        });
      }
    }
    return actions;
  }

  /** Point a creation receipt at the playlist's current canonical ID. */
  applyRekey(createdId: string, toId: string): void {
    this.queries.setCreationCurrentId(createdId, toId);
  }

  /**
   * Patch the cache after the bridge deleted an echo duplicate: drop the
   * deleted playlist's rows and point the creation receipt at the survivor.
   */
  applyDuplicateRemoval(createdId: string, deletedId: string, keptId: string): void {
    const run = this.db.transaction(() => {
      this.queries.deletePlaylistRow(deletedId);
      this.queries.setCreationCurrentId(createdId, keptId);
    });
    run();
  }

  close(): void {
    this.db.close();
  }
}
