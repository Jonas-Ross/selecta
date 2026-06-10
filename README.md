# Selecta

> A *selecta* is the soundsystem term for the one who picks the records. Claude is the selector; your library is the crate.

A local MCP server that exposes your Apple Music library to Claude so it can build playlists **from music you actually own** and write them back to Music.app as real playlists.

The model is the brain; Selecta is the eyes and hands. There is no recommendation engine, no similarity scoring, no ML in here — Selecta tells Claude what you own and how you engage with it (plays, favorites, ratings, skips, your own playlists), and turns Claude's tracklist into a playlist in Music.app.

## Requirements

- macOS with **Music.app** (this is a Music.app automation tool — no cross-platform pretense)
- **Node.js 22+**

## Setup

```bash
git clone https://github.com/Jonas-Ross/selecta.git
cd selecta
npm install
npm run build
```

Populate the cache once (macOS will prompt for Music.app automation permission on first run — allow it):

```bash
node dist/index.js refresh
```

This rereads your whole library into a local SQLite cache at `~/Library/Application Support/Selecta/library.db` (a few thousand tracks take ~10–15s). The cache **never refreshes itself** — rerun `refresh`, or ask Claude to call the `refresh_library` tool, when your library has changed.

## Register with Claude

**Claude Desktop** — add to `~/Library/Application Support/Claude/claude_desktop_config.json` (create the `mcpServers` key if absent), then restart Desktop:

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

**Claude Code** — from any directory:

```bash
claude mcp add --scope user selecta -- node /ABSOLUTE/PATH/TO/selecta/dist/index.js
```

Then try: *"Make a playlist around Teardrop by Massive Attack — late-night vibe. Preview it first."*

## Tool surface

| Tool | What it does |
|---|---|
| `search` | Faceted search over the cache: free text (FTS), artist, genre, year range, favorited, rating, play counts, played/added date ranges, playlist membership, local/cloud. Returns tracks with behavioral signal. |
| `get_track_context` | The curatorial graph walk around one track: same-artist tracks, playlists containing it, and tracks co-occurring with it in your own playlists. |
| `list_playlists` | Playlists with kind (`user`/`smart`/`subscription`/`folder`) and track counts. |
| `preview_playlist` | Overwrites the single **"Selecta Preview"** playlist for auditioning a draft. |
| `create_playlist` | Materializes the final playlist (name, ordered tracks, optional description). |
| `refresh_library` | Full library reread into the cache. Manual by design. |

Writes never edit your existing playlists — Selecta only creates new playlists and overwrites its own preview slot.

## Development

| Command | Use |
|---|---|
| `npm test` | Unit suite (fast, no Music.app) |
| `npm run test:integration` | Bridge tests against your real Music.app — needs a user playlist named `Selecta Test` with at least one track |
| `npm run smoke` | Scripted end-to-end scenario over real MCP stdio: refresh → search → context → preview → create (then cleans up the created playlist) |
| `npm run build` | TypeScript → `dist/` |

⚠️ Always use the npm scripts, never bare `vitest` — the bare runner ignores the tag filter and will launch Music.app from the unit suite.

Architecture, contracts, and design rationale live in [`docs/design.md`](docs/design.md) and [`docs/contracts.md`](docs/contracts.md).

## Troubleshooting

- **`automation_permission_denied`** — System Settings → Privacy & Security → Automation → enable Music for your terminal (CLI use) and for Claude Desktop.
- **`music_app_not_running`** — open Music.app and retry.
- **Tools return `cache_age_hours: null`** — the cache was never populated; run `refresh` (or let Claude call `refresh_library`).
- **`track_not_found` on writes** — the cache is stale relative to Music.app; refresh and re-resolve track IDs.
