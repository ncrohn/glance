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

# Link the CLI into a dir that is BOTH on PATH and writable, so the symlink
# actually resolves and we don't need sudo. Try, in order: the user's dotfiles
# bin, ~/.local/bin, then /usr/local/bin (last resort — may need sudo).
TARGET=""
for d in "$HOME/dev/dotfiles/bin" "$HOME/.local/bin" "/usr/local/bin"; do
  case ":${PATH}:" in *":${d}:"*) ;; *) continue ;; esac  # must be on PATH
  [[ -d "$d" && -w "$d" ]] || continue                    # must be writable
  TARGET="$d/mdview"
  break
done
if [[ -z "$TARGET" ]]; then
  echo "No writable dir on PATH found for mdview. Add ~/.local/bin to PATH and re-run, or symlink bin/mdview manually." >&2
  exit 1
fi
chmod +x bin/mdview
ln -sf "$(pwd)/bin/mdview" "$TARGET"
echo "Linked mdview -> $TARGET"
echo "Done. Try: mdview README.md"
