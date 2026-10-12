#!/usr/bin/env bash
# Tests for latest.sh's check and pull against throwaway repositories. No network.
set -euo pipefail

source_script=$(cd "$(dirname "$0")" && pwd)/latest.sh
failures=0

# A clone of a local origin whose main is one commit ahead of it.
fresh_clone() {
  local origin
  origin=$(mktemp -d)
  git init -q -b main "$origin"
  git -C "$origin" config user.email test@example.com
  git -C "$origin" config user.name test
  mkdir -p "$origin/apps/desktop/scripts"
  cp "$source_script" "$origin/apps/desktop/scripts/latest.sh"
  echo '{}' > "$origin/package-lock.json"
  git -C "$origin" add -A
  git -C "$origin" commit -qm base
  dir=$(mktemp -d)
  git clone -q "$origin" "$dir"
  git -C "$dir" config user.email test@example.com
  git -C "$dir" config user.name test
  echo new > "$origin/new.txt"
  git -C "$origin" add -A
  git -C "$origin" commit -qm 'feat: something new'
  latest=$dir/apps/desktop/scripts/latest.sh
}

expect() {
  local name=$1 want=$2 got=$3
  if [ "$got" = "$want" ]; then
    printf 'ok   %s\n' "$name"
  else
    printf 'FAIL %s: want %q, got %q\n' "$name" "$want" "$got"
    failures=$((failures + 1))
  fi
}

fact() { "$latest" check | sed -n "s/^$1=//p"; }

fresh_clone
expect 'clean main sees the new commit' 1 "$(fact behind)"
expect 'clean main is not dirty' 0 "$(fact dirty)"
"$latest" pull > /dev/null
expect 'pull fast-forwards' new "$(cat "$dir/new.txt")"
expect 'pulled main is up to date' 0 "$(fact behind)"

fresh_clone
echo '{"changed":1}' > "$dir/package-lock.json"
expect 'an uncommitted edit is dirty' 1 "$(fact dirty)"
expect 'pull refuses a dirty tree' refused "$("$latest" pull > /dev/null 2>&1 && echo pulled || echo refused)"
expect 'the edit survives' '{"changed":1}' "$(cat "$dir/package-lock.json")"

fresh_clone
echo scratch > "$dir/scratch.txt"
expect 'an untracked file is not dirty' 0 "$(fact dirty)"

fresh_clone
git -C "$dir" checkout -qb feat/x
expect 'another branch is reported' feat/x "$(fact branch)"
expect 'pull refuses another branch' refused "$("$latest" pull > /dev/null 2>&1 && echo pulled || echo refused)"

fresh_clone
echo mine > "$dir/mine.txt"
git -C "$dir" add -A
git -C "$dir" commit -qm 'local work'
expect 'diverged main is ahead' 1 "$(fact ahead)"
expect 'diverged main is behind' 1 "$(fact behind)"
expect 'pull refuses to merge a diverged main' refused "$("$latest" pull > /dev/null 2>&1 && echo pulled || echo refused)"

[ "$failures" -eq 0 ] || { printf '%d failed\n' "$failures"; exit 1; }
