// Bridge types and error envelope. Ported from docs/contracts.md §1–§2.
// All Music.app coupling lives behind the Bridge interface; tools depend on
// these types, never on the implementation.

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
  kind: 'user' | 'smart' | 'folder' | 'special';
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
}

export type ErrorCode =
  | 'not_implemented' // bridge method not yet built in the current milestone
  | 'automation_permission_denied' // macOS denied Music.app automation
  | 'music_app_not_running' // Music.app isn't open
  | 'jxa_error' // osascript non-zero or unparseable stdout
  | 'track_not_found' // cache miss on a referenced persistent ID
  | 'playlist_not_found' // same, for playlists
  | 'validation_error' // input failed schema check
  | 'cache_unavailable'; // DB open failed (perms, disk full)

export type SelectaError = {
  error: ErrorCode;
  hint: string; // model-facing; short, actionable
};

export class BridgeError extends Error {
  constructor(
    public readonly errorCode: ErrorCode,
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

// Canonical model-facing hints, one per ErrorCode. The single source of truth
// (docs/contracts.md §2). The bridge throws with only an error code; consumers
// resolve the hint as `err.hint ?? defaultHints[err.errorCode]`, so a per-call
// `hint` is reserved for overrides "when more context is available."
export const defaultHints: Record<ErrorCode, string> = {
  not_implemented:
    'This bridge method is not implemented yet in the current milestone.',
  automation_permission_denied:
    'macOS has not granted Music.app automation access. Ask the user to enable it in System Settings → Privacy & Security → Automation.',
  music_app_not_running:
    'Music.app is not running. Ask the user to open it before retrying.',
  jxa_error:
    'Music.app returned an unexpected response. Run refresh_library or check SELECTA_DEBUG=1 logs.',
  track_not_found:
    'Track is not in the cache. Cache may be stale — try refresh_library.',
  playlist_not_found:
    'Playlist is not in the cache. Cache may be stale — try refresh_library.',
  validation_error:
    'Input failed validation; see message for the offending field.',
  cache_unavailable:
    'Could not open the local cache. Check filesystem permissions on ~/Library/Application Support/Selecta/.',
};
