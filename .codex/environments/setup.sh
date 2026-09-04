#!/bin/sh

set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Selecta requires macOS because its bridge uses Music.app through osascript." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Selecta requires Node.js 22 or newer, but node is not on PATH." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Selecta requires npm, but npm is not on PATH." >&2
  exit 1
fi

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$node_major" -lt 22 ]; then
  echo "Selecta requires Node.js 22 or newer; found $(node --version)." >&2
  exit 1
fi

# npm ci is repeatable from the committed lockfile and replaces any partial or
# stale install left in a newly created worktree.
npm ci --no-audit --no-fund

# dist/ is intentionally ignored, but the MCP entrypoint runs from it.
npm run build

echo "Selecta environment ready (Node $(node --version))."
