// Cross-cutting error envelope. Shared by every layer: the external-world
// adapters (bridge/, enrich/) THROW BridgeError; tool handlers CATCH it and
// RETURN SelectaError (the MCP wire shape). Lives in src/types/ — not inside
// bridge/ — because every other layer consumes these too and must not depend
// on the bridge package.

export type ErrorCode =
  | 'draft_not_found'
  | 'draft_revision_conflict'
  | 'operation_cleanup_failed' // creation committed, but its operation lock could not be removed
  | 'operation_busy'
  | 'automation_permission_denied' // macOS denied Music.app automation
  | 'music_app_not_running' // Music.app isn't open
  | 'jxa_error' // osascript non-zero or unparseable stdout
  | 'track_not_found' // cache miss on a referenced persistent ID
  | 'playlist_not_found' // same, for playlists
  | 'playlist_not_editable' // edit target is smart/subscription/folder, not a user playlist
  | 'validation_error' // input failed schema check
  | 'cache_unavailable' // DB open failed (perms, disk full)
  // Thrown by enrich/sources.ts on any source failure. The engine converts it
  // into a per-chunk skip (reported in the summary), so it normally never
  // reaches the wire — the code exists so the engine can tell "source failed,
  // skippable" apart from a genuine bug, which rethrows.
  | 'enrichment_error';

export type SelectaError = {
  error: ErrorCode;
  partial_write?: { playlist_id: string; observed_track_ids?: string[] };
  hint: string; // model-facing; short, actionable
};

/** Bound an ID list in error hints while retaining the exact overflow count. */
export function summarizeIds(ids: string[]): string {
  const more = ids.length > 5 ? ` (+${ids.length - 5} more)` : '';

  return `${ids.slice(0, 5).join(', ')}${more}`;
}

/** Build the one model-facing error format for cached track-ID misses. */
export function trackNotFoundError(
  missingIds: string[],
  context: { label?: string; consequence?: string } = {},
): SelectaError {
  const consequence = context.consequence != null ? ` ${context.consequence}` : '';

  return {
    error: 'track_not_found',
    hint: `${context.label ?? 'Not in the cache'}: ${summarizeIds(missingIds)}. Use persistent IDs exactly as returned by search/get_track_context; if the library changed, run refresh_library.${consequence}`,
  };
}

export class BridgeError extends Error {
  constructor(
    public readonly errorCode: ErrorCode,
    message: string,
    public readonly hint?: string,
    public readonly partialWrite?: SelectaError['partial_write'],
    // Only a validated script guard before mutation may establish this proof.
    public readonly writePhase?: 'not_started',
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

/** Use only for a validated guard that returned before any external mutation. */
export function preWriteError(code: ErrorCode, message: string, hint?: string): BridgeError {
  return new BridgeError(code, message, hint, undefined, 'not_started');
}

// Canonical model-facing hints, one per ErrorCode — the single source of
// truth. The bridge throws with only an error code; consumers
// resolve the hint as `err.hint ?? defaultHints[err.errorCode]`, so a per-call
// `hint` is reserved for overrides "when more context is available."
export const defaultHints: Record<ErrorCode, string> = {
  draft_not_found:
    'No local draft with that ID. Check the original draft_id or ask the agent to open a new draft explicitly.',
  draft_revision_conflict:
    'The draft has changed. Use get_playlist_draft and reconcile your edits before continuing.',
  operation_cleanup_failed:
    'Creation committed to Music.app and the cache, but its operation lock could not be removed. Follow the returned lock-path recovery instructions; do not repeat creation.',
  operation_busy: 'Another operation is active. Wait for it to finish before trying again.',
  automation_permission_denied:
    'macOS has not granted Music.app automation access. Ask the user to enable it in System Settings → Privacy & Security → Automation.',
  music_app_not_running: 'Music.app is not running. Ask the user to open it before retrying.',
  jxa_error:
    'Music.app returned an unexpected response. Run refresh_library or check SELECTA_DEBUG=1 logs.',
  track_not_found: 'Track is not in the cache. Cache may be stale — try refresh_library.',
  playlist_not_found: 'Playlist is not in the cache. Cache may be stale — try refresh_library.',
  playlist_not_editable:
    'Only plain user playlists can be edited — smart, subscription, and folder playlists are read-only.',
  validation_error: 'Input failed validation; see message for the offending field.',
  cache_unavailable:
    'Could not open the local cache. Check filesystem permissions on ~/Library/Application Support/Selecta/.',
  enrichment_error:
    'An external metadata source failed (network down or rate-limiting). Completed chunks of this run are already saved — call enrich_features again later to continue.',
};

/** Unknown failures rethrow unless an operation explicitly supplies a fallback. */
export function toErrorEnvelope(error: unknown, fallback?: SelectaError): SelectaError {
  if (error instanceof BridgeError)
    return {
      error: error.errorCode,
      hint: error.hint ?? defaultHints[error.errorCode],
      ...(error.partialWrite ? { partial_write: error.partialWrite } : {}),
    };

  if (fallback) return { ...fallback, hint: `${fallback.hint} ${String(error)}` };

  throw error;
}
