// Public typed API for the cache layer. Tools depend on this facade; nothing
// outside src/cache/ writes SQL. Usable as a plain Node library without MCP.

import type { Database } from 'better-sqlite3';
import type {
  LibrarySnapshot,
  PlaylistWriteResult,
  TrackLovedState,
  TrackRatingState,
} from '../types/bridge.js';
import type {
  AudioFeaturesRow,
  CoOccurrenceFilters,
  CoOccurrenceResult,
  NoteRow,
  NoteSubject,
  PendingTrack,
  OverviewStats,
  PlayHistoryWindow,
  PlaylistRef,
  PlaylistRow,
  ReconcileAction,
  SearchFilters,
  SearchResultRow,
  TrackRow,
} from '../types/cache.js';
import { openDatabase } from './db.js';
import { createQueries, recentSinceIso, type Queries } from './queries.js';

export { defaultDbPath } from './db.js';

// How long after creation a receipt can drive iCloud-sync reconciliation
// (docs/music-app.md, iCloud sync). Echo twins arrive ~10s–3min after
// creation; the window bounds receipt-based rekey inference, so a
// later intentional copy of the same playlist is never touched. Generous vs.
// the observed echo latency to cover slow refresh habits, small vs.
// "intentional duplicate" timescales. Lives here because the refresh prune
// uses the same window: a playlist note is shielded from pruning only while
// its receipt could still move it to a rekeyed ID.
export const RECONCILE_WINDOW_MINUTES = 60;

export type RefreshResult = {
  trackCount: number;
  playlistCount: number;
  refreshedAt: string;
  // Play-history capture (issue #31): how many tracks got a delta row this
  // refresh, and how many had a counter go DOWN (re-import/iCloud weirdness) —
  // those reset their baseline instead of recording a negative delta.
  playDeltasRecorded: number;
  playCountResets: number;
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
   * record play/skip deltas against the previous counters, upsert all tracks
   * and playlists, replace memberships, prune rows absent from the snapshot,
   * rebuild FTS, append a refresh_log entry. After commit the cache reflects
   * the snapshot exactly, plus one sparse play_history window.
   */
  refreshFromSnapshot(
    snapshot: LibrarySnapshot,
    opts: { durationMs: number; notes?: string },
  ): RefreshResult {
    // One timestamp for the refresh_log row, the play_history window, and the
    // return value.
    const refreshedAt = new Date().toISOString();
    const reconcilableSince = new Date(
      Date.parse(refreshedAt) - RECONCILE_WINDOW_MINUTES * 60_000,
    ).toISOString();
    const q = this.queries;
    let playDeltasRecorded = 0;
    let playCountResets = 0;
    const run = this.db.transaction(() => {
      // Previous counters BEFORE any upsert — the delta compare needs them.
      const prior = q.getPlayCounts();
      for (const track of snapshot.tracks) {
        const prev = prior.get(track.persistentId);
        if (prev) {
          // First sighting (no prev) establishes baseline silently. A counter
          // that went down resets its baseline — no negative deltas; the other
          // counter still records if it rose.
          const playDelta = (track.playCount ?? prev.playCount) - prev.playCount;
          const skipDelta = (track.skipCount ?? prev.skipCount) - prev.skipCount;
          if (playDelta < 0 || skipDelta < 0) playCountResets += 1;
          if (playDelta > 0 || skipDelta > 0) {
            q.insertPlayHistory({
              trackPersistentId: track.persistentId,
              refreshedAt,
              playCountDelta: Math.max(0, playDelta),
              skipCountDelta: Math.max(0, skipDelta),
            });
            playDeltasRecorded += 1;
          }
        }
        const previous = prior.get(track.persistentId);
        q.upsertTrack({
          ...track,
          playCount: track.playCount ?? previous?.playCount,
          skipCount: track.skipCount ?? previous?.skipCount,
        });
      }
      for (const playlist of snapshot.playlists) {
        q.upsertPlaylist(playlist);
        q.replacePlaylistMembership(playlist.persistentId, playlist.trackPersistentIds);
      }
      q.pruneTracksNotIn(new Set(snapshot.tracks.map((t) => t.persistentId)));
      q.prunePlaylistsNotIn(
        new Set(snapshot.playlists.map((p) => p.persistentId)),
        reconcilableSince,
      );
      q.rebuildFts();
      const resetNote =
        playCountResets > 0
          ? `${playCountResets} play-counter reset(s), baseline re-established`
          : null;
      q.appendRefreshLog({
        refreshedAt,
        durationMs: opts.durationMs,
        trackCount: snapshot.tracks.length,
        playlistCount: snapshot.playlists.length,
        notes: [opts.notes, resetNote].filter(Boolean).join('; ') || undefined,
      });
    });
    run();
    return {
      trackCount: snapshot.tracks.length,
      playlistCount: snapshot.playlists.length,
      refreshedAt,
      playDeltasRecorded,
      playCountResets,
    };
  }

  getCacheAgeHours(): number | null {
    return this.queries.getCacheAgeHours();
  }

  /** Add an observation to one completed refresh without rewriting its facts. */
  appendRefreshNote(refreshedAt: string, note: string): void {
    this.queries.appendRefreshNote(refreshedAt, note);
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

  searchTracks(filters: SearchFilters): { rows: SearchResultRow[]; total: number } {
    if (filters.inPlaylist != null) {
      filters = { ...filters, inPlaylist: this.resolvePlaylistId(filters.inPlaylist) };
    }
    return this.queries.searchTracks(filters);
  }

  /**
   * Aggregate shape of the library, or of the slice the filters describe.
   * recentSince bounds the recentActivity sums; defaults to the shared
   * RECENT_WINDOW_DAYS cutoff.
   */
  getOverview(filters: SearchFilters, recentSince = recentSinceIso()): OverviewStats {
    if (filters.inPlaylist != null) {
      filters = { ...filters, inPlaylist: this.resolvePlaylistId(filters.inPlaylist) };
    }
    return this.queries.overviewStats(filters, recentSince);
  }

  /** A track's play_history windows, newest first. */
  getTrackPlayHistory(trackPersistentId: string, limit: number): PlayHistoryWindow[] {
    return this.queries.getTrackPlayHistory(trackPersistentId, limit);
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

  /** Co-occurrence aggregated across the seed set; seeds are never candidates. */
  getCoOccurrence(
    seedIds: string[],
    filters?: CoOccurrenceFilters,
    limit?: number,
  ): CoOccurrenceResult {
    return this.queries.getCoOccurrence(seedIds, filters, limit);
  }

  /**
   * Persist one enrichment batch atomically. Rows live outside the tracks
   * refresh cycle (see schema.ts) — a refresh never rewrites them, only prunes
   * rows whose track left the library.
   */
  saveAudioFeatures(rows: AudioFeaturesRow[]): void {
    const run = this.db.transaction(() => {
      for (const row of rows) {
        // A concurrent refresh may have removed a track while its lookup was in flight.
        if (this.getTrack(row.trackPersistentId)) this.queries.upsertAudioFeatures(row);
      }
    });
    run();
  }

  /** Full features row with provenance; feature values also ride every TrackRow. */
  getAudioFeatures(trackPersistentId: string): AudioFeaturesRow | null {
    return this.queries.getAudioFeatures(trackPersistentId);
  }

  /** The enrichment backlog, most-played first: tracks never attempted. */
  getTracksPendingEnrichment(limit: number): PendingTrack[] {
    return this.queries.getTracksPendingEnrichment(limit);
  }

  countPendingEnrichment(): number {
    return this.queries.countPendingEnrichment();
  }

  /**
   * Upsert the model's note on a track or playlist (issue #32) and return the
   * stored row. Callers key playlists by canonical ID (resolvePlaylistId) so
   * the note lands where reconciliation expects it. Like audio_features, notes
   * live outside the refresh cycle: a reread never rewrites one, only prunes
   * notes whose subject left the library.
   */
  setNote(subjectKind: NoteSubject, subjectId: string, body: string): NoteRow {
    return this.queries.upsertNote(subjectKind, subjectId, body, new Date().toISOString());
  }

  /** Remove a note; a no-op when there is none. */
  clearNote(subjectKind: NoteSubject, subjectId: string): void {
    this.queries.deleteNote(subjectKind, subjectId);
  }

  getNote(subjectKind: NoteSubject, subjectId: string): NoteRow | null {
    return this.queries.getNote(subjectKind, subjectId);
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
   * Surgical patches after a track-signal write (set_loved / set_rating):
   * update exactly the written column on the affected rows, from the
   * post-write values the bridge read back from Music.app. Neither column is
   * FTS-indexed, so no FTS work; nothing else on the row moves.
   */
  patchTrackLoved(states: TrackLovedState[]): void {
    const run = this.db.transaction(() => {
      for (const state of states) this.queries.updateTrackLoved(state);
    });
    run();
  }

  patchTrackRating(states: TrackRatingState[]): void {
    const run = this.db.transaction(() => {
      for (const state of states) this.queries.updateTrackRating(state);
    });
    run();
  }

  /**
   * Surgical patch after the bridge deleted a playlist on the user's behalf:
   * drop its row, membership, and note, and retire any creation receipt
   * pointing at it — otherwise the next refresh's sync reconciliation could
   * rekey the dead receipt onto an iCloud-resurrected copy and undo the
   * deliberate delete. (Echo dedupe keeps its receipts — it remaps them via
   * applyDuplicateRemoval instead.) Track rows are untouched — only the
   * playlist goes.
   */
  deletePlaylistRow(persistentId: string): void {
    const run = this.db.transaction(() => {
      this.queries.deletePlaylistRow(persistentId);
      this.queries.deleteCreationsByCurrentId(persistentId);
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

  /** The name on a creation receipt, by the ID Selecta created it under. */
  getCreationName(createdId: string): string | null {
    return this.queries.getCreationName(createdId);
  }

  /**
   * The bridge just proved, in one script execution, that `staleId` is gone
   * from Music.app and the same playlist now lives under `live` (an iCloud
   * rekey observed at write time, not refresh time). Repoint every receipt
   * at the live ID, move the note, mirror the live row and order, drop the
   * stale row. No receipt is retired or created.
   */
  applyLiveRekey(
    staleId: string,
    live: { persistentId: string; name: string; trackIds: string[] },
  ): void {
    const run = this.db.transaction(() => {
      this.queries.repointCreations(staleId, live.persistentId);
      // Move before delete: deletePlaylistRow takes the note with the row.
      this.queries.movePlaylistNote(staleId, live.persistentId);
      this.upsertPlaylistAfterWrite(
        { persistentId: live.persistentId, trackCount: live.trackIds.length },
        live.name,
        live.trackIds,
      );
      this.queries.deletePlaylistRow(staleId);
    });
    run();
  }

  /** Names of playlists created within the window — the "watch list" for echo logging. */
  getRecentCreationNames(windowMinutes: number, now = new Date()): string[] {
    const since = new Date(now.getTime() - windowMinutes * 60_000).toISOString();
    return [...new Set(this.queries.getCreationsSince(since).map((c) => c.name))];
  }

  /**
   * Match recent receipts after refresh. Rekey only when the current ID is gone
   * and exactly one same-name playlist remains. Several copies are ambiguous:
   * identical contents cannot establish that an intentional copy is an echo.
   * Reserved slots identify by name; ordinary rekeys also require exact order.
   */
  planSyncReconciliation(opts: {
    windowMinutes: number;
    now?: Date;
    reservedSlotNames?: readonly string[];
  }): ReconcileAction[] {
    const now = opts.now ?? new Date();
    const since = new Date(now.getTime() - opts.windowMinutes * 60_000).toISOString();
    const creations = this.queries.getCreationsSince(since);
    const actions: ReconcileAction[] = [];
    for (const creation of creations) {
      const wanted = JSON.stringify(creation.trackIds);
      const sameNameIds = this.queries.getUserPlaylistIdsByName(creation.name);
      const matchIds = sameNameIds.filter(
        (id) => JSON.stringify(this.queries.getPlaylistTrackIds(id)) === wanted,
      );
      const currentId = creation.currentPersistentId;
      // A reserved slot rekeys by name alone, so several same-name copies
      // are ambiguous regardless of sequence; any other receipt rekeys to
      // the single exact-sequence match.
      const rekeyId = opts.reservedSlotNames?.includes(creation.name)
        ? sameNameIds.length === 1
          ? sameNameIds[0]!
          : null
        : matchIds.length === 1
          ? matchIds[0]!
          : null;
      if (
        rekeyId !== null &&
        rekeyId !== currentId &&
        sameNameIds.length === 1 &&
        !this.queries.playlistExists(currentId)
      ) {
        actions.push({
          kind: 'rekey',
          createdId: creation.createdPersistentId,
          name: creation.name,
          fromId: currentId,
          toId: rekeyId,
        });
      } else if (
        sameNameIds.length >= 2 &&
        !actions.some((a) => a.kind === 'ambiguous' && a.name === creation.name)
      ) {
        actions.push({ kind: 'ambiguous', name: creation.name, playlistIds: sameNameIds });
      }
    }
    return actions;
  }

  /**
   * Point a creation receipt at the playlist's current canonical ID, moving
   * the playlist's note with it so model memory survives an iCloud rekey.
   */
  applyRekey(createdId: string, fromId: string, toId: string): void {
    const run = this.db.transaction(() => {
      this.queries.movePlaylistNote(fromId, toId);
      this.queries.setCreationCurrentId(createdId, toId);
    });
    run();
  }

  /**
   * Patch the cache after the bridge deleted an echo duplicate: move any note
   * from the deleted copy to the survivor, drop the deleted playlist's rows,
   * and point the creation receipt at the survivor.
   */
  applyDuplicateRemoval(createdId: string, deletedId: string, keptId: string): void {
    const run = this.db.transaction(() => {
      // Move before delete: deletePlaylistRow takes the note with the row.
      this.queries.movePlaylistNote(deletedId, keptId);
      this.queries.deletePlaylistRow(deletedId);
      this.queries.setCreationCurrentId(createdId, keptId);
    });
    run();
  }

  close(): void {
    this.db.close();
  }
}
