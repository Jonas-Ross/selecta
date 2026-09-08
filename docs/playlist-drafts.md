# Interactive playlist drafts

## Contract

Drafts live in `drafts.db`, separately from the refreshable library cache. Each repeated track has its own occurrence ID. Edits compare the exact revision inside a SQLite transaction; stale cards must reload and reconcile. A missing draft is never silently recreated. Missing library tracks remain recoverable alongside an inspection error.

The Setlist card shows track, artist, duration and BPM. Select occurrences, open **Feedback on N tracks**, and write the requested change. With no selection the drawer says **Feedback on the playlist**. Selection identifies the subject of explicit feedback; it never means replace, remove, preserve or rank. Arrow controls change order. Pinning is retired. Older stored drafts accept and discard validated legacy pin fields when read, without rewriting storage or changing revisions; later explicit edits persist the current shape.

The open feedback field retains its height when focus moves elsewhere. Regression check: open the drawer, note the field height and footer position, then click the title or tab to another control. Both measurements must stay unchanged (68px field by default). The earlier focus-only expansion shrank the field from 68px to 34px on blur.

**Keep feedback in draft**, **Send feedback**, or another draft edit persists typed feedback. Sending includes the exact revision, ordered occurrence IDs, selection and feedback. Codex receives widget context directly; Claude Desktop Code exposes **Read widget context** and may stage messages in the composer for the user to send. Agent edits require **Reload latest**; no automatic production polling is added.

**Save to Music.app** checks the revision, durably claims the attempt, then calls the existing create handler. Partial outcomes are retained. Interrupted pending saves cannot be retried automatically; inspect Music.app first. After a completed attempt, changing the name or ordered track list permits a new explicitly requested save. Selection and feedback alone retain the save guard. A rejection that provably precedes any write releases the draft claim: `operation_busy` from the Music operation lock, `track_not_found` from the create handler's own cache check, and `automation_permission_denied` or `music_app_not_running` from the first Music.app access, each without a partial-write receipt. Fix the cause, reload the latest revision and explicitly save again. No automatic retry occurs. Other failures, including those without a partial-write receipt, retain the guard because their outcome can be uncertain; a cache failure after the Music.app call is recorded as the stored outcome so the model still learns the write happened. No audition integration is included.

## Layout and appearance

Setlist uses a compact title/count header, an options menu for Appearance, Reload latest and Track details, a collapsible sequence timeline, dense rows, and a feedback drawer. Musical key is omitted from the rows; the optional timeline key lane shows the cached fact.

The timeline preserves exact draft order and occurrence identity. Positive-duration blocks share one proportional scale; a hatched marker represents an unknown duration and a fixed-width marker represents a known zero duration. Both marker types are explicitly outside the time scale. Elapsed timestamps remain unknown after the first missing duration, while later known durations still determine their own block widths. No durations or features are invented or interpolated. A missing inspection shows unknown facts with recovery guidance.

Times under an hour use `m:ss`. At an hour they use explicit units, such as `1h 02m 03s`; at 24 hours they include days, such as `1d 19h 51m 52s`. The same format applies to runtime summaries, timeline timestamps, track durations and accessible labels.

The artist strip labels raw artist names; colors are reading aids and can repeat across different artists. **Tempo (BPM)** and **Key** toggle independent lanes, initially hidden. Tempo is not a complete energy measurement; there is no transition score or variety judgment. View toggles do not change draft revisions or model context. There are no agent section annotations in this version.

Timeline buttons and track-list checkboxes select the same exact occurrences for feedback. Buttons support Tab and Enter/Space and expose complete track, elapsed-time and feature labels even when visual text is truncated. Long and narrow timelines scroll horizontally; all entries remain available in the list. Selection, ordering, pending-save guards and reload recovery use the existing revision-checked draft flow. The timeline stays synchronized with accepted revisions and preserves its horizontal scroll position through local edits.

Appearance defaults to **Follow host**. Copper, Cobalt, Ember, Moss and Oxblood override colors while following host light/dark mode; OLED forces black. The app-only appearance helper stores this preference independently of draft revisions and model context. Existing cards read it when reopened. Changing appearance preserves typed feedback; storage errors are reported without retries.

The card uses a shadow tree to isolate host CSS. Transient requests make the editor inert without dimming controls. Unchanged row nodes survive asynchronous context delivery so reorder motion can finish; motion respects reduced-motion preferences.

Codex caps inline cards at 720 CSS pixels. The track list absorbs the viewport constraint while feedback, save and status remain visible. Size reporting measures natural height independently of the capped viewport. Track details and status have bounded overflow. The user confirmed the host-style/flicker fixes and cap-aware layout before choosing Setlist.

## Local preview

Run `npm run preview:draft`, then open `http://127.0.0.1:8766`. `SELECTA_PREVIEW_PORT` selects another port. This loopback fixture host loads the production widget, an in-memory fixture library and a temporary draft store. It never loads the live Music.app bridge or user cache. Saves are simulated; feedback appears under **Latest interaction**.

Width controls offer 760px, 553px and 390px cards. Surface controls include dark, light, Claude-like and Codex-style injected CSS with its 720px height cap. Select a **Fixture**, then **Reset fixture** to load repeated tracks, missing/zero durations, or 500 entries. Audio feature values in this preview are synthetic. Source edits reload the card; persisted fixture edits survive, but unsaved text does not. Ctrl+C stops the preview and removes its temporary store. This is a development tool, not a standalone product.

## Validation and host smoke

Controlled tests cover exact occurrence IDs, revision conflicts, selection and feedback persistence, legacy draft recovery, save guards and failures, appearance isolation, row lifetime and size reporting. Timeline tests cover cumulative time, missing/zero durations and features, repeated occurrences, proportional widths, accessible labels and 500-entry drafts. Fixture browser checks cover repeated-occurrence selection, feedback scope and messages, reordering and narrow layouts.

Earlier user-reported Claude Desktop Code checks passed discovery, repeated-track editing, context/message agreement, reload recovery, stale-edit rejection and missing-draft errors. Those checks preceded Setlist. Codex reached creation and context delivery, with subsequent user confirmation of host CSS, flicker and height fixes. The final Setlist layout still needs a fresh actual-host check after rebuilding and restarting Selecta; fixture checks do not substitute for that. No real Music.app writes were performed for the design changes.

Before marking the PR ready:

1. Rebuild with `npm run build`, restart the client's Selecta connection, and open a draft containing a repeated track.
2. Select only the second occurrence, open its feedback drawer and submit explicit feedback. Confirm context and the user message contain the same occurrence ID and revision without pins.
3. Reorder, reopen and reload; confirm saved selection, order and feedback recover. Verify stale edits fail and missing drafts show recovery guidance.
4. Check Appearance, narrow sizing and the open feedback drawer in the actual host. Save only with explicit authorization for the real playlist write.
5. Expand the timeline, toggle tempo/key lanes, and select only the second repeated occurrence. Confirm the list and feedback target agree, then reorder and reload. Check horizontal scrolling and keyboard selection in a narrow card, missing-duration breaks, and the 500-entry fixture in both supported hosts. Fixture surface simulations do not establish actual-host compatibility.
