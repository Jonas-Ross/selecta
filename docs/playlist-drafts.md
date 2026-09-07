# Playlist draft verification

The widget uses standard [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview) over Selecta's existing local stdio transport. The SDK and UI are bundled by `npm run build`; the server serves one `ui://selecta/playlist-draft.html` resource. No host adapter, CDN, service or skill installation is involved.

## State and save contract

`show_playlist_draft` takes a caller-supplied UUID so the original tool input identifies the card even if the host loses its structured result. A repeated call with that ID fails rather than resetting it. `get_playlist_draft` opens the draft file read-only; it does not create a missing store. Drafts are stored separately from library snapshots and enrichment. Every occurrence has a distinct immutable `entry_id` tied to its `track_id`.

All edits use SQLite transactions with a required revision. A stale card fails rather than replacing a later edit. New entries omit `entry_id`; existing occurrences retain theirs. Unknown tracks fail before edits that replace the list. Recovery still returns existing state if inspection fails (for example, a track left the library).

Selection, feedback and pins are local state and agent context only. Feedback text is committed by **Keep feedback in draft**, **Send feedback to agent**, or another draft edit. Arrow controls change order; pins ask the agent to retain entries, without ranking or enforcing positions.

Save checks the requested revision, claims it durably, then calls `handleCreatePlaylist`. The result, including existing errors and `partial_write`, is persisted. A receipt-storage failure preserves the returned Music.app outcome and leaves the durable pending claim in place. Concurrent edits and repeated saves cannot race a pending claim. Interrupted pending saves require inspection of Music.app; there is no automatic retry or pending-state reset. After a completed attempt, a changed name or ordered track list permits another explicitly requested save. Feedback, pin and selection changes alone retain the guard. There is no audition integration or fingerprint write precondition.

## Automated and controlled checks

On September 7, 2026:

- Unit/protocol coverage exercises repeated occurrences, exact selections, persistence across store instances, stale revisions, identity reassignment, unknown tracks, read-only recovery, missing drafts, missing tracks after refresh, concurrent save/edit, partial write errors, interrupted claims and receipt-storage failures.
- Real stdio discovery exposes the four draft tools alongside the sixteen existing tools.
- A temporary loopback fixture host exercised the actual bundled widget and production draft handlers through standard MCP Apps messages. Playwright selected the second Teardrop occurrence, pinned it, moved it above Angel, sent feedback carrying that entry ID at revision 5, and reloaded with only the original tool input. Order, selection, pin and feedback were restored. Context events included explicit revisions. Explicit save reached the fake bridge once for revision 5 and disabled repeat save.
- The card rendered at 390px width in a dark fixture host. No real library writes or user-theme changes occurred.

The fixture host is not evidence that the new feature passed in either desktop application. It remains scratch verification outside the repository.

## Desktop smoke checklist — pending

The two target surfaces were established in [issue #84](https://github.com/Jonas-Ross/selecta/issues/84): OpenAI Codex task surface and Claude Desktop Code. The current feature still needs the following checks in each after reconnecting the updated Selecta server:

1. Run `npm ci && npm run build` in the configured checkout; reconnect Selecta. Confirm `show_playlist_draft`, `get_playlist_draft`, `edit_playlist_draft`, and `save_playlist_draft` are available. Open a fresh card; Claude may need a full restart to clear resource caching.
2. Ask the agent to search for a few owned tracks and open a draft that intentionally repeats one ID. Check titles, artists, runtime, known BPM/key and missing facts.
3. Select only the second occurrence, pin it, and reorder it. Verify the agent receives the exact entry and current revision. On Claude use **Read widget context**; on Codex context should arrive directly.
4. Enter feedback and send it. On Claude send the staged composer message; on Codex verify direct delivery.
5. Navigate away and reopen, then reload the app. Confirm edits and selection recover; if the host supplies neither input nor result, paste the displayed draft UUID into **Recover draft**. Check a nonexistent UUID's useful recovery message.
6. Open the same draft in a second card or edit it through the agent. Attempt an edit from the older revision and confirm rejection followed by **Reload latest** recovery. Preserve the user's current theme.
7. Save only a user-approved real draft, if desired. This is an actual library write; fixture tests already cover the contract. Never use destructive fault injection or remove user playlists for this smoke check.

No new-feature desktop pass is claimed yet: this task's live connector still advertised only the original sixteen tools during implementation. The PR remains a draft until these host checks are recorded.
