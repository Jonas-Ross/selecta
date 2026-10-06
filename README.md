# Selecta

> A *selecta* is the soundsystem term for the one who picks the records. Your AI agent is the selector; your library is the crate.

A local engine over your Apple Music library, so an AI agent can build playlists from music you actually own and write them back to Music.app. It runs as an MCP server for any agent that speaks MCP, and as an early [desktop app](#desktop-app-early) on the same core. The website is at [jonas-ross.github.io/selecta](https://jonas-ross.github.io/selecta/), where you can try the tempo and key analyzer on a file of your own in the browser.

There's no recommendation engine in here, no similarity scoring, no ML. Your agent does the picking. Selecta tells it what you own, how you listen (plays, favorites, ratings, skips, your own playlists) and, where known, how the music moves (BPM, key, danceability), and turns the tracklist your agent comes up with into a real playlist.

## Requirements

- macOS with Music.app
- Node.js 22+
- Optional: [metrognome](https://github.com/Jonas-Ross/metrognome) (`brew install jonas-ross/tap/metrognome`), to measure tempo and key for tracks the free catalogs don't know
- Optional: a signed-in [Claude Code](https://docs.claude.com/en/docs/claude-code) or [Codex](https://developers.openai.com/codex/cli) CLI, for the desktop app

## Setup

```bash
brew install jonas-ross/tap/metrognome   # optional, see Requirements
git clone https://github.com/Jonas-Ross/selecta.git
cd selecta
npm install
npm run build
node dist/index.js setup           # reports what is missing; changes nothing
node dist/index.js setup --apply   # registers Selecta with Claude Desktop and Claude Code
node dist/index.js refresh         # reads your library into the cache
```

`setup` adds Selecta to whichever of Claude Desktop and Claude Code is installed, using absolute paths so the apps can launch it without your shell's `PATH`. It backs up the Desktop config before writing it, keeps every other server and any `env` you set on Selecta's entry, and does nothing on a rerun once everything is registered. It then checks for metrognome, Music.app automation access and the library cache, and prints the command that fixes each one that is missing. Claude Desktop doesn't see your shell's `PATH`, so setup pins the metrognome it checked into the entry unless it is in Homebrew's bin; point it at another one with `--metrognome-path`. Restart Claude Desktop afterwards. Limit it to one client with `--client desktop` or `--client code`.

`refresh` populates the cache. macOS will ask for Music.app automation permission the first time; allow it. It reads your whole library into a SQLite cache at `~/Library/Application Support/Selecta/library.db`. A few thousand tracks take 10–15 seconds. The cache never refreshes itself, so rerun `refresh` (or ask your agent to call `refresh_library`) after your library changes.

Optionally, backfill tempo and key data so your agent can sequence by BPM:

```bash
node dist/index.js enrich                    # all not-yet-attempted tracks
node dist/index.js enrich -n 200             # or a batch at a time
node dist/index.js enrich --source analysis  # then analyze the previews of what's left
```

The default pass looks tracks up on MusicBrainz/AcousticBrainz and Deezer (free, no API keys) at roughly 1–3 seconds per track, so a large library takes a while — it's safe to interrupt and resume. AcousticBrainz has had no new data since early 2022, so recent releases mostly come back empty.

`--source analysis` fills that gap by measuring the music itself: it runs [metrognome](https://github.com/Jonas-Ross/metrognome) over each track's 30-second store preview for tempo and key. The audio is analyzed in memory and discarded. Selecta finds the binary on `PATH` or in Homebrew's bin, or wherever `SELECTA_METROGNOME_PATH` points, and refuses one older than it can read (`brew upgrade metrognome` fixes that); `node dist/index.js doctor` shows which one it found. Without it the command reports every track skipped and changes nothing. The two passes keep separate records, so a track the lookup found nothing for is still worth analyzing, and neither overwrites what the other already found. An estimate the analyzer isn't sure about is discarded rather than stored — a missing BPM is better than a wrong one. A fast tempo the analyzer folded from a half-time reading says so, and carries the half-time figure alongside. If your library wasn't bought in the US store, set `SELECTA_STORE_COUNTRY` to your two-letter country code (`gb`, `de`, `jp`) so previews are looked up where your music is sold; `docs/audio-features.md` lists this and the key-profile option.

Whichever pass runs, dead ends are remembered so they aren't attempted twice, and refreshing the library never discards features already fetched.

For a read-only health report, use `status`. It checks the database without creating, migrating, refreshing, enriching, or contacting Music.app. `doctor` adds one read-only Music.app availability and Automation probe. Both write one JSON result to stdout.

```bash
node dist/index.js status
node dist/index.js doctor
```

Three maintenance commands rewrite stored features. Each is a dry run that reports what it would change, per source, until you add `--apply`, and journals every row it overwrites or removes first so `restore` can put it back. Undoing a `restore` itself can't remove a row it re-added; [`docs/destructive-commands.md`](docs/destructive-commands.md) has that gap and the rest of the details.

| Command | Use |
|---|---|
| `supersede [--source S] [-p <algo>...] [--apply]` | List what produced each stored feature; with `-p`, clear what those algorithms measured so the next `enrich` measures it again |
| `reopen -s S -m <field> [--apply]` | Give tracks with no value in a field another try from that source, for example after setting `SELECTA_STORE_COUNTRY` |
| `restore <journal> [--apply]` | Put back the rows an applied command journalled |

Set `SELECTA_DEBUG=1` to mirror stderr logging to `~/Library/Logs/Selecta/selecta.log`. Failure to create or append that file is reported on stderr and never stops the MCP server.

## Register with an MCP client

`node dist/index.js setup --apply` does this for Claude Desktop and Claude Code. To do it by hand, or for another client: Selecta is agent-independent: use an MCP client that can launch a local server over stdio. Configure it to run `node` with `/ABSOLUTE/PATH/TO/selecta/dist/index.js` as its argument, with no subcommand. The server exposes the same tools regardless of which agent uses them. The Claude configurations below are examples.

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

## Tools

Tools are grouped by workflow. The first group answers from the local cache and never touches Music.app; the second writes to Music.app; the third keeps the cache current and holds the agent's own notes.

### Reading

| Tool | What it does |
|---|---|
| `search` | Faceted search over the cache: free text, artist, genre, year, BPM range, rating, favorites, play counts, last-played and date-added windows, playlist membership, local/cloud, plus artist and track exclusions. Sort lenses for most/least played, recently added, recent plays, random, or a playlist's own order. `dedupe` collapses copies of the same song across albums; `compact` shrinks the payload for wide sweeps. Every result carries play, skip and rating stats, and BPM, key and danceability where known. |
| `library_overview` | The shape of the library, or a filtered slice of it: genres, decades, top artists by track count, favorites and ratings coverage, runtime, how much of it has a known BPM, and plays and skips captured over the last 30 days. Same filters as `search`. |
| `get_track_context` | What sits around a track in your own playlists: same-artist tracks, the playlists it's in, and the tracks that co-occur with it. Accepts up to 20 seeds at once for a combined co-occurrence view. Single-seed calls include the track's play history across refreshes. You can leave specific playlists out, or skip any above a given size, before it counts; the response says which playlists were considered and which were dropped. |
| `inspect_tracklist` | Sanity-check an ordered draft before previewing or creating it: runtime, repeated IDs, duplicate copies of the same song, artist counts, per-track signal, and where BPM and key data is missing. Facts only, no judgement. |
| `list_playlists` | Your playlists, with kind (`user`/`smart`/`subscription`/`folder`) and track counts. Filter by kind or name. |

### Interactive library explorer

| Tool | What it does |
|---|---|
| `show_library_explorer` | Opens clickable decade and raw-genre charts over the owned library, with the same filters as `search` and `library_overview`, stable paginated results, and seed selection for an explicit curation request. Cache-only. |

Ask your agent to **open the library explorer**. Click a decade or genre, toggle **Never played**, **Loved**, or **Added in 30 days**, and optionally select seed tracks. Describe the playlist you want, then **Ask agent**. The request includes exact selected IDs and active filters. With no selection, it refers to the full filtered slice, including tracks beyond the visible page. It requests a proposal; it does not create or play a playlist. Claude Desktop Code may place the request in its composer for you to send.

**Reload view** rereads the existing cache. **Refresh library** explicitly rereads Music.app through the existing refresh tool. Both clear temporary selection; paging and sorting preserve it. Counts, cache age, unknown metadata and chart overflow remain visible. For a fixture preview, run `npm run preview` and open [the consolidated design gallery](http://127.0.0.1:8767). See [the explorer contract and host checks](docs/library-explorer.md).

### Interactive drafts

| Tool | What it does |
|---|---|
| `show_playlist_draft` | Opens an ordered interactive draft with existing inspection facts. Supply a fresh UUID as `draft_id`, a name, and ordered track IDs. Each occurrence gets its own entry ID. |
| `get_playlist_draft` | Read-only recovery of the latest local draft, including selection, feedback, preview status and save outcome. |
| `preview_playlist_draft` | Explicitly starts a linked audition. Requested ordered-track edits then update the preview without separate confirmation. |
| `edit_playlist_draft` | Changes the draft at an explicit revision. Preserve occurrence IDs when reordering or revising. Stale edits fail instead of overwriting newer work. |
| `open_preview` | Reveals the existing Selecta Preview in Music.app after checking its complete live order against the supplied draft IDs. Does not replace tracks or start playback. |
| `save_playlist_draft` | Saves an explicitly approved revision using the existing `create_playlist` contract. Selection and feedback never call it. |

Ask your agent to **open an interactive playlist draft**. Select entries to identify the subject of your feedback, then open **Feedback on N tracks** and explain what you want. With no selection, **Feedback on the playlist** applies to the whole draft. Selection alone never means replace, remove or keep. Arrow buttons change order. **Keep feedback in draft** persists text; **Send feedback** requests a revision. Codex receives context/messages directly; Claude Desktop Code exposes context through **Read widget context** and may stage feedback in the composer for you to send. The compact Setlist card lists track, artist, duration and BPM, with a collapsible timeline of the set whose optional tempo and key lanes show each track's cached tempo and its key as a position on the Camelot wheel (the map DJs use to see which keys sit next to each other), and a feedback drawer. Its Appearance menu defaults to Follow host and offers Copper, Cobalt, Ember, Moss, Oxblood and OLED; the choice persists across cards.

Drafts live in `~/Library/Application Support/Selecta/drafts.db`, separate from library refreshes. **Load into Selecta Preview** fills the shared `Selecta Preview` playlist in Music.app with this draft and links the two; it does not start playback. Once linked, subsequent requested track edits synchronize Music.app without another confirmation. Name, selection and feedback stay local. Preview status distinguishes current, out of date, pending, conflict and error. Manual Music.app changes stop replacement and preserve the local draft; ask the agent to reconcile before explicit recovery. A different draft or raw preview takes ownership. Visible cards read local draft state every three seconds, one request at a time; hidden cards resume on focus/visibility. Errors pause reads until **Reload latest**. Reads stop on errors or disposal; no Music.app polling or library refresh is involved. **Reload latest** restores persisted edits. If a host omits the original result after reload, the card recovers from the original tool input's draft ID; you can also paste that ID into **Recover draft**. A missing draft is reported explicitly. Uncommitted feedback text must be kept or sent before closing the card. Missing library tracks remain visible by ID in recovered drafts, with an inspection error; ask the agent to replace them before saving.

**Open preview in Music.app** reveals the existing audition slot after checking that its live order matches this draft, including repeats. Load the draft into Selecta Preview first. Missing, ambiguous or stale previews report an error; Open never overwrites them or starts playback.

**Save to Music.app** explicitly creates a real playlist. A save attempt is recorded before the Music.app call and its result is retained, including partial-write errors. Pending outcomes after interruption are uncertain and cannot be retried automatically; inspect Music.app before choosing further action. A changed name or track order/list can be saved as a new revision after a completed attempt. Selection and feedback changes alone do not re-enable save. An unresolved linked preview blocks permanent Save until the audition is reconciled. Playback controls remain in Music.app.

After updating Selecta, run `npm ci && npm run build` in the checkout your connector runs. The build bundles the widgets and SDK into `dist/ui/playlist-draft.html` and `dist/ui/library-explorer.html`; no CDN or separate service is needed. Restart/reconnect Selecta in your MCP client so it discovers the interactive tools, and reopen the card (Claude may need a full app restart to clear cached resources). Existing core tools still work in hosts without MCP Apps. See [draft smoke checks](docs/playlist-drafts.md) for verification and current desktop-test status.

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
| `enrich_features` | Fetch BPM, key and danceability for tracks not yet attempted, from MusicBrainz/AcousticBrainz and Deezer (`source: catalog`) or by analyzing store previews with metrognome (`source: analysis`). Works through the most-played backlog, or targets specific track IDs (up to 50). The only tool that uses the network. For a whole-library backfill, prefer the `enrich` CLI command above. |

Selecta only writes where you point it: it creates playlists, overwrites its own preview slot, edits or deletes the user playlists you ask it to, and sets favorites and ratings on the tracks you name. Smart, subscription and folder playlists are never modified.

## Desktop app (early)

A desktop app on the same core. Press New playlist, describe what you want, and Claude or Codex builds a draft from your library while you watch. The draft is a row of records on a rail, with tempo and key lanes underneath that show how the set moves from track to track. Above it is a crate of your library to flip through and drag records from. Drag to reorder, select records to point your feedback at them, and save to Music.app when you're happy.

Listen plays the draft through Music.app from the Selecta Preview playlist: the record playing, the join into the next one, and a Camelot wheel tracing the set's route. Selecta never touches audio or Music's volume itself, and the agent waits until you stop listening before it edits again.

It uses your own `claude` or `codex` CLI login, so there's no API key. The agent can read your library and edit the draft, but it can't save or touch Music.app; only you can.

```bash
npm run build
npm run desktop
```

It reads the same cache as the MCP server, so run `refresh` first. [`docs/desktop-app.md`](docs/desktop-app.md) has the details.

## Development

The repo is an npm workspace. `packages/core` holds the cache, the Music.app bridge, enrichment and the tool handlers, with no MCP in it. `packages/mcp` is the MCP server, the CLI and the widgets, `apps/desktop` the Electron app, and `site/` the static website, deployed to GitHub Pages from `main`.

The application version is maintained in `packages/core/package.json`; MCP server metadata and the enrichment User-Agent read it through `packages/core/src/version.ts`. Bump `packages/mcp/package.json` and the root `package.json` with it, and keep `package-lock.json` in sync.

| Command | Use |
|---|---|
| `npm test` | Unit suite (fast, no Music.app) |
| `npm run test:integration` | Bridge tests against your real Music.app. Needs a user playlist named `Selecta Test` with at least two tracks. |
| `npm run smoke` | End-to-end scenario over real MCP stdio: refresh → search → context → preview → create, then cleans up after itself. |
| `npm run build` | Core, then the MCP server and widgets, then the root `dist/index.js` entry, then the desktop app bundle |
| `npm run desktop` | Build and launch the desktop app |
| `npm run lint` | oxlint |
| `npm run format:check` | oxfmt check (`npm run format` rewrites) |
| `npm run check` | Everything CI runs: build, unit tests, lint, format check |
| `npm run preview` | Draft and explorer widget gallery at [127.0.0.1:8767](http://127.0.0.1:8767), with fixtures, simulated writes and live reload |
| `scripts/build-site.sh [metrognome checkout]` | Build the website's demo engine from a metrognome checkout (default `../metrognome`); then serve `site/` with any static server |

⚠️ Always use the npm scripts, never bare `vitest`. The bare runner ignores the tag filter and will launch Music.app from the unit suite.

For tool discovery without library writes, run `node packages/mcp/scripts/smoke.mjs --check-tools` after building. Positional edits use the explicit `playlist_positions` returned by playlist-order searches, never the search result index.

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
