# Music.app field notes

What Music.app actually does when you script it. Learned on a real iCloud-synced library; almost none of it is in Apple's documentation. When the code and these notes disagree, the notes are stale — fix them in the same PR.

## Library contents

- Music.app omits fields routinely: no genre, no rating, never played. Everything on a track except its persistent ID is optional. The bridge passes that through as-is; the cache applies defaults on write.
- `subscription` playlists (class `subscriptionPlaylist`) are Apple Music playlists the user added. Real libraries are full of them. Treat them read-only, like smart playlists.
- The special playlists (Library, Music, …) are excluded from the snapshot entirely. Caching the whole library as one giant playlist would poison co-occurrence and waste rows.
- Playlists can reference tracks that aren't in the library track list — unavailable or greyed-out entries. The bridge reports membership exactly as Music.app states it. Read queries JOIN `tracks`, so these dangling members never reach the model, except in `track_count`, which deliberately matches what Music.app displays.
- The `loved` property is gone from modern Music.app; read **and write** `favorited` instead (`set_loved` assigns it directly).
- The `location` property raises on cloud tracks. Derive locality from the track class instead: `fileTrack` means local, anything else is cloud.
- Ratings are 0–100 internally, writable via plain assignment (`track.rating = 80`); 0 clears the user rating. Tools translate to stars at the API boundary, both directions. With the user rating cleared, `rating()` may report a computed (album-derived) value rather than 0 — `ratingKind` ('user' vs 'computed') tells them apart, and the signal write scripts report null for anything non-user so computed values never masquerade as user signal.

## Persistent IDs

- Track and playlist persistent IDs are stable per library — trust them. If the user re-imports their library, they re-run `refresh_library`; no migration logic.
- **Except freshly created playlists.** iCloud reassigns a new playlist's persistent ID once sync settles (observed minutes after creation), and can even resurrect a just-deleted fresh playlist. So: the ID in a write receipt works immediately but may rotate later (the cache heals on the next refresh), `replacePlaylist` finds the preview slot by name and is immune, and test cleanup deletes scratch playlists by name too — never by creation-time ID.
- **The preview slot's identity is its name.** A first-ever `preview_playlist` creates a fresh playlist, so its receipt ID can rotate while the user is still auditioning. `preview_playlist` records the same creation receipt `create_playlist` does — only when it actually created the slot (`replacePlaylist` reports `created`) — and a clone whose source is known (cache row or receipt) to be the reserved `Selecta Preview` gets one extra step in the bridge: if the ID misses live, the script resolves the slot by exact name — exactly one plain user playlist, else it refuses (`playlist_not_found` for none, `validation_error` naming the copies for several) before anything is created. A live ID always wins, and no other playlist ever gets the name path. The refresh reconciler applies the same name-is-identity rule to the preview receipt (a lone same-name user playlist is a rekey even if the user reordered it), never to ordinary receipts.
- **Don't resolve write-path tracks by positional index against a bulk `persistentID()` read.** The two orderings silently diverge on real libraries and you get the wrong track. Use `whose({ persistentID })` per unique ID (see `src/bridge/scripts/resolve_tracks.ts`).

## iCloud sync

**Echo twins.** iCloud sometimes duplicates a freshly created playlist as sync settles — same tracks, different persistent ID. Nondeterministic: observed ~10s after one scripted create, absent for the identical call minutes later. It does this to Apple's own playlists too, so it's not something scripting causes.

> **2026-07 correction:** most *scripted-create* twins were self-inflicted — until #15 slice 2, the JXA wrapper executed every script body twice (see the run-handler bullet under JXA), so each create made two real same-name playlists in one call. That deterministic source is fixed. The reconciliation machinery stays: iCloud's own echoes (observed on Apple playlists scripting never touched) and post-create ID rekeys are real regardless.

Selecta records creation receipts and uses refresh to recognize unambiguous rekeys within 60 minutes. The old ID must be absent and exactly one same-name user playlist must remain; ordinary playlists must also match the receipt's ordered entries. The reserved preview can rekey by name because the user may have edited it while auditioning.

**Identical contents do not prove an echo.** A user can intentionally create the same name and sequence, including outside Selecta. Refresh never deletes playlists: it reports matching copies in `sync_reconciliation.ambiguous` so the model can ask which to keep before an explicit `delete_playlist`. CLI `refresh` and MCP `refresh_library` use the same operation. A surviving edited playlist is never rekeyed onto an untouched copy.

Positional edits compare the full cached order with the script's pre-edit read and refuse drift before writing. `search` with `sort: playlist_order` returns `playlist_positions` per track: actual entry positions, preserving duplicate occurrences and gaps for unavailable entries. Never use result-array indices as playlist positions. A failed bulk property read aborts refresh; it must not clear signal or reset counter baselines. Full refresh and rating writes both expose only `ratingKind: user` ratings.

**Entry edits race sync.** On an iCloud-synced library there is no read-your-writes guarantee while sync is churning. Probed extensively live during #15:

- A single `duplicate()` call sometimes materializes two real entries. Not tied to track class, playlist age, or how the playlist was fetched; clear-then-refill doesn't avoid it. The double can land immediately or a beat later. *2026-07 correction:* these probes ran through the double-executing wrapper (JXA section), so much of the observed doubling was the script adding twice, not `duplicate()` misbehaving. Genuine sync doubles haven't been re-confirmed since the fix, but the wipes and oscillation below definitely have — the add script's verify-and-trim stays as cheap insurance.
- A settling sync can wipe recent scripted edits — the playlist silently reverts to the cloud's snapshot. Freshly created playlists are worst (post-create edits reliably get wiped during the initial settle, and phantom entries from recently deleted similar playlists drift in and out), but a burst of consecutive writes triggers it on established playlists too.
- During churn, even reads oscillate between conflicting snapshots call-to-call. Everything converges once the library quiesces.

What the code does about it: the add script does a best-effort verify-and-trim (settle ~0.5s, count each added ID's occurrences against pre-read + requested, delete surplus trailing occurrences — catches doubles that land in-window; late ones heal at the next refresh). Both edit scripts return the pre-edit order read in the same script execution, because that atomic baseline is the only thing an edit can be checked against exactly. The cache is patched from the post-edit read, so cache == Music.app at that instant; later drift heals at the next refresh. The tool descriptions steer the model toward creating playlists with their full tracklist rather than create-then-edit.

## JXA

- **Never define a `run()` function in an `-e` script.** osascript evaluates the top-level code and *then* implicitly invokes a defined `run` handler — so `function run() {...} run();` executes the body TWICE per process. This shipped in v1's `wrap.ts` and silently doubled every non-idempotent script (creates made twin playlists, adds added twice) until the reorder drift guard — the first check that isn't idempotent under re-execution — caught it. The wrapper now uses a non-handler name and there's a regression test on the generated script.
- **Insertion locations don't work in Music.** Every form (`tracks.beginning`, `tracks[i].before`, …) raises ("Can't get object" / "descriptor type mismatch"). The only move that works is `Music.move(track, { to: playlist })`, which goes to the end. Positional insert therefore appends and rotates the displaced originals to the end; removal deletes by index in descending order so positions stay valid mid-loop.
- **Bulk property getters throw on empty collections.** `playlist.tracks.persistentID()` reads every value in one Apple event, but raises `-1728` (`errAENoSuchObject`, "Can't get object") when the collection is empty instead of returning `[]`. Guard with a length check. Applies to any `collection.property()` bulk read.
- Bulk getters are also the reason refresh is fast: one Apple event per property, not per track. A 3.6k-track library reads in ~12s.
- Error mapping from `osascript` stderr: `errAEPrivilegeError` / `-1743` / `Not authorized` means automation permission was denied; app-not-running / event-not-handled patterns mean Music.app isn't open; anything else is a generic JXA error.
- Each JXA call is a fresh `osascript` process. No shared state between invocations, no long-lived bridge.

### Operation ownership and interrupted calls

Refresh and Music.app writes hold a per-database `library.db.music.lock` directory across preflight, scripting, and cache updates. Enrichment independently holds `library.db.enrich.lock` across its whole run. Server-requested cooldowns of up to one minute are waited out; longer cooldowns are saved per host in SQLite, and requests to that host are skipped until expiry, including across process restarts. A competing CLI/MCP call fails with `operation_busy`; cached reads remain available. These locks coordinate Selecta processes using the same database, not edits made by Music.app or other applications.

Locks deliberately survive a process crash: stop all Selecta processes, inspect Music.app for partial writes, then remove the named lock directory before restarting. Never remove a live owner's lock. An MCP client timeout does not establish that the server operation stopped. `osascript` has a three-minute deadline; terminating it cannot undo Apple events already delivered. A timeout reports an unknown outcome, not permission to repeat a write. Metadata HTTP requests have a 30-second deadline, including body reads; 429/503 `Retry-After` delays are honored without retrying the failed request.


### Observed and partial playlist writes

Create, clone, and preview read the destination's ordered IDs after population; that snapshot supplies both membership and count in the cache. A clone keeps its source snapshot separate. `order_matches_request: false` exposes any difference instead of claiming the requested sequence was installed.

If population or destination readback throws after the playlist ID is captured, the error includes `partial_write.playlist_id` and, if readable, `observed_track_ids`. No rollback or repeat creation is attempted: either could compound iCloud churn. Refresh and inspect that playlist before choosing recovery. A killed subprocess cannot return this receipt, so its outcome remains explicitly unknown. Multiple plain user playlists named Selecta Preview now block overwrite before deletion; the user must choose which copy to retain.

Favorite/rating responses count only confirmed readbacks as `updated`; `mismatches` contains actual values for the remaining tracks. Clearing a rating and reading back null is a confirmed clear.
