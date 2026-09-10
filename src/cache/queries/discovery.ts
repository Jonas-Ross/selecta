// Connection-owned query statements. Transactions belong to SelectaCache.
import type { Database } from 'better-sqlite3';
import type {
  CoOccurrenceFilters,
  CoOccurrenceResult,
  OverviewStats,
  PlaylistRef,
  PlaylistRow,
  RecentActivity,
  SearchFilters,
  SearchResultRow,
  TrackRow,
} from '../../types/cache.js';
import { TRACK_COLUMNS, PLAYLIST_COLUMNS, EFFECTIVE_BPM, buildTrackFilter } from './shared.js';
import { SONG_IDENTITY_SQL_FUNCTION, songIdentityKey } from '../song_identity.js';

// group_concat(DISTINCT …) cannot take a separator in SQLite, so names use the
// unit separator and are deduped/capped in JS.
const UNIT_SEPARATOR = '\u001f';

function parsePlaylistRefs(raw: string): PlaylistRef[] {
  const parsed: unknown = JSON.parse(raw);

  if (!Array.isArray(parsed)) throw new Error('invalid co-occurrence playlist JSON');

  const refs = parsed.map((value): PlaylistRef => {
    if (
      typeof value !== 'object' ||
      value === null ||
      !('id' in value) ||
      typeof value.id !== 'string' ||
      !('name' in value) ||
      typeof value.name !== 'string'
    ) {
      throw new Error('invalid co-occurrence playlist reference');
    }

    return { id: value.id, name: value.name };
  });

  return [...new Map(refs.map((ref) => [ref.id, ref])).values()].slice(0, 3);
}

function buildCoOccurrenceSourceFilter(filters: CoOccurrenceFilters): {
  excludedSql: string;
  includedSql: string;
  params: Record<string, unknown>;
} {
  const excludeIds = [...new Set(filters.excludePlaylistIds ?? [])];
  const excludeParams = Object.fromEntries(excludeIds.map((id, i) => [`exclude${i}`, id]));
  const checks: string[] = [];

  if (excludeIds.length > 0) {
    const placeholders = excludeIds.map((_, i) => `@exclude${i}`).join(', ');

    checks.push(`p.persistent_id IN (${placeholders})`);
  }

  if (filters.maxPlaylistTracks != null) {
    checks.push(
      `(SELECT COUNT(*) FROM playlist_tracks size_pt
        WHERE size_pt.playlist_persistent_id = p.persistent_id) > @maxPlaylistTracks`,
    );
  }

  const excludedSql = checks.length > 0 ? checks.join(' OR ') : '0';

  return {
    excludedSql,
    includedSql: checks.length > 0 ? `AND NOT (${excludedSql})` : '',
    params: {
      ...excludeParams,
      ...(filters.maxPlaylistTracks != null
        ? { maxPlaylistTracks: filters.maxPlaylistTracks }
        : {}),
    },
  };
}

// library_overview returns a fact, not a ranking, so the artist cap only exists
// to bound tokens; artistsTotal carries the full breadth past it.
const TOP_ARTISTS_LIMIT = 25;

// ── Dedupe (issue #16) ───────────────────────────────────────────────────────
// Canonical identity for "same song": normalized title + artist. Parenthetical
// qualifiers stay in the title on purpose — "Levels (Radio Edit)" is a
// different version of "Levels", not a duplicate. Rows missing a title or
// artist can't establish identity, so each keys to itself. The registered
// function is the same Unicode-aware implementation inspect_tracklist uses.
const DEDUPE_KEY = `${SONG_IDENTITY_SQL_FUNCTION}(t.title, t.artist, t.persistent_id)`;

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
// A lens owns any params its SQL references (like buildTrackFilter does):
// searchTracks spreads them into the ordered row queries only, so the COUNT
// totals never see params they don't use (better-sqlite3 rejects those).
function orderClause(
  filters: SearchFilters,
  recentSinceIso: () => string,
  rankRef = 'f.rank',
): { sql: string; params: Record<string, unknown> } {
  switch (filters.sort) {
    case 'most_played':
      return { sql: 'ORDER BY t.play_count DESC, t.persistent_id', params: {} };
    case 'least_played':
      return { sql: 'ORDER BY t.play_count ASC, t.persistent_id', params: {} };
    case 'recently_added':
      // NULL dates sort last.
      return { sql: 'ORDER BY t.date_added DESC, t.persistent_id', params: {} };
    case 'random':
      return { sql: 'ORDER BY RANDOM()', params: {} };
    case 'recent_plays':
      // Play deltas recorded in the last RECENT_WINDOW_DAYS — current rotation
      // rather than lifetime count. Tracks with no recorded window sum to 0
      // and tiebreak on stable ID.
      return {
        sql: `ORDER BY (SELECT COALESCE(SUM(ph.play_count_delta), 0) FROM play_history ph
                WHERE ph.track_persistent_id = t.persistent_id
                  AND ph.refreshed_at >= @recentSince) DESC, t.persistent_id`,
        params: { recentSince: recentSinceIso() },
      };
    case 'playlist_order':
      // The tool layer returns a structured validation_error first; this
      // defends the SQL for plain-library consumers of the cache, where an
      // unbound @inPlaylist would surface as a cryptic sqlite error.
      if (filters.inPlaylist == null) {
        throw new Error('sort playlist_order requires the inPlaylist filter');
      }

      // MIN(position): a track duplicated in the playlist is one search row —
      // it sorts at its first occurrence. @inPlaylist is already bound as a
      // filter param.
      return {
        sql: `ORDER BY (SELECT MIN(position) FROM playlist_tracks
                WHERE playlist_persistent_id = @inPlaylist
                  AND track_persistent_id = t.persistent_id)`,
        params: {},
      };
    default:
      return {
        sql: filters.query ? `ORDER BY ${rankRef}` : 'ORDER BY t.play_count DESC',
        params: {},
      };
  }
}

export function createDiscoveryQueries(db: Database, recentSinceIso: () => string) {
  db.function(SONG_IDENTITY_SQL_FUNCTION, { deterministic: true }, songIdentityKey);

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

  const getTrackStmt = db.prepare(
    `SELECT ${TRACK_COLUMNS} FROM tracks t WHERE t.persistent_id = ?`,
  );

  const getTracksByArtistStmt = db.prepare(`SELECT ${TRACK_COLUMNS} FROM tracks t
           WHERE t.artist = ? COLLATE NOCASE
           ORDER BY t.play_count DESC LIMIT ?`);

  const getPlaylistsContainingTrackStmt =
    db.prepare(`SELECT p.persistent_id AS id, p.name FROM playlists p
           JOIN playlist_tracks pt ON pt.playlist_persistent_id = p.persistent_id
           WHERE pt.track_persistent_id = ?
           GROUP BY p.persistent_id ORDER BY p.name COLLATE NOCASE`);

  return {
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

    searchTracks(filters: SearchFilters): { rows: SearchResultRow[]; total: number } {
      const { from, whereSql, params } = buildTrackFilter(filters);
      const limit = Math.min(filters.limit ?? 50, 500);
      const offset = Math.max(0, Math.trunc(filters.offset ?? 0));

      if (!filters.dedupe) {
        const total = (
          db.prepare(`SELECT COUNT(*) AS n ${from} ${whereSql}`).get(params) as { n: number }
        ).n;
        const order = orderClause(filters, recentSinceIso);
        const rows = db
          .prepare(
            `SELECT ${TRACK_COLUMNS} ${from} ${whereSql} ${order.sql} LIMIT @limit OFFSET @offset`,
          )
          .all({ ...params, ...order.params, limit, offset }) as TrackRow[];

        return { rows, total };
      }

      // Dedupe: rank each canonical group in a windowed subquery, keep the
      // winner (rn = 1), then join back to tracks so the projection, sort
      // lenses, and limit apply to representatives exactly as they would to
      // plain rows. groupIds carries the whole group for alternate reporting.
      // The total is just the number of canonical groups — a flat aggregate.
      const total = (
        db.prepare(`SELECT COUNT(DISTINCT ${DEDUPE_KEY}) AS n ${from} ${whereSql}`).get(params) as {
          n: number;
        }
      ).n;
      const winners = `
        SELECT t.persistent_id AS pid,
               ${filters.query ? 'f.rank AS ftsRank,' : ''}
               ROW_NUMBER() OVER (PARTITION BY ${DEDUPE_KEY} ORDER BY ${DEDUPE_TIEBREAK}) AS rn,
               group_concat(t.persistent_id) OVER (PARTITION BY ${DEDUPE_KEY}) AS groupIds
        ${from} ${whereSql}
      `;
      const order = orderClause(filters, recentSinceIso, 'w.ftsRank');
      const rows = db
        .prepare(
          `SELECT ${TRACK_COLUMNS}, w.groupIds
           FROM (${winners}) w JOIN tracks t ON t.persistent_id = w.pid
           WHERE w.rn = 1
           ${order.sql} LIMIT @limit OFFSET @offset`,
        )
        .all({ ...params, ...order.params, limit, offset }) as (TrackRow & { groupIds: string })[];

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
    // grand totals come back in one scan; genre/decade/artist/rating/recent-
    // activity breakdowns are separate grouped scans. Genres are returned in
    // full (ordered) and capped by the tool; artists are capped here to bound
    // the long tail, with artistsTotal carrying the breadth past the cap.
    // recentSince is the recent-activity cutoff: deltas are summed over
    // windows *recorded* since then — refresh cadence is manual, so this is
    // "activity captured since", never a per-day rate.
    overviewStats(filters: SearchFilters, recentSince: string): OverviewStats {
      const { from, whereSql, params } = buildTrackFilter(filters);
      const and = (cond: string): string =>
        whereSql ? `${whereSql} AND ${cond}` : `WHERE ${cond}`;

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
             COALESCE(SUM(CASE WHEN ${EFFECTIVE_BPM} IS NOT NULL THEN 1 ELSE 0 END), 0) AS withBpm,
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

      // Driven from the sparse play_history side (idx_play_history_at), so
      // cost scales with recorded windows, not library size.
      const recentActivity = db
        .prepare(
          `SELECT
             COUNT(DISTINCT CASE WHEN ph.play_count_delta > 0 THEN ph.track_persistent_id END) AS tracksPlayed,
             COALESCE(SUM(ph.play_count_delta), 0) AS totalPlays,
             COALESCE(SUM(ph.skip_count_delta), 0) AS totalSkips
           ${from} JOIN play_history ph ON ph.track_persistent_id = t.persistent_id
           ${and('ph.refreshed_at >= @recentSince')}`,
        )
        .get({ ...params, recentSince }) as RecentActivity;

      return { ...totals, genres, decades, topArtists, ratingHistogram, recentActivity };
    },

    listPlaylists(filters: { kind?: PlaylistRow['kind']; nameQuery?: string }): PlaylistRow[] {
      const where: string[] = [];
      const params: Record<string, unknown> = {};

      if (filters.kind != null) {
        where.push('p.kind = @kind');
        params.kind = filters.kind;
      }

      if (filters.nameQuery != null) {
        where.push("p.name LIKE @nameQuery ESCAPE '\\'");
        params.nameQuery = `%${filters.nameQuery.replace(/[\\%_]/g, '\\$&')}%`;
      }

      const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

      return db
        .prepare(
          `SELECT ${PLAYLIST_COLUMNS} FROM playlists p ${whereSql} ORDER BY p.name COLLATE NOCASE`,
        )
        .all(params) as PlaylistRow[];
    },

    getTrack(persistentId: string): TrackRow | null {
      const row = getTrackStmt.get(persistentId) as TrackRow | undefined;

      return row ?? null;
    },

    getTracksByArtist(artist: string, limit = 30): TrackRow[] {
      return getTracksByArtistStmt.all(artist, limit) as TrackRow[];
    },

    getPlaylistsContainingTrack(trackPersistentId: string): PlaylistRef[] {
      return getPlaylistsContainingTrackStmt.all(trackPersistentId) as PlaylistRef[];
    },

    getCoOccurrence(
      seedIds: string[],
      filters: CoOccurrenceFilters = {},
      limit = 50,
    ): CoOccurrenceResult {
      // Clamp like getTracksPendingEnrichment: a negative LIMIT means
      // "unlimited" to SQLite. No seeds → no co-occurrence (and `IN ()` is a
      // syntax error), so answer the degenerate question directly.
      if (seedIds.length === 0 || limit <= 0) {
        return { tracks: [], sourcePlaylists: { considered: 0, excluded: 0 } };
      }

      // Co-occurrence counts only the user's own playlists (kind 'user') — the
      // curatorial signal. Smart and subscription playlists are machine- or
      // Apple-curated and would drown it out.
      // Aggregated across the seed set: total = distinct (seed, playlist)
      // pairs, i.e. the sum of per-seed shared-playlist counts; seeds are never
      // candidates themselves. Sorting by count is a convenience ordering of
      // facts, not a similarity score.
      const seedList = seedIds.map((_, i) => `@seed${i}`).join(', ');
      const seedParams = Object.fromEntries(seedIds.map((id, i) => [`seed${i}`, id]));
      const sourceFilter = buildCoOccurrenceSourceFilter(filters);
      const params = { ...seedParams, ...sourceFilter.params };

      const sourcePlaylists = db
        .prepare(
          `SELECT COUNT(*) AS considered, COALESCE(SUM(source.excluded), 0) AS excluded
           FROM (
             SELECT p.persistent_id,
                    CASE WHEN ${sourceFilter.excludedSql} THEN 1 ELSE 0 END AS excluded
             FROM playlist_tracks pt1
             JOIN playlists p ON p.persistent_id = pt1.playlist_persistent_id AND p.kind = 'user'
             WHERE pt1.track_persistent_id IN (${seedList})
             GROUP BY p.persistent_id
           ) source`,
        )
        .get(params) as { considered: number; excluded: number };

      const rows = db
        .prepare(
          `SELECT ${TRACK_COLUMNS},
                  shared.total AS totalSharedPlaylistCount,
                  shared.seeds AS seedsMatched,
                  shared.names AS namesRaw,
                  shared.playlists AS playlistsRaw
           FROM (
             SELECT pt2.track_persistent_id AS tid,
                    COUNT(DISTINCT pt1.track_persistent_id || '${UNIT_SEPARATOR}' || pt1.playlist_persistent_id) AS total,
                    COUNT(DISTINCT pt1.track_persistent_id) AS seeds,
                    group_concat(p.name, '${UNIT_SEPARATOR}') AS names,
                    json_group_array(json_object('id', p.persistent_id, 'name', p.name)) AS playlists
             FROM playlist_tracks pt1
             JOIN playlists p ON p.persistent_id = pt1.playlist_persistent_id AND p.kind = 'user'
             JOIN playlist_tracks pt2 ON pt2.playlist_persistent_id = pt1.playlist_persistent_id
             WHERE pt1.track_persistent_id IN (${seedList})
               AND pt2.track_persistent_id NOT IN (${seedList})
               ${sourceFilter.includedSql}
             GROUP BY pt2.track_persistent_id
           ) shared
           JOIN tracks t ON t.persistent_id = shared.tid
           ORDER BY shared.total DESC, shared.seeds DESC, t.play_count DESC
           LIMIT @limit`,
        )
        .all({ ...params, limit }) as (TrackRow & {
        totalSharedPlaylistCount: number;
        seedsMatched: number;
        namesRaw: string;
        playlistsRaw: string;
      })[];

      return {
        tracks: rows.map(({ namesRaw, playlistsRaw, ...row }) => ({
          ...row,
          sharedPlaylistNames: [...new Set(namesRaw.split(UNIT_SEPARATOR))].slice(0, 3),
          sharedPlaylists: parsePlaylistRefs(playlistsRaw),
        })),
        sourcePlaylists,
      };
    },
  };
}
