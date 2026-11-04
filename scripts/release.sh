#!/usr/bin/env bash
# Build a signed + notarized + stapled Glance.app / .dmg for distribution.
#
# One-time prerequisites (yours — they need your private key / Apple credentials):
#   1. Install a "Developer ID Application" certificate into your login keychain
#      (Xcode › Settings › Accounts › Manage Certificates › + Developer ID
#      Application, or download from developer.apple.com).
#   2. Store notarization credentials as a keychain profile, e.g.:
#        xcrun notarytool store-credentials "glance-notary" \
#          --key   AuthKey_XXXX.p8 \
#          --key-id KEY_ID \
#          --issuer ISSUER_UUID
#      (App Store Connect API key — no app password in env. App-specific
#      password works too: --apple-id ... --password ... --team-id 9Q64ABWBCM)
#
#   3. The auto-update signing key at ~/.tauri/glance.key (no password). Its
#      public half is plugins.updater.pubkey in tauri.conf.json; installed copies
#      only accept updates signed by it, so keep a backup.
#
# Then: bash scripts/release.sh   [NOTARY_PROFILE defaults to "glance-notary"]
# Upload the .dmg, the .app.tar.gz and latest.json it prints to the GitHub release.
set -euo pipefail
cd "$(dirname "$0")/.."

NOTARY_PROFILE="${NOTARY_PROFILE:-glance-notary}"
UPDATER_KEY="${UPDATER_KEY:-$HOME/.tauri/glance.key}"

if [[ ! -f "$UPDATER_KEY" ]]; then
  echo "✗ No auto-update signing key at $UPDATER_KEY." >&2
  exit 1
fi

if ! security find-identity -v -p codesigning | grep -q "Developer ID Application"; then
  echo "✗ No 'Developer ID Application' certificate in the keychain." >&2
  echo "  Install one first (see the header of this script)." >&2
  exit 1
fi

echo "Building signed release…"
pnpm install
# Layer the signing overlay on top of the sidecar bundle config. install.sh
# uses only tauri.bundle.conf.json, so the unsigned dev build stays cert-free.
pnpm tauri build \
  --config src-tauri/tauri.bundle.conf.json \
  --config src-tauri/tauri.sign.conf.json

APP="src-tauri/target/release/bundle/macos/Glance.app"
DMG="$(ls -t src-tauri/target/release/bundle/dmg/*.dmg 2>/dev/null | head -1 || true)"
[[ -d "$APP" ]] || { echo "Build did not produce $APP" >&2; exit 1; }
[[ -n "$DMG" ]] || { echo "Build did not produce a .dmg" >&2; exit 1; }

echo "Notarizing $DMG (profile: $NOTARY_PROFILE)…"
xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait

echo "Stapling…"
xcrun stapler staple "$APP"
xcrun stapler staple "$DMG"

echo "Verifying Gatekeeper acceptance…"
spctl -a -vvv -t install "$APP" || true
xcrun stapler validate "$DMG"

# Auto-update bundle: the stapled app, tarred and signed for the updater
# plugin, plus the manifest installed copies read from releases/latest.
VERSION="$(node -p 'require("./src-tauri/tauri.conf.json").version')"
case "$(uname -m)" in
  arm64) ARCH=aarch64 ;;
  x86_64) ARCH=x86_64 ;;
  *) echo "Unknown architecture $(uname -m)" >&2; exit 1 ;;
esac
OUT="src-tauri/target/release/bundle/updater"
TARBALL="Glance_${VERSION}_${ARCH}.app.tar.gz"
rm -rf "$OUT" && mkdir -p "$OUT"
COPYFILE_DISABLE=1 tar -czf "$OUT/$TARBALL" -C "$(dirname "$APP")" Glance.app
pnpm tauri signer sign --private-key-path "$UPDATER_KEY" --password "" --app-version "$VERSION" "$OUT/$TARBALL"
SIG="$(cat "$OUT/$TARBALL.sig")" \
URL="https://github.com/ncrohn/glance/releases/download/v$VERSION/$TARBALL" \
VERSION="$VERSION" TARGET="darwin-$ARCH" \
node -e '
  const { SIG, URL, VERSION, TARGET } = process.env;
  const manifest = {
    version: VERSION,
    pub_date: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    platforms: { [TARGET]: { signature: SIG, url: URL } },
  };
  process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
' > "$OUT/latest.json"

echo "✓ Signed + notarized + stapled: $DMG"
echo "✓ Auto-update files: $OUT/$TARBALL and $OUT/latest.json"
