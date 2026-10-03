# Selecta

A local engine over an Apple Music library that anyone on a Mac can install: it caches the library, enriches it with audio features, and reads and writes Music.app so playlists can be built from owned tracks. Front ends share that core: the MCP server that exposes it to AI agents, and a planned desktop app. The model is the brain — it does all sequencing, ranking, and taste; Selecta surfaces facts (inventory, behavioral signal, audio features) and executes reads and writes.

`AGENTS.md` is a symlink to this file. `docs/music-app.md` records what Music.app actually does when scripted.
`docs/cache-migrations.md` covers schema upgrades and the backup policy for future destructive migrations.
`docs/cache-architecture.md` records transaction boundaries and refresh-pruning ownership.
`docs/audio-features.md` covers the two enrichment sources, per-source terminal status, the merge rule and which of it reaches the model.
`docs/destructive-commands.md` covers the dry-run/`--apply` convention, the undo journal and the test pattern every destructive command owes.
`docs/merge-gate.md` covers which PRs merge without the user and why.
`docs/desktop-app.md` covers the desktop app's processes, the in-app agent's tool allowlist and how drafts update live.

## Architecture

An npm workspace. `packages/core` (`@selecta/core`) holds everything transport-neutral: cache, bridge, enrich, drafts, domain, operations and the tool handlers. `packages/mcp` (`selecta`) holds MCP registration, the CLI and the widgets in `ui/`, and imports core only as `@selecta/core/<path>.js`. Nothing in core imports from `packages/mcp`, and future front ends go in `apps/` on the same core. The root build writes `dist/index.js` as a shim to `packages/mcp/dist/index.js`, so client configs pointing at `<repo>/dist/index.js` keep working. Tests run core from source through the Vitest alias.

Tools on top, three external/storage peers below — cache, bridge, and enrich are all usable as a plain Node library without MCP, which keeps tests fast and boundaries crisp.

- **`packages/core/src/tools/`** — one MCP handler per file. Thin orchestrators: validate input, query cache and/or bridge, shape response. Handlers remain transport-neutral; MCP registration lives in `packages/mcp/src/`: `server.ts`, `draft_app.ts`, and `explorer_app.ts`. `search` and `library_overview` share `library_filters.libraryFilterShape`; `inspect_tracklist` resolves and summarizes an ordered draft entirely from cached track rows, including how each adjacent pair's Camelot positions relate (`packages/core/src/domain/harmonic.ts`) — geometry and its caveats, never a score; `docs/audio-features.md` records why. `show_library_explorer` shares those filters and reads charts, a stable page, and freshness in one cache read transaction; its bundled widget keeps temporary seed selection, publishes IDs/filters as context, and sends curation requests only on explicit action. `docs/library-explorer.md` records its limits and host checks.
- **`packages/core/src/drafts/`** — minimal revision-checked local draft storage in `drafts.db`, separate from library refreshes. Per-occurrence entry IDs preserve intentional repeated tracks. Selection identifies the subject of explicit feedback; it never implies an action. Draft cards use Setlist without pins, with a collapsible duration timeline, artist strip and optional tempo/key lanes. `packages/mcp/src/draft_app.ts` registers the additive MCP Apps surface; `packages/mcp/ui/` is bundled by the normal build, which runs `npm run typecheck:ui`. `packages/core/src/drafts/contracts.ts` shares browser-safe schemas with storage. The card renders from pure state, reconciled in place by entry ID and unit-tested against the controlled DOM in `packages/mcp/test/dom.ts`. Explicit `preview_playlist_draft` links the shared audition slot; subsequent requested ordered-track edits synchronize it without redundant confirmation, guarded by ownership and live expected order. Metadata-only edits remain local. Visible cards use bounded cache-only draft reads. Only explicit draft save reaches the shared creation operation; direct creation and draft saving retain observed outcomes across local persistence failures.
- **`packages/core/src/cache/`** — `SelectaCache` is the public facade and owns transactions; `queries.ts` composes connection-owned discovery, library persistence, playlist/receipt, and metadata queries from `queries/`. Shared SQL projections and filters live in `queries/shared.ts`; `reconciliation.ts` is a pure planner over data loaded by the facade. SQLite at `~/Library/Application Support/Selecta/library.db`. Tracks, playlists, playlist_tracks, play_history, audio_features, notes, refresh_log + FTS5. All model-triggered reads hit this layer. play_history holds sparse per-refresh play/skip deltas captured inside the refresh transaction, so its grain is the refresh cadence: deltas exist only where refreshes bracketed the listening. A dropped counter resets silently and is noted in refresh_log. audio_features (bpm/musical_key/camelot/danceability + per-field provenance, confidence and maturity, keyed by persistent ID) sits outside the refresh cycle: a reread never wipes enrichment; rows are pruned only when their track leaves the library. notes (the model's own free text, one per track or playlist) follows the same lifecycle, and a playlist note moves with its playlist when sync reconciliation rekeys the ID — unless the destination already has one, which wins, since a rekey can land on the user's own older copy (refresh flags it with `note_conflict`). The same collision marks the creation receipt itself (`edit_conflict`), and edit tools (add/remove/reorder/delete_playlist, set_note) refuse a conflicted ID instead of risking a write to the wrong playlist.
- **`packages/core/src/bridge/`** — wraps Music.app. Builds JXA snippets, shells out via `osascript -l JavaScript`, parses JSON. Read `docs/music-app.md` before touching the playlist edit scripts: scripted entry edits race iCloud sync (entry doubles, wiped edits, oscillating reads during churn).
- **`packages/core/src/enrich/`** — two independent passes onto one `audio_features` row, selected by `source`; `docs/audio-features.md` is the reference. `source: 'catalog'` wraps the external metadata services (MusicBrainz→AcousticBrainz, Deezer; free, no API keys), which self-throttle to each host's documented limit (MusicBrainz 1 req/s, AcousticBrainz 10 req/10s; throttles start "as if a call just happened" so run boundaries can't burst); a source failure (AcousticBrainz throws intermittent 5xx) skips that 25-track chunk — nothing saved for it, tracks stay pending for a later run, skip reported in the summary — and the run continues. `source: 'analysis'` drives the metrognome binary (`metrognome.ts`) in `batch` mode over one long-lived pipe, feeding artist/title plus the persistent ID as metrognome's opaque `client_ref` and saving results in chunks as they stream; a missing binary fails soft (everything skipped, reason in `source_errors`). Attempts are terminal **per source** (`catalog_status`/`analysis_status`), so analysis still reaches tracks the catalogs had nothing for, and neither pass overwrites a feature the other supplied. An estimate metrognome flags `uncertain` is discarded, never stored as fact. `camelot` is derived from whichever `musical_key` a row ends up with (`packages/core/src/domain/camelot.ts`), not carried by one source, so a catalog key gets a wheel position too. No request is ever reissued within a run. Runs only when explicitly invoked (`enrich_features` tool, `enrich` CLI) — never as a side effect of refresh. Coverage is partial by nature: a live probe of this library measured roughly 57% of tracks with bpm and 37% with key from the catalogs, weakest on 2022+ releases.

- **`apps/desktop/`** — the Electron front end. The renderer is sandboxed and reaches core only through the host's method table (`src/host/api.ts`). The host runs under system Node rather than Electron, so `better-sqlite3` keeps one native build. The in-app agent is `claude -p` over the real MCP server, and its tool allowlist excludes save and every Music.app write; `docs/desktop-app.md` has the details. The UI follows the approved Dig design: tokens in `src/renderer/tokens.css`, the draft drawn as records on a rail with tempo and key lanes under a crate of the library to drag from, album art read from Music.app, springs by hand. Listen plays the draft through Music.app from the Selecta Preview playlist, so Claude waits until you stop listening.

`site/` is the website: plain static files outside the workspace, deployed to GitHub Pages from `main` by `.github/workflows/pages.yml`. Its try-it demo is metrognome compiled to WebAssembly, built from the metrognome commit pinned in that workflow; bump the pin to put a newer engine on the page. Its scripts are native ES modules in `site/js/`, one concern each with `main.js` as the entry and no bundler; a new module gets a `modulepreload` line in `index.html`, except `crate.js`, which `story.js` imports only as the crate section nears. Styles are one sheet per page section in `site/css/`, linked in page order after `base.css`. GSAP is vendored in `site/vendor/` and left out of lint and format. The photos and the hero film in `site/media/` are generated: AVIF stills under the 64 KB binary limit, and an MP4 film that `scripts/check-no-binaries.sh` lets through by path, header and size. The drum machine is two registered photos of the same device, pads off and pads lit; `site/js/machine.js` holds where each pad sits in them, so a new photo needs new numbers. Step one's crate is a three.js scene in `site/js/crate.js`, scrubbed by the story's scroll; without WebGL, or with reduced motion, the photographed crate stays. `site/vendor/three.min.js` holds only the classes `crate.js` imports, bundled by esbuild from the three package, so importing another class means rebuilding it.

All MCP widgets share the `npm run preview` design gallery. Add future widget previews there rather than creating separate preview servers or commands.

Shared storage and bridge types live in `packages/core/src/types/`; the cross-cutting error envelope in `packages/core/src/types/errors.ts`. `packages/core/src/domain/` owns explicit track projections, inspection/overview transforms, and the browser-safe recent-activity window. Tool dependencies, validation/errors, freshness, and filters have dedicated modules under `packages/core/src/tools/`; shared cache resource preflights live in `packages/core/src/operations/resources.ts`.

## Commands

| Command | Use |
|---|---|
| `npm install` | Install deps |
| `npm run build` | Compile core, then the MCP server and widgets, then write the root `dist/index.js` entry, then bundle the desktop app |
| `npm run desktop` | Build and launch the desktop app (needs a signed-in `claude` CLI) |
| `npm test` | Unit suite (fast, no Music.app) |
| `npm run test:integration` | Bridge integration suite against real Music.app (slow, opt-in) |
| `npm run lint` | oxlint |
| `npm run format:check` | oxfmt check; `npm run format` applies lint fixes, then formats |
| `npm run check` | Everything CI runs: build, unit tests, lint, format check |
| `scripts/check-no-binaries.sh` | Fail on a tracked SQLite database or large binary (its own CI job) |
| `npm run smoke` | End-to-end smoke against the real library (builds first) |
| `scripts/build-site.sh [metrognome checkout]` | Build the website's demo engine into `site/` (default `../metrognome`); serve `site/` with any static server |
| `npm run preview` | Consolidated draft and explorer fixture gallery at `http://127.0.0.1:8767` |
| `npm run dev` | Run the MCP server over stdio |
| `node dist/index.js setup [--client desktop\|code] [--apply]` | Register Selecta with Claude Desktop and Claude Code (backing up the Desktop config first), then check metrognome, Music.app automation and the cache, naming the fix for each gap |
| `node dist/index.js status` | Read-only cache integrity, schema version and pending migrations, freshness, counts, and enrichment diagnostics |
| `node dist/index.js doctor` | `status` plus a read-only Music.app availability and Automation probe, and which metrognome binary analysis would run |
| `node dist/index.js refresh` | Refresh the library cache from the CLI, no MCP client needed |
| `node dist/index.js enrich [-n N] [--source catalog\|analysis]` | Backfill audio features from the CLI (default all pending on `catalog`, ~1-3s/track; live progress line on a terminal, plain throttled lines when redirected) |
| `node dist/index.js supersede [--source S] [-p <algo>...] [--apply]` | List what produced each stored feature; with `-p`, report what clearing those values would change, and with `--apply` carry it out so a later `enrich` re-measures them |
| `node dist/index.js reopen -s S -m <field> [--apply]` | Clear a source's terminal attempt for tracks holding no value in that field, so a later `enrich` tries them again |
| `node dist/index.js restore <journal> [--apply]` | Put back the cache rows a destructive command journalled before it ran |

## Testing

Two tiers, cheapest first:

1. **Unit (bulk of the suite, sub-second)** — cache layer against in-memory SQLite with fixtures; tool handlers with the bridge *interface* mocked. Don't simulate Music.app's behavior in unit tests — integration owns all "does Music.app actually do that" questions.
2. **Bridge integration (tagged `integration`)** — JXA against a real Music.app, scoped to a test playlist, not the whole library.

**Run suites only via the npm scripts, never bare `vitest`:**

- ⚠️ `npx vitest run` ignores the scripts' `--tags-filter` and runs *everything*, launching Music.app and firing the macOS Automation prompt. Use `npm test` / `npm run test:integration`.
- The `integration` tag is the only gate (no env var).
- CI runs `npm run check` and `scripts/check-no-binaries.sh` on every PR and push to `main`. On a PR, the `gate` job then decides by the files it touches whether it needs the user, and turns auto-merge on or off to match (`scripts/risk-tier.sh`). Integration and smoke never run hosted — they need a real Music.app.
- **Integration prerequisites:** a user playlist named **`Selecta Test`** with a few tracks (at least two — reorder coverage needs a permutable order) in Music.app, plus Automation permission (macOS prompt on first run; re-enable under System Settings → Privacy & Security → Automation).

## Hard rules

- **No taste in Selecta.** No similarity scoring, candidate ranking, or recommendation inside Selecta, in any front end — sequencing and taste are the model's job. Surfacing and enriching objective facts (BPM/key/energy, including from external sources like MusicBrainz/AcousticBrainz) is in scope. A feature drifting toward ranking is the wrong feature — stop and flag it.
- **All Music.app coupling stays in `packages/core/src/bridge/`.** No `osascript`/JXA in `tools/` or `cache/`.
- **`stdout` is the MCP protocol channel.** All logging to `stderr`; optional file log at `~/Library/Logs/Selecta/selecta.log` only when `SELECTA_DEBUG=1`.
- **Destructive CLI commands are dry-run by default.** A command that deletes or overwrites cache rows reports what it would change — with counts per source, not just totals — and writes only with `--apply`, dumping every row it overwrites or removes to an undo journal beside the database first. Its tests snapshot the whole cache and assert the delta is exactly what the summary reported, and empty for a dry run. `docs/destructive-commands.md` has the convention and what is deliberately outside it.
- **No hidden retries, no fallbacks, no auto-refresh.** Bridge fails → structured error; the model decides what to do. Write paths patch the cache surgically but never trigger a full reread.
- **CLI no-arg must start the MCP server over stdio** — clients spawn it that way; never print help on no-arg. Commander output routes to stderr (`configureOutput`).
- **macOS only, local-first.** Out of scope: Spotify integration, Last.fm scrobbling, multi-user, cloud, auth. A standalone UI is in scope as another front end on the same core, calling the operations the MCP tools do.

## Standing decisions

Settled calls — don't re-litigate without the user:

- No bias/weighting knobs (a `favorite_weight` blend was explicitly rejected). `search`'s sort lenses are neutral orderings the model picks, never weightings Selecta applies.
- Genres surface raw; normalization is an opinion the model owns.
- Co-occurrence counts hand-made (`kind = 'user'`) playlists only. Smart/subscription playlists are read-only snapshots.
- Playlist cloning accepts non-empty plain user sources only (max 500 entries). Generated, smart, subscription, special, and folder sources must never feed externally shifting curation back into user co-occurrence signal.
- Refresh never deletes playlists based on name/content similarity; ambiguous copies require explicit user choice. CLI and MCP refresh share orchestration. Positional edits use explicit playlist_positions and verify the full expected order live.
- Cache refresh is manual-only (`refresh_library`). Persistent IDs are trusted per library — re-import means the user re-runs refresh; no migration logic.
- The model names playlists. Names are half the point.
- Tool descriptions are first-class model interface: terse, contractual, with failure-mode hints ("if no match, returns empty array — don't retry with the same query").
- Notes are verbatim model memory, surfaced raw like genres. No note filter, sort, or FTS field, ever — the moment a note influences a query result, taste has leaked into the MCP.

## Engineering defaults

- **Tests land with the code.** Unit coverage ships in the same commit(s); bugfixes get a test that reproduces the bug.
- **Small, readable, minimal-dependency code wins.** Core deps: `@modelcontextprotocol/sdk`, `better-sqlite3`, `commander`, `zod`, `vitest`, TS toolchain. A UI front end's dependencies stay out of the core. Add beyond that only when it clearly earns its keep, and say why in the commit message.
- **Stay on the ticket.** A pre-existing bug, cleanup, or refactor noticed mid-task is a follow-up issue, not part of this change, unless the requested behavior can't work without it. Scratch verification scripts stay out of the repo.

## Working style

Build autonomously: design, implement, test, branch, and open PRs without per-step sign-off. Current scope is the open GitHub issues (`gh issue list`). Ask the user only for real scope changes, destructive/irreversible actions, or expensive forks nothing decides. Changes to scope or the hard rules are deliberate user decisions, never drift. A change that contradicts or extends a documented Music.app reality updates `docs/music-app.md` (and this file, if it shifts scope or workflow) in the same PR — docs never trail the code.

## Git workflow

- Feature branches off `main`; never commit directly on `main`. Branch names: `feat/<slug>`, `fix/<slug>`, `docs/<slug>`, `refactor/<slug>`, `chore/<slug>`.
- [Conventional Commits](https://www.conventionalcommits.org/): `<type>(<scope>): <subject>`, imperative, lowercase, no trailing period. One concern per commit; keep the build green where reasonable.
- Pushing feature branches and opening PRs is normal flow — no per-action confirmation. Never push to `main` or use an unguarded force-push. `--force-with-lease` is allowed when publishing rebased feature branches, including stacked PRs; if the lease fails, inspect the remote changes before proceeding. Never turn on auto-merge or merge by hand: the `gate` job turns auto-merge on for `auto-ok` PRs, and the user merges `needs-jonas` ones or tells you to. Never split a change to dodge a `needs-jonas` tier. Don't amend committed work.
- Before opening a PR, run `/simplify` over the diff and address what it surfaces.
- Work that depends on an unmerged PR is stacked, not held: `gh stack` where the extension is installed (`gh stack submit --open` — bare `--auto` opens drafts), otherwise branch off that PR's head and open the follow-up against it by hand. Branches are named per the convention above either way. After editing a lower layer, rebase the upper layers onto it and publish with lease protection; copying fixes between branches does not maintain stack ancestry.
- **During PR review cycles:** commit fixes for reviewer feedback (Codex, humans) and push only once **every** comment in the review batch is addressed (fixed or skipped with a reply saying why) — one push per batch, so a reviewer re-reads once instead of per fix. Never push with review comments still unaddressed. CodeRabbit is not active on this repo: don't wait for its pass or ask it to review.

## Worktrees

A worktree is named after the branch it carries, whichever tool created it (Claude Code, Codex, `git worktree add`):

- Branch: `<type>/<short-slug>`, same types as commits (`feat`, `fix`, `docs`, `refactor`, `chore`).
- Directory: the branch name flattened to `<type>-<short-slug>`, under whatever root the tool uses (`.claude/worktrees/feat-play-history`, `~/.codex/worktrees/feat-play-history`). Never a hash, a generated name, or a `+`-joined path. One exception: a worktree the desktop app created keeps the app's directory name (see below).
- A session that starts on an auto-named branch (`worktree-…`, `claude/…`, `bright-running-fox`) renames it before any work: `git branch -m <type>/<slug>`. Whether the directory moves too depends on who owns the worktree:
  - **Desktop app** (`CLAUDE_CODE_ENTRYPOINT=claude-desktop` in the environment; branch `claude/<slug>`): rename the branch only, never `git worktree move`. The app tracks the worktree by directory path in its own registry (`~/Library/Application Support/Claude/git-worktrees.json`). A moved directory strands the session in the primary checkout on `main` ("old worktree was removed and couldn't be re-created") and queues the moved directory for the app's garbage collection.
  - **CLI** (EnterWorktree: branch `worktree-<name>`, directory `agent-<hash>`): rename and move: `git worktree move <old> <root>/<type>-<slug>`, then re-enter the moved path so the session's cwd follows.
  - The primary checkout only ever gets the rename; `git worktree move` refuses a main working tree.
- After the PR merges, remove the worktree and delete the branch. Merged worktrees don't linger.
