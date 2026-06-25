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

# Link the CLI. Prefer the user's dotfiles bin if present, else /usr/local/bin.
DOTBIN="$HOME/dev/dotfiles/bin"
if [[ -d "$DOTBIN" ]]; then
  TARGET="$DOTBIN/mdview"
else
  TARGET="/usr/local/bin/mdview"
fi
chmod +x bin/mdview
ln -sf "$(pwd)/bin/mdview" "$TARGET"
echo "Linked mdview -> $TARGET"
echo "Done. Try: mdview README.md"
