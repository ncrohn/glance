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

# Install the `mdview` CLI as a tiny wrapper that opens files in the installed
# app through LaunchServices (`open -n -a … --args`). Running the binary from a
# zellij, tmux or ssh shell can abort before Glance registers with the
# WindowServer; `open` starts it in the login session. The app starts with / as
# its working directory, so the wrapper passes absolute paths. This matches the
# in-app "Install 'mdview' Command Line Tool" menu item (a test keeps the two
# the same); both target the bundle, so the CLI survives app updates.
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
{
cat <<EOF
#!/bin/sh
# Glance CLI: open files in Glance through LaunchServices, so the app
# starts in the login session even from a zellij, tmux or ssh shell.
GLANCE_APP=$Q_APP
EOF
cat <<'EOF'
if [ ! -x "$GLANCE_APP" ]; then
  echo "mdview: Glance not found at $GLANCE_APP. Reinstall Glance, then run its AI integration setup again." >&2
  exit 1
fi
# The app starts with / as its working directory: pass absolute paths.
paths_only=
for a in "$@"; do
  shift
  if [ -z "$paths_only" ] && [ "$a" = -- ]; then
    paths_only=1
  elif [ -n "$a" ] && [ "${a#/}" = "$a" ]; then
    case $a in
      -*) if [ -n "$paths_only" ] || [ -f "$a" ]; then a="${PWD%/}/$a"; fi ;;
      *) a="${PWD%/}/$a" ;;
    esac
  fi
  set -- "$@" "$a"
done
exec '/usr/bin/open' -n -a "${GLANCE_APP%/Contents/MacOS/*}" --args "$@" >/dev/null
EOF
} > "$TMP"
chmod 755 "$TMP"
mv -f "$TMP" "$DEST"
echo "Installed mdview -> $MDVIEW (opens ${APP_BIN%/Contents/MacOS/*})"
case ":${PATH}:" in
  *":${BINDIR}:"*) echo "Done. Try: mdview README.md" ;;
  *) echo "Done. Add ~/.local/bin to your shell PATH, then: mdview README.md" ;;
esac
