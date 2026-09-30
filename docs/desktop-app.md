# Desktop app

`apps/desktop` is the second front end on `@selecta/core`. Phase 3 of the plan is deliberately plain: brief, Claude builds a draft, you reorder and give feedback, you save. A design pass replaces the UI wholesale later, so the styling is throwaway and the logic lives in testable modules.

## Processes

| Process | Runs under | Owns |
|---|---|---|
| Renderer | Electron, sandboxed, no Node | Screens. Talks only through `window.selecta` (`src/main/preload.ts`). |
| Main | Electron | The window, and a pipe to the host. No logic. |
| Host | System `node` | Every call into core (`src/host/api.ts`), `claude -p` runs, and the draft watcher. |

The host runs outside Electron so `better-sqlite3` keeps the one native build that the MCP server, the CLI and the tests use. Rebuilding it for Electron's ABI would rewrite the shared `node_modules` copy and break the others. It talks to main over JSON lines on stdio, one request `{id, method, args}` per line, answered with `{id, result}` or `{id, error}`; events are `{event, ...}` lines. `SELECTA_NODE` picks the Node binary (default `node` on `PATH`).

The method table in `src/host/api.ts` is the whole surface, typed in `src/shared/protocol.ts`. Add a method when a screen needs one, never speculatively.

## The agent

Each turn is one `claude -p --output-format stream-json` run on the user's own Claude login (`src/host/agent.ts`). It gets:

- no built-in tools (`--tools ""`), so no shell or file access;
- only the selecta MCP server, launched from `<repo>/dist/index.js` (`--strict-mcp-config`);
- read tools plus `show_playlist_draft`, `get_playlist_draft` and `edit_playlist_draft` as the allowlist, under `--permission-mode dontAsk`;
- every other selecta tool in `--disallowedTools`, because a deny rule beats an allow rule in the user's own Claude settings. `test/agent_tools.test.ts` fails when a new MCP tool is in neither list.

Claude never saves. Save is the app's button, calling the same revision-checked operation as `save_playlist_draft`. A recorded save attempt, good or uncertain, blocks another from the app, as it does over MCP.

The app mints the draft ID and passes it in the brief, so the screen can open before the draft exists. Later turns `--resume` the session the first turn reported, and always tell Claude to re-read the draft, since the user may have reordered it. Sessions are held in memory: after a restart, feedback starts a fresh session on the same draft. `SELECTA_CLAUDE_PATH` overrides the `claude` binary.

## Live updates

Claude's edits land in `drafts.db` through the MCP server process, not the host. The host holds one read-only connection and polls `PRAGMA data_version`, which moves when any other connection commits, then emits `drafts.changed`. The renderer re-reads the draft on that event. Concurrent edits from the user and Claude both go through revision checks: the loser gets `draft_revision_conflict` and re-reads; nothing retries automatically.

## Running it

```bash
npm install
npm run build
npm run desktop
```

It uses the same `~/Library/Application Support/Selecta/library.db` as the MCP server, so refresh the library first. CI typechecks and bundles the app (`ELECTRON_SKIP_BINARY_DOWNLOAD=1`) but never launches it; the tests cover the host, the stream parser and the view logic without Electron or Claude.
