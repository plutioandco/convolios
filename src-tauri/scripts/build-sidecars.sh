#!/usr/bin/env bash
# Compile the Go sidecars and lay them out where Tauri's `externalBin`
# expects to find them.
#
# Tauri looks for `binaries/<name>-<target-triple>` at build time. We also
# symlink the binary into the per-sidecar folder (`sidecars/<name>/<name>`)
# so `cargo run` / `tauri dev` — which does NOT consult externalBin — can
# still find it via the in-crate dev fallback in on_device/rpc.rs.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v go >/dev/null 2>&1; then
  echo "build-sidecars: Go is not installed. Install with 'brew install go' and retry." >&2
  exit 1
fi

# Pick up the Rust target triple. In `tauri build` this is set via --target
# or inferred; we mirror the same discovery so externalBin lookups match.
if [[ -n "${TAURI_ENV_TARGET_TRIPLE:-}" ]]; then
  TRIPLE="$TAURI_ENV_TARGET_TRIPLE"
elif command -v rustc >/dev/null 2>&1; then
  TRIPLE="$(rustc -vV | awk '/^host:/ {print $2}')"
else
  echo "build-sidecars: neither TAURI_ENV_TARGET_TRIPLE nor rustc available" >&2
  exit 1
fi

mkdir -p binaries

for NAME in meta-bridge; do
  SRC="sidecars/$NAME"
  if [[ ! -d "$SRC" ]]; then
    echo "build-sidecars: skipping $NAME — $SRC does not exist" >&2
    continue
  fi

  (
    cd "$SRC"
    go build -trimpath -ldflags="-s -w" -o "$NAME" .
  )

  # Tauri externalBin destination.
  cp "$SRC/$NAME" "binaries/$NAME-$TRIPLE"
  echo "build-sidecars: built binaries/$NAME-$TRIPLE"
done
