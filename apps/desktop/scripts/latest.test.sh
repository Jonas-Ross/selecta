#!/usr/bin/env bash
# Tests for latest.sh's check and pull against throwaway repositories. No network.
set -euo pipefail

source_script=$(cd "$(dirname "$0")" && pwd)/latest.sh
failures=0

# A brew that knows no formula, so check never touches a real Homebrew tap.
stub=$(mktemp -d)
printf '#!/bin/sh\nexit 1\n' > "$stub/brew"
chmod +x "$stub/brew"
export PATH="$stub:$PATH"

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

fresh_clone
perl -MFcntl=:flock -e 'open(my $f, ">>", shift) or die; flock($f, LOCK_EX); sleep 30' "$dir/.git/selecta-latest.lock" &
holder=$!
sleep 0.5
expect 'a live run holds the lock' refused "$("$latest" pull > /dev/null 2>&1 && echo pulled || echo refused)"
kill $holder && wait $holder 2> /dev/null || true
expect 'a dead run leaves no lock behind' pulled "$("$latest" pull > /dev/null 2>&1 && echo pulled || echo refused)"

fresh_clone
export HOME=$dir/home
expect 'refresh-app skips a missing app' 'ok ' "$("$latest" refresh-app && echo ok) $(ls "$HOME/Applications" 2> /dev/null)"
stamp="$HOME/Applications/Selecta Latest.app/Contents/Resources/selecta-latest.stamp"
mkdir -p "$(dirname "$stamp")"
printf '/elsewhere/latest.sh\nold\n' > "$stamp"
"$latest" refresh-app
expect "refresh-app leaves another checkout's app alone" old "$(tail -n 1 "$stamp")"

[ "$failures" -eq 0 ] || { printf '%d failed\n' "$failures"; exit 1; }
