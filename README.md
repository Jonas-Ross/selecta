# Selecta

> A *selecta* is the soundsystem term for the one who picks the records. Claude is the selector; your library is the crate.

A local MCP server that gives Claude access to your Apple Music library, so it can build playlists from music you actually own and write them back to Music.app.

There's no recommendation engine in here, no similarity scoring, no ML. Claude does the picking. Selecta tells it what you own and how you listen (plays, favorites, ratings, skips, your own playlists), and turns the tracklist Claude comes up with into a real playlist.

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

| Tool | What it does |
|---|---|
| `search` | Faceted search over the cache: free text, artist, genre, year, rating, play counts, date ranges, playlist membership, local/cloud. Results include play and rating stats. |
| `library_overview` | The shape of the library (or a filtered slice of it): genres, decades, top artists, ratings, runtime. |
| `get_track_context` | Everything around one track: other tracks by the same artist, the playlists it's in, and the tracks that sit next to it in your own playlists. |
| `list_playlists` | Your playlists, with kind (`user`/`smart`/`subscription`/`folder`) and track counts. |
| `preview_playlist` | Overwrites the single "Selecta Preview" playlist so you can audition a draft. |
| `create_playlist` | Creates the real playlist: name, ordered tracks, optional description. |
| `add_tracks` / `remove_tracks` | Edit an existing user playlist. Smart and subscription playlists are read-only. |
| `reorder_tracks` | Rearrange a user playlist's entries to a new order (a full permutation of its current positions). |
| `refresh_library` | Full reread of the library into the cache. Manual by design. |

Selecta only writes where you point it: it creates playlists, overwrites its own preview slot, and edits the user playlists you ask it to.

## Development

| Command | Use |
|---|---|
| `npm test` | Unit suite (fast, no Music.app) |
| `npm run test:integration` | Bridge tests against your real Music.app. Needs a user playlist named `Selecta Test` with at least one track. |
| `npm run smoke` | End-to-end scenario over real MCP stdio: refresh → search → context → preview → create, then cleans up after itself. |
| `npm run build` | TypeScript → `dist/` |

⚠️ Always use the npm scripts, never bare `vitest`. The bare runner ignores the tag filter and will launch Music.app from the unit suite.

Architecture and working conventions are in [`CLAUDE.md`](CLAUDE.md); Music.app quirks in [`docs/music-app.md`](docs/music-app.md).

## Troubleshooting

- `automation_permission_denied`: System Settings → Privacy & Security → Automation → enable Music for your terminal (CLI use) and for Claude Desktop.
- `music_app_not_running`: open Music.app and retry.
- Tools return `cache_age_hours: null`: the cache was never populated. Run `refresh`.
- `track_not_found` on writes: the cache is stale. Refresh and re-resolve track IDs.
- A created playlist appears twice in Music.app: iCloud Sync Library sometimes duplicates a fresh playlist as sync settles (it does this to Apple's own playlists too — not a Selecta bug, and the create only ran once). Run `refresh` within an hour of creating it and Selecta removes the echo copy automatically. It only touches exact twins of playlists it just created, so same-name playlists you made on purpose are safe. For older duplicates, delete either copy in Music.app and refresh.
