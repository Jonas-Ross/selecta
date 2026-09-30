# Merge gate

Every PR used to wait for Jonas's approval, which made him the bottleneck for
changes nobody needed him to read. The `gate` CI job now decides, from the
files a PR touches (`scripts/risk-tier.sh`), whether it can merge without him.
When it can, the gate labels it `auto-ok` and turns on GitHub's auto-merge
(squash), which fires once the required checks pass. When it can't, the gate
labels it `needs-jonas` and turns auto-merge off. The gate job itself always
finishes green.

## Tiers

| Tier | Files | Merges when |
|---|---|---|
| `deps` | any, when every commit is Dependabot's, as signed by GitHub, and every bump's `update-type:` trailer reads minor or patch | CI is green |
| `auto` | Markdown other than `CLAUDE.md`, `packages/*/test/` apart from the list below, `package-lock.json` | CI is green and the Claude review passes |
| `jonas` | everything else | Jonas merges it |

`jonas` is the default, so a file nobody classified fails closed. It covers
every package's `src/` whole: the cache and its migrations, Music.app writes, and the
destructive commands are where wrong data is the one thing selecta cannot cheaply
undo, and the rest of the source waits until the Claude review has a track record.

Some files are `jonas` even though they look like tests or config, because
they are the gate's own inputs, and a change that could edit its grader and then
pass it has graded itself:

- `.github/`, `scripts/` at any depth, every `package.json`, and the TypeScript,
  Vitest and lint config, any of which can loosen what CI checks.
- `CLAUDE.md`, `AGENTS.md`, `.claude/` and `.codex/` at any depth, which steer
  the agents and the Claude review.
- `packages/core/test/table_diff.ts` and the destructive-command, supersede, reopen, migration
  and state-safety tests (split between `packages/core/test/` and `packages/mcp/test/`), which `docs/destructive-commands.md` makes the
  guardrail against lost data.
- `packages/core/test/network-guard.ts` and `packages/core/test/repo_hygiene.test.ts`, which keep the suite
  off the network and the repository free of databases.

So CI configuration changes do not merge on their own, and neither does a
hand-edited `package.json`. Dependabot's minor and patch bumps do, and CI turns
on auto-merge for them since no one else opens those PRs; its majors arrive as
their own PRs (`.github/dependabot.yml`) and wait for Jonas.

A bump of a transitive dependency is the exception. Dependabot writes
`update-type:` only for a direct dependency, so nothing bounds an indirect bump
to a minor or patch; it misses `deps`, its `package-lock.json` puts it in `auto`,
and with the Claude review skipped it waits for Jonas.

## What the gate trusts

**The Claude review is a separate reviewer, not the author's self-review.**
Codex skips PRs opened by `claude[bot]`, so `anthropics/claude-code-action`
reviews the diff with read-only tools and returns a structured `pass`/`block`.
With no token configured the job fails, which routes the PR to Jonas instead of
merging it unreviewed. It is skipped where Jonas reviews anyway, and on
Dependabot PRs, which get no secrets.

**Nothing waits in a pending or red state for Jonas.** An earlier version
posted a `merge-gate` status that sat `pending` until he approved. Sessions
watching CI waited on it forever, and he cannot approve a PR his own account
opened, which is every thread's PR. For the same reason there is no CODEOWNERS
file or required review. A `needs-jonas` PR merges when Jonas merges it or tells
a thread to. Agents never turn auto-merge on themselves, and the gate turns it
back off on every push to a `needs-jonas` PR. To hold an `auto-ok` PR, turn its
auto-merge off. A red job now means something actually broke.

**It stops a mistake, not an adversary.** The tier script runs from `main`'s
copy, so a buggy edit to it cannot classify itself. The workflow still comes from
the PR, so a PR that rewrote it could pass the gate; that is why workflow changes
are `jonas`. The only authors with write access are Jonas and his agents, and a
fork's PR gets no secrets, so no review, so `jonas`. It also gets a read-only
token, so its gate cannot turn auto-merge on; Jonas merges those by hand.
