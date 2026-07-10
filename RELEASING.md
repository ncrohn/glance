# Releasing Glance

Manual release process (GitHub Actions automation is a future follow-up).

## Prerequisites (one-time)

- Apple **Developer ID Application** certificate in the login keychain.
- Notarization keychain profile `glance-notary` (see `scripts/release.sh` header).
- `gh` CLI authenticated with push access to `ncrohn/glance` and `ncrohn/homebrew-glance`.

## Steps

1. **Bump version** in `package.json` and `src-tauri/tauri.conf.json` (keep them in sync).
2. **Build the signed DMG:**
   ```bash
   bash scripts/release.sh
   ```
   Output: `src-tauri/target/release/bundle/dmg/Glance_<version>_aarch64.dmg` (signed + notarized + stapled).
3. **Compute the checksum:**
   ```bash
   shasum -a 256 src-tauri/target/release/bundle/dmg/Glance_<version>_aarch64.dmg
   ```
4. **Publish the GitHub Release:**
   ```bash
   gh release create v<version> \
     src-tauri/target/release/bundle/dmg/Glance_<version>_aarch64.dmg \
     --title "v<version>" --notes "<release notes>"
   ```
5. **Update the Homebrew cask** in `ncrohn/homebrew-glance`:
   - Bump `version` and `sha256` in `Casks/glance.rb`.
   - Commit and push.
6. **Verify:**
   ```bash
   brew update
   brew upgrade --cask glance   # or: brew install --cask ncrohn/glance/glance
   ```
