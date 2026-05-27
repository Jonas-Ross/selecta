# Selecta

A local MCP server that exposes the user's Apple Music library to Claude so playlists can be built from owned tracks and written back to Music.app. The model is the brain; this server is the eyes and hands.

`AGENTS.md` is a symlink to this file — agents that look for either will find the same content.

## Read before changing anything

- **`docs/design.md`** — the spec. Decisions, tool surface, cache schema, error shapes, build sequence, verification. This is the source of truth; CLAUDE.md just restates the load-bearing bits.
- The Selecta concept handoff in `docs/design.md` Context section — the "model is the brain" framing is non-negotiable. If a feature drifts toward analysis, ranking, or similarity scoring inside the MCP, it has lost the plot.

## Commands

Project is in scaffolding stage; once `package.json` lands:

| Command | Use |
|---|---|
| `npm install` | Install deps |
| `npm run build` | TypeScript compile to `dist/` |
| `npm test` | Run the unit suite (Vitest, no Music.app needed) |
| `npm test -- --tag integration` | Run bridge integration tests against your real Music.app (slow, opt-in) |
| `npm run dev` | Run the MCP server over stdio for local Claude Desktop / Claude Code use |
| `npx selecta refresh` | CLI: full library reread into the local SQLite cache |

## Git workflow

- Work on a feature branch off `main`. Never commit directly on `main`.
- Branch names: `feat/<slug>`, `fix/<slug>`, `docs/<slug>`, `refactor/<slug>`, `chore/<slug>`. Lowercase, hyphenated.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/): `<type>(<scope>): <subject>`. Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `build`, `ci`. Scope is the package or area (`bridge`, `cache`, `tools`, `docs`, etc.). Subject in imperative mood, lowercase, no trailing period.
- Keep commits as logical chunks — one concern per commit. Each commit should leave the build green where reasonable.
- After committing and before opening a PR, run the `/simplify` skill over the diff; address what it surfaces.
- Pushing feature branches and opening PRs is part of the normal flow — no per-action confirmation needed. Never push directly to `main`, never force-push, never merge without explicit ask.
- Do not amend committed work; create a new commit.

## Testing

**TDD is required for every feature and bugfix.** Red → green → refactor, no exceptions:

1. Write a failing test that pins the behavior you're about to add or fix. For a bug, the test must reproduce the bug and fail in the current tree before any production code changes.
2. Run the test and confirm it fails for the right reason (not a typo, not a missing import). Note the failure mode before moving on.
3. Write the minimum production code to make it pass. No drive-by features, no speculative abstractions.
4. Run the full suite to confirm green, then refactor with the test as the safety net.

**No "I'll add tests after" commits.** If you find yourself writing production code first, stop, revert, and start with the test. The only exception is exploratory spikes you throw away before the real commit.

**Two test tiers, cheapest first:**

1. **Unit (Vitest, fast, no Music.app)** — cache layer against in-memory SQLite seeded with fixtures; tool handlers with the bridge interface mocked. Bulk of the suite. Sub-second.
2. **Bridge integration (Vitest, tagged `integration`, slow)** — JXA layer exercised against a real Music.app, but against a hand-set-up *test playlist folder*, not the whole library. Run on demand.

Plus the **end-to-end smoke**: one scripted scenario (refresh → search → get_track_context → preview → create) against the real library. Not in the suite — manual review.

**Don't mock Music.app's behavior in unit tests.** Mock the bridge *interface* (small, typed). Integration tests own all "does Music.app actually behave that way" questions.

## Architecture

Three layers, top-down dependency:

- **`src/tools/`** — six MCP tool handlers (`search`, `get_track_context`, `list_playlists`, `create_playlist`, `preview_playlist`, `refresh_library`). Thin orchestrators: validate input, query cache and/or bridge, shape response. The only layer that knows MCP exists.
- **`src/cache/`** — SQLite at `~/Library/Application Support/Selecta/library.db`. Tracks, playlists, playlist_tracks, refresh_log + FTS5 virtual table. All model-triggered reads hit this layer.
- **`src/bridge/`** — wraps Music.app access. Builds JXA snippets, shells out via `osascript -l JavaScript`, parses JSON. All Music.app coupling lives here.

The cache and bridge are usable as a plain Node library without MCP — keeps tests fast and the boundaries crisp.

## Hard rules

- **The model is the brain. Selecta is the eyes and hands.** No taste modeling, no similarity scoring, no ML, no audio analysis, no candidate ranking inside the MCP. If a proposed feature does any of that, it's the wrong feature.
- **All Music.app coupling stays in `src/bridge/`.** No `osascript` or JXA in `tools/` or `cache/`. If you reach for that elsewhere, you're in the wrong package.
- **`stdout` is the MCP protocol channel.** All logging goes to `stderr`. Optional file logging to `~/Library/Logs/Selecta/selecta.log` only when `SELECTA_DEBUG=1`.
- **No hidden retries, no fallbacks.** Bridge fails → tool returns a structured error. The model decides whether to refresh, retry, or give up.
- **No auto-refresh.** Cache refresh is manual (`refresh_library` tool). Write paths (`create_playlist`, `preview_playlist`) patch the cache surgically so they don't desync — but they do *not* trigger a full reread.
- **Persistent IDs are trusted.** They're stable per Music.app library. If the user re-imports their library, they re-run `refresh_library`. No migration logic.
- **Tool descriptions are written for the model.** Terse, contractual, with failure-mode hints (e.g., "if no match, returns empty array — don't retry with the same query"). Tool docs are the cheapest way to shape good model behavior.
- **macOS only.** Music.app is the dependency. No cross-platform pretense.
- **No kitchen-sink dependencies.** Discuss before adding any library beyond `@modelcontextprotocol/sdk`, `better-sqlite3`, `vitest`, and the TS toolchain.
- **Cobra-style CLI surface, but in TypeScript terms.** The `selecta` bin currently has one verb (`refresh`); design for adding more verbs (`status`, `inspect`) without restructuring.
- **Out of scope (v1):** Spotify, Last.fm / MusicBrainz enrichment, scrobble logging, multi-user, cloud, auth, standalone UI, editing existing playlists beyond the dedicated preview slot.

## How to work

- **Pressure-test designs before code.** Flag inconsistencies, missing edge cases, things he'll regret. The Selecta handoff doc was crisp because it scoped hard; preserve that spirit.
- **Do not run ahead.** No implementing multiple layers before talking shape.
- **Slow is smooth, smooth is fast.** Design conversation first, implementation second.
- **If analysis/ranking starts leaking into the MCP, say so.** That's the load-bearing boundary.
- **Stay opinionated about small/understandable code over large libraries.** This is a personal MCP — readability and surface minimalism win every fork.
- **Tool descriptions are first-class.** When adding or changing a tool, the description for the model matters as much as the implementation.
- **The `superpowers` plugin (brainstorming, writing-plans, subagent-driven-development) is allowed.** Use it when it earns its keep — design passes and multi-step features benefit most. Don't over-process small changes.

## Status

Greenfield. Design committed (`docs/design.md`). No code yet.

Next: milestone 1 — bridge spike. JXA read of a Music.app test playlist printed as JSON, to confirm the `osascript -l JavaScript` path and the macOS Automation permission flow. Then milestones 2–5: cache + refresh, read-side tools over MCP, write-side tools, polish.

## Code Search

Use `semble search` to find code by describing what it does or naming a symbol/identifier, instead of grep:

```bash
semble search "FTS5 search builder" ./selecta
semble search "buildFromTracks" ./selecta
semble search "playlist co-occurrence query" ./selecta --top-k 10
```

If you anticipate doing more than one search, use `semble index` to create an index.

```bash
semble index ./selecta -o selecta_index
```

You can then reuse this index later:

```bash
semble search "buildFromTracks" --index selecta_index
```

An index is not automatically updated; if the code changes significantly, reindex. If you notice stale results while resolving searches to files, reindex.

Use `--content docs` to search documentation and prose, `--content config` for config files, or `--content all` to search code, docs, and config:

```bash
semble search "design rationale" ./selecta --content docs
semble search "vitest config" ./selecta --content config
semble search "FTS5" ./selecta --content all
```

Use `semble find-related` to discover code similar to a known location (pass `file_path` and `line` from a prior search result):

```bash
semble find-related src/cache/queries.ts 42 ./selecta
```

Like search, `find-related` also accepts an `--index` argument.

`path` defaults to the current directory when omitted; git URLs are accepted.

If `semble` is not on `$PATH`, use `uvx --from "semble[mcp]" semble` in its place.

### Workflow

1. Index the repo using `semble index -o cached_index`.
2. Start with `semble search` to find relevant chunks. Pass the index for faster results.
3. Use `--content docs` for documentation, `--content config` for config files, or `--content all` for everything.
4. Inspect full files only when the returned chunk does not give enough context.
5. Optionally use `semble find-related` with a promising result's `file_path` and `line` to discover related implementations.
6. Use grep only when you need exhaustive literal matches or quick confirmation of an exact string.
