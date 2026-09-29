#!/usr/bin/env bash
# Tests for risk-tier.sh against throwaway repositories. No network.
set -euo pipefail

tier_script=$(cd "$(dirname "$0")" && pwd)/risk-tier.sh
failures=0
# The workflow sets this from GitHub's commit records; see the case that unsets it.
export DEPENDABOT_VERIFIED=1

# Each case starts from a base commit carrying these files.
fresh_repo() {
  dir=$(mktemp -d)
  cd "$dir"
  git init -q -b main
  git config user.email test@example.com
  git config user.name test
  mkdir -p src/cache src/tools test docs .github/workflows
  for f in src/cache/schema.ts src/tools/search.ts test/cache.test.ts test/destructive.test.ts; do
    echo "// $f" > "$f"
  done
  echo '# x' > docs/music-app.md
  echo '{}' > package.json && echo '{}' > package-lock.json
  echo 'on: push' > .github/workflows/ci.yml
  git add -A
  git commit -qm base
  git checkout -qb pr
}

# commit_as <author> <message>: stage everything and commit it.
commit_as() {
  git add -A
  git -c user.name="$1" commit -qm "$2" --allow-empty
}

expect() {
  local want=$1 name=$2 got
  got=$("$tier_script" main pr 2>/dev/null)
  if [ "$got" = "$want" ]; then
    printf 'ok   %s\n' "$name"
  else
    printf 'FAIL %s: want %s, got %s\n' "$name" "$want" "$got"
    failures=$((failures + 1))
  fi
  cd /
  rm -rf "$dir"
}

bump() {
  printf 'chore(deps): bump\n\n---\nupdated-dependencies:\n'
  for t in "$@"; do printf -- '- dependency-name: x\n  update-type: version-update:semver-%s\n' "$t"; done
}

fresh_repo; echo more >> docs/music-app.md; commit_as test docs; expect auto 'docs only'
fresh_repo; echo t > test/new.test.ts; echo x >> test/cache.test.ts; commit_as test tests; expect auto 'ordinary tests'
fresh_repo; echo x >> test/destructive.test.ts; commit_as test t; expect jonas 'destructive-command test'
fresh_repo; echo x >> src/cache/schema.ts; commit_as test s; expect jonas 'cache schema'
fresh_repo; echo x >> src/tools/search.ts; commit_as test s; expect jonas 'unlisted source'
fresh_repo; echo x >> docs/music-app.md; echo x >> .github/workflows/ci.yml; commit_as test c; expect jonas 'docs plus workflow'
fresh_repo; echo x > CLAUDE.md; commit_as test c; expect jonas 'agent rules'
fresh_repo; mkdir -p src; echo x > src/AGENTS.md; commit_as test c; expect jonas 'nested agent rules'
fresh_repo; mkdir -p ui/.claude; echo x > ui/.claude/x.md; commit_as test c; expect jonas 'nested agent skill'
fresh_repo; echo x >> package.json; commit_as test p; expect jonas 'manifest by hand'
fresh_repo; echo x >> package-lock.json; commit_as test p; expect auto 'lockfile by hand'
fresh_repo; commit_as test empty; expect jonas 'empty diff'

fresh_repo
echo x >> package.json && echo x >> package-lock.json && echo x >> .github/workflows/ci.yml
commit_as 'dependabot[bot]' "$(bump minor patch)"
expect deps 'dependabot minor and patch'

fresh_repo; echo x >> package.json; commit_as 'dependabot[bot]' "$(bump minor major)"; expect jonas 'dependabot group with a major'
fresh_repo; echo x >> package.json; commit_as 'dependabot[bot]' 'chore(deps): bump'; expect jonas 'dependabot without an update type'

fresh_repo
echo x >> package.json && commit_as 'dependabot[bot]' "$(bump patch)"
echo x >> src/cache/schema.ts && commit_as test 'fix: follow the bump'
expect jonas 'dependabot bump with a commit on top'

fresh_repo; echo x >> src/cache/schema.ts; commit_as test "$(bump patch)"; expect jonas 'a bump message from someone else'

fresh_repo
echo x >> package-lock.json && commit_as 'dependabot[bot]' "$(bump patch)"
git checkout -q main && echo y >> docs/music-app.md && commit_as test 'main moves' && git checkout -q pr
git -c user.name='dependabot[bot]' merge -q --no-edit --no-ff main
echo x >> src/cache/schema.ts && git add -A && git -c user.name='dependabot[bot]' commit -q --amend --no-edit
expect jonas 'dependabot bump with an edit hidden in a merge'

fresh_repo
echo x >> package-lock.json && commit_as 'dependabot[bot]' "$(bump patch)"
git checkout -q main && echo y >> docs/music-app.md && commit_as test 'main moves' && git checkout -q pr
git -c user.name='dependabot[bot]' merge -q --no-edit --no-ff main
expect auto 'dependabot bump with a plain merge of main is judged by its files'
fresh_repo; echo x >> package.json; commit_as 'dependabot[bot]' "$(bump patch)"
DEPENDABOT_VERIFIED= expect jonas 'dependabot author text without a verified signature'

[ "$failures" -eq 0 ] || { printf '%d failed\n' "$failures"; exit 1; }
