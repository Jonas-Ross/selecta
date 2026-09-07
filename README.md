# Selecta

> A *selecta* is the soundsystem term for the one who picks the records. Your AI agent is the selector; your library is the crate.

A local MCP server that gives AI agents access to your Apple Music library, so they can build playlists from music you actually own and write them back to Music.app.

There's no recommendation engine in here, no similarity scoring, no ML. Your agent does the picking. Selecta tells it what you own, how you listen (plays, favorites, ratings, skips, your own playlists) and, where known, how the music moves (BPM, key, danceability), and turns the tracklist your agent comes up with into a real playlist.

## Requirements

- macOS with Music.app
- Node.js 22+

## Setup

```bash
git clone https://github.com/Jonas-Ross/selecta.git
cd selecta
npm install
npm run build
```

Then populate the cache. macOS will ask for Music.app automation permission the first time; allow it.

```bash
node dist/index.js refresh
```

This reads your whole library into a SQLite cache at `~/Library/Application Support/Selecta/library.db`. A few thousand tracks take 10–15 seconds. The cache never refreshes itself, so rerun `refresh` (or ask your agent to call `refresh_library`) after your library changes.

Optionally, backfill tempo and key data so your agent can sequence by BPM:

```bash
node dist/index.js enrich        # all not-yet-attempted tracks
node dist/index.js enrich -n 200 # or a batch at a time
```

This looks tracks up on MusicBrainz/AcousticBrainz and Deezer (free, no API keys) at roughly 1–3 seconds per track, so a large library takes a while — it's safe to interrupt and resume. Coverage is partial by nature: many tracks, especially recent releases, simply have no data anywhere, and those are remembered so they aren't looked up twice. Refreshing the library never discards features already fetched.

For a read-only health report, use `status`. It checks the database without creating, migrating, refreshing, enriching, or contacting Music.app. `doctor` adds one read-only Music.app availability and Automation probe. Both write one JSON result to stdout.

```bash
node dist/index.js status
node dist/index.js doctor
```

Set `SELECTA_DEBUG=1` to mirror stderr logging to `~/Library/Logs/Selecta/selecta.log`. Failure to create or append that file is reported on stderr and never stops the MCP server.

## Register with an MCP client

Selecta is agent-independent: use an MCP client that can launch a local server over stdio. Configure it to run `node` with `/ABSOLUTE/PATH/TO/selecta/dist/index.js` as its argument, with no subcommand. The server exposes the same tools regardless of which agent uses them. The Claude configurations below are examples.

For Claude Desktop, add this to `~/Library/Application Support/Claude/claude_desktop_config.json` (create the `mcpServers` key if it isn't there) and restart the app:

```json
{
  "mcpServers": {
    "selecta": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/selecta/dist/index.js"]
    }
  }
}
```

For Claude Code, from any directory:

```bash
claude mcp add --scope user selecta -- node /ABSOLUTE/PATH/TO/selecta/dist/index.js
```

Then try: *"Make a playlist around Teardrop by Massive Attack — late-night vibe. Preview it first."*

For visual iteration without reconnecting MCP, run `npm run preview:draft` and open [the local design preview](http://127.0.0.1:8766). It uses the same widget with fixture data, simulated saves, live reload, and width/surface controls.

## Tools

Twenty tools, in four groups. The first group answers from the local cache and never touches Music.app; the second writes to Music.app; the third keeps the cache current and holds the agent's own notes.

### Reading

| Tool | What it does |
|---|---|
| `search` | Faceted search over the cache: free text, artist, genre, year, BPM range, rating, favorites, play counts, last-played and date-added windows, playlist membership, local/cloud, plus artist and track exclusions. Sort lenses for most/least played, recently added, recent plays, random, or a playlist's own order. `dedupe` collapses copies of the same song across albums; `compact` shrinks the payload for wide sweeps. Every result carries play, skip and rating stats, and BPM, key and danceability where known. |
| `library_overview` | The shape of the library, or a filtered slice of it: genres, decades, top artists by track count, favorites and ratings coverage, runtime, how much of it has a known BPM, and plays and skips captured over the last 30 days. Same filters as `search`. |
| `get_track_context` | What sits around a track in your own playlists: same-artist tracks, the playlists it's in, and the tracks that co-occur with it. Accepts up to 20 seeds at once for a combined co-occurrence view. Single-seed calls include the track's play history across refreshes. You can leave specific playlists out, or skip any above a given size, before it counts; the response says which playlists were considered and which were dropped. |
| `inspect_tracklist` | Sanity-check an ordered draft before previewing or creating it: runtime, repeated IDs, duplicate copies of the same song, artist counts, per-track signal, and where BPM and key data is missing. Facts only, no judgement. |
| `list_playlists` | Your playlists, with kind (`user`/`smart`/`subscription`/`folder`) and track counts. Filter by kind or name. |

### Interactive drafts

| Tool | What it does |
|---|---|
| `show_playlist_draft` | Opens an ordered interactive draft with existing inspection facts. Supply a fresh UUID as `draft_id`, a name, and ordered track IDs. Each occurrence gets its own entry ID. |
| `get_playlist_draft` | Read-only recovery of the latest local draft, including selection, pins, feedback and save outcome. |
| `edit_playlist_draft` | Changes the draft at an explicit revision. Preserve occurrence IDs when reordering or revising. Stale edits fail instead of overwriting newer work. |
| `save_playlist_draft` | Saves an explicitly approved revision using the existing `create_playlist` contract. Selection, pinning and feedback never call it. |

Ask your agent to **open an interactive playlist draft**. Select entries, move them with the arrow buttons, and pin entries you want retained in later revisions. Use **Keep feedback in draft** to persist text, or **Send feedback** to request a revision. Codex receives context/messages directly; Claude Desktop Code exposes context through **Read widget context** and may stage feedback in the composer for you to send. Pins are instructions for you and your agent, not scores or enforced positions.

Drafts live in `~/Library/Application Support/Selecta/drafts.db`, separate from library refreshes. **Reload latest** restores persisted edits. If a host omits the original result after reload, the card recovers from the original tool input's draft ID; you can also paste that ID into **Recover draft**. A missing draft is reported explicitly. Uncommitted feedback text must be kept or sent before closing the card. Missing library tracks remain visible by ID in recovered drafts, with an inspection error; ask the agent to replace them before saving.

**Save to Music.app** explicitly creates a real playlist. A save attempt is recorded before the Music.app call and its result is retained, including partial-write errors. Pending outcomes after interruption are uncertain and cannot be retried automatically; inspect Music.app before choosing further action. A changed name or track order/list can be saved as a new revision after a completed attempt. Selection, feedback and pin changes alone do not re-enable save. Playback and preview-slot controls are outside this widget.

After updating Selecta, run `npm ci && npm run build` in the checkout your connector runs. The build bundles the widget and SDK into `dist/ui/playlist-draft.html`; no CDN or separate service is needed. Restart/reconnect Selecta in your MCP client so it discovers the four new tools, and reopen the card (Claude may need a full app restart to clear cached resources). Existing core tools still work in hosts without MCP Apps. See [draft smoke checks](docs/playlist-drafts.md) for verification and current desktop-test status.

### Writing to Music.app

| Tool | What it does |
|---|---|
| `preview_playlist` | Overwrites the single "Selecta Preview" playlist so you can audition a draft. Previous preview contents are discarded. |
| `create_playlist` | Creates the real playlist, either from ordered track IDs or by cloning an approved preview (or any plain user playlist, max 500 entries) in its current live order. Optional description and note. |
| `add_tracks` / `remove_tracks` | Append or insert tracks into a user playlist; remove entries by track ID or by position. Smart and subscription playlists are read-only. |
| `reorder_tracks` | Rearrange a user playlist's entries to a new order (a full permutation of its current positions). |
| `delete_playlist` | Delete a user playlist outright. Irreversible — the tracks stay in your library, the playlist doesn't. |
| `set_loved` / `set_rating` | Favorite or unfavorite tracks; set a star rating (0–5, half stars allowed, 0 clears). Both reversible. |

### Maintaining the cache

| Tool | What it does |
|---|---|
| `refresh_library` | Full reread of Music.app into the cache. Manual by design. Also records play and skip deltas since the previous refresh, and remaps unambiguous recent playlist rekeys and reports ambiguous copies without deleting them. |
| `set_note` | Save the agent's own note on a track or playlist ("great opener", "user preferred the plain name") so it's there next session. Cache-only, never written to Music.app. Notes come back verbatim on reads; Selecta never filters or ranks on them. |
| `enrich_features` | Fetch BPM, key and danceability for tracks not yet attempted, from MusicBrainz/AcousticBrainz and Deezer. Works through the most-played backlog, or targets specific track IDs (up to 50). The only tool that uses the network. For a whole-library backfill, prefer the `enrich` CLI command above. |

Selecta only writes where you point it: it creates playlists, overwrites its own preview slot, edits or deletes the user playlists you ask it to, and sets favorites and ratings on the tracks you name. Smart, subscription and folder playlists are never modified.

## Development

The application version is maintained in `package.json`; MCP server metadata and the enrichment User-Agent read it through `src/version.ts`. Keep `package-lock.json` in sync when bumping it.

| Command | Use |
|---|---|
| `npm test` | Unit suite (fast, no Music.app) |
| `npm run test:integration` | Bridge tests against your real Music.app. Needs a user playlist named `Selecta Test` with at least two tracks. |
| `npm run smoke` | End-to-end scenario over real MCP stdio: refresh → search → context → preview → create, then cleans up after itself. |
| `npm run build` | TypeScript and bundled widget → `dist/` |
| `npm run lint` | oxlint |
| `npm run format:check` | oxfmt check (`npm run format` rewrites) |
| `npm run check` | Everything CI runs: build, unit tests, lint, format check |

⚠️ Always use the npm scripts, never bare `vitest`. The bare runner ignores the tag filter and will launch Music.app from the unit suite.

For tool discovery without library writes, run `node scripts/smoke.mjs --check-tools` after building. Positional edits use the explicit `playlist_positions` returned by playlist-order searches, never the search result index.

Run `npm run check` before pushing. GitHub Actions runs the same gates on every pull request and push to `main`; the integration and smoke suites need a real Music.app and stay local.

The one-time formatting pass is listed in `.git-blame-ignore-revs`; run `git config blame.ignoreRevsFile .git-blame-ignore-revs` once so local blame skips it (GitHub's blame view does so on its own).

Architecture and working conventions are in [`CLAUDE.md`](CLAUDE.md); Music.app quirks in [`docs/music-app.md`](docs/music-app.md).

## Troubleshooting

- Start with `node dist/index.js status`; use `doctor` when the report points toward the Music.app boundary.
- `automation_permission_denied`: System Settings → Privacy & Security → Automation → enable Music for the terminal or MCP client app that launches Selecta.
- `music_app_not_running`: open Music.app and retry.
- Tools return `cache_age_hours: null`: the cache was never populated. Run `refresh`.
- `track_not_found` on writes: the cache is stale. Refresh and re-resolve track IDs.
- A created playlist appears twice in Music.app: run `refresh` to inspect recent rekeys and ambiguous copies. Identical tracks and names cannot distinguish an iCloud echo from an intentional copy, so refresh never deletes playlists. Choose which copy to keep before deleting the other.
