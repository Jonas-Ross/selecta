# Music.app field notes

What Music.app actually does when you script it. Learned on a real iCloud-synced library; almost none of it is in Apple's documentation. When the code and these notes disagree, the notes are stale — fix them in the same PR.

## Library contents

- Music.app omits fields routinely: no genre, no rating, never played. Everything on a track except its persistent ID is optional. The bridge passes that through as-is; the cache applies defaults on write.
- `subscription` playlists (class `subscriptionPlaylist`) are Apple Music playlists the user added. Real libraries are full of them. Treat them read-only, like smart playlists.
- The special playlists (Library, Music, …) are excluded from the snapshot entirely. Caching the whole library as one giant playlist would poison co-occurrence and waste rows.
- Playlists can reference tracks that aren't in the library track list — unavailable or greyed-out entries. The bridge reports membership exactly as Music.app states it. Read queries JOIN `tracks`, so these dangling members never reach the model, except in `track_count`, which deliberately matches what Music.app displays.
- The `loved` property is gone from modern Music.app; read `favorited` instead.
- The `location` property raises on cloud tracks. Derive locality from the track class instead: `fileTrack` means local, anything else is cloud.
- Ratings are 0–100 internally. Tools translate to 1–5 stars at the API boundary, both directions.

## Persistent IDs

- Track and playlist persistent IDs are stable per library — trust them. If the user re-imports their library, they re-run `refresh_library`; no migration logic.
- **Except freshly created playlists.** iCloud reassigns a new playlist's persistent ID once sync settles (observed minutes after creation), and can even resurrect a just-deleted fresh playlist. So: the ID in a write receipt works immediately but may rotate later (the cache heals on the next refresh), `replacePlaylist` finds the preview slot by name and is immune, and test cleanup deletes scratch playlists by name too — never by creation-time ID.
- **Don't resolve write-path tracks by positional index against a bulk `persistentID()` read.** The two orderings silently diverge on real libraries and you get the wrong track. Use `whose({ persistentID })` per unique ID (see `src/bridge/scripts/resolve_tracks.ts`).

## iCloud sync

**Echo twins.** iCloud sometimes duplicates a freshly created playlist as sync settles — same tracks, different persistent ID. Nondeterministic: observed ~10s after one scripted create, absent for the identical call minutes later. It does this to Apple's own playlists too, so it's not something scripting causes.

> **2026-07 correction:** most *scripted-create* twins were self-inflicted — until #15 slice 2, the JXA wrapper executed every script body twice (see the run-handler bullet under JXA), so each create made two real same-name playlists in one call. That deterministic source is fixed. The reconciliation machinery stays: iCloud's own echoes (observed on Apple playlists scripting never touched) and post-create ID rekeys are real regardless.

To handle it, `create_playlist` records a receipt in `playlist_creations` (created ID, current ID, name, exact track sequence, timestamp). The next `refresh_library` matches receipts younger than 60 minutes against the fresh snapshot. One same-name, same-sequence user playlist under a different ID is a rekey: the receipt is remapped, nothing deleted. Two or more is an echo: the iCloud-keyed survivor is kept and the rest are deleted (safe — the ID was just observed in the snapshot). Everything the reconciler does shows up in the response's `sync_reconciliation` field, never silently. `searchTracks(inPlaylist)` follows receipts, so a creation-time ID stays resolvable after a rekey or dedupe. Same-name playlists the user made on purpose never match, because the track sequence differs.

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
