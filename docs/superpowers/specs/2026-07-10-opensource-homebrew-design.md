# Open-source Glance + Homebrew distribution — Design

**Date:** 2026-07-10
**Status:** Approved design → implementation

## Goal

Make Glance an open-source project and installable via Homebrew:

```bash
brew install --cask ncrohn/glance/glance
```

## Decisions

| Question | Decision |
|---|---|
| License | **MIT** (© 2026 Nicholas Crohn) |
| Homebrew path | **Own tap** `ncrohn/homebrew-glance` (graduate to official cask later) |
| Release automation | **Manual now** (`scripts/release.sh` + `gh`), CI later |
| Architecture | **arm64 only** (Apple Silicon) for v1 |
| GitHub ops | Use authenticated **`gh` CLI** (logged in as `ncrohn`) |

## Why a cask, not a formula

Glance is a prebuilt, notarized macOS `.app`. Homebrew ships GUI apps as **casks** (download + verify + drop into `/Applications`). A formula builds a CLI from source — wrong fit. `scripts/release.sh` already signs + notarizes + staples, so a cask install is Gatekeeper-clean.

## Facts

- Main repo remote: `git@github.com:ncrohn/glance.git` → tap must be repo `ncrohn/homebrew-glance`.
- `src-tauri/tauri.sign.conf.json` holds only the signing **identity string** + Team ID `Z8DA4B78K9` — public info, no private key. Safe to open-source. No secrets in the repo.
- Release DMG name: `Glance_<version>_aarch64.dmg` (Tauri output on Apple Silicon).
- Current version: `0.5.1`. App identifier: `fun.sibi.glance`. Annotations stored at `~/.glance/`.
- No `minimumSystemVersion` set → Tauri default (macOS 10.13+). Cask leaves macOS unconstrained; only `arch: :arm64` is required.

## Workstreams

### 1. Open-source hygiene (main repo `ncrohn/glance`)

- Add `LICENSE` — MIT, © 2026 Nicholas Crohn.
- `package.json` → add `"license": "MIT"`.
- README → add a **License** section + Homebrew as the primary install method.
- Make repo public (`gh repo edit --visibility public`).

### 2. First GitHub Release (v0.5.1)

- **User step:** run `scripts/release.sh` (needs the Apple Developer ID cert already in the keychain) → notarized `Glance_0.5.1_aarch64.dmg`.
- Compute `shasum -a 256 <dmg>`.
- `gh release create v0.5.1 <dmg> --title … --notes …`.

### 3. Homebrew tap (new repo `ncrohn/homebrew-glance`)

- `gh repo create ncrohn/homebrew-glance --public`.
- `Casks/glance.rb`:
  - `version "0.5.1"`, `sha256 "<from step 2>"`.
  - `url "https://github.com/ncrohn/glance/releases/download/v#{version}/Glance_#{version}_aarch64.dmg"`.
  - `name`, `desc`, `homepage`.
  - `depends_on arch: :arm64`.
  - `app "Glance.app"`.
  - `livecheck { url :url; strategy :github_latest }` for future version bumps.
  - `zap trash: ["~/.glance", "~/Library/Caches/fun.sibi.glance", "~/Library/Application Support/fun.sibi.glance"]`.
    - **Deliberately does not touch `~/.claude`** — AI integration is removed via the app menu (**Remove AI Integration…**), not by a cask uninstall.
- Tap README with the `brew install --cask ncrohn/glance/glance` one-liner.
- Verify: `brew install --cask ncrohn/glance/glance` locally, then `brew uninstall --cask glance`.

### 4. Release runbook `RELEASING.md` (main repo)

Steps for future releases (seeds the "CI later" path):
1. Bump version in `package.json` + `src-tauri/tauri.conf.json`.
2. `bash scripts/release.sh`.
3. `gh release create vX.Y.Z <dmg>`.
4. Bump `version` + `sha256` in the tap's `Casks/glance.rb`, commit, push.

## Sequencing gate

The cask's `sha256` requires the real notarized DMG. So **build (step 2) must complete before the cask can be finalized**. Plan: write the cask with a placeholder sha256, user builds, then fill the real hash and push the tap.

## Division of labor

| I do (Claude) | User does |
|---|---|
| LICENSE, package.json, README edits, RELEASING.md | Run `scripts/release.sh` (needs Apple private key) |
| Write `Casks/glance.rb` (placeholder → real sha256) | — |
| `gh` repo create / visibility / release upload (authed as ncrohn) | Confirm/approve `gh` write actions |
| Local `brew install --cask` verification | — |

## Out of scope (v1)

- Intel / universal builds.
- GitHub Actions CI signing (secrets-based automation) — follow-up.
- Submitting to the official `homebrew-cask` repo.
- CONTRIBUTING.md / issue templates (add if the project draws contributors).
