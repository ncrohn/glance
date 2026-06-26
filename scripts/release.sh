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
# Then: bash scripts/release.sh   [NOTARY_PROFILE defaults to "glance-notary"]
set -euo pipefail
cd "$(dirname "$0")/.."

NOTARY_PROFILE="${NOTARY_PROFILE:-glance-notary}"

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

echo "✓ Signed + notarized + stapled: $DMG"
