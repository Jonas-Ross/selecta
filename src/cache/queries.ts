// Named query builders (docs/contracts.md §3). All SQL lives here — tools and
// the cache facade never write SQL inline. createQueries prepares statements
// once per connection; the facade in index.ts owns transactions.

import type { Database, Statement } from 'better-sqlite3';
import type { RawPlaylist, RawTrack } from '../types/bridge.js';
import type {
  CoOccurringTrack,
  PlaylistRef,
  PlaylistRow,
  SearchFilters,
  TrackRow,
} from '../types/cache.js';

export type Queries = ReturnType<typeof createQueries>;

// SELECT fragment aliasing snake_case columns to TrackRow's camelCase fields.
const TRACK_COLUMNS = `
  t.persistent_id AS persistentId, t.title, t.artist,
  t.album_artist AS albumArtist, t.album, t.genre, t.year,
  t.duration_seconds AS durationSeconds, t.bpm,
  t.track_number AS trackNumber, t.disc_number AS discNumber,
  t.date_added AS dateAdded, t.last_played AS lastPlayed,
  t.play_count AS playCount, t.skip_count AS skipCount, t.rating,
  t.loved, t.disliked, t.comments, t.location_kind AS locationKind
`;

// FTS5 treats quotes/operators as syntax; quote each whitespace-separated term
// so free text can never produce a MATCH syntax error. Terms AND together.
function toFtsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(' ');
}

// group_concat(DISTINCT …) cannot take a separator in SQLite, so names use the
// unit separator and are deduped/capped in JS.
const NAME_SEPARATOR = '\u001f';

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

    getCacheAgeHours(): number | null {
      const row = latestRefreshStmt.get() as { refreshedAt: string } | undefined;
      if (!row) return null;
      return (Date.now() - Date.parse(row.refreshedAt)) / 3_600_000;
    },

    searchTracks(filters: SearchFilters): { rows: TrackRow[]; total: number } {
      const where: string[] = [];
      const params: Record<string, unknown> = {};

      // With a free-text query the FTS table drives the scan and supplies
      // ranking; otherwise plain tracks ordered by engagement.
      const from = filters.query
        ? 'FROM tracks_fts f JOIN tracks t ON t.rowid = f.rowid'
        : 'FROM tracks t';
      if (filters.query) {
        where.push('tracks_fts MATCH @ftsQuery');
        params.ftsQuery = toFtsQuery(filters.query);
      }
      if (filters.artist != null) {
        where.push('t.artist = @artist COLLATE NOCASE');
        params.artist = filters.artist;
      }
      if (filters.genre != null) {
        where.push('t.genre = @genre COLLATE NOCASE');
        params.genre = filters.genre;
      }
      if (filters.yearMin != null) {
        where.push('t.year >= @yearMin');
        params.yearMin = filters.yearMin;
      }
      if (filters.yearMax != null) {
        where.push('t.year <= @yearMax');
        params.yearMax = filters.yearMax;
      }
      if (filters.loved != null) {
        where.push('t.loved = @loved');
        params.loved = filters.loved ? 1 : 0;
      }
      if (filters.disliked != null) {
        where.push('t.disliked = @disliked');
        params.disliked = filters.disliked ? 1 : 0;
      }
      if (filters.ratingMin != null) {
        where.push('t.rating >= @ratingMin');
        params.ratingMin = filters.ratingMin;
      }
      if (filters.minPlays != null) {
        where.push('t.play_count >= @minPlays');
        params.minPlays = filters.minPlays;
      }
      if (filters.maxPlays != null) {
        where.push('t.play_count <= @maxPlays');
        params.maxPlays = filters.maxPlays;
      }
      if (filters.lastPlayedBefore != null) {
        // Never-played tracks count as "not played since X" — that is the
        // dig-up-forgotten-gems use case.
        where.push('(t.last_played < @lastPlayedBefore OR t.last_played IS NULL)');
        params.lastPlayedBefore = filters.lastPlayedBefore;
      }
      if (filters.lastPlayedAfter != null) {
        where.push('t.last_played > @lastPlayedAfter');
        params.lastPlayedAfter = filters.lastPlayedAfter;
      }
      if (filters.addedBefore != null) {
        where.push('t.date_added < @addedBefore');
        params.addedBefore = filters.addedBefore;
      }
      if (filters.addedAfter != null) {
        where.push('t.date_added > @addedAfter');
        params.addedAfter = filters.addedAfter;
      }
      if (filters.inPlaylist != null) {
        where.push(
          't.persistent_id IN (SELECT track_persistent_id FROM playlist_tracks WHERE playlist_persistent_id = @inPlaylist)',
        );
        params.inPlaylist = filters.inPlaylist;
      }
      if (filters.locationKind != null) {
        where.push('t.location_kind = @locationKind');
        params.locationKind = filters.locationKind;
      }

      const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      const orderSql = filters.query ? 'ORDER BY f.rank' : 'ORDER BY t.play_count DESC';
      const limit = Math.min(filters.limit ?? 50, 500);

      const total = (
        db.prepare(`SELECT COUNT(*) AS n ${from} ${whereSql}`).get(params) as { n: number }
      ).n;
      const rows = db
        .prepare(`SELECT ${TRACK_COLUMNS} ${from} ${whereSql} ${orderSql} LIMIT @limit`)
        .all({ ...params, limit }) as TrackRow[];
      return { rows, total };
    },

    listPlaylists(filters: { kind?: PlaylistRow['kind']; nameQuery?: string }): PlaylistRow[] {
      const where: string[] = [];
      const params: Record<string, unknown> = {};
      if (filters.kind != null) {
        where.push('p.kind = @kind');
        params.kind = filters.kind;
      }
      if (filters.nameQuery != null) {
        where.push('p.name LIKE @nameQuery');
        params.nameQuery = `%${filters.nameQuery}%`;
      }
      const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      return db
        .prepare(
          `SELECT p.persistent_id AS persistentId, p.name, p.kind,
                  p.parent_persistent_id AS parentPersistentId,
                  (SELECT COUNT(*) FROM playlist_tracks pt
                   WHERE pt.playlist_persistent_id = p.persistent_id) AS trackCount
           FROM playlists p ${whereSql} ORDER BY p.name COLLATE NOCASE`,
        )
        .all(params) as PlaylistRow[];
    },

    getTrack(persistentId: string): TrackRow | null {
      const row = db
        .prepare(`SELECT ${TRACK_COLUMNS} FROM tracks t WHERE t.persistent_id = ?`)
        .get(persistentId) as TrackRow | undefined;
      return row ?? null;
    },

    getTracksByArtist(artist: string, limit = 30): TrackRow[] {
      return db
        .prepare(
          `SELECT ${TRACK_COLUMNS} FROM tracks t
           WHERE t.artist = ? COLLATE NOCASE
           ORDER BY t.play_count DESC LIMIT ?`,
        )
        .all(artist, limit) as TrackRow[];
    },

    getPlaylistsContainingTrack(trackPersistentId: string): PlaylistRef[] {
      return db
        .prepare(
          `SELECT p.persistent_id AS id, p.name FROM playlists p
           JOIN playlist_tracks pt ON pt.playlist_persistent_id = p.persistent_id
           WHERE pt.track_persistent_id = ?
           GROUP BY p.persistent_id ORDER BY p.name COLLATE NOCASE`,
        )
        .all(trackPersistentId) as PlaylistRef[];
    },

    getCoOccurringTracks(trackPersistentId: string, limit = 50): CoOccurringTrack[] {
      // Co-occurrence counts only the user's own playlists (kind 'user') — the
      // curatorial signal. Smart and subscription playlists are machine- or
      // Apple-curated and would drown it out.
      const rows = db
        .prepare(
          `SELECT ${TRACK_COLUMNS}, shared.cnt AS sharedPlaylistCount, shared.names AS namesRaw
           FROM (
             SELECT pt2.track_persistent_id AS tid,
                    COUNT(DISTINCT pt1.playlist_persistent_id) AS cnt,
                    group_concat(p.name, '${NAME_SEPARATOR}') AS names
             FROM playlist_tracks pt1
             JOIN playlists p ON p.persistent_id = pt1.playlist_persistent_id AND p.kind = 'user'
             JOIN playlist_tracks pt2 ON pt2.playlist_persistent_id = pt1.playlist_persistent_id
               AND pt2.track_persistent_id <> pt1.track_persistent_id
             WHERE pt1.track_persistent_id = @trackId
             GROUP BY pt2.track_persistent_id
           ) shared
           JOIN tracks t ON t.persistent_id = shared.tid
           ORDER BY shared.cnt DESC, t.play_count DESC
           LIMIT @limit`,
        )
        .all({ trackId: trackPersistentId, limit }) as (TrackRow & {
        sharedPlaylistCount: number;
        namesRaw: string;
      })[];
      return rows.map(({ namesRaw, ...row }) => ({
        ...row,
        sharedPlaylistNames: [...new Set(namesRaw.split(NAME_SEPARATOR))].slice(0, 3),
      }));
    },

    rebuildFts(): void {
      db.prepare(`INSERT INTO tracks_fts(tracks_fts) VALUES('rebuild')`).run();
    },
  };
}
