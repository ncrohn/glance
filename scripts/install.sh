#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Building Glance (release)…"
pnpm install
# The bundle config overlay adds the glance-mcp sidecar (externalBin) and a
# beforeBuildCommand that stages it. Kept out of the base tauri.conf.json so
# everyday `cargo test` / `tauri dev` don't require the sidecar to exist.
pnpm tauri build --config src-tauri/tauri.bundle.conf.json

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
MDVIEW="$BINDIR/mdview"
is_wrapper() { [[ "$(head -c 23 "$1" 2>/dev/null)" == $'#!/bin/sh\n# Glance CLI:' ]]; }
# Same rules as the in-app installer: update a Glance wrapper in place
# (through a dotfiles symlink), replace an old symlink to the app binary
# (writing through it would overwrite the app), leave anything else alone.
not_ours() { echo "$MDVIEW exists and isn't Glance's mdview wrapper; left it alone." >&2; exit 1; }
if [[ -L "$MDVIEW" ]]; then
  if is_wrapper "$MDVIEW"; then DEST="$(realpath "$MDVIEW")"
  elif [[ "$(readlink "$MDVIEW")" == *.app/Contents/MacOS/glance ]]; then DEST="$MDVIEW"
  else not_ours; fi
elif [[ -e "$MDVIEW" ]] && ! is_wrapper "$MDVIEW"; then
  not_ours
else
  DEST="$MDVIEW"
fi
Q_APP="'${APP_BIN//\'/\'\\\'\'}'"
TMP="$(mktemp "$(dirname "$DEST")/.mdview.XXXXXX")"
cat > "$TMP" <<EOF
#!/bin/sh
# Glance CLI: launch/forward to Glance detached so the terminal returns
# immediately even on a cold start (when this invocation becomes the app).
GLANCE_APP=$Q_APP
if [ ! -x "\$GLANCE_APP" ]; then
  echo "mdview: Glance not found at \$GLANCE_APP. Reinstall Glance, then run its AI integration setup again." >&2
  exit 1
fi
"\$GLANCE_APP" "\$@" >/dev/null 2>&1 &
EOF
chmod 755 "$TMP"
mv -f "$TMP" "$DEST"
echo "Installed mdview -> $MDVIEW (launches $APP_BIN)"
case ":${PATH}:" in
  *":${BINDIR}:"*) echo "Done. Try: mdview README.md" ;;
  *) echo "Done. Add ~/.local/bin to your shell PATH, then: mdview README.md" ;;
esac
