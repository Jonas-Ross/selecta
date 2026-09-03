# Selecta

> A *selecta* is the soundsystem term for the one who picks the records. Claude is the selector; your library is the crate.

A local MCP server that gives Claude access to your Apple Music library, so it can build playlists from music you actually own and write them back to Music.app.

There's no recommendation engine in here, no similarity scoring, no ML. Claude does the picking. Selecta tells it what you own, how you listen (plays, favorites, ratings, skips, your own playlists) and, where known, how the music moves (BPM, key, danceability), and turns the tracklist Claude comes up with into a real playlist.

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

This reads your whole library into a SQLite cache at `~/Library/Application Support/Selecta/library.db`. A few thousand tracks take 10–15 seconds. The cache never refreshes itself, so rerun `refresh` (or ask Claude to call `refresh_library`) after your library changes.

Optionally, backfill tempo and key data so Claude can sequence by BPM:

```bash
node dist/index.js enrich        # all not-yet-attempted tracks
node dist/index.js enrich -n 200 # or a batch at a time
```

This looks tracks up on MusicBrainz/AcousticBrainz and Deezer (free, no API keys) at roughly 1–3 seconds per track, so a large library takes a while — it's safe to interrupt and resume. Coverage is partial by nature: many tracks, especially recent releases, simply have no data anywhere, and those are remembered so they aren't looked up twice. Refreshing the library never discards features already fetched.

## Register with Claude

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

Sixteen tools, in three groups. The first group answers from the local cache and never touches Music.app; the second writes to Music.app; the third keeps the cache current and holds Claude's own notes.

### Reading

| Tool | What it does |
|---|---|
| `search` | Faceted search over the cache: free text, artist, genre, year, BPM range, rating, favorites, play counts, last-played and date-added windows, playlist membership, local/cloud, plus artist and track exclusions. Sort lenses for most/least played, recently added, recent plays, random, or a playlist's own order. `dedupe` collapses copies of the same song across albums; `compact` shrinks the payload for wide sweeps. Every result carries play, skip and rating stats, and BPM, key and danceability where known. |
| `library_overview` | The shape of the library, or a filtered slice of it: genres, decades, top artists by track count, favorites and ratings coverage, runtime, how much of it has a known BPM, and plays and skips captured over the last 30 days. Same filters as `search`. |
| `get_track_context` | What sits around a track in your own playlists: same-artist tracks, the playlists it's in, and the tracks that co-occur with it. Accepts up to 20 seeds at once for a combined co-occurrence view. Single-seed calls include the track's play history across refreshes. You can leave specific playlists out, or skip any above a given size, before it counts; the response says which playlists were considered and which were dropped. |
| `inspect_tracklist` | Sanity-check an ordered draft before previewing or creating it: runtime, repeated IDs, duplicate copies of the same song, artist counts, per-track signal, and where BPM and key data is missing. Facts only, no judgement. |
| `list_playlists` | Your playlists, with kind (`user`/`smart`/`subscription`/`folder`) and track counts. Filter by kind or name. |

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
| `refresh_library` | Full reread of Music.app into the cache. Manual by design. Also records play and skip deltas since the previous refresh, and cleans up iCloud echo copies of playlists created in the last hour. |
| `set_note` | Save Claude's own note on a track or playlist ("great opener", "user preferred the plain name") so it's there next session. Cache-only, never written to Music.app. Notes come back verbatim on reads; Selecta never filters or ranks on them. |
| `enrich_features` | Fetch BPM, key and danceability for tracks not yet attempted, from MusicBrainz/AcousticBrainz and Deezer. Works through the most-played backlog, or targets specific track IDs (up to 50). The only tool that uses the network. For a whole-library backfill, prefer the `enrich` CLI command above. |

Selecta only writes where you point it: it creates playlists, overwrites its own preview slot, edits or deletes the user playlists you ask it to, and sets favorites and ratings on the tracks you name. Smart, subscription and folder playlists are never modified.

## Development

| Command | Use |
|---|---|
| `npm test` | Unit suite (fast, no Music.app) |
| `npm run test:integration` | Bridge tests against your real Music.app. Needs a user playlist named `Selecta Test` with at least two tracks. |
| `npm run smoke` | End-to-end scenario over real MCP stdio: refresh → search → context → preview → create, then cleans up after itself. |
| `npm run build` | TypeScript → `dist/` |
| `npm run lint` | ESLint over `src/`, `test/`, `scripts/` |
| `npm run format:check` | Prettier check (`npm run format` rewrites) |

⚠️ Always use the npm scripts, never bare `vitest`. The bare runner ignores the tag filter and will launch Music.app from the unit suite.

CI runs the same four gates on every pull request and push to `main` (GitHub Actions, macOS, Node 22): build, `npm test`, lint, format check. The integration and smoke suites need a real Music.app and stay local. Before pushing:

```bash
npm run build && npm test && npm run lint && npm run format:check
```

The one-time Prettier pass is listed in `.git-blame-ignore-revs`; run `git config blame.ignoreRevsFile .git-blame-ignore-revs` once so local blame skips it (GitHub's blame view does so on its own).

Architecture and working conventions are in [`CLAUDE.md`](CLAUDE.md); Music.app quirks in [`docs/music-app.md`](docs/music-app.md).

## Troubleshooting

- `automation_permission_denied`: System Settings → Privacy & Security → Automation → enable Music for your terminal (CLI use) and for Claude Desktop.
- `music_app_not_running`: open Music.app and retry.
- Tools return `cache_age_hours: null`: the cache was never populated. Run `refresh`.
- `track_not_found` on writes: the cache is stale. Refresh and re-resolve track IDs.
- A created playlist appears twice in Music.app: iCloud Sync Library sometimes duplicates a fresh playlist as sync settles (it does this to Apple's own playlists too — not a Selecta bug, and the create only ran once). Run `refresh` within an hour of creating it and Selecta removes the echo copy automatically. It only touches exact twins of playlists it just created, so same-name playlists you made on purpose are safe. For older duplicates, delete either copy in Music.app and refresh.
