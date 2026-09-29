# Merge gate

Every PR used to wait for Jonas's approval, which made him the bottleneck for
changes nobody needed him to read. The `merge-gate` CI job now decides, from the
files a PR touches (`scripts/risk-tier.sh`), whether it can merge without him.
GitHub's auto-merge (squash) does the merging; `merge-gate` is a required check,
so auto-merge fires only once the gate passes.

## Tiers

| Tier | Files | Merges when |
|---|---|---|
| `deps` | any, when every commit is Dependabot's and no bump is a major | CI is green |
| `auto` | Markdown other than `CLAUDE.md`, `test/` apart from the list below, `package-lock.json` | CI is green and the Claude review passes |
| `jonas` | everything else | CI is green and Jonas approved this change |

`jonas` is the default, so a file nobody classified fails closed. It covers
`src/` whole: the cache and its migrations, Music.app writes, and the
destructive commands are where wrong data is the one thing selecta cannot cheaply
undo, and the rest of `src/` waits until the Claude review has a track record.

Some files are `jonas` even though they look like tests or config, because
they are the gate's own inputs, and a change that could edit its grader and then
pass it has graded itself:

- `.github/`, `scripts/`, `CLAUDE.md`/`AGENTS.md`, `package.json`, and the
  TypeScript, Vitest and lint config, any of which can loosen what CI checks.
- `test/table_diff.ts` and the destructive-command, supersede, reopen, migration
  and state-safety tests, which `docs/destructive-commands.md` makes the
  guardrail against lost data.
- `test/network-guard.ts` and `test/repo_hygiene.test.ts`, which keep the suite
  off the network and the repository free of databases.

So CI configuration changes do not merge on their own, and neither does a
hand-edited `package.json`. Dependabot's minor and patch bumps do; its majors
arrive as their own PRs (`.github/dependabot.yml`) and wait for Jonas.

## What the gate trusts

**The Claude review is a separate reviewer, not the author's self-review.**
Codex skips PRs opened by `claude[bot]`, so `anthropics/claude-code-action`
reviews the diff with read-only tools and returns a structured `pass`/`block`.
With no token configured the job fails, which routes the PR to Jonas instead of
merging it unreviewed. It is skipped where Jonas reviews anyway, and on
Dependabot PRs, which get no secrets.

**An approval covers a change, not a commit.** Keeping a PR up to date means
merging `main` into it, which moves the head. The gate hashes the PR's diff
from its merge base at the approved commit and at the head, byte for byte apart
from line positions and blob ids, so merging `main` keeps an approval and any
edit to the change itself, down to whitespace, drops it. (`git patch-id` would
ignore whitespace, which a shell string can depend on.) Jonas requesting changes
blocks every tier. A review from him re-runs only the gate job
(`merge-gate-review.yml`), so an approval merges without re-running CI. That
re-run needs a `MERGE_GATE_TOKEN` secret, because `GITHUB_TOKEN` gets a 403
re-running a job. Without it the gate has to be re-run by hand, and a
changes-requested review cannot stop an auto-merge the gate already passed.

**It stops a mistake, not an adversary.** The gate runs from the PR's own
workflow, so a PR that rewrote the workflow could pass it; that is why workflow
changes are `jonas`. The only authors with write access are Jonas and his
agents, and a fork's PR gets no secrets, so no review, so `jonas`.
