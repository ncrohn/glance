# Open-source Glance + Homebrew Distribution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open-source Glance under MIT and make it installable via `brew install --cask ncrohn/glance/glance` from an own tap.

**Architecture:** Add MIT license + docs to the main repo (`ncrohn/glance`), publish a notarized DMG as a GitHub Release, and create a separate Homebrew tap repo (`ncrohn/homebrew-glance`) whose cask downloads that DMG. Release build stays manual (`scripts/release.sh`); GitHub Actions CI is a later follow-up.

**Tech Stack:** Tauri 2 (existing app), Homebrew Cask (Ruby DSL), `gh` CLI, `shasum`, Apple `notarytool` (already wired in `scripts/release.sh`).

## Global Constraints

- License: **MIT**, © 2026 Nicholas Crohn — verbatim in `LICENSE`.
- Version being shipped: **0.5.1** (matches `package.json`).
- Architecture: **arm64 only** — cask must carry `depends_on arch: :arm64`.
- Main repo: `ncrohn/glance`. Tap repo: `ncrohn/homebrew-glance` (Homebrew requires the `homebrew-` prefix).
- DMG artifact name: `Glance_<version>_aarch64.dmg`.
- App identifier: `com.escapementlabs.glance` (changed from the old `fun.sibi.glance`). App bundle: `Glance.app`. Data dir: `~/.glance`.
- `gh` is authenticated as `ncrohn` — use it for repo create / visibility / release.
- Cask `zap` must **not** remove `~/.claude*` — AI integration is uninstalled via the app menu.
- Commit format: subject line + `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: MIT license + README/package metadata

**Files:**
- Create: `LICENSE`
- Modify: `package.json` (add `"license"` field)
- Modify: `README.md` (add Homebrew install + License section)
- Modify: `src-tauri/tauri.conf.json:5` (bundle identifier)

**Interfaces:**
- Produces: `LICENSE` file at repo root (referenced by cask/README and GitHub license detection).
- Produces: corrected bundle identifier `com.escapementlabs.glance` (consumed by the cask `zap` paths in Task 6, and by the v0.5.1 build in Task 4).

- [ ] **Step 1: Write `LICENSE`**

```
MIT License

Copyright (c) 2026 Nicholas Crohn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 2: Add `license` to `package.json`**

Add a top-level `"license": "MIT"` field (next to `"version"`). Example region:

```json
  "name": "glance",
  "version": "0.5.1",
  "license": "MIT",
```

- [ ] **Step 3: Add Homebrew install to `README.md`**

Insert a new subsection as the **first** option under `## Install`, before "### On any Mac (recommended)":

```markdown
### Homebrew (recommended)

```bash
brew install --cask ncrohn/glance/glance
```

Apple Silicon only. Installs the notarized `Glance.app` into `/Applications`. Then open Glance and run **Glance ▸ Set up AI Integration…** to wire up the `mdview` CLI and Claude/Cursor integration.
```

- [ ] **Step 4: Add a License section to `README.md`**

Append at the end of `README.md`:

```markdown
## License

[MIT](LICENSE) © 2026 Nicholas Crohn
```

- [ ] **Step 5: Fix the bundle identifier**

Edit `src-tauri/tauri.conf.json` line 5:

```json
  "identifier": "com.escapementlabs.glance",
```

(Was `fun.sibi.glance` — reassigned to Escapement Labs. Confirm no other source references remain: `grep -rn "fun.sibi.glance" src-tauri src` returns nothing.)

- [ ] **Step 6: Type-check + Rust build still parse config**

Run: `pnpm exec tsc --noEmit && (cd src-tauri && cargo check)`
Expected: PASS (confirms `package.json` and `tauri.conf.json` edits did not break tooling).

- [ ] **Step 7: Commit**

```bash
git add LICENSE package.json README.md src-tauri/tauri.conf.json
git commit -m "$(cat <<'EOF'
docs: add MIT license and Homebrew install instructions

Also reassign the bundle identifier to com.escapementlabs.glance.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Release runbook

**Files:**
- Create: `RELEASING.md`

**Interfaces:**
- Produces: `RELEASING.md` documenting the manual release loop (referenced by future version bumps).

- [ ] **Step 1: Write `RELEASING.md`**

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add RELEASING.md
git commit -m "$(cat <<'EOF'
docs: add manual release runbook

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Merge branch and make main repo public

**Files:** none (git + GitHub operations)

**Interfaces:**
- Consumes: commits from Tasks 1–2 on branch `opensource-homebrew`.
- Produces: public repo `ncrohn/glance` with license/docs on `main`.

- [ ] **Step 1: Push the branch and open a PR**

```bash
git push -u origin opensource-homebrew
gh pr create --title "Open-source: MIT license + Homebrew docs" \
  --body "Adds MIT LICENSE, Homebrew install instructions, and release runbook. Precursor to publishing the repo and Homebrew tap."
```

- [ ] **Step 2: Merge the PR**

```bash
gh pr merge --squash --delete-branch
```
Expected: PR merged into `main`.

- [ ] **Step 3: Make the repo public**

```bash
gh repo edit ncrohn/glance --visibility public --accept-visibility-change-consequences
```

- [ ] **Step 4: Verify**

```bash
gh repo view ncrohn/glance --json visibility,licenseInfo
```
Expected: `"visibility": "PUBLIC"` and license detected as MIT.

---

### Task 4: Build the notarized release DMG (USER-DRIVEN)

**Files:**
- Produces artifact: `src-tauri/target/release/bundle/dmg/Glance_0.5.1_aarch64.dmg`

**Interfaces:**
- Produces: the DMG path + its `sha256` (consumed by Tasks 5 and 6).

> This task needs the Apple private key in the user's keychain. The agent cannot produce the signature; **the user runs the build**. The agent may prepare and then wait.

- [ ] **Step 1: User runs the signed release build**

```bash
bash scripts/release.sh
```
Expected tail output: `✓ Signed + notarized + stapled: …/Glance_0.5.1_aarch64.dmg`

- [ ] **Step 2: Confirm the artifact exists and capture the checksum**

```bash
ls -la src-tauri/target/release/bundle/dmg/Glance_0.5.1_aarch64.dmg
shasum -a 256 src-tauri/target/release/bundle/dmg/Glance_0.5.1_aarch64.dmg
```
Expected: file exists; record the 64-hex `sha256` for Task 6.

---

### Task 5: Publish the GitHub Release v0.5.1

**Files:** none (GitHub operation)

**Interfaces:**
- Consumes: DMG from Task 4.
- Produces: release asset URL `https://github.com/ncrohn/glance/releases/download/v0.5.1/Glance_0.5.1_aarch64.dmg` (consumed by the cask `url`).

- [ ] **Step 1: Create the release with the DMG attached**

```bash
gh release create v0.5.1 \
  src-tauri/target/release/bundle/dmg/Glance_0.5.1_aarch64.dmg \
  --repo ncrohn/glance \
  --title "v0.5.1" \
  --notes "First public release. Install via \`brew install --cask ncrohn/glance/glance\` (Apple Silicon)."
```

- [ ] **Step 2: Verify the asset is downloadable**

```bash
gh release view v0.5.1 --repo ncrohn/glance --json assets --jq '.assets[].name'
```
Expected: `Glance_0.5.1_aarch64.dmg`

---

### Task 6: Create the Homebrew tap with the cask

**Files:**
- Create (in new repo `ncrohn/homebrew-glance`): `Casks/glance.rb`
- Create: `README.md` (tap repo)

**Interfaces:**
- Consumes: `sha256` from Task 4, release URL from Task 5.
- Produces: installable cask `ncrohn/glance/glance`.

- [ ] **Step 1: Create the tap repo and clone it into the scratch area**

```bash
gh repo create ncrohn/homebrew-glance --public \
  --description "Homebrew tap for Glance — a lightweight macOS markdown viewer/editor"
git clone git@github.com:ncrohn/homebrew-glance.git /tmp/homebrew-glance
mkdir -p /tmp/homebrew-glance/Casks
```

- [ ] **Step 2: Write `Casks/glance.rb`**

Replace `REPLACE_WITH_SHA256_FROM_TASK_4` with the real checksum captured in Task 4.

```ruby
cask "glance" do
  version "0.5.1"
  sha256 "REPLACE_WITH_SHA256_FROM_TASK_4"

  url "https://github.com/ncrohn/glance/releases/download/v#{version}/Glance_#{version}_aarch64.dmg",
      verified: "github.com/ncrohn/glance/"
  name "Glance"
  desc "Lightweight macOS markdown viewer and editor"
  homepage "https://github.com/ncrohn/glance"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on arch: :arm64

  app "Glance.app"

  zap trash: [
    "~/.glance",
    "~/Library/Caches/com.escapementlabs.glance",
    "~/Library/Application Support/com.escapementlabs.glance",
  ]
end
```

- [ ] **Step 3: Write the tap `README.md`**

```markdown
# Homebrew Glance

Homebrew tap for [Glance](https://github.com/ncrohn/glance), a lightweight macOS markdown viewer and editor.

```bash
brew install --cask ncrohn/glance/glance
```

Apple Silicon only. After install, open Glance and run **Glance ▸ Set up AI Integration…**.
```

- [ ] **Step 4: Lint the cask with Homebrew's own checks**

```bash
cd /tmp/homebrew-glance
brew style ./Casks/glance.rb
brew audit --cask --new ./Casks/glance.rb
```
Expected: `brew style` passes; `brew audit` reports no errors (network warnings about the URL are acceptable only if the release from Task 5 is live — it should be).

- [ ] **Step 5: Commit and push the tap**

```bash
cd /tmp/homebrew-glance
git add Casks/glance.rb README.md
git commit -m "$(cat <<'EOF'
feat: add glance cask v0.5.1

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
git push origin HEAD
```

---

### Task 7: End-to-end install verification

**Files:** none (verification only)

**Interfaces:**
- Consumes: published tap (Task 6) + release (Task 5).

- [ ] **Step 1: Install from the tap (uninstall any dev copy first)**

```bash
brew install --cask ncrohn/glance/glance
```
Expected: downloads `Glance_0.5.1_aarch64.dmg`, checksum matches, `Glance.app` installed to `/Applications`.

> Note: if a hand-built `Glance.app` from `scripts/install.sh` already sits in `/Applications`, Homebrew may refuse to overwrite it. Remove it first (`rm -rf /Applications/Glance.app`) or expect a "It seems there is already an App at …" message — then re-run.

- [ ] **Step 2: Confirm the app launches and is Gatekeeper-clean**

```bash
spctl -a -vvv -t install /Applications/Glance.app
open -a Glance
```
Expected: `accepted` / `source=Notarized Developer ID`; app window opens.

- [ ] **Step 3: Confirm clean uninstall (optional)**

```bash
brew uninstall --cask glance
```
Expected: `Glance.app` removed. (`brew uninstall --zap` also clears `~/.glance` but leaves `~/.claude*` untouched.)

---

## Self-Review

**Spec coverage:**
- License (MIT) → Task 1. ✓
- README Homebrew + License → Task 1. ✓
- Repo public → Task 3. ✓
- First GitHub Release v0.5.1 → Tasks 4–5. ✓
- Homebrew tap + cask (arm64, livecheck, zap excluding ~/.claude) → Task 6. ✓
- Release runbook → Task 2. ✓
- Sequencing gate (sha256 needs real DMG) → Task 4 before Task 6, placeholder called out. ✓
- Division of labor (user builds, agent writes/gh) → Task 4 flagged USER-DRIVEN. ✓

**Placeholder scan:** Only intentional placeholder is `REPLACE_WITH_SHA256_FROM_TASK_4`, resolved in Task 6 Step 2 from Task 4's output. No other TBDs.

**Type consistency:** Bundle identifier (`com.escapementlabs.glance` — updated in Task 1, referenced in Task 6 zap), DMG name (`Glance_0.5.1_aarch64.dmg`), tap name (`ncrohn/homebrew-glance`), install command (`ncrohn/glance/glance`) consistent across all tasks and the spec.
