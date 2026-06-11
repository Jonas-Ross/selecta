// Bridge contract — the data shapes JXA emits and the typed interface tools
// depend on (docs/contracts.md §1). All Music.app coupling lives behind the
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

export interface Bridge {
  // Temporary debug capability (M1 spike). The CLI verb that exercises it
  // (`bridge:read-playlist`) is removed in M2; the method itself stays.
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
}
