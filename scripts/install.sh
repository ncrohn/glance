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

# Install the `mdview` CLI as a tiny wrapper that launches the installed app
# binary DETACHED. The binary resolves relative paths and forwards to the running
# instance itself, so the wrapper's only job is backgrounding (`… & `): without
# it, the first `mdview <file>` of a session would become the GUI process and
# block the calling terminal. This matches the in-app "Install 'mdview' Command
# Line Tool" menu item; both target the bundle binary, so the CLI is independent
# of this repo and survives app updates.
APP_BIN="/Applications/Glance.app/Contents/MacOS/glance"
if [[ ! -x "$APP_BIN" ]]; then
  echo "Expected app binary not found at $APP_BIN" >&2
  exit 1
fi
BINDIR="$HOME/.local/bin"
mkdir -p "$BINDIR"
cat > "$BINDIR/mdview" <<EOF
#!/bin/sh
# Glance CLI: launch/forward to Glance detached so the terminal returns
# immediately even on a cold start (when this invocation becomes the app).
"$APP_BIN" "\$@" >/dev/null 2>&1 &
EOF
chmod +x "$BINDIR/mdview"
echo "Installed mdview -> $BINDIR/mdview (launches $APP_BIN)"
case ":${PATH}:" in
  *":${BINDIR}:"*) echo "Done. Try: mdview README.md" ;;
  *) echo "Done. Add ~/.local/bin to your shell PATH, then: mdview README.md" ;;
esac
