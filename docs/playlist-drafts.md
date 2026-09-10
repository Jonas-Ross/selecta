# Interactive playlist drafts

## Contract

Drafts live in `drafts.db`, separately from the refreshable library cache. Each repeated track has its own occurrence ID. Edits compare the exact revision inside a SQLite transaction; stale cards must reload and reconcile. A missing draft is never silently recreated. Missing library tracks remain recoverable alongside an inspection error.

The Setlist card shows track, artist, duration and BPM. Select occurrences, open **Feedback on N tracks**, and write the requested change. With no selection the drawer says **Feedback on the playlist**. Selection identifies the subject of explicit feedback; it never means replace, remove, preserve or rank. Arrow controls change order. Pinning is retired. Older stored drafts accept and discard validated legacy pin fields when read, without rewriting storage or changing revisions; later explicit edits persist the current shape.

The open feedback field retains its height when focus moves elsewhere. Regression check: open the drawer, note the field height and footer position, then click the title or tab to another control. Both measurements must stay unchanged (68px field by default). The earlier focus-only expansion shrank the field from 68px to 34px on blur.

**Keep feedback in draft**, **Send feedback**, or another draft edit persists typed feedback. Sending includes the exact revision, ordered occurrence IDs, selection and feedback. Codex receives widget context directly; Claude Desktop Code exposes **Read widget context** and may stage messages in the composer for the user to send. Agent edits require **Reload latest**; no automatic production polling is added.

**Save to Music.app** checks the revision, durably claims the attempt, then calls the same creation operation as the direct tool. The operation distinguishes rejection before writing, uncertain writes, observed success, and an observed destination whose local persistence failed. A proven pre-write rejection releases the draft claim: this includes local preflight/lock failures and validated script guards that run before creation. Error codes alone are not proof; subprocess permission/app-not-running failures can follow earlier Apple events and retain the guard. After a proven rejection, fix the cause, reload the latest revision and explicitly save again. No automatic retry occurs.

After Music.app returns a destination, membership, creation receipt, optional note and any preview-source rekey commit in one cache transaction. If that transaction fails, all these local changes roll back and `result.partial_write` retains the known target ID and observed ordered IDs. If recording the draft outcome also fails, the response retains that result and the durable pending claim blocks replay after reopening. Failure to remove an operation lock likewise preserves the settled outcome; a successful cache commit is not undone by lock cleanup failure. An interrupted pending save never clears automatically: inspect Music.app and repair local storage/operation ownership before choosing recovery.

After a completed attempt, changing the name or ordered track list permits a new explicitly requested save. Selection and feedback alone retain the save guard. For partial or uncertain outcomes, inspect the target before deciding that a new draft revision is safe to save. No audition integration is included.

## Layout and appearance

Setlist uses a compact title/count header, an options menu for Appearance, Reload latest and Track details, a collapsible sequence timeline, dense rows, and a feedback drawer. Musical key is omitted from the rows; the timeline's optional key lane shows the cached fact.

Timeline blocks share one proportional scale. An unknown duration is a fixed-width hatched marker, and the elapsed clock stays unknown from the first gap onwards rather than skipping over it; nothing is interpolated. There is no zero-duration case: the bridge treats a zero duration as unset, so the cache only ever holds positive or missing durations. Blocks and row checkboxes toggle the same occurrence selection through the revision-checked edit flow; lane toggles are view state only. Durations at or over an hour use explicit units (`1h 02m 03s`, `1d 19h 51m 52s`) everywhere the card shows time.

Appearance defaults to **Follow host**. Copper, Cobalt, Ember, Moss and Oxblood override colors while following host light/dark mode; OLED forces black. The app-only appearance helper stores this preference independently of draft revisions and model context. Existing cards read it when reopened. Changing appearance preserves typed feedback; storage errors are reported without retries.

The card uses a shadow tree to isolate host CSS. Transient requests make the editor inert without dimming controls. Rows and timeline blocks are keyed by entry ID and updated in place, so a selection, a reorder or asynchronous context delivery never replaces a node that is still moving; motion respects reduced-motion preferences.

Codex caps inline cards at 720 CSS pixels. The track list absorbs the viewport constraint while feedback, save and status remain visible. Size reporting measures natural height independently of the capped viewport. Track details and status have bounded overflow. The user confirmed the host-style/flicker fixes and cap-aware layout before choosing Setlist.

## Local preview

Run `npm run preview`, then open `http://127.0.0.1:8767`. `SELECTA_PREVIEW_PORT` selects another port. One gallery shows the production draft and explorer widgets together, side by side when space permits and stacked in narrow windows. Each has its own in-memory fixture library, fixture reset and interaction log; resetting the explorer does not change the draft. Draft state lives in a temporary store. The gallery never loads the live Music.app bridge or user cache. Saves are simulated; feedback appears under **Draft interaction**.

Shared **Maximum card width** controls offer 760px, 553px and 390px; cards shrink to fit the available column. **Surface** controls include dark, light, Claude-like and Codex-style injected CSS with its 720px height cap. Use the draft's **Fixture** selector, then **Reset draft**, to load repeated tracks, a missing duration, or 500 entries. Feature values are synthetic. Source edits reload both cards; persisted fixture edits survive, but unsaved text and temporary explorer selection do not. Ctrl+C stops the preview and removes its temporary store. This is a development tool, not a standalone product.

## Validation and host smoke

Controlled tests cover exact occurrence IDs, revision conflicts, selection and feedback persistence, legacy draft recovery, save guards and failures, appearance isolation, row lifetime and size reporting. Timeline tests cover cumulative time, missing durations and features, repeated occurrences, proportional widths, accessible labels and 500-entry drafts. Fixture browser checks cover repeated-occurrence selection, feedback scope and messages, reordering and narrow layouts.

Earlier user-reported Claude Desktop Code checks passed discovery, repeated-track editing, context/message agreement, reload recovery, stale-edit rejection and missing-draft errors. Those checks preceded Setlist. Codex reached creation and context delivery, with subsequent user confirmation of host CSS, flicker and height fixes. The final Setlist layout still needs a fresh actual-host check after rebuilding and restarting Selecta; fixture checks do not substitute for that. No real Music.app writes were performed for the design changes.

Before marking the PR ready:

1. Rebuild with `npm run build`, restart the client's Selecta connection, and open a draft containing a repeated track.
2. Select only the second occurrence, open its feedback drawer and submit explicit feedback. Confirm context and the user message contain the same occurrence ID and revision without pins.
3. Reorder, reopen and reload; confirm saved selection, order and feedback recover. Verify stale edits fail and missing drafts show recovery guidance.
4. Check Appearance, narrow sizing and the open feedback drawer in the actual host. Save only with explicit authorization for the real playlist write.
5. Expand the timeline, toggle the tempo/key lanes, and select the second repeated occurrence from its block. Confirm the list and feedback target agree, then reorder and reload. Check horizontal scrolling and keyboard selection in a narrow card and the 500-entry fixture in both supported hosts.
