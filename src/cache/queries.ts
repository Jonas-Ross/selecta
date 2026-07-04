// Named query builders. All SQL lives here — tools and
// the cache facade never write SQL inline. createQueries prepares statements
// once per connection; the facade in index.ts owns transactions.

import type { Database, Statement } from 'better-sqlite3';
import type {
  RawPlaylist,
  RawTrack,
  TrackLovedState,
  TrackRatingState,
} from '../types/bridge.js';
import type {
  CoOccurringTrack,
  OverviewStats,
  PlaylistCreationRow,
  PlaylistRef,
  PlaylistRow,
  SearchFilters,
  SearchResultRow,
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

// SELECT fragment for PlaylistRow, shared by getPlaylist and listPlaylists so
// the two projections can't drift.
const PLAYLIST_COLUMNS = `
  p.persistent_id AS persistentId, p.name, p.kind,
  p.parent_persistent_id AS parentPersistentId,
  (SELECT COUNT(*) FROM playlist_tracks pt
   WHERE pt.playlist_persistent_id = p.persistent_id) AS trackCount
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
// unit separator and are deduped/capped in JS. Also the field separator inside
// the dedupe key (DEDUPE_KEY below).
const UNIT_SEPARATOR = '\u001f';

// library_overview returns a fact, not a ranking, so the artist cap only exists
// to bound tokens; artistsTotal carries the full breadth past it.
const TOP_ARTISTS_LIMIT = 25;

// The faceted WHERE clause shared by searchTracks and overviewStats: identical
// predicates over the same rowset, so a search and an overview of that search
// agree by construction. Returns the FROM (FTS-joined when a free-text query is
// present) plus the WHERE fragment and its bound params; callers add their own
// projection, grouping, ordering, and limits.
function buildTrackFilter(filters: SearchFilters): {
  from: string;
  whereSql: string;
  params: Record<string, unknown>;
} {
  const where: string[] = [];
  const params: Record<string, unknown> = {};

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
  if (filters.excludeArtists?.length) {
    // NOT EXISTS instead of NOT IN: a NULL artist must survive the exclusion
    // (excluding "Kygo" shouldn't drop unknown-artist tracks).
    where.push(
      'NOT EXISTS (SELECT 1 FROM json_each(@excludeArtists) WHERE t.artist = value COLLATE NOCASE)',
    );
    params.excludeArtists = JSON.stringify(filters.excludeArtists);
  }
  if (filters.excludeTracks?.length) {
    where.push('t.persistent_id NOT IN (SELECT value FROM json_each(@excludeTracks))');
    params.excludeTracks = JSON.stringify(filters.excludeTracks);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  return { from, whereSql, params };
}

// ── Dedupe (issue #16) ───────────────────────────────────────────────────────
// Canonical identity for "same song": normalized title + artist. Parenthetical
// qualifiers stay in the title on purpose — "Levels (Radio Edit)" is a
// different version of "Levels", not a duplicate. Rows missing a title or
// artist can't establish identity, so each keys to itself (a real key always
// contains the unit separator, which a persistent ID never does, so the two
// namespaces can't collide). lower() is ASCII-only in SQLite — non-ASCII case
// variants don't fold, which is acceptable for this collapse.
const DEDUPE_KEY = `
  CASE WHEN t.title IS NULL OR TRIM(t.title) = '' OR t.artist IS NULL OR TRIM(t.artist) = ''
       THEN t.persistent_id
       ELSE lower(TRIM(t.title)) || '${UNIT_SEPARATOR}' || lower(TRIM(t.artist)) END
`;

// Which copy wins: a DETERMINISTIC tiebreak, not quality ranking (the identity
// guardrail on #16). Prefer loved → studio album over a Various Artists
// compilation → earliest release year (NULL last) → stable ID.
const DEDUPE_TIEBREAK = `
  t.loved DESC,
  CASE WHEN t.album_artist = 'Various Artists' COLLATE NOCASE THEN 1 ELSE 0 END,
  (t.year IS NULL), t.year,
  t.persistent_id
`;

// Result ordering for searchTracks. A neutral lens the model picks — not a
// ranking opinion baked into the cache. Omitted sort keeps the historical
// default (FTS relevance with a query, else most-played); the explicit lenses
// let the model dig past heavy rotation. Non-relevance lenses get a
// persistent_id tiebreak so paging is stable; `random` is deliberately not.
// `rankRef` names the FTS rank column for the relevance default — the dedupe
// path reads it from its windowed subquery instead of the FTS join directly.
function orderClause(filters: SearchFilters, rankRef = 'f.rank'): string {
  switch (filters.sort) {
    case 'most_played':
      return 'ORDER BY t.play_count DESC';
    case 'least_played':
      return 'ORDER BY t.play_count ASC, t.persistent_id';
    case 'recently_added':
      return 'ORDER BY t.date_added DESC, t.persistent_id'; // NULL dates sort last
    case 'random':
      return 'ORDER BY RANDOM()';
    case 'playlist_order':
      // The tool layer returns a structured validation_error first; this
      // defends the SQL for plain-library consumers of the cache, where an
      // unbound @inPlaylist would surface as a cryptic sqlite error.
      if (filters.inPlaylist == null) {
        throw new Error('sort playlist_order requires the inPlaylist filter');
      }
      // MIN(position): a track duplicated in the playlist is one search row —
      // it sorts at its first occurrence.
      return `ORDER BY (SELECT MIN(position) FROM playlist_tracks
                WHERE playlist_persistent_id = @inPlaylist
                  AND track_persistent_id = t.persistent_id)`;
    default:
      return filters.query ? `ORDER BY ${rankRef}` : 'ORDER BY t.play_count DESC';
  }
}

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

  const updateTrackLovedStmt = db.prepare(
    'UPDATE tracks SET loved = @loved WHERE persistent_id = @persistentId',
  );
  const updateTrackRatingStmt = db.prepare(
    'UPDATE tracks SET rating = @rating WHERE persistent_id = @persistentId',
  );

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

  const recordCreationStmt = db.prepare(`
    INSERT OR REPLACE INTO playlist_creations
      (created_persistent_id, current_persistent_id, name, track_ids_json, created_at)
    VALUES (@createdId, @createdId, @name, @trackIdsJson, @createdAt)
  `);
  const creationsSinceStmt = db.prepare(`
    SELECT created_persistent_id AS createdPersistentId,
           current_persistent_id AS currentPersistentId,
           name, track_ids_json AS trackIdsJson, created_at AS createdAt
    FROM playlist_creations WHERE created_at >= ? ORDER BY created_at
  `);
  const setCreationCurrentIdStmt = db.prepare(
    'UPDATE playlist_creations SET current_persistent_id = ? WHERE created_persistent_id = ?',
  );
  const deleteCreationsByCurrentIdStmt = db.prepare(
    'DELETE FROM playlist_creations WHERE current_persistent_id = ?',
  );
  const resolveCreationStmt = db.prepare(
    'SELECT current_persistent_id AS currentId FROM playlist_creations WHERE created_persistent_id = ?',
  );
  const playlistExistsStmt = db.prepare('SELECT 1 FROM playlists WHERE persistent_id = ?');
  const getPlaylistStmt = db.prepare(
    `SELECT ${PLAYLIST_COLUMNS} FROM playlists p WHERE p.persistent_id = ?`,
  );
  const userPlaylistIdsByNameStmt = db.prepare(
    `SELECT persistent_id AS id FROM playlists WHERE name = ? AND kind = 'user' ORDER BY persistent_id`,
  );
  const playlistTrackIdsStmt = db.prepare(
    'SELECT track_persistent_id AS id FROM playlist_tracks WHERE playlist_persistent_id = ? ORDER BY position',
  );
  const deletePlaylistRowStmt = db.prepare('DELETE FROM playlists WHERE persistent_id = ?');

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

    recordPlaylistCreation(entry: {
      createdId: string;
      name: string;
      trackIds: string[];
      createdAt: string;
    }): void {
      recordCreationStmt.run({
        createdId: entry.createdId,
        name: entry.name,
        trackIdsJson: JSON.stringify(entry.trackIds),
        createdAt: entry.createdAt,
      });
    },

    getCreationsSince(sinceIso: string): PlaylistCreationRow[] {
      const rows = creationsSinceStmt.all(sinceIso) as (Omit<PlaylistCreationRow, 'trackIds'> & {
        trackIdsJson: string;
      })[];
      return rows.map(({ trackIdsJson, ...row }) => ({
        ...row,
        trackIds: JSON.parse(trackIdsJson) as string[],
      }));
    },

    setCreationCurrentId(createdId: string, currentId: string): void {
      setCreationCurrentIdStmt.run(currentId, createdId);
    },

    deleteCreationsByCurrentId(persistentId: string): void {
      deleteCreationsByCurrentIdStmt.run(persistentId);
    },

    resolveCreatedPlaylistId(createdId: string): string | null {
      const row = resolveCreationStmt.get(createdId) as { currentId: string } | undefined;
      return row?.currentId ?? null;
    },

    playlistExists(persistentId: string): boolean {
      return playlistExistsStmt.get(persistentId) !== undefined;
    },

    getPlaylist(persistentId: string): PlaylistRow | null {
      return (getPlaylistStmt.get(persistentId) as PlaylistRow | undefined) ?? null;
    },

    getUserPlaylistIdsByName(name: string): string[] {
      return (userPlaylistIdsByNameStmt.all(name) as { id: string }[]).map((r) => r.id);
    },

    getPlaylistTrackIds(playlistPersistentId: string): string[] {
      return (playlistTrackIdsStmt.all(playlistPersistentId) as { id: string }[]).map((r) => r.id);
    },

    deletePlaylistRow(persistentId: string): void {
      deletePlaylistRowStmt.run(persistentId);
      deleteMembershipStmt.run(persistentId);
    },

    getCacheAgeHours(): number | null {
      const row = latestRefreshStmt.get() as { refreshedAt: string } | undefined;
      if (!row) return null;
      return (Date.now() - Date.parse(row.refreshedAt)) / 3_600_000;
    },

    searchTracks(filters: SearchFilters): { rows: SearchResultRow[]; total: number } {
      const { from, whereSql, params } = buildTrackFilter(filters);
      const limit = Math.min(filters.limit ?? 50, 500);

      if (!filters.dedupe) {
        const total = (
          db.prepare(`SELECT COUNT(*) AS n ${from} ${whereSql}`).get(params) as { n: number }
        ).n;
        const rows = db
          .prepare(`SELECT ${TRACK_COLUMNS} ${from} ${whereSql} ${orderClause(filters)} LIMIT @limit`)
          .all({ ...params, limit }) as TrackRow[];
        return { rows, total };
      }

      // Dedupe: rank each canonical group in a windowed subquery, keep the
      // winner (rn = 1), then join back to tracks so the projection, sort
      // lenses, and limit apply to representatives exactly as they would to
      // plain rows. groupIds carries the whole group for alternate reporting.
      // The total is just the number of canonical groups — a flat aggregate.
      const total = (
        db
          .prepare(`SELECT COUNT(DISTINCT ${DEDUPE_KEY}) AS n ${from} ${whereSql}`)
          .get(params) as { n: number }
      ).n;
      const winners = `
        SELECT t.persistent_id AS pid,
               ${filters.query ? 'f.rank AS ftsRank,' : ''}
               ROW_NUMBER() OVER (PARTITION BY ${DEDUPE_KEY} ORDER BY ${DEDUPE_TIEBREAK}) AS rn,
               group_concat(t.persistent_id) OVER (PARTITION BY ${DEDUPE_KEY}) AS groupIds
        ${from} ${whereSql}
      `;
      const rows = db
        .prepare(
          `SELECT ${TRACK_COLUMNS}, w.groupIds
           FROM (${winners}) w JOIN tracks t ON t.persistent_id = w.pid
           WHERE w.rn = 1
           ${orderClause(filters, 'w.ftsRank')} LIMIT @limit`,
        )
        .all({ ...params, limit }) as (TrackRow & { groupIds: string })[];
      return {
        rows: rows.map(({ groupIds, ...row }) => {
          const alternates = groupIds
            .split(',')
            .filter((id) => id !== row.persistentId)
            .sort();
          return { ...row, alternateIds: alternates.length > 0 ? alternates : undefined };
        }),
        total,
      };
    },

    // Aggregate "shape of the crate" over the same filtered rowset as
    // searchTracks. Pure GROUP BY work, cache-only. The
    // grand totals come back in one scan; genre/decade/artist/rating
    // breakdowns are separate grouped scans. Genres are returned in full
    // (ordered) and capped by the tool; artists are capped here to bound the
    // long tail, with artistsTotal carrying the breadth past the cap.
    overviewStats(filters: SearchFilters): OverviewStats {
      const { from, whereSql, params } = buildTrackFilter(filters);
      const and = (cond: string): string => (whereSql ? `${whereSql} AND ${cond}` : `WHERE ${cond}`);

      const totals = db
        .prepare(
          `SELECT
             COUNT(*) AS totalTracks,
             COALESCE(SUM(t.duration_seconds), 0) AS totalRuntimeSeconds,
             COUNT(DISTINCT NULLIF(TRIM(t.artist), '')) AS artistsTotal,
             COALESCE(SUM(t.loved), 0) AS loved,
             COALESCE(SUM(t.disliked), 0) AS disliked,
             COALESCE(SUM(CASE WHEN t.rating > 0 THEN 1 ELSE 0 END), 0) AS rated,
             COALESCE(SUM(CASE WHEN t.rating IS NULL OR t.rating = 0 THEN 1 ELSE 0 END), 0) AS unrated,
             COALESCE(SUM(CASE WHEN t.play_count = 0 THEN 1 ELSE 0 END), 0) AS neverPlayed,
             COALESCE(SUM(CASE WHEN t.location_kind = 'local' THEN 1 ELSE 0 END), 0) AS local,
             COALESCE(SUM(CASE WHEN t.location_kind = 'cloud' THEN 1 ELSE 0 END), 0) AS cloud,
             COALESCE(SUM(CASE WHEN t.location_kind = 'missing' THEN 1 ELSE 0 END), 0) AS missing,
             COALESCE(SUM(CASE WHEN t.location_kind IS NULL THEN 1 ELSE 0 END), 0) AS unknownLocation,
             MIN(t.date_added) AS earliestAdded,
             MAX(t.date_added) AS latestAdded
           ${from} ${whereSql}`,
        )
        .get(params) as Omit<
        OverviewStats,
        'genres' | 'decades' | 'topArtists' | 'ratingHistogram'
      >;

      const genres = db
        .prepare(
          `SELECT t.genre AS name, COUNT(*) AS count
           ${from} ${and("t.genre IS NOT NULL AND TRIM(t.genre) <> ''")}
           GROUP BY t.genre ORDER BY count DESC, name COLLATE NOCASE`,
        )
        .all(params) as { name: string; count: number }[];

      const decades = db
        .prepare(
          `SELECT (t.year / 10) * 10 AS decade, COUNT(*) AS count
           ${from} ${and('t.year IS NOT NULL AND t.year > 0')}
           GROUP BY decade ORDER BY decade`,
        )
        .all(params) as { decade: number; count: number }[];

      const topArtists = db
        .prepare(
          `SELECT t.artist AS name, COUNT(*) AS trackCount
           ${from} ${and("t.artist IS NOT NULL AND TRIM(t.artist) <> ''")}
           GROUP BY t.artist ORDER BY trackCount DESC, name COLLATE NOCASE
           LIMIT @artistLimit`,
        )
        .all({ ...params, artistLimit: TOP_ARTISTS_LIMIT }) as {
        name: string;
        trackCount: number;
      }[];

      const ratingHistogram = db
        .prepare(
          `SELECT t.rating AS rating, COUNT(*) AS count
           ${from} ${and('t.rating > 0')}
           GROUP BY t.rating ORDER BY t.rating DESC`,
        )
        .all(params) as { rating: number; count: number }[];

      return { ...totals, genres, decades, topArtists, ratingHistogram };
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
          `SELECT ${PLAYLIST_COLUMNS} FROM playlists p ${whereSql} ORDER BY p.name COLLATE NOCASE`,
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
                    group_concat(p.name, '${UNIT_SEPARATOR}') AS names
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
        sharedPlaylistNames: [...new Set(namesRaw.split(UNIT_SEPARATOR))].slice(0, 3),
      }));
    },

    rebuildFts(): void {
      db.prepare(`INSERT INTO tracks_fts(tracks_fts) VALUES('rebuild')`).run();
    },
  };
}
