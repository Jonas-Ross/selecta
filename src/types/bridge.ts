// Bridge contract — the data shapes JXA emits and the typed interface tools
// depend on. All Music.app coupling lives behind the
// Bridge interface; tools depend on these types, never on the implementation.
// The cross-cutting error envelope lives in src/types/errors.ts, not here.

export type RawTrack = {
  persistentId: string; // required, everything else optional
  title?: string;
  artist?: string;
  albumArtist?: string;
  album?: string;
  genre?: string;
  year?: number;
  durationSeconds?: number;
  bpm?: number;
  trackNumber?: number;
  discNumber?: number;
  dateAdded?: string; // ISO 8601
  lastPlayed?: string; // ISO 8601
  playCount?: number; // defaults to 0 in cache
  skipCount?: number; // defaults to 0 in cache
  rating?: number; // 0..100, Music.app native scale
  loved?: boolean;
  disliked?: boolean;
  comments?: string;
  locationKind?: 'local' | 'cloud' | 'missing';
};

export type RawPlaylist = {
  persistentId: string;
  name: string;
  // 'subscription' = an Apple Music playlist the user added to their library
  // (class subscriptionPlaylist). Real in the wild; read-only like 'smart'.
  kind: 'user' | 'smart' | 'folder' | 'special' | 'subscription';
  parentPersistentId?: string;
  trackPersistentIds: string[]; // ordered; empty for folders
};

export type LibrarySnapshot = {
  capturedAt: string; // ISO 8601
  tracks: RawTrack[];
  playlists: RawPlaylist[];
};

export type PlaylistWriteResult = {
  persistentId: string;
  trackCount: number;
};

// Result of an in-place playlist mutation. trackPersistentIds is the playlist's
// FULL post-edit order read back from Music.app — the cache patch uses it as
// ground truth instead of recomputing the edit locally. preEditTrackPersistentIds
// is the order the SAME script execution saw before mutating: on iCloud
// libraries a fresh playlist can gain phantom entries asynchronously
// (docs/music-app.md, iCloud sync), so only a baseline captured atomically
// with the edit makes the edit exactly checkable.
export type PlaylistEditResult = {
  persistentId: string;
  trackCount: number;
  trackPersistentIds: string[];
  preEditTrackPersistentIds: string[];
  removedCount?: number; // remove path only: playlist entries actually deleted
  movedCount?: number; // reorder path only: entries the script actually moved
};

export interface Bridge {
  // Single-playlist read; used by integration tests and debugging.
  readPlaylist(persistentId: string): Promise<RawPlaylist>;

  readLibrary(): Promise<LibrarySnapshot>;

  createPlaylist(input: {
    name: string;
    trackIds: string[]; // Music.app persistent IDs
    description?: string;
  }): Promise<PlaylistWriteResult>;

  replacePlaylist(input: {
    name: string; // find-or-create by name, clear, repopulate
    trackIds: string[];
  }): Promise<PlaylistWriteResult>;

  // Delete one specific playlist. Used only by refresh-time iCloud-echo
  // reconciliation, where the ID comes from the snapshot just read — never
  // from a stale creation-time receipt. Resolves to the number deleted (0 if
  // the ID is already gone, which reconciliation treats as benign).
  deletePlaylistById(persistentId: string): Promise<number>;

  // Append tracks to a user playlist, or insert at a 0-based position
  // (position omitted or ≥ current length = append). Throws
  // playlist_not_found / playlist_not_editable / track_not_found without
  // writing anything.
  addPlaylistTracks(input: {
    playlistId: string;
    trackIds: string[];
    position?: number;
  }): Promise<PlaylistEditResult>;

  // Remove playlist entries by track persistent ID (EVERY occurrence of each)
  // and/or by 0-based position in the current order. Irreversible. Throws
  // playlist_not_found / playlist_not_editable / track_not_found /
  // validation_error (position out of range live) without deleting anything.
  removePlaylistTracks(input: {
    playlistId: string;
    trackIds?: string[];
    positions?: number[];
  }): Promise<PlaylistEditResult>;

  // Reorder a user playlist to `order`, a complete permutation of its current
  // 0-based positions: post-edit position i holds the entry that was at
  // order[i]. expectedTrackIds is the caller's belief of the current order
  // (the cache's); the script verifies it against the live playlist before
  // moving anything — a permutation computed against a drifted order would
  // scramble the playlist. Throws playlist_not_found / playlist_not_editable /
  // validation_error (drift or non-permutation live) without moving anything.
  reorderPlaylistTracks(input: {
    playlistId: string;
    order: number[];
    expectedTrackIds: string[];
  }): Promise<PlaylistEditResult>;
}
