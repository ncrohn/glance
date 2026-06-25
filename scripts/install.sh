#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Building Glance (release)…"
pnpm install
pnpm tauri build

APP_SRC="src-tauri/target/release/bundle/macos/Glance.app"
if [[ ! -d "$APP_SRC" ]]; then
  echo "Build did not produce $APP_SRC" >&2
  exit 1
fi

echo "Installing Glance.app to /Applications…"
rm -rf "/Applications/Glance.app"
cp -R "$APP_SRC" "/Applications/Glance.app"

# Link the `mdview` CLI to the installed app binary. The binary itself resolves
# relative paths and forwards to the running instance, so no wrapper script is
# needed — the symlink IS the CLI. This matches the in-app "Install 'mdview'
# Command Line Tool" menu item; both point at the bundle binary so the CLI is
# independent of this repo and survives app updates.
APP_BIN="/Applications/Glance.app/Contents/MacOS/glance"
BINDIR="$HOME/.local/bin"
mkdir -p "$BINDIR"
ln -sf "$APP_BIN" "$BINDIR/mdview"
echo "Linked mdview -> $BINDIR/mdview -> $APP_BIN"
case ":${PATH}:" in
  *":${BINDIR}:"*) echo "Done. Try: mdview README.md" ;;
  *) echo "Done. Add ~/.local/bin to your shell PATH, then: mdview README.md" ;;
esac
