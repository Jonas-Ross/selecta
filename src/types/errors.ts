// Cross-cutting error envelope. Shared by every layer: the external-world
// adapters (bridge/, enrich/) THROW BridgeError; tool handlers CATCH it and
// RETURN SelectaError (the MCP wire shape). Lives in src/types/ — not inside
// bridge/ — because every other layer consumes these too and must not depend
// on the bridge package.

export type ErrorCode =
  | 'not_implemented' // bridge method not yet built in the current milestone
  | 'automation_permission_denied' // macOS denied Music.app automation
  | 'music_app_not_running' // Music.app isn't open
  | 'jxa_error' // osascript non-zero or unparseable stdout
  | 'track_not_found' // cache miss on a referenced persistent ID
  | 'playlist_not_found' // same, for playlists
  | 'playlist_not_editable' // edit target is smart/subscription/folder, not a user playlist
  | 'validation_error' // input failed schema check
  | 'cache_unavailable' // DB open failed (perms, disk full)
  | 'enrichment_error'; // an external metadata source failed mid-enrichment

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

// Canonical model-facing hints, one per ErrorCode — the single source of
// truth. The bridge throws with only an error code; consumers
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
  playlist_not_editable:
    'Only plain user playlists can be edited — smart, subscription, and folder playlists are read-only.',
  validation_error:
    'Input failed validation; see message for the offending field.',
  cache_unavailable:
    'Could not open the local cache. Check filesystem permissions on ~/Library/Application Support/Selecta/.',
  enrichment_error:
    'An external metadata source failed (network down or rate-limiting). Completed chunks of this run are already saved — call enrich_features again later to continue.',
};
