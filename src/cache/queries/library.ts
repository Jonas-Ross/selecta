// Connection-owned query statements. Transactions belong to SelectaCache.
import type { Database, Statement } from 'better-sqlite3';
import type { RawTrack, TrackLovedState, TrackRatingState } from '../../types/bridge.js';
import type { PlayHistoryWindow } from '../../types/cache.js';

export function createLibraryQueries(db: Database) {
  const upsertTrackStmt: Statement = db.prepare(`
    INSERT INTO tracks (
      persistent_id, title, artist, album_artist, album, genre,
      year, duration_seconds, bpm, track_number, disc_number,
      date_added, last_played, play_count, skip_count,
      rating, loved, disliked, comments, location_kind
    ) VALUES (
      @persistentId, @title, @artist, @albumArtist, @album, @genre,
      @year, @durationSeconds, @bpm, @trackNumber, @discNumber,
      @dateAdded, @lastPlayed, @playCount, @skipCount,
      @rating, @loved, @disliked, @comments, @locationKind
    )
    ON CONFLICT(persistent_id) DO UPDATE SET
      title=excluded.title, artist=excluded.artist, album_artist=excluded.album_artist,
      album=excluded.album, genre=excluded.genre, year=excluded.year,
      duration_seconds=excluded.duration_seconds, bpm=excluded.bpm,
      track_number=excluded.track_number, disc_number=excluded.disc_number,
      date_added=excluded.date_added, last_played=excluded.last_played,
      play_count=excluded.play_count, skip_count=excluded.skip_count,
      rating=excluded.rating, loved=excluded.loved, disliked=excluded.disliked,
      comments=excluded.comments, location_kind=excluded.location_kind
  `);

  const updateTrackLovedStmt = db.prepare(
    'UPDATE tracks SET loved = @loved WHERE persistent_id = @persistentId',
  );

  const updateTrackRatingStmt = db.prepare(
    'UPDATE tracks SET rating = @rating WHERE persistent_id = @persistentId',
  );

  // Pre-refresh counter snapshot for play-history deltas: read before any
  // upsert so the comparison sees the previous refresh's values.
  const playCountsStmt = db.prepare(
    'SELECT persistent_id AS persistentId, play_count AS playCount, skip_count AS skipCount FROM tracks',
  );

  // OR REPLACE mirrors refresh_log: two refreshes in the same millisecond
  // collapse to the latest.
  const insertPlayHistoryStmt = db.prepare(`
    INSERT OR REPLACE INTO play_history
      (track_persistent_id, refreshed_at, play_count_delta, skip_count_delta)
    VALUES (@trackPersistentId, @refreshedAt, @playCountDelta, @skipCountDelta)
  `);

  const trackPlayHistoryStmt = db.prepare(`
    SELECT refreshed_at AS refreshedAt, play_count_delta AS playCountDelta,
           skip_count_delta AS skipCountDelta
    FROM play_history WHERE track_persistent_id = ?
    ORDER BY refreshed_at DESC LIMIT ?
  `);

  // json_each keeps us clear of SQLite's bound-variable ceiling on 10k-track prunes.
  const pruneTracksStmt = db.prepare(
    'DELETE FROM tracks WHERE persistent_id NOT IN (SELECT value FROM json_each(?))',
  );

  // Features follow their track out of the library; features of surviving
  // tracks are untouched by refresh (the survive-refresh guarantee on #19).
  const pruneFeaturesStmt = db.prepare(
    'DELETE FROM audio_features WHERE track_persistent_id NOT IN (SELECT value FROM json_each(?))',
  );

  // Play history follows its track out too — same lifecycle as features.
  const prunePlayHistoryStmt = db.prepare(
    'DELETE FROM play_history WHERE track_persistent_id NOT IN (SELECT value FROM json_each(?))',
  );

  // Notes follow their subject out of the library (issue #32). A playlist note
  // whose ID a still-reconcilable creation receipt names is kept: the ID may
  // have been rekeyed by iCloud, and reconciliation moves the note to the new
  // ID right after this refresh. Older receipts can never be reconciled, so
  // their notes prune like any other.
  const pruneTrackNotesStmt = db.prepare(
    `DELETE FROM notes WHERE subject_kind = 'track'
       AND subject_id NOT IN (SELECT value FROM json_each(?))`,
  );

  const prunePlaylistNotesStmt = db.prepare(
    `DELETE FROM notes WHERE subject_kind = 'playlist'
       AND subject_id NOT IN (SELECT value FROM json_each(?))
       AND subject_id NOT IN (
         SELECT current_persistent_id FROM playlist_creations WHERE created_at >= ?
       )`,
  );

  const prunePlaylistsStmt = db.prepare(
    'DELETE FROM playlists WHERE persistent_id NOT IN (SELECT value FROM json_each(?))',
  );

  const pruneMembershipsStmt = db.prepare(
    'DELETE FROM playlist_tracks WHERE playlist_persistent_id NOT IN (SELECT value FROM json_each(?))',
  );

  // refreshed_at (ISO, ms precision) is the primary key — two refreshes inside
  // the same millisecond collapse to the latest, which is fine for a log.
  const appendRefreshLogStmt = db.prepare(`
    INSERT OR REPLACE INTO refresh_log (refreshed_at, duration_ms, track_count, playlist_count, notes)
    VALUES (@refreshedAt, @durationMs, @trackCount, @playlistCount, @notes)
  `);

  const appendRefreshNoteStmt = db.prepare(`
    UPDATE refresh_log
       SET notes = CASE WHEN notes IS NULL OR notes = '' THEN @note ELSE notes || '; ' || @note END
     WHERE refreshed_at = @refreshedAt
  `);

  const latestRefreshStmt = db.prepare(
    'SELECT refreshed_at AS refreshedAt FROM refresh_log ORDER BY refreshed_at DESC LIMIT 1',
  );

  const rebuildFtsStmt = db.prepare(`INSERT INTO tracks_fts(tracks_fts) VALUES('rebuild')`);

  return {
    upsertTrack(track: RawTrack): void {
      upsertTrackStmt.run({
        persistentId: track.persistentId,
        title: track.title ?? null,
        artist: track.artist ?? null,
        albumArtist: track.albumArtist ?? null,
        album: track.album ?? null,
        genre: track.genre ?? null,
        year: track.year ?? null,
        durationSeconds: track.durationSeconds != null ? Math.round(track.durationSeconds) : null,
        bpm: track.bpm ?? null,
        trackNumber: track.trackNumber ?? null,
        discNumber: track.discNumber ?? null,
        dateAdded: track.dateAdded ?? null,
        lastPlayed: track.lastPlayed ?? null,
        playCount: track.playCount ?? 0,
        skipCount: track.skipCount ?? 0,
        rating: track.rating ?? null,
        loved: track.loved ? 1 : 0,
        disliked: track.disliked ? 1 : 0,
        comments: track.comments ?? null,
        locationKind: track.locationKind ?? null,
      });
    },

    // Signal patches for set_loved / set_rating: exactly the written column
    // moves, from values read back from Music.app (rating null = unrated,
    // already normalized by the bridge).
    updateTrackLoved(state: TrackLovedState): void {
      updateTrackLovedStmt.run({
        persistentId: state.persistentId,
        loved: state.loved ? 1 : 0,
      });
    },

    updateTrackRating(state: TrackRatingState): void {
      updateTrackRatingStmt.run({ persistentId: state.persistentId, rating: state.rating });
    },

    pruneTracksNotIn(presentPersistentIds: Set<string>): void {
      const ids = JSON.stringify([...presentPersistentIds]);

      pruneTracksStmt.run(ids);
      pruneFeaturesStmt.run(ids);
      prunePlayHistoryStmt.run(ids);
      pruneTrackNotesStmt.run(ids);
    },

    /** All tracks' current counters, keyed for the pre-refresh delta compare. */
    getPlayCounts(): Map<string, { playCount: number; skipCount: number }> {
      const rows = playCountsStmt.all() as {
        persistentId: string;
        playCount: number;
        skipCount: number;
      }[];

      return new Map(rows.map((r) => [r.persistentId, r]));
    },

    insertPlayHistory(row: PlayHistoryWindow & { trackPersistentId: string }): void {
      insertPlayHistoryStmt.run(row);
    },

    getTrackPlayHistory(trackPersistentId: string, limit: number): PlayHistoryWindow[] {
      return trackPlayHistoryStmt.all(trackPersistentId, Math.max(0, limit)) as PlayHistoryWindow[];
    },

    /** reconcilableSince: receipts created at or after it still shield their note. */
    prunePlaylistsNotIn(presentPersistentIds: Set<string>, reconcilableSince: string): void {
      const ids = JSON.stringify([...presentPersistentIds]);

      prunePlaylistsStmt.run(ids);
      pruneMembershipsStmt.run(ids);
      prunePlaylistNotesStmt.run(ids, reconcilableSince);
    },

    appendRefreshLog(entry: {
      refreshedAt: string;
      durationMs: number;
      trackCount: number;
      playlistCount: number;
      notes?: string;
    }): void {
      appendRefreshLogStmt.run({
        refreshedAt: entry.refreshedAt,
        durationMs: entry.durationMs,
        trackCount: entry.trackCount,
        playlistCount: entry.playlistCount,
        notes: entry.notes ?? null,
      });
    },

    appendRefreshNote(refreshedAt: string, note: string): void {
      appendRefreshNoteStmt.run({ refreshedAt, note });
    },

    getCacheAgeHours(): number | null {
      const row = latestRefreshStmt.get() as { refreshedAt: string } | undefined;

      if (!row) return null;

      return (Date.now() - Date.parse(row.refreshedAt)) / 3_600_000;
    },

    rebuildFts(): void {
      rebuildFtsStmt.run();
    },
  };
}
