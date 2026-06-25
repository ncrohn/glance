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

# Link the CLI into a dir that is actually on PATH. Prefer the user's dotfiles
# bin, but only if it's on PATH (a dir that exists but isn't on PATH would leave
# mdview uncallable); otherwise fall back to /usr/local/bin.
DOTBIN="$HOME/dev/dotfiles/bin"
case ":${PATH}:" in
  *":${DOTBIN}:"*) TARGET="$DOTBIN/mdview" ;;
  *)               TARGET="/usr/local/bin/mdview" ;;
esac
chmod +x bin/mdview
ln -sf "$(pwd)/bin/mdview" "$TARGET"
echo "Linked mdview -> $TARGET"
echo "Done. Try: mdview README.md"
