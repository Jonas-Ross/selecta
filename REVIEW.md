# Review instructions

CLAUDE.md holds the project's rules; this file only tunes how reviews weigh them.
Most PRs here merge with no human reading them (`docs/merge-gate.md`), so a
missed bug ships.

## What Important means here

Important is anything that would break behavior for someone using selecta:
incorrect logic, a broken hard rule from CLAUDE.md, a race in a Music.app
playback or playlist edit, wrong data stored or shown as fact, a cache write
outside its transaction, a destructive command that writes without `--apply`
or skips its undo journal, or documentation that now contradicts the code.
A test weakened or removed without cause is Important too.

Style, naming and refactoring suggestions are Nit at most. Report at most five
Nits per review.

## Always check

- Nothing writes to stdout in the MCP server or core except the protocol.
- `osascript`/JXA appears only under `packages/core/src/bridge/`.
- Nothing in `packages/core` imports from `packages/mcp` or `apps/`.
- No unit test can launch Music.app or reach the network; Music.app tests carry
  the `integration` tag.
- No ranking, scoring or recommendation logic: selecta surfaces facts, the
  model owns taste.
- An estimate metrognome flags `uncertain` is never stored or shown as fact.
- A change to a Music.app behavior updates `docs/music-app.md` in the same PR.

## Do not report

- Anything CI already enforces: types, oxlint, oxfmt.
- `package-lock.json` and other lockfiles.
- Vendored or generated files: `site/vendor/`, `site/media/`, `site/fonts/`, `dist/`.
