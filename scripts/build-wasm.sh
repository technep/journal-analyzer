#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/core/target}"
export CARGO_TARGET_DIR="$TARGET_DIR"
cargo build --manifest-path "$ROOT/core/Cargo.toml" --release --target wasm32-unknown-unknown
wasm-bindgen "$TARGET_DIR/wasm32-unknown-unknown/release/journal_core.wasm" \
  --target web \
  --out-dir "$ROOT/core/pkg" \
  --out-name journal_core
WASM="$ROOT/core/pkg/journal_core_bg.wasm"
if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -Oz --enable-bulk-memory --enable-sign-ext --enable-nontrapping-float-to-int "$WASM" -o "$WASM"
elif [[ -x "$ROOT/node_modules/binaryen/bin/wasm-opt" ]]; then
  "$ROOT/node_modules/binaryen/bin/wasm-opt" -Oz --enable-bulk-memory --enable-sign-ext --enable-nontrapping-float-to-int "$WASM" -o "$WASM"
else
  echo "warning: wasm-opt not found; shipping unoptimized wasm-bindgen output" >&2
fi
