// Named query builders (docs/contracts.md §3). All SQL lives here — tools and
// the cache facade never write SQL inline. createQueries prepares statements
// once per connection; the facade in index.ts owns transactions.

import type { Database, Statement } from 'better-sqlite3';
import type { RawPlaylist, RawTrack } from '../types/bridge.js';

export type Queries = ReturnType<typeof createQueries>;

export function createQueries(db: Database) {
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

  const upsertPlaylistStmt: Statement = db.prepare(`
    INSERT INTO playlists (persistent_id, name, kind, parent_persistent_id)
    VALUES (@persistentId, @name, @kind, @parentPersistentId)
    ON CONFLICT(persistent_id) DO UPDATE SET
      name=excluded.name, kind=excluded.kind,
      parent_persistent_id=excluded.parent_persistent_id
  `);

  const deleteMembershipStmt = db.prepare(
    'DELETE FROM playlist_tracks WHERE playlist_persistent_id = ?',
  );
  const insertMembershipStmt = db.prepare(
    'INSERT INTO playlist_tracks (playlist_persistent_id, track_persistent_id, position) VALUES (?, ?, ?)',
  );

  // json_each keeps us clear of SQLite's bound-variable ceiling on 10k-track prunes.
  const pruneTracksStmt = db.prepare(
    'DELETE FROM tracks WHERE persistent_id NOT IN (SELECT value FROM json_each(?))',
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

  const latestRefreshStmt = db.prepare(
    'SELECT refreshed_at AS refreshedAt FROM refresh_log ORDER BY refreshed_at DESC LIMIT 1',
  );

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

    upsertPlaylist(playlist: RawPlaylist): void {
      upsertPlaylistStmt.run({
        persistentId: playlist.persistentId,
        name: playlist.name,
        kind: playlist.kind,
        parentPersistentId: playlist.parentPersistentId ?? null,
      });
    },

    replacePlaylistMembership(playlistPersistentId: string, trackPersistentIds: string[]): void {
      deleteMembershipStmt.run(playlistPersistentId);
      trackPersistentIds.forEach((trackId, position) => {
        insertMembershipStmt.run(playlistPersistentId, trackId, position);
      });
    },

    pruneTracksNotIn(presentPersistentIds: Set<string>): void {
      pruneTracksStmt.run(JSON.stringify([...presentPersistentIds]));
    },

    prunePlaylistsNotIn(presentPersistentIds: Set<string>): void {
      const ids = JSON.stringify([...presentPersistentIds]);
      prunePlaylistsStmt.run(ids);
      pruneMembershipsStmt.run(ids);
    },

    appendRefreshLog(entry: {
      durationMs: number;
      trackCount: number;
      playlistCount: number;
      notes?: string;
    }): void {
      appendRefreshLogStmt.run({
        refreshedAt: new Date().toISOString(),
        durationMs: entry.durationMs,
        trackCount: entry.trackCount,
        playlistCount: entry.playlistCount,
        notes: entry.notes ?? null,
      });
    },

    getCacheAgeHours(): number | null {
      const row = latestRefreshStmt.get() as { refreshedAt: string } | undefined;
      if (!row) return null;
      return (Date.now() - Date.parse(row.refreshedAt)) / 3_600_000;
    },

    rebuildFts(): void {
      db.prepare(`INSERT INTO tracks_fts(tracks_fts) VALUES('rebuild')`).run();
    },
  };
}
