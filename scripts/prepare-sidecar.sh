#!/usr/bin/env bash
# Build the glance-mcp binary and stage it as a Tauri sidecar so `tauri build`
# embeds it inside Glance.app. Tauri's externalBin requires the file to be named
# with the target triple suffix; on bundling it copies it into the app's
# Contents/MacOS/ with the suffix stripped, landing next to the GUI binary --
# which is exactly where setup.rs's current_exe().parent().join("glance-mcp")
# looks for it.
set -euo pipefail
cd "$(dirname "$0")/.."

TRIPLE=$(rustc -vV | sed -n 's/host: //p')
if [[ -z "$TRIPLE" ]]; then
  echo "Could not determine host target triple from rustc" >&2
  exit 1
fi

DEST="src-tauri/binaries/glance-mcp-${TRIPLE}"
mkdir -p src-tauri/binaries
# tauri-build validates externalBin existence whenever it sees the bundle config.
# Seed an empty placeholder so building glance-mcp itself can't trip that check,
# then overwrite with the real binary. Also clear TAURI_CONFIG so this nested
# build uses the base (externalBin-free) config regardless of how we were invoked.
[ -f "$DEST" ] || : > "$DEST"

echo "Building glance-mcp (release) for ${TRIPLE}..."
( cd src-tauri && env -u TAURI_CONFIG cargo build --release --bin glance-mcp )

cp "src-tauri/target/release/glance-mcp" "$DEST"
echo "Staged sidecar: $DEST"
