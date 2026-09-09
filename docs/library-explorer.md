# Owned-library explorer

`show_library_explorer` opens a bundled MCP App over local stdio. It returns useful JSON in clients without Apps support. It uses the same `LibraryFilters` schema, range validation and SQL predicates as `search` and `library_overview`; the optional `filters` object is ANDed. There is no ranking, genre normalization, deduplication, automatic refresh or Music.app scripting in the explorer.

## Browsing and selection

The tool accepts `filters`, `sort` (`recently_added`, `least_played`, `most_played`), `offset` and `limit`. Defaults are the whole library, recently added, offset 0 and 25 tracks; the page limit is 50. Persistent IDs break sort ties so an unchanged cache can be traversed without repeats or omissions. Charts, rows, match count and cache age share one read transaction. Pages are fresh reads, not persisted snapshots; concurrent cache refreshes may change later pages. Reload from the first page after a refresh.

Charts describe the entire filtered slice. Raw genre spellings stay distinct, even though clicking a genre matches case-insensitively to preserve existing search semantics. Genres cap at 50 and decades at 30. Remaining counts and missing genre/year counts are explicit; **Specific genre or years** allows an exact filter beyond the chart bounds. No unknown value is assigned to a genre or decade. Runtime is a sum of known durations. Recent plays/skips are labeled as activity captured between manual refreshes in the last 30 days, not continuous listening history.

Quick filters map directly to shared predicates: **Never played** sets `max_plays: 0`, **Loved** sets `loved: true`, and **Added in 30 days** sets an explicit ISO `added_after` cutoff computed when the card opens. Active chips expose all supplied filters, including ones only available through the tool, and remove them individually. Exact genre/year fields are optional. Changing a filter resets the page and clears selection after success; a failed request restores the last successful filter inputs and keeps the last slice and selection.

Selection is temporary card state, up to 50 distinct owned persistent IDs. Separate library copies remain separate selectable rows. Selection survives page and sort changes. **Reload view**, a successful **Refresh library**, and successful filter changes clear it. Reopening the card starts a new selection. There is no separate selection database or permanent library note.

**Ask agent** requires an explicit curation request. It sends the exact selected IDs, active filters, match count and cache age. Selected tracks are seeds, not a sequenced playlist. With no selected IDs, the request applies to the whole filtered slice rather than just its current page. Selection alone publishes context without requesting work. Context deliveries are serialized; a slow host cannot leave an older update after the latest selection. The message repeats the full context so it remains usable when passive context delivery fails.

Codex receives context/messages directly; Claude Desktop Code exposes **Read widget context** and can stage messages in the composer. The card tells users to press Send when that happens. No skills installation is needed. The existing draft tools remain the path for inspecting a resulting proposal and explicitly saving it.

## Recovery and freshness

Cache age `null` means never populated; an empty populated slice instead suggests broadening filters. Unknown metadata is labeled in rows and distributions. **Reload view** rereads cached data; it never refreshes Music.app. **Refresh library** invokes the existing refresh tool only on that explicit button action, then reloads page zero after success. If refresh succeeds but the subsequent view read fails, the old selection and context are invalidated and curation stays disabled until an explicit reload succeeds. Failed reads, refreshes, context delivery and message delivery are visible; none automatically retry. A stripped initial tool result offers **Reload view** using the original input. Replayed initial results cannot overwrite a view the user has already changed.

The widget uses the existing shadow-tree isolation and natural-height reporting. It follows the host theme. The request area stays visible under the host's height cap; browsing and expanded fact explanations scroll within bounded regions.

## Local preview and validation

Run `npm run preview`, then open `http://127.0.0.1:8767` (override with `SELECTA_PREVIEW_PORT`). One gallery displays both production widgets with independent in-memory fixture libraries, fixture resets and interaction logs. Resetting one widget leaves the other alone. It never opens the user cache or calls Music.app. Shared **Maximum card width** controls offer 760px, 553px and 390px; cards shrink to fit their columns and stack in narrow windows. **Surface** controls exercise light/dark themes and representative Claude/Codex styles, including the 720px cap. Explorer fixtures cover normal slices, missing metadata, 1,000 tracks with 65 raw genres, and an empty library. **Explorer interaction** shows exact context or the message instead of sending it to an agent. Source edits reload both cards and reset temporary selection.

Automated tests cover filter consistency, bounded distributions and paging with ties, empty/unpopulated caches, validation errors, read transactions, payload validation, selection identity, request scope, recovery and ordered context delivery. A compiled-server MCP test checks tool metadata, JSON fallback and the bundled resource. Unit tests remain network-isolated and never use Music.app.

Actual-host smoke checks require the updated server connection. Rebuild with `npm run build` in the checkout the client runs, reconnect/restart Selecta, then reopen the explorer. Claude may require a full restart to clear a cached widget. Do not treat the fixture host as an actual Codex or Claude test.

1. In both Codex and Claude Desktop Code, open `show_library_explorer`, drill into a genre and decade, and compare the displayed filters/counts with `search` and `library_overview`.
2. Select a track, change page, select a second track, and send an explicit curation request. Verify the exact two IDs and filters in the context/message; send Claude's staged composer message if necessary.
3. Change filters, reopen, and reload to confirm temporary selection clears as documented. Exercise an empty slice, narrow width, and light/dark surfaces; keep the request area reachable under the host cap.
4. Verify **Reload view** changes no library data. Use **Refresh library** only when intentionally updating the real cache. No real playlist writes are needed for these checks.

Current validation: controlled tests and fixture-browser checks are local evidence. A compiled-server MCP smoke read against the existing library cache succeeded in SQLite read-only/query-only mode (3,686 cached tracks); it made no Music.app calls. Fresh checks in both actual desktop hosts remain required after loading the new server; this implementation does not claim them as completed.
