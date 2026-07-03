# Selecta — Cross-cutting contracts

How the layers talk to each other, plus the Music.app behavior we learned the hard way. `CLAUDE.md` covers what Selecta is and how to work on it.

Terse on purpose. Code blocks are the spec.

---

## 1. Bridge typed interface

All Music.app coupling lives behind this interface. Tools never call `osascript` directly; they call methods on `Bridge`. The interface is implemented in `src/bridge/index.ts`; tools depend on the type, not the implementation.

```ts
// src/types/bridge.ts

export interface Bridge {
  // Single-playlist read; used by integration tests and debugging.
  readPlaylist(persistentId: string): Promise<RawPlaylist>;

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

  // Refresh-time iCloud-echo reconciliation only.
  deletePlaylistById(persistentId: string): Promise<number>;

  // In-place mutation of a user playlist (#15).
  addPlaylistTracks(input: {
    playlistId: string;
    trackIds: string[];
    position?: number;         // 0-based; omitted/past-end = append
  }): Promise<PlaylistEditResult>;

  removePlaylistTracks(input: {
    playlistId: string;
    trackIds?: string[];       // every occurrence of each
    positions?: number[];      // 0-based, pre-removal order
  }): Promise<PlaylistEditResult>;
}

export type PlaylistWriteResult = {
  persistentId: string;
  trackCount: number;
};

export type PlaylistEditResult = {
  persistentId: string;
  trackCount: number;
  trackPersistentIds: string[];        // FULL post-edit order — cache-patch ground truth
  preEditTrackPersistentIds: string[]; // order the SAME script execution saw pre-edit
  removedCount?: number;               // remove path only
};
```

### `LibrarySnapshot` — what JXA emits

The JSON the bridge produces. Not the cache row shape — the cache layer normalizes on write (booleans → 0/1, undefined → NULL).

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
  kind: 'user' | 'smart' | 'folder' | 'special' | 'subscription';
  parentPersistentId?: string;
  trackPersistentIds: string[]; // ordered; empty for folders
};
```

### Music.app realities

Everything on `RawTrack` except the ID is optional because Music.app routinely omits fields: no genre, no rating, never played. The bridge doesn't invent defaults; the cache fills them in on write.

`subscription` playlists are Apple Music playlists the user added. Real libraries are full of them. They're read-only, like smart playlists. The special playlists (Library, Music, …) are excluded from the snapshot entirely — caching the whole library as one giant playlist would poison co-occurrence and waste rows.

**Fresh playlist IDs are transient.** iCloud reassigns a new playlist's persistent ID once sync settles, and can even resurrect a just-deleted fresh playlist. So: the ID in a write receipt works immediately but may rotate later (the cache heals on the next refresh), `replacePlaylist` finds the preview slot by name and is immune, and test cleanup deletes scratch playlists by name too — never by creation-time ID.

**Sync reconciliation.** iCloud sometimes duplicates a freshly created playlist as sync settles. To catch this, `create_playlist` records a receipt in `playlist_creations`: created ID, current ID, name, exact track sequence, timestamp. On the next `refresh_library`, receipts younger than 60 minutes are matched against the fresh snapshot. One same-name, same-sequence user playlist under a different ID is a rekey — the receipt is remapped and nothing is deleted. Two or more is an echo duplicate — the iCloud-keyed survivor is kept and the rest are deleted via `Bridge.deletePlaylistById` (safe here: the ID was just observed in the snapshot). Everything the reconciler does shows up in the response's `sync_reconciliation` field, never silently. `searchTracks(inPlaylist)` follows receipts, so a creation-time ID stays resolvable after a rekey or dedupe.

**Dangling memberships are tolerated.** Playlists can reference tracks that aren't in the library track list (unavailable or greyed-out entries). The bridge reports membership exactly as Music.app states it and the cache stores it as-is. Read queries JOIN `tracks`, so dangling members never reach the model — except in `track_count`, which deliberately matches what Music.app displays.

**Scripted playlist-entry edits race iCloud sync.** On an iCloud-synced library there is no read-your-writes guarantee while sync is churning. Probed extensively live (#15):

- A single `duplicate()` call sometimes materializes two real entries. Not tied to track class, playlist age, or how the playlist was fetched; clear-then-refill doesn't avoid it. The double can land immediately or a beat later.
- A settling sync can wipe recent scripted edits — the playlist silently reverts to the cloud's snapshot. Freshly created playlists are worst (post-create edits reliably get wiped during the initial settle, and phantom entries from recently deleted similar playlists drift in and out), but a burst of consecutive writes triggers it on established playlists too.
- During churn, even reads oscillate between conflicting snapshots call-to-call. Everything converges once the library quiesces.

What the design does about it: the add script does a best-effort verify-and-trim (settle ~0.5s, count each added ID's occurrences against pre-read + requested, delete surplus trailing occurrences — catches doubles that land in-window; late ones heal at the next refresh). Both edit scripts return `preEditTrackPersistentIds` read in the same script execution, because that atomic baseline is the only thing an edit can be checked against exactly. The cache is patched from the post-edit read, so cache == Music.app at that instant; later sync drift heals at the next refresh, as always. The tool descriptions steer the model toward creating playlists with their full tracklist rather than create-then-edit.

**JXA insertion locations don't work in Music.** Every insertion-location form (`tracks.beginning`, `tracks[i].before`, …) raises ("Can't get object" / "descriptor type mismatch"). The only move that works is `Music.move(track, { to: playlist })`, which goes to the end. Positional insert therefore appends and rotates the displaced originals to the end (`originalCount − position` moves, each sliding the next original into the same source index). Removal deletes by index in descending order so positions stay valid mid-loop.

---

## 2. Error envelope

Three failure shapes — bridge failures, cache misses/stale state, validation errors. Lives in `src/types/errors.ts`, not inside `bridge/`, because cache and tools consume it too and must not depend on the bridge package.

```ts
// src/types/errors.ts
export type ErrorCode =
  | 'not_implemented'                // bridge method not built yet
  | 'automation_permission_denied'   // macOS denied Music.app automation
  | 'music_app_not_running'          // Music.app isn't open
  | 'jxa_error'                      // osascript non-zero or unparseable stdout
  | 'track_not_found'                // cache miss on a referenced persistent ID
  | 'playlist_not_found'             // same, for playlists
  | 'playlist_not_editable'          // edit target is smart/subscription/folder
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

Conventions:

- The bridge layer throws `BridgeError`. Tool handlers return `SelectaError` (the MCP wire shape).
- Tool handlers wrap their body in try/catch and convert `BridgeError` → envelope using `errorCode` and either the thrown `hint` or the default for that code.
- Validation errors come from the input schema layer (zod) and convert to `{ error: 'validation_error', hint: <zod message> }`.
- No hidden retries, no fallbacks. A failure surfaces; the model decides what to do.

### Canonical hints

```ts
const defaultHints: Record<ErrorCode, string> = {
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
};
```

Tool authors can override per-call via the `hint` argument to `BridgeError` when they have more context.

---

## 3. Cache query API

All read paths go through named functions in `src/cache/queries.ts`. Tools never write SQL inline.

### Write-side

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
  refreshedAt: string;        // caller supplies; one timestamp for log + result
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
4. Prune: delete tracks and playlists whose persistent IDs are absent from the snapshot. This is what makes the "cache may be stale — try refresh_library" hint actually true after the user deletes things in Music.app.
5. Rebuild `tracks_fts` from the surviving `tracks` rows.
6. Append a `refresh_log` entry.

Pruning runs after upsert so the transaction always leaves the cache reflecting the snapshot exactly — no window where a freshly-deleted-then-readded track vanishes.

### Read-side

```ts
getCacheAgeHours(): number | null;             // null if never refreshed

searchTracks(filters: SearchFilters): {
  rows: TrackRow[];
  total: number;                               // unbounded count, separate from limit
};
listPlaylists(filters: {
  kind?: 'user' | 'smart' | 'folder' | 'subscription';
  nameQuery?: string;
}): PlaylistRow[];

// get_track_context
getTrack(persistentId: string): TrackRow | null;
getTracksByArtist(artist: string, limit?: number): TrackRow[];
getPlaylistsContainingTrack(trackPersistentId: string): PlaylistRef[];
getCoOccurringTracks(
  trackPersistentId: string,
  limit?: number,
): CoOccurringTrack[];

// write-path cache patching
upsertPlaylistAfterWrite(result: PlaylistWriteResult, name: string, trackIds: string[]): void;

// library_overview
overviewStats(filters: SearchFilters): OverviewStats;   // aggregate shape of the (optionally filtered) library

// playlist edit tools (#15)
getPlaylist(persistentId: string): PlaylistRow | null;
getPlaylistTrackIds(persistentId: string): string[];    // playlist order, duplicates preserved
patchPlaylistMembership(persistentId: string, trackIds: string[]): void;  // surgical, from post-edit ground truth
```

`overviewStats` reuses the exact WHERE-clause builder behind `searchTracks` (the shared `buildTrackFilter`), so a search and an overview of the same filter agree by construction. The facade exposes it as `getOverview`, resolving `inPlaylist` through creation receipts like `searchTracks` does. The tool layer shares the faceted input schema too (`common.libraryFilterShape`), so `search` and `library_overview` accept identical facets; search adds `limit`.

### Row shapes

Defined in `src/types/cache.ts`, alongside `src/types/bridge.ts` and `src/types/errors.ts` — all shared type modules live under `src/types/`.

`TrackRow` mirrors the cache schema columns (Music.app's native rating scale, 0/1 booleans). Tools translate to the API shape (`rating_min` 1–5 → `rating` 0–100) at their own boundary.

```ts
// src/types/cache.ts
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

// library_overview aggregates. Counts are RAW (genres grouped verbatim, no
// normalization); the tool layer caps genres/artists and formats for the wire.
// rating here is 0..100.
export type OverviewStats = {
  totalTracks: number;
  totalRuntimeSeconds: number;
  artistsTotal: number;              // distinct named artists in the slice
  loved: number; disliked: number;
  rated: number; unrated: number;    // rating > 0 / (null or 0)
  neverPlayed: number;               // play_count = 0
  local: number; cloud: number; missing: number; unknownLocation: number;
  earliestAdded: string | null; latestAdded: string | null;
  genres: { name: string; count: number }[];       // full, ordered desc
  decades: { decade: number; count: number }[];     // decade start (1990), asc
  topArtists: { name: string; trackCount: number }[]; // capped in SQL
  ratingHistogram: { rating: number; count: number }[]; // rating 0..100, desc
};
```

---

## 4. JXA script strategy

One file per operation in `src/bridge/scripts/`, each exporting a builder function:

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

Args are JSON-stringified and interpolated into the snippet, never passed via shell quoting. JSON is valid JS, so this sidesteps escaping bugs entirely:

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

`runJxa(script: string): Promise<unknown>` in `src/bridge/jxa.ts` does the actual invocation:

- `child_process.execFile('osascript', ['-l', 'JavaScript', '-e', script])`.
- Parses stdout as JSON; returns the parsed value.
- On non-zero exit, inspects stderr and maps to a `BridgeError`: `errAEPrivilegeError` / `-1743` / `Not authorized` → `automation_permission_denied`; app-not-running / event-not-handled → `music_app_not_running`; anything else → `jxa_error`. JSON parse failure is also `jxa_error`.

Two things worth knowing:

- **Bulk property getters raise `-1728` (`errAENoSuchObject`) on empty collections.** `playlist.tracks.persistentID()` reads every track ID in one Apple event, but throws "Can't get object" on an empty collection instead of returning `[]`. Guard with a length check. Applies to any `collection.property()` bulk read.
- **No shared runtime state between invocations.** Each JXA call is a fresh `osascript` process. No long-lived bridge, no in-process event loop dependency.

No `osascript`/JXA outside `src/bridge/` — CLAUDE.md hard rule.

---

## 5. Test fixture format

- `test/fixtures/library.json` matches `LibrarySnapshot` byte-for-byte. Hand-authored, small (~5 tracks, 2–3 playlists), deterministic, with overlapping playlist membership so co-occurrence tests have signal.
- Cache tests seed an in-memory SQLite via the same write path used in production (`refreshFromSnapshot`). No bespoke seeding code — if the production path breaks, the fixture surfaces it.
- Tool tests mock the `Bridge` interface, not Music.app's behavioral quirks. Behavioral correctness is owned by the tagged integration tests against a real Music.app.
- Additional fixtures (e.g., a stale-cache scenario) are siblings: `test/fixtures/<name>.json`.

---

## 6. Tool handler skeleton

Every tool handler follows the same shape so failures stay consistent and `cache_age_hours` is never forgotten.

```ts
import { z } from 'zod';

const SearchInput = z.object({
  query: z.string().optional(),
  // …rest of the faceted schema (authoritative version: src/tools/common.ts)
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

- Input parsing always via zod. No ad-hoc type checks.
- Handlers receive `deps` (cache, bridge) — no module-level singletons, which keeps testing trivial.
- Every read-tool response includes `cache_age_hours`; write tools return their write receipt instead.

---

## 7. Logging

Stderr only. `stdout` is the MCP protocol channel; non-MCP bytes corrupt the wire. `src/log.ts` is a tiny shim:

```ts
export const log = {
  info: (...a: unknown[]) => process.stderr.write(format(a) + '\n'),
  debug: (...a: unknown[]) => { if (process.env.SELECTA_DEBUG === '1') process.stderr.write(format(a) + '\n'); },
  error: (...a: unknown[]) => process.stderr.write(format(a) + '\n'),
};
```

An optional file sink at `~/Library/Logs/Selecta/selecta.log` opens lazily on first write, and only when `SELECTA_DEBUG=1`. Default off — no surprise files.

The CLI verbs (`refresh`, etc.) print their final result summary to stdout because they're not the MCP server; everything else goes through the shim.

---

## Change protocol

This doc is load-bearing. If a code change moves a contract — a type, an error code, a query signature, a documented Music.app reality — update this doc in the same PR. Renames are cheap; semantic changes (like a new `ErrorCode`) get reviewed for downstream impact. The out-of-scope items in `CLAUDE.md` §Hard rules stay out of scope here: no new contract surface for things Selecta doesn't do.
