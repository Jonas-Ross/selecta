# Selecta — Cross-cutting contracts

The types and conventions that all five build milestones consume. `docs/design.md` is the conceptual spec — *what* Selecta does. This doc is *how* the layers talk to each other so the milestones don't fight.

Terse on purpose. Code blocks are the spec.

---

## 1. Bridge typed interface

All Music.app coupling lives behind this interface. Tools never call `osascript` directly; they call methods on `Bridge`. The interface is implemented in `src/bridge/index.ts`; tools depend on the type, not the implementation.

```ts
// src/bridge/types.ts (or co-located in src/bridge/index.ts)

export interface Bridge {
  readLibrary(): Promise<LibrarySnapshot>;

  createPlaylist(input: {
    name: string;
    trackIds: string[];        // Music.app persistent IDs
    description?: string;
  }): Promise<PlaylistWriteResult>;

  replacePlaylist(input: {
    name: string;              // find-or-create by name, clear, repopulate
    trackIds: string[];
  }): Promise<PlaylistWriteResult>;
}

export type PlaylistWriteResult = {
  persistentId: string;
  trackCount: number;
};
```

### `LibrarySnapshot` — what JXA emits

The JSON the bridge produces. **Not** the cache row shape — the cache layer normalizes (e.g., booleans → 0/1, undefined → NULL).

```ts
export type LibrarySnapshot = {
  capturedAt: string;          // ISO 8601
  tracks: RawTrack[];
  playlists: RawPlaylist[];
};

export type RawTrack = {
  persistentId: string;        // required, everything else optional
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
  dateAdded?: string;          // ISO 8601
  lastPlayed?: string;         // ISO 8601
  playCount?: number;          // defaults to 0 in cache
  skipCount?: number;          // defaults to 0 in cache
  rating?: number;             // 0..100, Music.app native scale
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
```

**Why optional everywhere on `RawTrack`:** Music.app routinely omits fields (no genre, no rating, never played). The bridge does not invent defaults — the cache layer applies them on write.

---

## 2. Error envelope

Three failure shapes from `docs/design.md` §Error handling, formalized.

```ts
export type ErrorCode =
  | 'automation_permission_denied'   // macOS denied Music.app automation
  | 'music_app_not_running'          // Music.app isn't open
  | 'jxa_error'                      // osascript non-zero or unparseable stdout
  | 'track_not_found'                // cache miss on a referenced persistent ID
  | 'playlist_not_found'             // same, for playlists
  | 'validation_error'               // input failed schema check
  | 'cache_unavailable';             // DB open failed (perms, disk full)

export type SelectaError = {
  error: ErrorCode;
  hint: string;                      // model-facing; short, actionable
};

export class BridgeError extends Error {
  constructor(
    public readonly errorCode: ErrorCode,
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
  }
}
```

**Conventions:**

- Bridge layer **throws** `BridgeError`. Tool handlers **return** `SelectaError` (the MCP wire shape).
- Tool handlers wrap their body in try/catch and convert `BridgeError` → envelope using `errorCode` and either the thrown `hint` or a default for that code.
- Validation errors are produced by the input schema layer (zod) and converted to `{ error: 'validation_error', hint: <message from zod> }`.
- **No hidden retries, no fallbacks.** A failure surfaces — the model decides what to do.

### Canonical hints

```ts
const defaultHints: Record<ErrorCode, string> = {
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
```

Tool authors may override per-call via the `hint` argument to `BridgeError` when more context is available.

---

## 3. Cache query API

All read paths go through named functions in `src/cache/queries.ts`. Tools never write SQL inline. Implementations land across M2/M3/M4 — the **contract** is fixed up front so later milestones don't have to rename.

### Write-side (M2)

```ts
upsertTrack(track: RawTrack): void;
upsertPlaylist(playlist: RawPlaylist): void;
replacePlaylistMembership(
  playlistPersistentId: string,
  trackPersistentIds: string[],
): void;
pruneTracksNotIn(presentPersistentIds: Set<string>): void;
prunePlaylistsNotIn(presentPersistentIds: Set<string>): void;  // cascades to playlist_tracks
appendRefreshLog(entry: {
  durationMs: number;
  trackCount: number;
  playlistCount: number;
  notes?: string;
}): void;
```

A full refresh is a single transaction:

1. Upsert all tracks in the snapshot.
2. Upsert all playlists in the snapshot.
3. Replace memberships for every playlist in the snapshot.
4. **Prune**: delete tracks/playlists whose persistent IDs are absent from the snapshot. This is what makes the `track_not_found`/`playlist_not_found` hint ("Cache may be stale — try refresh_library") actually true after the user deletes things in Music.app. `playlist_tracks` rows for pruned playlists go with them via `ON DELETE CASCADE` (or an explicit delete in the prune helper).
5. Rebuild `tracks_fts` from the surviving `tracks` rows.
6. Append a `refresh_log` entry.

Pruning runs **after** upsert so a single transaction always leaves the cache reflecting the snapshot exactly — no window where freshly-deleted-then-readded tracks vanish.

### Read-side

```ts
// M2
getCacheAgeHours(): number | null;             // null if never refreshed

// M3
searchTracks(filters: SearchFilters): {
  rows: TrackRow[];
  total: number;                               // unbounded count, separate from limit
};
listPlaylists(filters: {
  kind?: 'user' | 'smart' | 'folder';
  nameQuery?: string;
}): PlaylistRow[];

// M4
getTrack(persistentId: string): TrackRow | null;
getTracksByArtist(artist: string, limit?: number): TrackRow[];
getPlaylistsContainingTrack(trackPersistentId: string): PlaylistRef[];
getCoOccurringTracks(
  trackPersistentId: string,
  limit?: number,
): CoOccurringTrack[];

// M5
upsertPlaylistAfterWrite(result: PlaylistWriteResult, name: string, trackIds: string[]): void;
```

### Row shapes

`TrackRow` mirrors the cache schema columns (Music.app's native rating scale, 0/1 booleans). Tools translate to API shape (`rating_min` 1–5 → `rating` 0–100) at their own boundary.

```ts
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
  rating: number | null;             // 0..100
  loved: 0 | 1;
  disliked: 0 | 1;
  comments: string | null;
  locationKind: 'local' | 'cloud' | 'missing' | null;
};

export type PlaylistRow = {
  persistentId: string;
  name: string;
  kind: 'user' | 'smart' | 'folder' | 'special';
  parentPersistentId: string | null;
  trackCount: number;
};

export type PlaylistRef = { id: string; name: string };

export type CoOccurringTrack = TrackRow & {
  sharedPlaylistCount: number;
  sharedPlaylistNames: string[];     // cap 3
};
```

---

## 4. JXA script strategy

- **One file per operation** in `src/bridge/scripts/`. Exports a builder function:

  ```ts
  // src/bridge/scripts/read_library.ts
  export function buildReadLibraryScript(): string {
    return `
      function run() {
        const Music = Application('Music');
        // ...
        return JSON.stringify({ capturedAt, tracks, playlists });
      }
    `;
  }
  ```

- **Args are JSON-stringified and interpolated into the snippet**, never passed via shell quoting:

  ```ts
  export function buildCreatePlaylistScript(args: {
    name: string;
    trackIds: string[];
    description?: string;
  }): string {
    return `
      const args = ${JSON.stringify(args)};
      function run() { /* uses args.name, args.trackIds */ }
    `;
  }
  ```

  This avoids escaping bugs entirely. JSON is valid JS.

- **`runJxa(script: string): Promise<unknown>`** in `src/bridge/jxa.ts`:
  - `child_process.execFile('osascript', ['-l', 'JavaScript', '-e', script])`.
  - Parses stdout as JSON; returns the parsed value.
  - On non-zero exit: inspect stderr, map to `BridgeError` with the right `ErrorCode`. Patterns:
    - stderr contains `errAEPrivilegeError` / `-1743` / `Not authorized` → `automation_permission_denied`.
    - stderr indicates the app isn't running / event not handled → `music_app_not_running`.
    - Anything else non-zero → `jxa_error`.
  - On JSON parse failure → `jxa_error`.

- **No shared runtime state between invocations.** Each JXA call is a fresh `osascript` process. No long-lived JXA bridge, no in-process event loop dependency.

- **No `osascript`/JXA outside `src/bridge/`.** Enforced by review; CLAUDE.md hard rule.

---

## 5. Test fixture format

- **`test/fixtures/library.json`** — matches `LibrarySnapshot` byte-for-byte. Hand-authored, small (~5 tracks, 2–3 playlists), deterministic. Includes overlapping playlist membership so co-occurrence tests have signal.
- **Cache tests** seed an in-memory SQLite via the **same write path used in production** (`refreshFromSnapshot`). No bespoke seeding code — if the production path is broken, the fixture surfaces it.
- **Tool tests** mock the `Bridge` interface (small, typed) — not Music.app's behavioral quirks. Behavioral correctness is owned by tagged integration tests against a real Music.app.
- Additional small fixtures (e.g., one with a stale-cache scenario) are siblings: `test/fixtures/<name>.json`.

---

## 6. Tool handler skeleton

Every tool handler follows the same shape so failures stay consistent and `cache_age_hours` is never forgotten.

```ts
import { z } from 'zod';

const SearchInput = z.object({
  query: z.string().optional(),
  // …rest of faceted schema from design.md §search
}).refine(/* year_min <= year_max etc. */);

export async function handleSearch(
  raw: unknown,
  deps: { cache: Cache; bridge: Bridge },
): Promise<SearchOutput | SelectaError> {
  const parsed = SearchInput.safeParse(raw);
  if (!parsed.success) {
    return { error: 'validation_error', hint: parsed.error.message };
  }

  try {
    const { rows, total } = deps.cache.searchTracks(parsed.data);
    return {
      tracks: rows.map(toApiTrack),
      total_matches: total,
      cache_age_hours: deps.cache.getCacheAgeHours(),
    };
  } catch (e) {
    if (e instanceof BridgeError) {
      return {
        error: e.errorCode,
        hint: e.hint ?? defaultHints[e.errorCode],
      };
    }
    throw e;                         // unknown errors bubble; logged by server
  }
}
```

- Input parsing **always** via zod (or equivalent). No ad-hoc type checks.
- Handlers receive `deps` (cache, bridge) — no module-level singletons. Makes testing trivial.
- The response always includes `cache_age_hours` per design.md §Tool surface.

---

## 7. Logging

- **Stderr only.** `stdout` is the MCP protocol channel — non-MCP bytes corrupt the wire.
- `src/log.ts` exposes a tiny shim:

  ```ts
  export const log = {
    info: (...a: unknown[]) => process.stderr.write(format(a) + '\n'),
    debug: (...a: unknown[]) => { if (process.env.SELECTA_DEBUG === '1') process.stderr.write(format(a) + '\n'); },
    error: (...a: unknown[]) => process.stderr.write(format(a) + '\n'),
  };
  ```

- **Optional file sink at `~/Library/Logs/Selecta/selecta.log`** opens lazily on first write **only when `SELECTA_DEBUG=1`**. Default off — no surprise files.
- The CLI verbs (`refresh`, etc.) print their final result summary to stdout because they're not the MCP server — but they go through the log shim for everything else.

---

## Change protocol

This doc is load-bearing. Modifying it ripples across milestones. Changes during implementation:

1. If a milestone discovers a contract needs to change, the change lands as a follow-up PR to this doc **before** the dependent code change is merged.
2. Renames are cheap; semantic changes (e.g., adding a new `ErrorCode`) are reviewed for downstream impact.
3. The `Out of scope` items in `docs/design.md` remain out of scope here — no new contract surface for things v1 doesn't do.
