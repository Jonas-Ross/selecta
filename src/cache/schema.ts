// CREATE TABLE statements (docs/design.md §Cache schema). Idempotent — applied
// on every open. No FKs: prune does explicit deletes inside the refresh
// transaction, which keeps the schema simple and the delete order obvious.

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS tracks (
  persistent_id TEXT PRIMARY KEY,
  title TEXT, artist TEXT, album_artist TEXT, album TEXT, genre TEXT,
  year INTEGER, duration_seconds INTEGER, bpm INTEGER,
  track_number INTEGER, disc_number INTEGER,
  date_added TEXT, last_played TEXT,
  play_count INTEGER DEFAULT 0,
  skip_count INTEGER DEFAULT 0,
  rating INTEGER,
  loved INTEGER DEFAULT 0, disliked INTEGER DEFAULT 0,
  comments TEXT,
  location_kind TEXT
);

CREATE TABLE IF NOT EXISTS playlists (
  persistent_id TEXT PRIMARY KEY,
  name TEXT,
  kind TEXT,
  parent_persistent_id TEXT
);

CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist_persistent_id TEXT,
  track_persistent_id TEXT,
  position INTEGER,
  PRIMARY KEY (playlist_persistent_id, position)
);

-- Creation receipts for playlists Selecta itself created. Drives refresh-time
-- iCloud-echo reconciliation (docs/design.md §Implementation notes) and keeps
-- creation-time IDs resolvable after iCloud rekeys them: current_persistent_id
-- tracks the canonical ID, created_persistent_id never changes.
CREATE TABLE IF NOT EXISTS playlist_creations (
  created_persistent_id TEXT PRIMARY KEY,
  current_persistent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  track_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_log (
  refreshed_at TEXT PRIMARY KEY,
  duration_ms INTEGER,
  track_count INTEGER,
  playlist_count INTEGER,
  notes TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
  title, artist, album_artist, album,
  content='tracks', content_rowid='rowid'
);

CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);
CREATE INDEX IF NOT EXISTS idx_tracks_genre ON tracks(genre);
CREATE INDEX IF NOT EXISTS idx_tracks_play_count ON tracks(play_count);
CREATE INDEX IF NOT EXISTS idx_tracks_loved ON tracks(loved);
CREATE INDEX IF NOT EXISTS idx_pt_track ON playlist_tracks(track_persistent_id);
`;
