# Selecta — Design Spec

> *A* selecta *is the soundsystem term for the one who picks the records. Claude is the selector, the library is the crate. If any part of this build starts acting like the brain instead of the crate-digger's hands, it's drifted from the name.*

## Context

Selecta is a local MCP server that exposes the Apple Music library to Claude so the user can say "make a playlist around *this* song" and get a coherent, personalized tracklist built **only from music they actually own**, written back as a real playlist in Music.app.

**Core insight (load-bearing):** the MCP is NOT a taste/recommendation engine. The model is the brain. Selecta's only reason to exist is grounding — telling the model what's in the library, how the user engages with it, and turning a chosen tracklist into a real playlist. If any feature drifts toward "deciding what's similar" or "ranking candidates," it has lost the plot.

**What Selecta owns:** reading the on-machine library catalog, caching it locally, answering "what do I own relevant to X," surfacing behavioral signal (plays/loved/rating/recency/skips/date-added), writing playlists back.

**What Selecta does NOT own:** taste modeling, similarity scoring, candidate ranking, recommendation, standalone UI, cloud components, auth, anyone else's library. (Audio *features* — BPM/key/energy — are facts Selecta may surface and enrich, including from an external source; what stays out is using them to *rank or recommend* inside the MCP. See the v2 scope note under [Out of scope](#out-of-scope-v1).)

## Decisions

- **Clients:** Both Claude Desktop and Claude Code. Same stdio MCP server, two configs.
- **Library size assumption:** 2–10k tracks. Hybrid design (lightweight summaries + targeted slices); no exotic indexing needed.
- **Seed shape:** Owned-song seed OR pure-vibe seed (no track). Don't engineer for "reference an unowned track."
- **Behavioral signal:** Surface it all by default (play count, last played, loved/disliked, rating, date added, skip count). Compact fields, cheap in tokens, all load-bearing.
- **Track-context bundle:** seed + same-artist owned tracks + playlists containing the seed + co-occurring tracks from those playlists. Curatorial graph walk — leverages user's own playlists as the strongest "things that belong together" signal.
- **Vibe-only flow:** Same search tool; model adapts. No special vibe-only API.
- **Cache refresh:** Manual only via `refresh_library` tool. Write paths (create/preview playlist) patch the cache surgically so they don't desync.
- **Draft flow:** Chat-side draft + optional `preview_playlist` that overwrites a single "Selecta Preview" playlist in Music.app for auditioning. `create_playlist` materializes the final.
- **Naming:** Model picks playlist names. Names are half the point.
- **Stack:** TypeScript + JXA-via-osascript + SQLite (better-sqlite3). MCP via `@modelcontextprotocol/sdk`.
- **Search shape:** Faceted optional params (schema-defined), not free-text DSL.
- **Testing lib:** Vitest.

## Architecture

Single Node.js process speaking MCP over stdio. Both clients spawn a fresh instance per session. No daemon, no socket, no port. Cold start <200ms — cache opens lazily on first tool call.

Three internal layers:

1. **Bridge** — wraps Music.app access. Builds JXA snippets, shells out via `osascript -l JavaScript`, parses JSON. Single responsibility. All Music.app coupling lives here.
2. **Cache** — SQLite at `~/Library/Application Support/Selecta/library.db`. Tracks, playlists, playlist_tracks, refresh_log + FTS5 virtual table. All model-triggered reads hit this layer.
3. **Tools** — seven MCP handlers (the six v1 tools + `library_overview`). Thin orchestrators: validate, query cache and/or bridge, shape response.

**Boundaries.** Model never sees the bridge. Cache never knows about MCP. Tools layer is the only place "an MCP request" exists. Cache + bridge are usable as a plain Node library without MCP — keeps tests fast.

## Tool surface (seven tools)

All inputs JSON Schema-defined. All responses include `cache_age_hours`. Tool descriptions written for the model — terse, contractual, with failure-mode hints.

> Six tools shipped in v1; **`library_overview` (the seventh) was added post-v1** — the "lightweight summaries" half of the hybrid design that v1's targeted slices left unbuilt. Spec'd in `### library_overview` below, recorded in §Implementation notes.

### `search`

Faceted, all filters optional, combined as AND.

```
{
  query?: string,                  // free-text over title/artist/album (FTS5 ranked)
  artist?: string,
  genre?: string,
  year_min?, year_max?: number,
  loved?, disliked?: boolean,
  rating_min?: number,             // 1..5; converted to Music.app's 0-100 internally
  min_plays?, max_plays?: number,
  last_played_before?, last_played_after?: string,  // ISO date
  added_after?, added_before?: string,
  in_playlist?: string,            // playlist persistent ID
  location_kind?: 'local' | 'cloud',
  exclude_artists?: string[],      // exact names, case-insensitive; artistless tracks kept
  exclude_tracks?: string[],       // persistent IDs
  limit?: number,                  // default 50, max 500
  sort?: 'most_played' | 'least_played' | 'recently_added' | 'random'
                                   // omitted → relevance (with query) else most-played
}
→ { tracks: [{ persistent_id, title, artist, album, year, genre, signal: {…} }], total_matches, cache_age_hours }
```

### `get_track_context`

The curatorial graph walk.

```
{ track_id: string }
→ {
    seed: TrackWithSignal,
    same_artist: TrackWithSignal[],            // cap ~30, sort by play_count desc
    appearing_in_playlists: [{ id, name }],
    co_occurring_tracks: [{
      …TrackWithSignal,
      shared_playlist_count: number,
      shared_playlist_names: string[]          // up to 3 for context
    }],                                        // cap ~50, ranked by shared_playlist_count
    cache_age_hours
  }
```

### `list_playlists`

```
{ kind?: 'user' | 'smart' | 'folder', name_query?: string }
→ { playlists: [{ id, name, kind, track_count, parent_id? }], cache_age_hours }
```

### `library_overview` (post-v1)

The "shape of the crate" — aggregate counts and distributions so the model can orient before searching, especially for vibe-only seeds. Pure grounding: counts are **raw** (no genre normalization), `top_artists` is "most tracks owned" (a fact, not a taste ranking). Accepts the same faceted filters as `search` (minus `limit`), so it can describe a filtered slice; with no filters it describes the whole library.

```
{ …same optional facets as search, no limit }
→ {
    filtered: boolean,
    total_tracks: number,
    total_runtime_seconds: number, total_runtime_human: string,   // "9d 9h"
    genres: [{ name, count }],                  // raw, top 50, ordered desc
    genres_other?: { distinct, tracks },        // rollup beyond the cap
    decades: [{ decade: "1990s", count }],
    top_artists: [{ name, track_count }],        // top 25 by track count
    artists_total: number,                       // distinct artists past the cap
    signal: { loved, disliked, rated, unrated, never_played,
              rating_histogram: { "5": n, "4.5": n, … } },
    location: { local, cloud, missing?, unknown? },
    date_added_range: { earliest, latest } | null,
    cache_age_hours
  }
```

### `create_playlist`

Materializes the final playlist. Side effect: patches cache with new playlist + memberships.

```
{ name: string, track_ids: string[], description?: string }
→ { playlist_id: string, name, track_count }
```

### `preview_playlist`

Overwrites the single "Selecta Preview" playlist in Music.app. Same surgical cache patch.

```
{ track_ids: string[] }
→ { playlist_id: string, track_count }
```

### `refresh_library`

Full reread via JXA. Slow (minutes for 10k tracks). Tool description warns the model "only call when user asks or staleness is significant."

```
{}
→ { duration_ms, track_count, playlist_count, refreshed_at }
```

## Cache schema

```sql
CREATE TABLE tracks (
  persistent_id TEXT PRIMARY KEY,
  title TEXT, artist TEXT, album_artist TEXT, album TEXT, genre TEXT,
  year INTEGER, duration_seconds INTEGER, bpm INTEGER,
  track_number INTEGER, disc_number INTEGER,
  date_added TEXT, last_played TEXT,          -- ISO 8601
  play_count INTEGER DEFAULT 0,
  skip_count INTEGER DEFAULT 0,
  rating INTEGER,                              -- 0..100 (Music.app's scale)
  loved INTEGER DEFAULT 0, disliked INTEGER DEFAULT 0,
  comments TEXT,
  location_kind TEXT                           -- 'local' | 'cloud' | 'missing'
);

CREATE TABLE playlists (
  persistent_id TEXT PRIMARY KEY,
  name TEXT,
  kind TEXT,                                   -- 'user' | 'smart' | 'folder' | 'special'
  parent_persistent_id TEXT
);

CREATE TABLE playlist_tracks (
  playlist_persistent_id TEXT,
  track_persistent_id TEXT,
  position INTEGER,
  PRIMARY KEY (playlist_persistent_id, position)
);

CREATE TABLE refresh_log (
  refreshed_at TEXT PRIMARY KEY,
  duration_ms INTEGER,
  track_count INTEGER,
  playlist_count INTEGER,
  notes TEXT
);

CREATE VIRTUAL TABLE tracks_fts USING fts5(
  title, artist, album_artist, album,
  content='tracks', content_rowid='rowid'
);

CREATE INDEX idx_tracks_artist ON tracks(artist);
CREATE INDEX idx_tracks_genre ON tracks(genre);
CREATE INDEX idx_tracks_play_count ON tracks(play_count);
CREATE INDEX idx_tracks_loved ON tracks(loved);
CREATE INDEX idx_pt_track ON playlist_tracks(track_persistent_id);
```

- **Smart playlists:** snapshot membership at refresh time; treated as read-only (we don't write into them).
- **Cloud vs. local:** `location_kind` lets the model filter for offline use.
- **Persistent IDs:** stable per-library; trust them. If user re-imports library (rare), re-run `refresh_library`.

## Error handling

Three failure shapes, returned as structured errors so the model can react:

1. **Bridge failures** (Music.app not running, automation permission denied, JXA error). Return `{ error: "automation_permission_denied", hint: "..." }`. First-run wall — most common cause of "doesn't work." Surface clearly.
2. **Cache misses / stale state** (track_id referenced but deleted from Music.app since last refresh). Return `{ error: "track_not_found", hint: "Cache may be stale — try refresh_library." }`.
3. **Validation errors** (e.g., `year_min > year_max`). Caught at schema layer; return field-specific error.

**No hidden retries, no fallbacks.** Bridge fails → tool fails. The model decides whether to refresh, retry, or give up.

**Logging.** Stderr only (stdout is the MCP channel). Optional file at `~/Library/Logs/Selecta/selecta.log` when `SELECTA_DEBUG=1`.

## Testing

- **Unit (fast, no Music.app)** — Vitest. Cache layer against in-memory SQLite seeded with fixtures. Tool handlers with the bridge interface mocked. Bulk of the suite.
- **Bridge integration (slow, your machine)** — Vitest tagged `integration`. JXA layer exercised against a real Music.app, but against a hand-set-up test folder, not the whole library. Run on demand.
- **End-to-end smoke** — one scripted scenario (refresh → search → get_track_context → preview → create) against the real library. Manual review.
- **No Music.app behavior simulation.** Bridge interface is small; mock the interface, not Music.app's quirks. Integration tests own behavioral correctness.

## Repo layout

```
selecta/
  package.json
  tsconfig.json
  vitest.config.ts
  src/
    types/              # shared type modules (mirror docs/contracts.md)
      errors.ts         # cross-cutting error envelope (ErrorCode, BridgeError, …)
      bridge.ts         # bridge data shapes + Bridge interface
      cache.ts          # cache row shapes (M2)
    log.ts              # stderr logging shim
    bridge/
      index.ts          # public typed API (impl)
      jxa.ts            # osascript invocation, JSON parsing
      scripts/          # JXA template strings (read_library, create_playlist, …)
    cache/
      index.ts          # public typed API
      schema.ts         # CREATE TABLE statements
      db.ts             # SQLite handle, migrations
      queries.ts        # named query builders for tool handlers
    tools/
      search.ts
      get_track_context.ts
      list_playlists.ts
      create_playlist.ts
      preview_playlist.ts
      refresh_library.ts
    server.ts           # MCP server wiring
    index.ts            # entrypoint (bin)
  test/
    cache.test.ts
    tools.test.ts       # mocks bridge interface
    integration/
      bridge.test.ts    # tagged integration
  README.md             # setup, MCP config snippets for Desktop + Claude Code
```

## Build sequence

Five rough milestones, each independently demoable:

1. **Bridge spike.** JXA read of a Music.app test playlist; print JSON to stdout. Confirms automation permission flow and the JXA-via-osascript shape end-to-end.
2. **Cache + refresh.** Schema, full-library JXA read, write to SQLite, refresh_log. CLI command `selecta refresh` for testing pre-MCP.
3. **Read-side tools over MCP.** server.ts, search + get_track_context + list_playlists + refresh_library wired through MCP. Both clients registered. First "make a playlist" prompt round-trips end-to-end as a chat-only draft.
4. **Write-side tools.** create_playlist + preview_playlist via JXA, with surgical cache patching. Now full v1 loop works.
5. **Polish & docs.** README, MCP config snippets, error message review, integration smoke test, the one end-to-end scenario script.

## Verification

End-to-end check that v1 is "done":

1. Fresh clone, `npm install`, run `selecta refresh` once (allow Automation permission when prompted by macOS). Library appears in SQLite.
2. Register Selecta in Claude Desktop's MCP config. Restart Desktop.
3. In Desktop: "Make a playlist around *Teardrop* by Massive Attack, late-night vibe." Model resolves the seed via `search`, calls `get_track_context`, proposes a tracklist with rationale, in chat only.
4. "Let me preview it first." Model calls `preview_playlist`. Switch to Music.app, "Selecta Preview" playlist exists with the proposed tracks. Audition.
5. "Ship it as 'late night teardrop'." Model calls `create_playlist`. Switch to Music.app, the new playlist exists with the right name and tracks.
6. Repeat in Claude Code with the same MCP config to confirm both clients work.
7. Run `npm test` — unit suite green. Run `npm test -- --tag integration` — bridge tests green against your test playlist folder.

If all six pass and the playlist *feels* like a Jonas playlist, ship it.

## Implementation notes (v1, as built)

Where reality bent the spec during the build — details in `docs/contracts.md`:

- **Playlist kinds gained `'subscription'`** (Apple Music playlists the user added; class `subscriptionPlaylist`). Read-only like smart. Real libraries are full of them.
- **Special playlists (Library, Music, …) are excluded from the snapshot.** Caching the whole library as a playlist would poison co-occurrence and waste rows.
- **Co-occurrence counts `kind = 'user'` playlists only.** Smart/subscription playlists are machine- or Apple-curated — the design's "user's own playlists" signal means hand-made ones.
- **Dangling memberships are tolerated.** Playlists can reference tracks absent from the library (unavailable/greyed-out entries). Read queries JOIN `tracks`, so they never surface; `track_count` matches what Music.app displays.
- **`loved` reads Music's `favorited` property** (the `loved` property is gone from modern Music.app). `location_kind` derives from the track class (`fileTrack` → local, else cloud) — the `location` property raises on cloud tracks.
- **Refresh is seconds, not minutes:** bulk property getters (one Apple event per property, not per track) read a 3.6k-track library in ~12s.
- **Write-path track resolution uses `whose({persistentID})` per unique ID.** Positional indexing against a bulk `persistentID()` read silently resolves the wrong track — the two orderings diverge on real libraries.
- **Refreshes in the same millisecond collapse** (`INSERT OR REPLACE` on `refresh_log`'s timestamp key) — fine for a log.
- **Freshly created playlists have transient persistent IDs.** iCloud Music Library reassigns the ID when sync settles (observed minutes after creation), and can resurrect a just-deleted fresh playlist. "Persistent IDs are trusted" holds for refresh-time reads; a `create_playlist` receipt ID is valid immediately but may rotate later — the cache self-heals on the next refresh, and the preview slot is immune because `replacePlaylist` finds it by name.
- **iCloud Sync Library sometimes duplicates a freshly created playlist** — a second copy with identical tracks and a different persistent ID appears as sync settles. Non-deterministic and Apple-side: observed ~10s after one scripted create, absent for the identical call minutes later, twinning one of two same-night creates in live use, and the same library had pre-existing doubles of Apple's own playlists. The docs-only stance (descriptions + README, no code) didn't survive contact: the duplicates kept landing in real sessions. A post-v1 fix (2026-06) adds **refresh-time reconciliation**, scoped so it can't become a hidden fallback: `create_playlist` records a creation receipt (ID, name, exact track sequence, timestamp); the next `refresh_library` within 60 minutes matches receipts against the snapshot (name + kind `user` + identical ordered track IDs — intentional same-name dupes and user-edited copies never match), remaps iCloud **rekeys** in the receipt so the creation-time ID stays resolvable, deletes **echo twins** in Music.app (keeping the iCloud-keyed survivor — rekey observations show the new ID is canonical, and deleting the local copy minimizes resurrection risk), and reports every action in `sync_reconciliation` — visible in the response, never silent. Resurrection risk is bounded by the window: worst case the duplicate persists, same as before. Live verification showed the echo often self-collapses (Apple absorbs the provisional local copy into the cloud one within minutes — the by-ID delete then finds nothing, logged as `0 removed` and treated as benign), but not always: durable twins survive for hours, and `whose({persistentID})` was confirmed to match those, so the delete path covers them. Echoes of the preview slot remain out of scope (benign: `replacePlaylist` keeps overwriting the first name match). `npm run verify:echo` is the live verification harness.
- **Ratings cross the API boundary as 0–5 stars** (input `rating_min` and output `signal.rating` both), converted to Music's 0–100 internally — symmetric, unlike the spec sketch which only converted input.
- **`search` gained a `sort` lens (post-v1, 2026-06).** Playlists were skewing onto the same heavy-rotation tracks because no-query `search` could only order by `play_count DESC` — the model had no way to see past the top of the library. `sort` (`most_played` | `least_played` | `recently_added` | `random`) lets it deliberately pull deep cuts or a fresh sample. This stays on the identity's right side: it's *how to order a query* (neutral), not a weighting the MCP applies — the decision to vary lives in the model, nudged by the tool description, never in Selecta's SQL. A `favorite_weight`/bias knob the MCP blends was explicitly rejected as taste-in-the-MCP. Omitted `sort` preserves the historical default; non-relevance lenses carry a `persistent_id` tiebreak for stable paging (`random` intentionally doesn't).
- **`library_overview` (seventh tool, post-v1, 2026-06)** completes the hybrid design's "lightweight summaries" half. It reuses `search`'s faceted filter via a shared WHERE-builder (`buildTrackFilter`) and a shared input schema (`common.libraryFilterShape`), so search and overview never drift. Deliberate scope calls: genres are reported **raw** (no merging "Hip-Hop"/"Hip-Hop/Rap"/"Rap" — normalization is an opinion the model owns, not the MCP); `top_artists` is "most tracks owned", a fact, not a recommendation; years bucket into **decades** (shape over noise); genres cap at 50 (rest in `genres_other`), artists at 25 (`artists_total` carries breadth). Surfacing `bpm`/`comments` was scoped in then **dropped** when the live library showed them ~empty (bpm on 7/3609 tracks, comments on 29) — the shared filter shape is structured so adding `bpm_min/max` later is a one-line change. `location` reflects reality: an Apple Music / iCloud library reads as ~100% `cloud`.

## Out of scope (v1)

> **Scope change (v2, 2026-06).** After living with v1, audio-feature enrichment and editing existing playlists were deliberately graduated into scope (see CLAUDE.md Identity + issues #15–#20). The struck items below are kept for the historical v1 record. The line that still holds: Selecta surfaces *facts* (incl. audio features, incl. externally sourced); it never *ranks or recommends* candidates inside the MCP.

- Spotify integration (their audio-features / recommendations endpoints were cut off for new apps 2024-11-27).
- ~~Last.fm / MusicBrainz enrichment.~~ → MusicBrainz/AcousticBrainz is now a candidate data source for audio-feature enrichment (#19); Last.fm scrobbling stays out.
- ~~Audio analysis / ML / embeddings / similarity scoring.~~ → audio *features* (BPM/key/energy) are now in scope as facts (#19); ML/embeddings/similarity *scoring used to rank candidates* stays out.
- Scrobble logging for temporal taste evolution.
- Multi-user, cloud, auth, account systems.
- Standalone UI beyond chat.
- ~~Editing existing playlists (only create new + overwrite the dedicated preview slot).~~ → add/remove/reorder/delete now in scope (#15).
