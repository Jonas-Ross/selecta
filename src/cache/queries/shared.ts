// Shared SQL projections and predicates; notes remain projection-only.
import type { NoteSubject, SearchFilters } from '../../types/cache.js';

// Audio-feature lookups as correlated scalar subqueries (PK probes) rather
// than a LEFT JOIN: TRACK_COLUMNS stays self-contained — no call site has to
// remember a join — and aggregate queries over the same FROM never pay for
// features they don't read.
const featureColumn = (column: string): string =>
  `(SELECT ${column} FROM audio_features af WHERE af.track_persistent_id = t.persistent_id)`;

// The one tempo, decided once: the enriched value wins (consistent,
// analyzer-derived); the native Music.app tag is the fallback (rarely set).
// Projections and bpm filters both read this, so wire values and filter
// matches can't disagree.
export const EFFECTIVE_BPM = `COALESCE(${featureColumn('bpm')}, t.bpm)`;

// The model's own note rides every track and playlist projection the same
// way features do (PK probe per column). Projection only: no filter, sort, or
// FTS ever reads the notes table — a note is memory, not signal.
const noteColumn = (kind: NoteSubject, column: string, subjectIdExpr: string): string =>
  `(SELECT ${column} FROM notes n WHERE n.subject_kind = '${kind}' AND n.subject_id = ${subjectIdExpr})`;
const noteColumns = (kind: NoteSubject, subjectIdExpr: string): string => `
  ${noteColumn(kind, 'body', subjectIdExpr)} AS noteBody,
  ${noteColumn(kind, 'created_at', subjectIdExpr)} AS noteCreatedAt,
  ${noteColumn(kind, 'updated_at', subjectIdExpr)} AS noteUpdatedAt
`;

// SELECT fragment aliasing snake_case columns to TrackRow's camelCase fields.
export const TRACK_COLUMNS = `
  t.persistent_id AS persistentId, t.title, t.artist,
  t.album_artist AS albumArtist, t.album, t.genre, t.year,
  t.duration_seconds AS durationSeconds, ${EFFECTIVE_BPM} AS bpm,
  t.track_number AS trackNumber, t.disc_number AS discNumber,
  t.date_added AS dateAdded, t.last_played AS lastPlayed,
  t.play_count AS playCount, t.skip_count AS skipCount, t.rating,
  t.loved, t.disliked, t.comments, t.location_kind AS locationKind,
  ${featureColumn('musical_key')} AS musicalKey,
  ${featureColumn('danceability')} AS danceability,
  ${noteColumns('track', 't.persistent_id')}
`;

// SELECT fragment for PlaylistRow, shared by getPlaylist and listPlaylists so
// the two projections can't drift.
export const PLAYLIST_COLUMNS = `
  p.persistent_id AS persistentId, p.name, p.kind,
  p.parent_persistent_id AS parentPersistentId,
  (SELECT COUNT(*) FROM playlist_tracks pt
   WHERE pt.playlist_persistent_id = p.persistent_id) AS trackCount,
  ${noteColumns('playlist', 'p.persistent_id')}
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

// The faceted WHERE clause shared by searchTracks and overviewStats: identical
// predicates over the same rowset, so a search and an overview of that search
// agree by construction. Returns the FROM (FTS-joined when a free-text query is
// present) plus the WHERE fragment and its bound params; callers add their own
// projection, grouping, ordering, and limits.
export function buildTrackFilter(filters: SearchFilters): {
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

  if (filters.bpmMin != null) {
    where.push(`${EFFECTIVE_BPM} >= @bpmMin`);
    params.bpmMin = filters.bpmMin;
  }

  if (filters.bpmMax != null) {
    where.push(`${EFFECTIVE_BPM} <= @bpmMax`);
    params.bpmMax = filters.bpmMax;
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
