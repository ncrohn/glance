# Glance

A lightweight macOS markdown viewer and editor. Defaults to formatted view. Designed as a companion to terminal-based workflows — Claude Code can open any markdown file it creates with `mdview <path>` for immediate review.

## Features

- **Tabbed single window** — every `mdview <file>` call opens in the same window; duplicate paths are deduped.
- **Rendered ↔ source toggle** — `⌘E` switches between formatted view and a CodeMirror editor.
- **GFM rendering** — GitHub Flavored Markdown with syntax-highlighted code blocks (highlight.js).
- **Explicit save** — `⌘S` writes the file and clears the dirty dot. No autosave.
- **Smart auto-reload** — when a file changes on disk, clean tabs refresh silently; dirty tabs prompt "Keep mine / Load disk".
- **Single-instance** — `mdview` reuses the running Glance window; no duplicate processes.
- **Session restore** — open tabs are saved at quit and restored on next launch.
- **Deleted-file marker** — tabs whose files have been removed are marked visually.
- **macOS light/dark** — follows the system appearance.
- **Native macOS menu** — app (Glance) and Edit menus with the standard editing shortcuts (undo/redo, cut/copy/paste/select-all) and Quit. App actions (⌘E toggle, ⌘S save) are handled in-window via keyboard shortcuts.

## Install

**Requirements:** Rust toolchain (stable), pnpm.

```bash
bash scripts/install.sh
```

This builds Glance in release mode, copies `Glance.app` to `/Applications`, and symlinks the `mdview` CLI to `~/dev/dotfiles/bin/mdview` (or `/usr/local/bin/mdview` if that directory is absent).

## Usage

```bash
mdview path/to/file.md        # open a file (relative or absolute path)
mdview                        # open Glance with no file
```

Relative paths are resolved against the working directory before being forwarded to the app, so `mdview` works correctly from any directory.

If Glance is already running, the file is added as a new tab in the existing window. If the same path is already open, that tab is focused.

## For Claude Code

Claude can open any markdown doc it creates with `mdview` for immediate review:

```bash
mdview /absolute/path/to/file.md
```

- Works from any working directory (paths are resolved before forwarding).
- Reuses the running Glance window — no new app launches.
- Auto-refreshes when Claude rewrites the file (clean tabs update silently).

Optionally, add this line to your `~/.claude/CLAUDE.md` so Claude prefers `mdview` for surfacing markdown:

```
When creating or updating a markdown file that the user should review, open it with `mdview <absolute-path>`.
```

## Development

```bash
pnpm install            # install JS dependencies
pnpm tauri dev          # run in dev mode (hot reload)
pnpm test               # frontend unit tests (vitest)
cd src-tauri && cargo test   # Rust unit tests (CLI path resolution)
pnpm build              # production JS build
pnpm exec tsc --noEmit  # TypeScript type check
```

Tests: 5 frontend suites (22 tests) + 4 Rust CLI tests.
