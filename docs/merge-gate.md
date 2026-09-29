# Merge gate

Every PR used to wait for Jonas's approval, which made him the bottleneck for
changes nobody needed him to read. The `gate` CI job now decides, from the
files a PR touches (`scripts/risk-tier.sh`), whether it can merge without him,
and posts the answer as the `merge-gate` commit status. GitHub's auto-merge
(squash) does the merging; `merge-gate` is a required status, so auto-merge
fires only once the gate passes. Waiting on Jonas is `pending`, not a failed
job, because a red job emails him on every push.

## Tiers

| Tier | Files | Merges when |
|---|---|---|
| `deps` | any, when every commit is Dependabot's, as signed by GitHub, and no bump is a major | CI is green |
| `auto` | Markdown other than `CLAUDE.md`, `test/` apart from the list below, `package-lock.json` | CI is green and the Claude review passes |
| `jonas` | everything else | CI is green and Jonas approved this change |

`jonas` is the default, so a file nobody classified fails closed. It covers
`src/` whole: the cache and its migrations, Music.app writes, and the
destructive commands are where wrong data is the one thing selecta cannot cheaply
undo, and the rest of `src/` waits until the Claude review has a track record.

Some files are `jonas` even though they look like tests or config, because
they are the gate's own inputs, and a change that could edit its grader and then
pass it has graded itself:

- `.github/`, `scripts/`, `package.json`, and the TypeScript, Vitest and lint
  config, any of which can loosen what CI checks.
- `CLAUDE.md`, `AGENTS.md`, `.claude/` and `.codex/` at any depth, which steer
  the agents and the Claude review.
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
merging `main` into it, which moves the head. The gate merges the approved
commit and the head each into `main` as it is now (`git merge-tree`) and
requires the same tree, so merging `main` in keeps an approval, and any other
edit, down to whitespace or which of two identical blocks changed, drops it. So
does a conflict with `main`. Jonas requesting changes
blocks every tier. A review from him re-runs only the gate job
(`merge-gate-review.yml`), so an approval merges without re-running CI. That
re-run needs a `MERGE_GATE_TOKEN` secret, because `GITHUB_TOKEN` gets a 403
re-running a job. Without it the gate has to be re-run by hand, and a
changes-requested review cannot stop an auto-merge the gate already passed.

**It stops a mistake, not an adversary.** The gate runs from the PR's own
workflow, so a PR that rewrote the workflow could pass it; that is why workflow
changes are `jonas`. The only authors with write access are Jonas and his
agents, and a fork's PR gets no secrets, so no review, so `jonas`. It also gets
a read-only token, so its gate cannot post `merge-gate` at all; Jonas merges
those by hand.
