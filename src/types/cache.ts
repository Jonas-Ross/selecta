// Cache row shapes (docs/contracts.md §3). Mirror the SQLite schema: Music.app's
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

export type CoOccurringTrack = TrackRow & {
  sharedPlaylistCount: number;
  sharedPlaylistNames: string[]; // cap 3
};

// Faceted search filters (docs/design.md §search). All optional, combined as AND.
// rating here is Music.app's 0..100 scale — the tool layer converts from 1..5.
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
  limit?: number; // default 50, max 500
};
