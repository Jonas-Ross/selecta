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
- Discovery exposes four draft tools and an app-only appearance helper alongside the sixteen existing tools.
- A temporary loopback fixture host exercised the actual bundled widget and production draft handlers through standard MCP Apps messages. Playwright selected the second Teardrop occurrence, pinned it, moved it above Angel, sent feedback carrying that entry ID at revision 5, and reloaded with only the original tool input. Order, selection, pin and feedback were restored. Context events included explicit revisions. Explicit save reached the fake bridge once for revision 5 and disabled repeat save.
- The card rendered at 390px width in a dark fixture host. No real library writes or user-theme changes occurred.

The fixture host is not evidence that the new feature passed in either desktop application. The fixture host is available through `npm run preview:draft`.

## Desktop smoke results

User-reported Claude Desktop Code results for draft `ff9d8396-9573-44b4-a967-87964e0f0a53`:

- Passed: all four tools loaded with full schemas; cached search and opening a draft with three tracks and an intentional repeat of Talk produced distinct occurrence IDs.
- Passed: selecting, pinning and moving the second Talk occurrence produced revisions 2–4. The staged composer message, widget context and server draft agreed on revision 4, order, selection and pins, targeting only that occurrence.
- Passed: navigation away, reopening and app reload restored the same order, selection and pins.
- Passed: an agent-side edit set feedback at revision 5 while preserving entry IDs and pins. A stale revision-4 edit attempting to unpin, clear selection and replace feedback returned `draft_revision_conflict`; a follow-up read confirmed revision 5 remained intact.
- Passed: a nonexistent UUID returned `draft_not_found` with a useful recovery hint.
- Passed in user follow-up: typed feedback, selection, order and pins survive reload after the remaining feedback/recovery check. This result applies to the pre-redesign card.
- No save, audition, library refresh, Music.app change or theme change was reported.

Observed limitation: an agent-side edit does not automatically update an already mounted card or its published context. The reported card/context remained at revision 4 after the server reached revision 5. Source inspection confirms **Reload latest** reads the current draft and updates the card without reopening it; the user subsequently confirmed the remaining recovery check passed. Recovery alone does not republish widget context; a subsequent widget edit or feedback message carries the current revision. Stale submissions are rejected. No polling or automatic synchronization is implemented.

Codex task-surface testing started with draft `718f6655-2535-4bf3-b02e-cd07f01c9504`: discovery and draft creation succeeded, and widget context reached the model at revision 5. The user confirmed animations worked but reported action flicker and incorrect colors, including explicit palettes. This is a partial smoke result, not a pass.

Inspection of the installed Codex renderer found injected global CSS overlapping the card's custom properties, body spacing and form controls. The card now mounts its styles and content in a shadow tree and inherits only the standard MCP host theme variables. Follow host uses neutral host text colors instead of the leftover purple accent. Temporary requests make the editor inert without dimming every button; feedback updates only when a server response is accepted, avoiding a flash back to old text during submission. The controlled render regression checks transient interaction blocking, stable disabled states, feedback retention and animated row lifetime. The fixture host includes representative CSS collisions; browser checks verified Copper rendering and occurrence selection, pin/reorder and feedback through the isolated tree. Actual-host rechecking remains pending.

## Desktop smoke checklist

The two target surfaces were established in [issue #84](https://github.com/Jonas-Ross/selecta/issues/84): OpenAI Codex task surface and Claude Desktop Code. Use the following checks in each after reconnecting the updated Selecta server; results and remaining gaps are recorded above:

1. Run `npm ci && npm run build` in the configured checkout; reconnect Selecta. Confirm `show_playlist_draft`, `get_playlist_draft`, `edit_playlist_draft`, and `save_playlist_draft` are available. Open a fresh card; Claude may need a full restart to clear resource caching.
2. Ask the agent to search for a few owned tracks and open a draft that intentionally repeats one ID. Check titles, artists, runtime, known BPM/key and missing facts.
3. Select only the second occurrence, pin it, and reorder it. Verify the agent receives the exact entry and current revision. On Claude use **Read widget context**; on Codex context should arrive directly.
4. Enter feedback and send it. On Claude send the staged composer message; on Codex verify direct delivery.
5. Navigate away and reopen, then reload the app. Confirm edits and selection recover; if the host supplies neither input nor result, paste the displayed draft UUID into **Recover draft**. Check a nonexistent UUID's useful recovery message.
6. Open the same draft in a second card or edit it through the agent. Attempt an edit from the older revision and confirm rejection followed by **Reload latest** recovery. Preserve the user's current theme.
7. Save only a user-approved real draft, if desired. This is an actual library write; fixture tests already cover the contract. Never use destructive fault injection or remove user playlists for this smoke check.

The PR remains a draft while the Codex smoke check is pending. The visual redesign must also be checked in the actual hosts after browser review. Prior compatibility testing is not counted as evidence for this feature.

## Live design preview

Run `npm run preview:draft`, then open `http://127.0.0.1:8766`. Use `SELECTA_PREVIEW_PORT` to choose a different port. This development-only loopback host loads the actual bundled widget, a fixture library in memory, and a temporary draft store. It never loads the live Music.app bridge or user cache. Save is simulated and feedback appears under **Latest interaction**.

Use the width selector for 760px, 553px or 390px cards, and the surface selector for dark, light or Claude-like colors. These controls affect only the preview. Editing `ui/playlist-draft.html` or `ui/playlist-draft.js` rebuilds and reloads the card automatically; persisted fixture edits survive reload. Unsaved text does not. **Reset fixture** starts a fresh draft. Ctrl+C stops the preview and removes its temporary store. This is a development tool, not a shipped standalone UI or an alternative to host smoke testing.

The design pass uses aligned time/BPM/key columns, compact icon controls, occurrence-specific selection highlighting, a focused feedback composer, and secondary save. IDs remain accessible in Track details. Browser checks verified selection of the second repeated occurrence, pin/reorder, feedback carrying revision 5, persistence across preview remount, and the 390px Claude-like surface. Keyboard focus and queue scroll are retained during row redraws. This does not replace the pending Codex host smoke check.

### Appearance

The local preview offers three layout studies: **1. Queue** uses a compact title/count header, an options menu, expanding feedback input and slim action bar; **2. Sidecar** places the composer beside the queue on wide cards and below it on narrow cards; **3. Setlist** uses dense rows and a feedback drawer. The chooser rearranges the existing controls without remounting the widget, preserving draft edits and typed feedback. A caption reports the visible track area. These studies live in `ui/preview-designs.js` and `ui/preview-designs.css` and are injected only by the fixture host; they are not included in the MCP resource. Browser checks covered all three at 760px and 390px, retained feedback across switches, and selection, pinning, reordering and feedback submission.

Pulse is the shipped design, including entry motion that respects reduced-motion preferences. **Appearance** defaults to **Follow host**. Copper, Cobalt, Ember, Moss and Oxblood explicitly override the host colors, with light and dark versions following the host mode; OLED forces true black and dark controls. Returning to Follow host restores the current host colors and mode.

The choice is stored locally in a separate preferences table in `drafts.db`, through the app-only `playlist_draft_appearance` helper. It survives card reloads and is read when a new card connects. Already open cards retain their appearance until reopened or changed. It never increments a draft revision, changes library state, or enters model context. Changing appearance preserves typed feedback. Storage failures are reported without automatic retry.

Rendering retains rows when their displayed state is unchanged, so asynchronous context delivery cannot cancel reorder motion by replacing the animated nodes. A controlled regression test covers that race.

The user confirmed the isolated card looked correct, then reported a persistent outer scrollbar. Removing document margins and rounding the requested height did not resolve the actual-host failure. Inspection of the installed Codex renderer established a 720-CSS-pixel inline height cap. The preview now reproduces that cap under **Codex-style injection**. The card fits the iframe viewport with a flexible track list while feedback, save and status stay visible; expanded details are bounded independently. Size notifications measure the unconstrained natural height synchronously, so a small initial iframe cannot lock subsequent size requests to that small height. Controlled sizing coverage tests natural height beyond the cap. Browser measurements at 390px width and with expanded details showed equal document scroll/client heights (718px inside the bordered 720px fixture), with overflow confined to the track list. The user confirmed the cap-aware layout and requested a further preview pass to reduce header and footer space.
