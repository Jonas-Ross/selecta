#!/usr/bin/env bash
# Build metrognome's DSP for the browser from a metrognome checkout and drop it next
# to the website. Usage: scripts/build-site.sh [metrognome checkout], default ../metrognome.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
engine="$(cd "${1:-$root/../metrognome}" && pwd)"
# Run from the checkout so its rust-toolchain.toml picks the compiler.
(cd "$engine" && cargo build -p metrognome-wasm --release --target wasm32-unknown-unknown)
cp "$engine/target/wasm32-unknown-unknown/release/metrognome_wasm.wasm" "$root/site/metrognome.wasm"
# Pages builds the commit pinned in pages.yml; a local build uses whatever is checked out.
echo "site/metrognome.wasm: $(wc -c < "$root/site/metrognome.wasm") bytes, metrognome $(git -C "$engine" rev-parse --short HEAD)" >&2
