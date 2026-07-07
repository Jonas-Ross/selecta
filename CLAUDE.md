# Selecta

A local MCP server that exposes the user's Apple Music library to Claude so playlists can be built from owned tracks and written back to Music.app. The model is the brain — it does all sequencing, ranking, and taste; Selecta surfaces facts (inventory, behavioral signal, audio features) and executes reads and writes.

`AGENTS.md` is a symlink to this file. `docs/music-app.md` is the one companion doc: field notes on what Music.app actually does when scripted.

## Architecture

Tools on top, three external/storage peers below — cache, bridge, and enrich are all usable as a plain Node library without MCP, which keeps tests fast and boundaries crisp.

- **`src/tools/`** — fourteen MCP handlers (`search`, `library_overview`, `get_track_context`, `list_playlists`, `create_playlist`, `preview_playlist`, `add_tracks`, `remove_tracks`, `reorder_tracks`, `delete_playlist`, `set_loved`, `set_rating`, `refresh_library`, `enrich_features`). Thin orchestrators: validate input, query cache and/or bridge, shape response. Only layer that knows MCP exists. `search` and `library_overview` share `common.libraryFilterShape`.
- **`src/cache/`** — SQLite at `~/Library/Application Support/Selecta/library.db`. Tracks, playlists, playlist_tracks, audio_features, refresh_log + FTS5. All model-triggered reads hit this layer. audio_features (bpm/musical_key/danceability + per-field provenance, keyed by persistent ID) sits outside the refresh cycle: a reread never wipes enrichment; rows are pruned only when their track leaves the library.
- **`src/bridge/`** — wraps Music.app. Builds JXA snippets, shells out via `osascript -l JavaScript`, parses JSON.
- **`src/enrich/`** — wraps the external metadata sources (MusicBrainz→AcousticBrainz, Deezer; free, no API keys). Sources self-throttle to each host's documented limit (MusicBrainz 1 req/s, AcousticBrainz 10 req/10s; throttles start "as if a call just happened" so run boundaries can't burst); every attempted track gets a terminal status (`ok`/`no_data`/`no_match`) so dead ends are never retried. A source failure (AcousticBrainz throws intermittent 5xx) skips that 25-track chunk — nothing saved for it, tracks stay pending for a later run, skip reported in the summary — and the run continues; no request is ever reissued within a run. Runs only when explicitly invoked (`enrich_features` tool, `enrich` CLI) — never as a side effect of refresh.

Shared types live in `src/types/`; the cross-cutting error envelope in `src/types/errors.ts`.

## Commands

| Command | Use |
|---|---|
| `npm install` | Install deps |
| `npm run build` | TypeScript compile to `dist/` |
| `npm test` | Unit suite (fast, no Music.app) |
| `npm run test:integration` | Bridge integration suite against real Music.app (slow, opt-in) |
| `npm run smoke` | End-to-end smoke against the real library (builds first) |
| `npm run verify:echo` | Live iCloud-echo reconciliation harness |
| `npm run dev` | Run the MCP server over stdio |
| `node dist/index.js refresh` | Refresh the library cache from the CLI, no MCP client needed |
| `node dist/index.js enrich [-n N]` | Backfill audio features from the CLI (default all pending, ~1-3s/track) |

## Testing

Two tiers, cheapest first:

1. **Unit (bulk of the suite, sub-second)** — cache layer against in-memory SQLite with fixtures; tool handlers with the bridge *interface* mocked. Don't simulate Music.app's behavior in unit tests — integration owns all "does Music.app actually do that" questions.
2. **Bridge integration (tagged `integration`)** — JXA against a real Music.app, scoped to a test playlist, not the whole library.

**Run suites only via the npm scripts, never bare `vitest`:**

- ⚠️ `npx vitest run` ignores the scripts' `--tags-filter` and runs *everything*, launching Music.app and firing the macOS Automation prompt. Use `npm test` / `npm run test:integration`.
- The `integration` tag is the only gate (no env var).
- **Integration prerequisites:** a user playlist named **`Selecta Test`** with a few tracks (at least two — reorder coverage needs a permutable order) in Music.app, plus Automation permission (macOS prompt on first run; re-enable under System Settings → Privacy & Security → Automation).

## Hard rules

- **No taste in the MCP.** No similarity scoring, candidate ranking, or recommendation inside Selecta — sequencing and taste are the model's job. Surfacing and enriching objective facts (BPM/key/energy, including from external sources like MusicBrainz/AcousticBrainz) is in scope. A feature drifting toward ranking is the wrong feature — stop and flag it.
- **All Music.app coupling stays in `src/bridge/`.** No `osascript`/JXA in `tools/` or `cache/`.
- **`stdout` is the MCP protocol channel.** All logging to `stderr`; optional file log at `~/Library/Logs/Selecta/selecta.log` only when `SELECTA_DEBUG=1`.
- **No hidden retries, no fallbacks, no auto-refresh.** Bridge fails → structured error; the model decides what to do. Write paths patch the cache surgically but never trigger a full reread.
- **CLI no-arg must start the MCP server over stdio** — clients spawn it that way; never print help on no-arg. Commander output routes to stderr (`configureOutput`).
- **macOS only.** Out of scope: Spotify integration, Last.fm scrobbling, multi-user, cloud, auth, standalone UI.

## Standing decisions

Settled calls — don't re-litigate without the user:

- No bias/weighting knobs (a `favorite_weight` blend was explicitly rejected). `search`'s sort lenses are neutral orderings the model picks, never weightings Selecta applies.
- Genres surface raw; normalization is an opinion the model owns.
- Co-occurrence counts hand-made (`kind = 'user'`) playlists only. Smart/subscription playlists are read-only snapshots.
- Cache refresh is manual-only (`refresh_library`). Persistent IDs are trusted per library — re-import means the user re-runs refresh; no migration logic.
- The model names playlists. Names are half the point.
- Tool descriptions are first-class model interface: terse, contractual, with failure-mode hints ("if no match, returns empty array — don't retry with the same query").

## Engineering defaults

- **Tests land with the code.** Unit coverage ships in the same commit(s); bugfixes get a test that reproduces the bug.
- **Small, readable, minimal-dependency code wins.** Core deps: `@modelcontextprotocol/sdk`, `better-sqlite3`, `commander`, `zod`, `vitest`, TS toolchain. Add beyond that only when it clearly earns its keep, and say why in the commit message.

## Working style

Build autonomously: design, implement, test, branch, and open PRs without per-step sign-off. Current scope lives in GitHub issues (#15–#20 for v2). Ask the user only for real scope changes, destructive/irreversible actions, or expensive forks nothing decides. Changes to scope or the hard rules are deliberate user decisions, never drift. A change that contradicts or extends a documented Music.app reality updates `docs/music-app.md` (and this file, if it shifts scope or workflow) in the same PR — docs never trail the code.

## Git workflow

- Feature branches off `main`; never commit directly on `main`. Branch names: `feat/<slug>`, `fix/<slug>`, `docs/<slug>`, `refactor/<slug>`, `chore/<slug>`.
- [Conventional Commits](https://www.conventionalcommits.org/): `<type>(<scope>): <subject>`, imperative, lowercase, no trailing period. One concern per commit; keep the build green where reasonable.
- Pushing feature branches and opening PRs is normal flow — no per-action confirmation. Never push to `main`, never force-push, never merge without explicit ask. Don't amend committed work.
- Before opening a PR, run `/simplify` over the diff and address what it surfaces.
- **During PR review cycles:** commit fixes for reviewer feedback (CodeRabbit, Codex, humans) and push only once **every** comment in the review batch is addressed (fixed or skipped with a reply saying why) — one push per batch, so CodeRabbit re-reviews once instead of per fix. Never push with review comments still unaddressed.

## Status

v1 complete — eleven tools live over MCP stdio, unit + integration suites green. v2 underway, tracked in issues #15–#20. Shipped: exclusion filters (#17); playlist mutation (#15, complete) — `add_tracks`/`remove_tracks` plus a `playlist_order` search sort, `reorder_tracks`, `delete_playlist`; search dedup (#16) — `dedupe` flag on `search` collapsing same-song copies, suppressed IDs in `alternate_ids`; write-back signal (#18) — `set_loved`/`set_rating` (stars 0–5, halves; 0 clears); audio-feature enrichment (#19) — `audio_features` cache, `enrich_features` tool + `enrich` CLI, bpm/musical_key/danceability on every track surface plus `bpm_min`/`bpm_max` filters and overview `tracks_with_bpm` (coverage is partial by nature — a live probe of this library measured ~57% bpm / ~37% key, weakest on 2022+ releases); multi-seed co-occurrence (#20) — `seed_ids` on `get_track_context`, co-occurrence aggregated across the seed set (`total_shared_playlist_count` + `seeds_matched` per candidate). v2 feature set complete.

⚠️ **Before touching the playlist edit paths, read `docs/music-app.md`** — scripted playlist-entry edits race iCloud sync (entry doubles, wiped edits, oscillating reads during churn).

## Code search

Prefer `semble` over grep for "how does X work" questions:

```bash
semble index . -o selecta_index                      # once, reuse after
semble search "FTS5 search builder" --index selecta_index
semble search "design rationale" . --content docs    # docs/config: --content docs|config|all
semble find-related src/cache/queries.ts 42 .        # similar code to a known spot
```

Reindex if results look stale. If `semble` isn't on `$PATH`, use `uvx --from "semble[mcp]" semble`. Grep is still right for exhaustive literal matches or confirming an exact string.
