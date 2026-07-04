// Cache row shapes. Mirror the SQLite schema: Music.app's
// native 0..100 rating scale, 0/1 booleans, NULL for absent. Tools translate to
// API shape (e.g. rating_min 1–5 → 0..100) at their own boundary.

export type TrackRow = {
  persistentId: string;
  title: string | null;
  artist: string | null;
  albumArtist: string | null;
  album: string | null;
  genre: string | null;
  year: number | null;
  durationSeconds: number | null;
  bpm: number | null;
  trackNumber: number | null;
  discNumber: number | null;
  dateAdded: string | null;
  lastPlayed: string | null;
  playCount: number;
  skipCount: number;
  rating: number | null; // 0..100
  loved: 0 | 1;
  disliked: 0 | 1;
  comments: string | null;
  locationKind: 'local' | 'cloud' | 'missing' | null;
};

export type PlaylistRow = {
  persistentId: string;
  name: string;
  kind: 'user' | 'smart' | 'folder' | 'special' | 'subscription';
  parentPersistentId: string | null;
  trackCount: number;
};

export type PlaylistRef = { id: string; name: string };

// A row in playlist_creations: the receipt for a playlist Selecta created.
// createdPersistentId is the ID Music.app returned at creation and never
// changes; currentPersistentId tracks the canonical ID after iCloud rekeys
// or echo-duplicate reconciliation.
export type PlaylistCreationRow = {
  createdPersistentId: string;
  currentPersistentId: string;
  name: string;
  trackIds: string[];
  createdAt: string;
};

// Reconciliation plan entries computed after a refresh (docs/music-app.md,
// iCloud sync). 'rekey' = iCloud reassigned the ID, single copy
// survives; 'duplicate' = an echo twin appeared — keep the iCloud-keyed copy,
// delete the rest.
export type ReconcileAction =
  | { kind: 'rekey'; createdId: string; name: string; fromId: string; toId: string }
  | { kind: 'duplicate'; createdId: string; name: string; keepId: string; deleteIds: string[] };

export type CoOccurringTrack = TrackRow & {
  sharedPlaylistCount: number;
  sharedPlaylistNames: string[]; // cap 3
};

// searchTracks row. alternateIds is only present on a dedupe search, on rows
// that collapsed duplicates: the suppressed copies' persistent IDs, sorted.
export type SearchResultRow = TrackRow & {
  alternateIds?: string[];
};

// Aggregate "shape of the crate" for library_overview (post-v1). Computed over
// the same filtered rowset SearchFilters describes — so an overview can scope to
// a slice. Counts are RAW: genres are grouped verbatim (no normalization), the
// tool layer caps/rolls-up and formats for the wire. rating here is 0..100.
export type OverviewStats = {
  totalTracks: number;
  totalRuntimeSeconds: number;
  artistsTotal: number; // distinct named artists in the slice
  loved: number;
  disliked: number;
  rated: number; // rating > 0
  unrated: number; // rating null or 0
  neverPlayed: number; // play_count = 0
  local: number;
  cloud: number;
  missing: number;
  unknownLocation: number; // location_kind NULL
  earliestAdded: string | null;
  latestAdded: string | null;
  genres: { name: string; count: number }[]; // full, ordered desc; tool caps
  decades: { decade: number; count: number }[]; // decade start (1990), asc
  topArtists: { name: string; trackCount: number }[]; // already capped in SQL
  ratingHistogram: { rating: number; count: number }[]; // rating 0..100, desc
};

// Faceted search filters. All optional, combined as AND.
// rating here is Music.app's 0..100 scale — the tool layer converts from 1..5.
// Shared by searchTracks and overviewStats (overview ignores `limit`).
export type SearchFilters = {
  query?: string;
  artist?: string;
  genre?: string;
  yearMin?: number;
  yearMax?: number;
  loved?: boolean;
  disliked?: boolean;
  ratingMin?: number; // 0..100
  minPlays?: number;
  maxPlays?: number;
  lastPlayedBefore?: string; // ISO date
  lastPlayedAfter?: string;
  addedBefore?: string;
  addedAfter?: string;
  inPlaylist?: string; // playlist persistent ID
  locationKind?: 'local' | 'cloud';
  excludeArtists?: string[]; // exact names, case-insensitive; NULL-artist rows are kept
  excludeTracks?: string[]; // persistent IDs
  // Collapse rows that are the same song (same normalized title + artist) to
  // one canonical representative. Presentation, not ranking: the winner is a
  // deterministic tiebreak (loved → non-compilation → earliest year → stable
  // ID), never a quality score. Distinct titles (remix/live/edit) don't
  // collapse. search-only, like `sort`.
  dedupe?: boolean;
  limit?: number; // default 50, max 500
  // How to order results. Omitted → relevance (with query) else most-played.
  // A neutral lens, not a ranking opinion: lets the model escape the
  // most-played pool when building a varied playlist. search-only (overview
  // aggregates, so it never sets this). 'playlist_order' is only valid with
  // inPlaylist set — the tool layer enforces that.
  sort?: 'most_played' | 'least_played' | 'recently_added' | 'random' | 'playlist_order';
};
