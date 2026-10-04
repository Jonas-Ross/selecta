# Desktop app

`apps/desktop` is the second front end on `@selecta/core`: brief, Claude builds a draft, you reorder and give feedback, you save. The look is the approved "Dig" direction (graphite ground, hairlines, UV for what you touch, acid kept for "now"), arriving in phases. Phase 1 restyled every screen and drew the draft as a rail. Phase 2 adds the crate to dig through and album art from Music.app; phase 3 adds playback, so there is no transport bar yet.

## Processes

| Process | Runs under | Owns |
|---|---|---|
| Renderer | Electron, sandboxed, no Node | Screens. Talks only through `window.selecta` (`src/main/preload.ts`). |
| Main | Electron | The window, and a pipe to the host. No logic. |
| Host | System `node` | Every call into core (`src/host/api.ts`), `claude -p` runs, and the draft watcher. |

The host runs outside Electron so `better-sqlite3` keeps the one native build that the MCP server, the CLI and the tests use. Rebuilding it for Electron's ABI would rewrite the shared `node_modules` copy and break the others. It talks to main over JSON lines on stdio, one request `{id, method, args}` per line, answered with `{id, result}` or `{id, error}`; events are `{event, ...}` lines. `SELECTA_NODE` picks the Node binary (default `node` on `PATH`).

The method table in `src/host/api.ts` is the whole surface, typed in `src/shared/protocol.ts`. Add a method when a screen needs one, never speculatively.

## The renderer

`src/renderer/app.tsx` only switches screens and keeps each draft's run record. Screens and their parts live in `src/renderer/components/`, one per file; anything with logic worth testing is a pure module beside them, tested in `test/` without a DOM:

| Module | Holds |
|---|---|
| `state.ts` | Rows, totals, the log, run recovery, save outcomes |
| `edits.ts` | The draft's edit queue: one edit at a time on the newest revision, the barrier Save and Home wait on, and the held order a pending edit shows |
| `lanes.ts` | Record size, the bands around the rail, tempo and key scales, step paths that break at a missing value, set-time ticks |
| `joins.ts` | Each gap's tempo step and wheel relation in plain words, from core's `harmonicRelation` |
| `facts.ts` | Where a tempo or key came from and how sure it was, in words |
| `springs.ts`, `reorder.ts` | The spring step and settle test, and where a dragged or carried record lands |
| `crate.ts`, `flight.ts` | How each record in the crate stands and shades, flick and wheel flips, and the arc a record flies from the crate to the rail |

Styles are split by concern, all built from the custom properties in `tokens.css`: `base.css` (reset, buttons, notices), `chrome.css` (top bar, save card), `home.css` (Home and Brief), `crate.css`, `rail.css`, `panel.css` (Claude), `explain.css`. The fonts are the website's, copied into `src/renderer/fonts/` and served from the bundle, since the page's CSP allows only `'self'`. The window uses an inset title bar, so the top bar is the drag region and leaves the traffic lights 80px.

### The crate

Above the rail is the crate: the cached library as records standing in a bin (`components/Crate.tsx`), filled by the host's `library.crate`. With no search it holds the 300 most recently added tracks; a search gives the 300 most relevant, copies of one song collapsed, the same search the MCP tool runs. Scroll, drag or the arrow keys flip records forward, and a flick carries on and settles on a whole record. Only the records near the front are drawn, so the crate stays the same depth however far in you are. The card beside it lists the front record's facts with their sources, as the rail's explainers do, and its buttons pull the record out to read or add it to the end of the draft. Dragging the front record carries it out of the crate; over the rail it shrinks to rail size and holds a gap open where it would land. Either way the record flies along an arc to its slot, and the edit goes in only once it has landed there, through the same queue and revision check as a reorder; one record is in the air at a time. Records already in the draft wear an "In draft" tag, and the crate refuses nothing: adding a track twice is allowed, as in Music.app. While the draft is locked, the crate can still be flipped and read.

### The rail

Records stand on the rail in draft order at equal spacing and scroll sideways past the window. Above is the tempo lane, scaled to the draft's own range; below is the key lane, the Camelot B ring over the A ring, where a ring the draft never touches shrinks to a strip. The lanes are sized by what they hold and the records take the remaining height, so the rail stays the largest thing on screen. Both are step lines, and a missing tempo or key breaks the line over a hatched "not measured" span rather than bridging it. Every gap carries a join marker: the tempo step and the wheel relation in words, geometry only, never a score or a good/bad colour. Hovering or focusing a lane title, a join or a value opens a plain-language explainer, including where a value came from (`metrognome` measured it here from a preview, a catalog supplied it, or Music.app holds it as a tag) and how sure that was.

Each record's slot is a spring (`components/Rail.tsx`). A drag lifts the record and the others slide to open a slot; Claude's edits and removals move records the same way, matched by entry ID; and the lanes and joins are redrawn every frame from where the records are, so the set's shape shows before a drop. A lifted record's caption fades out, and a join squeezed narrower than its words drops them and keeps only the glyph and tempo step. Only the joins and labels in view are drawn, which keeps an 80-track draft at frame rate. Drag is pointer events, not HTML5 drag and drop, and the keyboard does the same: arrows move focus, Alt+arrows move the record, Delete removes it, Enter or Space selects it. Reordering and removal wait while a save or another edit holds the draft, and the last record cannot be removed. With reduced motion, records snap and fade in place instead of travelling. A drop or removal shows its new order at once, but the write still goes through the edit queue and its revision check: if the edit fails, the stored order comes back and the notice says why.

Selecting records only names the subject of the next message to Claude, as chips above the feedback box. Save asks first in a card that says what will be written, after any queued edits have landed. While a draft is saved, linked to the preview, or saving, the rail locks and the head says why.

## The agent

Each turn is one `claude -p --output-format stream-json` run on the user's own Claude login (`src/host/agent.ts`). It gets:

- no built-in tools (`--tools ""`), so no shell or file access;
- only the selecta MCP server, launched from `<repo>/dist/index.js` (`--strict-mcp-config`);
- read tools plus `show_playlist_draft`, `get_playlist_draft` and `edit_playlist_draft` as the allowlist, under `--permission-mode dontAsk`;
- every other selecta tool in `--disallowedTools`, because a deny rule beats an allow rule in the user's own Claude settings. `test/agent_tools.test.ts` fails when a new MCP tool is in neither list.

Claude never saves. Save is the app's button, calling the same revision-checked operation as `save_playlist_draft`. A recorded save attempt, good or uncertain, blocks another from the app, as it does over MCP.

A draft linked to the Selecta Preview playlist (started with `preview_playlist_draft` over MCP) is read-only in the app, for you and for Claude. Core mirrors every ordered edit of a linked draft into that Music.app playlist, and the app's only Music write is Save. Detach the preview where it was started to edit the draft here. The refusal is the draft store's local-only mode, checked inside the write transaction, so a preview linked mid-run can't slip an agent edit through to Music; the agent's MCP server gets the mode through `SELECTA_LOCAL_DRAFTS=1`.

The app mints the draft ID and passes it in the brief, so the screen can open before the draft exists. Later turns `--resume` the session the first turn reported, and always tell Claude to re-read the draft, since the user may have reordered it. Sessions are held in memory: after a restart, feedback starts a fresh session on the same draft. Leaving a draft doesn't stop Claude: the host keeps each draft's numbered run record and the app replays it after a reload or a missed event, so a run that finishes or fails while you're elsewhere is there when you reopen it, and a build that failed before creating its draft stays on Home to retry. `SELECTA_CLAUDE_PATH` overrides the `claude` binary.

## Live updates

Claude's edits land in `drafts.db` through the MCP server process, not the host. The host holds one read-only connection and polls `PRAGMA data_version`, which moves when any other connection commits, then emits `drafts.changed`. The renderer re-reads the draft on that event. Concurrent edits from the user and Claude both go through revision checks: the loser gets `draft_revision_conflict` and re-reads; nothing retries automatically.

## Artwork

A sleeve shows the track's first artwork from Music.app, read through the bridge's `readArtwork`: AppleScript's `raw data of artwork 1`, run through `NSAppleScript` from JXA (`docs/music-app.md`, Artwork). It is a read; nothing in Music.app changes, and it never launches Music.app. The host (`src/host/artwork.ts`) asks one batch of up to 40 tracks at a time, shrinks each original to a 600px JPEG with `sips` in `~/Library/Caches/Selecta/artwork/<ID>.jpg`, and deletes the original. A cached thumbnail answers without Music.app; a track with no artwork is remembered until the app restarts, and a failed read is not remembered: that track answers with the error (Music.app's or `sips`') while the rest of its call still lands, the draft names it, and nothing asks again until you press "try again" on that notice. A cached thumbnail is checked on disk each time it is handed out, and one that has gone is read again. Main serves the folder to the renderer as `selecta-art://thumb/<ID>.jpg`, refusing any other name, and the page's CSP allows only that scheme besides `'self'` for images. The sleeve keeps its white label underneath and fades the art in once it has loaded. Deleting the folder is safe; it refills as records are shown.

## Running it

```bash
npm install
npm run build
npm run desktop
```

It uses the same `~/Library/Application Support/Selecta/library.db` as the MCP server, so refresh the library first. CI typechecks and bundles the app (`ELECTRON_SKIP_BINARY_DOWNLOAD=1`) but never launches it; the tests cover the host, the stream parser and the view logic, rail geometry included, without Electron or Claude.
