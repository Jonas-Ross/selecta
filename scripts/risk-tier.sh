#!/usr/bin/env bash
# Classify a change by the files it touches, for the merge gate.
#
#   scripts/risk-tier.sh <base> <head>
#
# Prints the tier on stdout: `deps` (a minor or patch Dependabot bump; merges
# once CI passes), `auto` (merges once CI and the Claude review pass), or
# `jonas`. One `<class> <path>` line per file goes to stderr. Anything unlisted
# is `jonas`, so a new kind of file fails closed. docs/merge-gate.md has the
# tiers.
set -euo pipefail

[ $# -eq 2 ] || { printf 'usage: %s <base> <head>\n' "$0" >&2; exit 2; }
base=$(git merge-base "$1" "$2")
head=$2

# Every commit is Dependabot's and none of its bumps is a major, which the
# grouping in dependabot.yml sends as its own PR for exactly this reason. No
# merge commits: Dependabot rebases, and a merge can carry any edit. Author
# text survives an amend, so the caller must also set DEPENDABOT_VERIFIED=1 from
# GitHub's own record of who signed the commits.
dependabot_minor() {
  local authors types
  [ "${DEPENDABOT_VERIFIED:-}" = 1 ] || return 1
  [ -z "$(git rev-list --merges "$base..$head")" ] || return 1
  authors=$(git log --format=%an "$base..$head" | sort -u)
  types=$(git log --no-merges --format=%B "$base..$head" | sed -n 's/^ *update-type: //p' | sort -u)
  [ "$authors" = 'dependabot[bot]' ] && [ -n "$types" ] &&
    ! grep -qvE '^version-update:semver-(minor|patch)$' <<< "$types"
}

if dependabot_minor; then
  echo deps
  exit 0
fi

classify() {
  case $1 in
    # The gate itself and the rules agents follow: a change cannot grade its own
    # grader. Lint and compiler config can loosen what CI checks.
    .github/* | scripts/* | LICENSE) echo jonas ;;
    # Agent instructions nest, so they are the gate's inputs at any depth.
    CLAUDE*.md | */CLAUDE*.md | AGENTS*.md | */AGENTS*.md | REVIEW.md | */REVIEW.md | \
      .claude/* | */.claude/* | .codex/* | */.codex/*) echo jonas ;;
    package.json | tsconfig*.json | vitest.config.ts | .oxlintrc.json | .oxfmtrc.json) echo jonas ;;
    # The tests that stand between a flag typo and lost data, and the one that
    # keeps the suite off the network and off Music.app.
    test/table_diff.ts | test/destructive.test.ts | test/supersede.test.ts | \
      test/reopen.test.ts | test/migrations.test.ts | test/state_safety.test.ts | \
      test/network-guard.ts | test/repo_hygiene.test.ts) echo jonas ;;
    *.md | test/* | package-lock.json) echo auto ;;
    *) echo jonas ;;
  esac
}

tier=
while IFS= read -r -d '' path; do
  class=$(classify "$path")
  printf '%-8s %s\n' "$class" "$path" >&2
  case $class:$tier in
    jonas:* | auto:) tier=$class ;;
  esac
done < <(git diff -z --name-only --no-renames "$base" "$head")

# An empty diff has nothing to vouch for it.
echo "${tier:-jonas}"
