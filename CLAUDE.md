# Selecta

A local MCP server that exposes the user's Apple Music library to Claude so playlists can be built from owned tracks and written back to Music.app. The model is the brain; this server is the eyes and hands.

`AGENTS.md` is a symlink to this file — agents that look for either will find the same content.

## Mandate

**Claude owns this build end-to-end.** `docs/design.md` is the spec; build it through, milestone by milestone, without waiting for per-step sign-off. Design, implement, test, commit, push feature branches, and open PRs autonomously. When the spec and implementation reality disagree, use judgment, deviate, and record the deviation in `docs/design.md` so the spec stays true. Ask the user only when something genuinely needs their input: a real scope change, a destructive/irreversible action, or a fork in the road the spec doesn't decide and that's expensive to redo.

The spec is a map, not a cage — tool shapes, schema details, and internals may be adjusted where building reveals better answers. The identity below is the firm spine: change it only as a deliberate, recorded scope decision made with the user (as the v2 audio-feature and playlist-editing expansion was) — never casually drift it.

## Identity (non-negotiable)

- **The model is the brain. Selecta is the eyes and hands.** Selecta surfaces *facts* for the model to reason over — inventory, behavioral signal, and audio features (BPM/key/energy) — and the model does the sequencing and ranking. Computing or fetching objective audio features (including from an external source) is enrichment-of-facts and is in scope. What stays out is the model's job: no taste modeling, no similarity scoring, no candidate ranking or recommendation inside the MCP. If a feature drifts toward ranking/recommending candidates, it's the wrong feature — stop and flag it.
- **All Music.app coupling stays in `src/bridge/`.** No `osascript`/JXA in `tools/` or `cache/`.
- **`stdout` is the MCP protocol channel.** All logging to `stderr`; optional file log at `~/Library/Logs/Selecta/selecta.log` only when `SELECTA_DEBUG=1`.
- **No hidden retries, no fallbacks, no auto-refresh.** Bridge fails → structured error; the model decides what to do. Write paths patch the cache surgically but never trigger a full reread.
- **macOS only.** Music.app is the dependency; no cross-platform pretense.
- **Out of scope:** Spotify integration, Last.fm scrobbling, multi-user, cloud, auth, standalone UI. (Two former v1 exclusions graduated into v2: editing existing playlists — add/remove/reorder/delete (#15) — and external *audio-feature* enrichment (#19). MusicBrainz/AcousticBrainz is now a candidate data source for that enrichment, not an excluded dependency.)

## Engineering defaults

These are defaults, not gates — exercise judgment, optimize for shipping good software.

- **Tests land with the code.** Every feature and bugfix ships with unit coverage in the same commit(s); bugfixes get a test that reproduces the bug. Test-first is encouraged where it's cheap; it isn't ceremony to be policed.
- **Small, readable, minimal-dependency code wins.** Core deps: `@modelcontextprotocol/sdk`, `better-sqlite3`, `commander`, `vitest`, TS toolchain. Add beyond that only when it clearly earns its keep, and say why in the commit message.
- **Persistent IDs are trusted** — stable per Music.app library. Re-import → user re-runs `refresh_library`. No migration logic.
- **Tool descriptions are first-class.** Written for the model: terse, contractual, with failure-mode hints ("if no match, returns empty array — don't retry with the same query"). They're the cheapest lever on model behavior.
- **Canonical docs move together.** The spec lives in three places: `CLAUDE.md` (+ the `AGENTS.md` symlink), `docs/design.md` (decisions/scope/identity), and `docs/contracts.md` (Music.app realities). A change to identity, scope, or a contract must land in **all** the relevant ones in the same PR. A decision recorded in only one is one a future agent will miss — this bit us once: a v2 scope change landed in `CLAUDE.md` while `docs/design.md` still said the opposite, so the stale spec could still be cited to reject the new work.
- **CLI via `commander`:** the `selecta` bin is a verb dispatcher. No-arg must start the MCP server over stdio (clients spawn it that way — never print help on no-arg), and commander output routes to **stderr** (`configureOutput`). M1's hand-rolled `bridge:read-playlist` switch is deleted when `refresh` lands in M2.

## Architecture

Three layers, top-down dependency. Cache + bridge are usable as a plain Node library without MCP — keeps tests fast and boundaries crisp.

- **`src/tools/`** — seven MCP handlers (`search`, `library_overview`, `get_track_context`, `list_playlists`, `create_playlist`, `preview_playlist`, `refresh_library`). Thin orchestrators: validate input, query cache and/or bridge, shape response. Only layer that knows MCP exists. (`library_overview` is the post-v1 seventh; `search` and it share `common.libraryFilterShape`.)
- **`src/cache/`** — SQLite at `~/Library/Application Support/Selecta/library.db`. Tracks, playlists, playlist_tracks, refresh_log + FTS5. All model-triggered reads hit this layer.
- **`src/bridge/`** — wraps Music.app. Builds JXA snippets, shells out via `osascript -l JavaScript`, parses JSON.

Shared types live in `src/types/`; the cross-cutting error envelope in `src/types/errors.ts`.

## Commands

| Command | Use |
|---|---|
| `npm install` | Install deps |
| `npm run build` | TypeScript compile to `dist/` |
| `npm test` | Unit suite (fast, no Music.app) |
| `npm run test:integration` | Bridge integration suite against real Music.app (slow, opt-in) |
| `npm run dev` | Run the MCP server over stdio |

## Testing

Two tiers, cheapest first:

1. **Unit (bulk of the suite, sub-second)** — cache layer against in-memory SQLite with fixtures; tool handlers with the bridge *interface* mocked. Don't simulate Music.app's behavior in unit tests — integration owns all "does Music.app actually do that" questions.
2. **Bridge integration (tagged `integration`)** — JXA against a real Music.app, scoped to a test playlist, not the whole library.

**Run suites only via the npm scripts, never bare `vitest`:**

- ⚠️ `npx vitest run` ignores the scripts' `--tags-filter` and runs *everything*, launching Music.app and firing the macOS Automation prompt. Use `npm test` / `npm run test:integration`.
- The `integration` tag is the only gate (no env var).
- **Integration prerequisites:** a user playlist named **`Selecta Test`** with a few tracks in Music.app, plus Automation permission (macOS prompt on first run; re-enable under System Settings → Privacy & Security → Automation).

Plus one manual **end-to-end smoke** (refresh → search → get_track_context → preview → create) against the real library before calling v1 done.

## Git workflow

- Feature branches off `main`; never commit directly on `main`. Branch names: `feat/<slug>`, `fix/<slug>`, `docs/<slug>`, `refactor/<slug>`, `chore/<slug>`.
- [Conventional Commits](https://www.conventionalcommits.org/): `<type>(<scope>): <subject>`, imperative, lowercase, no trailing period. One concern per commit; keep the build green where reasonable.
- Pushing feature branches and opening PRs is normal flow — no per-action confirmation. Never push to `main`, never force-push, never merge without explicit ask. Don't amend committed work.
- Before opening a PR, run `/simplify` over the diff and address what it surfaces.
- **Every time a PR goes up, and every time review comments are addressed, check whether the change implies a doc update** — does it shift identity, scope, a tool contract, or a documented Music.app reality? If so, update `CLAUDE.md` / `docs/design.md` / `docs/contracts.md` in the same PR. Don't let the docs drift behind the code.
- **During PR review cycles:** commit fixes for reviewer feedback (CodeRabbit, Codex, humans) but **do not auto-push** — the user pushes, so CodeRabbit re-reviews one batch instead of every fix.

## Status

**v1 complete — all five milestones built.** Seven tools live over MCP stdio (six v1 + `library_overview`, added post-v1), cache + bridge fully implemented, unit + integration suites green, end-to-end smoke scripted (`npm run smoke`). Spec deviations discovered during the build are recorded in `docs/design.md` §Implementation notes and `docs/contracts.md`.

**v2 in planning (issues #15–#20).** After living with v1, scope was deliberately widened (see Identity): mutate existing playlists (#15), search dedup (#16), exclusion filters (#17), `set_loved`/`set_rating` write-back (#18), audio-feature enrichment populated incrementally on refresh (#19), and multi-seed co-occurrence (#20). Audio features and external audio-feature enrichment graduated into scope. None built yet.

## Code search

Prefer `semble` over grep for "how does X work" questions:

```bash
semble index . -o selecta_index                      # once, reuse after
semble search "FTS5 search builder" --index selecta_index
semble search "design rationale" . --content docs    # docs/config: --content docs|config|all
semble find-related src/cache/queries.ts 42 .        # similar code to a known spot
```

Reindex if results look stale. If `semble` isn't on `$PATH`, use `uvx --from "semble[mcp]" semble`. Grep is still right for exhaustive literal matches or confirming an exact string.
