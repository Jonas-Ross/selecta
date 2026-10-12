#!/usr/bin/env bash
# Opens the desktop app on the latest main: fast-forwards the checkout, upgrades
# metrognome, installs and builds only what changed. docs/desktop-app.md, "Always on latest".
#
#   apps/desktop/scripts/latest.sh                 the whole run, asking on the terminal
#   apps/desktop/scripts/latest.sh install-app     put "Selecta Latest" in ~/Applications
#   apps/desktop/scripts/latest.sh <step>          check | pull | metrognome | install | build | stop | open
#
# The app in ~/Applications runs the steps one at a time, so it can show each one.
set -euo pipefail

# Everything lives in main, so bash has read the whole file before a pull rewrites it.
main() {
  # Physical path, since Electron's argv (what pgrep matches) has symlinks resolved.
  repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)
  desktop=$repo/apps/desktop
  electron_app=$desktop/.dev/Selecta.app
  state=$repo/node_modules/.selecta-latest
  log_dir=$HOME/Library/Logs/Selecta
  tap=jonas-ross/tap
  formula=$tap/metrognome
  cd "$repo"

  # A Finder launch has launchd's bare PATH; node, npm and brew live on the login shell's.
  if ! command -v node > /dev/null || ! command -v brew > /dev/null; then
    local shell_path
    # perl's alarm stands in for timeout(1), which macOS lacks, in case a shell rc hangs.
    shell_path=$(perl -e 'alarm 10; exec @ARGV' "${SHELL:-/bin/zsh}" -ilc 'printf "__PATH__%s__PATH__" "$PATH"' 2> /dev/null < /dev/null |
      sed -n 's/.*__PATH__\(.*\)__PATH__.*/\1/p' || true)
    PATH=${shell_path:-$PATH}:/opt/homebrew/bin:/usr/local/bin
    export PATH
  fi

  lock_dir= tmp_dir=
  trap cleanup EXIT
  case ${1:-run} in
    check | -h | --help) ;;
    *) lock ;;
  esac

  case ${1:-run} in
    run) run ;;
    check) check ;;
    pull) pull ;;
    metrognome) metrognome ;;
    install) install ;;
    build) build ;;
    stop) stop ;;
    open) open_app ;;
    install-app) install_app ;;
    *) printf 'usage: %s [run|install-app|check|pull|metrognome|install|build|stop|open]\n' "$0" >&2; exit 2 ;;
  esac
}

say() { printf '%s\n' "$*"; }

# One run at a time per checkout, so two launches never build or rebuild the dev bundle together.
lock() {
  local dir
  dir="$(git rev-parse --absolute-git-dir)/selecta-latest.lock"
  if ! mkdir "$dir" 2> /dev/null; then
    if kill -0 "$(cat "$dir/pid" 2> /dev/null)" 2> /dev/null; then
      say "Another Selecta Latest run is busy in this checkout; try again once it finishes." >&2
      exit 1
    fi
    rm -rf "$dir"
    mkdir "$dir"
  fi
  echo $$ > "$dir/pid"
  lock_dir=$dir
}

cleanup() {
  [ -z "$tmp_dir" ] || rm -rf "$tmp_dir"
  [ -z "$lock_dir" ] || rm -rf "$lock_dir"
}

branch() { git symbolic-ref --quiet --short HEAD || echo detached; }

# Untracked files don't count: a fast-forward refuses to overwrite one anyway.
dirty() { [ -n "$(git status --porcelain --untracked-files=no)" ]; }

# pgrep takes a regex, so the path's own metacharacters (a "selecta (1)" folder) are escaped.
running_pid() {
  local literal
  literal=$(printf '%s' "$electron_app/Contents/MacOS/Electron" | sed 's/[][\\.*^$+?(){}|]/\\&/g')
  pgrep -f "^$literal( |\$)" | head -n 1 || true
}

install_stamp() { printf '%s %s' "$(shasum package-lock.json | cut -d' ' -f1)" "$(node -p 'process.version + " " + process.arch')"; }

built_stamp() { printf '%s %s' "$(git rev-parse HEAD)" "$(install_stamp)"; }

is_built() {
  [ -f "$desktop/dist/main.js" ] && ! dirty &&
    [ "$(cat "$state/built" 2> /dev/null)" = "$(built_stamp)" ]
}

brew_installed() { command -v brew > /dev/null && brew list --formula "$formula" > /dev/null 2>&1; }

# Prints key=value lines the app and run() decide from. Network failures are reported, not fatal.
check() {
  local fetched=1 behind=0 ahead=0 metro=missing
  if ! GIT_TERMINAL_PROMPT=0 GIT_HTTP_LOW_SPEED_LIMIT=1000 GIT_HTTP_LOW_SPEED_TIME=15 \
    git fetch --quiet origin main 2> /dev/null; then
    fetched=0
  fi
  if git rev-parse --verify --quiet origin/main > /dev/null; then
    behind=$(git rev-list --count HEAD..origin/main)
    ahead=$(git rev-list --count origin/main..HEAD)
  fi
  if brew_installed; then
    # Pull only this tap, so a new release shows up without a full brew update.
    git -C "$(brew --repository "$tap")" pull --quiet --ff-only > /dev/null 2>&1 || true
    if [ -n "$(HOMEBREW_NO_AUTO_UPDATE=1 brew outdated --quiet "$formula" 2> /dev/null)" ]; then
      metro=outdated
    else
      metro=current
    fi
  fi
  say "branch=$(branch)"
  say "dirty=$(dirty && echo 1 || echo 0)"
  say "fetched=$fetched"
  say "behind=$behind"
  say "ahead=$ahead"
  say "metrognome=$metro"
  say "built=$(is_built && echo 1 || echo 0)"
  say "running=$([ -n "$(running_pid)" ] && echo 1 || echo 0)"
}

pull() {
  if [ "$(branch)" != main ] || dirty; then
    say "The checkout isn't a clean main, so it stays as it is." >&2
    exit 1
  fi
  local behind
  behind=$(git rev-list --count HEAD..origin/main)
  [ "$behind" -gt 0 ] || { say "main is up to date"; return; }
  say "Pulling $behind new commit(s):"
  git log --format='  %s' HEAD..origin/main
  git merge --ff-only --quiet origin/main
}

metrognome() {
  brew_installed || { say "metrognome isn't installed from Homebrew; skipping"; return; }
  say "Upgrading metrognome"
  HOMEBREW_NO_AUTO_UPDATE=1 brew upgrade "$formula" ||
    say "metrognome didn't upgrade; the app keeps the one installed" >&2
}

install() {
  if [ -d node_modules ] && [ "$(cat "$state/installed" 2> /dev/null)" = "$(install_stamp)" ]; then
    return
  fi
  say "Installing dependencies"
  npm ci --no-audit --no-fund
  mkdir -p "$state"
  install_stamp > "$state/installed"
}

build() {
  if is_built; then return; fi
  say "Building Selecta"
  rm -f "$state/built"
  npm run build
  # A dirty tree builds every time, since its changes have no commit to stamp.
  dirty || { mkdir -p "$state" && built_stamp > "$state/built"; }
}

stop() {
  local pid
  pid=$(running_pid)
  [ -n "$pid" ] || return 0
  say "Closing Selecta"
  kill -TERM "$pid"
  for _ in $(seq 1 50); do
    kill -0 "$pid" 2> /dev/null || return 0
    sleep 0.2
  done
  say "Selecta didn't close; quit it and try again" >&2
  exit 1
}

open_app() {
  if [ -n "$(running_pid)" ]; then
    osascript -e 'tell application id "io.github.jonas-ross.selecta.dev" to activate' > /dev/null 2>&1 || true
    return
  fi
  say "Opening Selecta"
  mkdir -p "$log_dir"
  # Detached, with its output in a log, so this script (and the launcher) can exit.
  # Its own process group, so a timeout can stop the cp or codesign start.mjs is waiting on.
  nohup perl -e 'setpgrp(0, 0); exec @ARGV' node "$desktop/scripts/start.mjs" \
    >> "$log_dir/desktop-output.log" 2>&1 < /dev/null &
  local launcher=$!
  # Stopping this step (the applet's Stop) stops the launch too.
  trap "kill -TERM -- -$launcher 2> /dev/null; exit 143" TERM INT
  # A first launch may download Electron and rebuild the dev bundle, so allow minutes.
  for _ in $(seq 1 900); do
    if [ -n "$(running_pid)" ]; then
      trap - TERM INT
      return 0
    fi
    kill -0 "$launcher" 2> /dev/null || break
    sleep 0.2
  done
  kill -TERM -- "-$launcher" 2> /dev/null || true
  say "Selecta didn't start; see $log_dir/desktop-output.log" >&2
  exit 1
}

ask() {
  local reply
  [ -t 0 ] || return 1
  read -r -p "$1 [y/N] " reply
  [ "$reply" = y ] || [ "$reply" = Y ]
}

value() { sed -n "s/^$1=//p" <<< "$facts"; }

run() {
  say "Checking for updates"
  facts=$(check)
  local can_pull=1 behind
  behind=$(value behind)
  [ "$(value fetched)" = 1 ] || say "Couldn't reach GitHub; opening what's here"
  if [ "$(value branch)" != main ]; then
    say "The checkout is on $(value branch), not main."
    can_pull=0
  elif [ "$(value dirty)" = 1 ]; then
    say "The checkout has uncommitted changes."
    can_pull=0
  elif [ "$(value ahead)" -gt 0 ] && [ "$behind" -gt 0 ]; then
    say "Local main has commits origin/main doesn't, so it can't fast-forward."
    can_pull=0
  fi
  if [ $can_pull = 0 ]; then
    ask "Open it as it is?" || exit 1
    behind=0
  fi
  # The app runs metrognome fresh for each measurement, so upgrading it needs no restart.
  [ "$(value metrognome)" != outdated ] || metrognome
  if [ "$(value running)" = 1 ]; then
    if [ "$behind" = 0 ] && [ "$(value built)" = 1 ]; then
      open_app
      return
    fi
    ask "Selecta is open and there's something newer. Close it and reopen on the latest?" || {
      open_app
      return
    }
    stop
  fi
  [ "$behind" = 0 ] || pull
  install
  build
  open_app
}

install_app() {
  local dest=$HOME/Applications/Selecta\ Latest.app tmp app
  tmp=$(mktemp -d)
  tmp_dir=$tmp
  # osacompile names the app after its file, so it's built under its real name.
  app="$tmp/Selecta Latest.app"
  install
  mkdir -p "$HOME/Applications"
  # The applet knows only where this checkout is; every step is this script.
  # Escaped as an AppleScript string, then handed to perl as data so no character is special.
  SCRIPT_PATH=$(printf '%s' "$desktop/scripts/latest.sh" | sed 's/[\\"]/\\&/g') \
    perl -pe 's/__SCRIPT__/$ENV{SCRIPT_PATH}/g' "$desktop/scripts/latest.applescript" > "$tmp/latest.applescript"
  # Built beside, so a failed compile leaves the installed app alone.
  osacompile -o "$app" "$tmp/latest.applescript"
  "$(cd "$desktop" && node -p "require('electron')" | tail -n 1)" "$desktop/scripts/icon.mjs" "$app/Contents/Resources/applet.icns"
  plutil -replace CFBundleIdentifier -string io.github.jonas-ross.selecta.latest "$app/Contents/Info.plist"
  # osacompile's asset catalog icon wins over applet.icns, so drop it.
  rm -f "$app/Contents/Resources/Assets.car"
  plutil -remove CFBundleIconName "$app/Contents/Info.plist" 2> /dev/null || true
  # Editing the bundle breaks osacompile's signature, which macOS then refuses to run.
  codesign --force --deep --sign - "$app"
  rm -rf "$dest"
  mv "$app" "$dest"
  say "Installed $dest"
}

main "$@"
