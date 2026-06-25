# Glance — macOS Markdown Companion App

**Date:** 2026-06-25
**Status:** Approved design, pre-implementation

## Purpose

A lightweight, always-resident macOS desktop app for viewing and editing markdown
files, defaulting to a formatted (rendered) view. Its primary role is a companion to
a terminal-based Claude Code workflow: Claude creates markdown docs and opens them in
the app via a CLI command (`mdview <file>`) so the user can review them in formatted
form and make edits when needed.

This is a single-user tool for one machine (macOS only). Build effort and weight are
weighed against the fact that the app stays running in the background all day.

## Goals

- Open any markdown file in a formatted view with one command.
- Let Claude open docs it creates without stealing a terminal or requiring manual steps.
- Support real editing sessions (true dual editor), not just viewing.
- Stay out of the way: fast launch, low RAM, single resident instance, many docs as tabs.
- React intelligently when Claude rewrites a file that is currently open.

## Non-Goals (YAGNI)

- No file-tree / sidebar navigation.
- No multi-window mode (single window, tabs only).
- No plugin system.
- No remote storage or sync.
- No WYSIWYG/rich editing — source editing is plain markdown in CodeMirror.
- No PDF/HTML export.
- No split-pane view — formatted↔source is a toggle, not side-by-side.
- Cross-platform support — macOS only by design.

## Tech Stack

**Tauri** (Rust core + web frontend).

Rationale: ~10MB binary, fast launch, low RAM — the right profile for an always-on
companion. The Rust surface needed here is small (single-instance lock, CLI arg
forwarding, fs watching, file read/write, native menu), all covered by mature plugins.
The bulk of the code is the TS/web frontend, which matches the user's daily stack.

Key dependencies:
- Frontend: `markdown-it` (+ GFM plugins: tables, task lists, strikethrough),
  a syntax highlighter for code fences (e.g. `highlight.js` or Shiki), `CodeMirror 6`
  (markdown language mode).
- Rust: `tauri-plugin-single-instance`, `tauri-plugin-fs` (or `notify` crate) for file
  watching, `tauri-plugin-cli` or custom arg parsing.
- Package manager: `pnpm` (and `pnpm exec`).

## Architecture

Three layers:

1. **Rust core** — owns the OS-facing concerns:
   - Single-instance lock: only one Glance process runs.
   - CLI arg forwarding: a second `mdview`/app invocation forwards the file path to the
     already-running instance instead of starting a new process.
   - File system: read file contents, write file contents (on save), watch open files
     for external changes.
   - Native macOS menu (app/file/edit/view menus, standard shortcuts).
   - Emits events to the frontend (e.g. `open-file`, `file-changed-on-disk`).

2. **Web frontend (TS)** — owns the UI and document state:
   - Tab bar + tab manager.
   - Rendered view (markdown-it + GFM).
   - Source view (CodeMirror 6).
   - Per-document state and dirty tracking.
   - Handles Rust events (open new tab, reload, conflict prompt).

3. **`mdview` CLI** — a thin wrapper that launches/forwards to the app.

### Open flow

```
mdview foo.md
   │  (resolve foo.md → absolute path; cwd varies per Claude session)
   ▼
Rust single-instance check
   ├─ app NOT running → launch Glance, then open tab for path
   └─ app running      → forward path to live instance via single-instance IPC,
                          focus window, open/focus tab
```

Path resolution to an absolute path happens before forwarding, because Claude invokes
the CLI from arbitrary working directories.

## Components

### Tab manager (frontend)
- Open, focus, and close tabs.
- **Dedupe:** opening a path that already has a tab focuses the existing tab rather
  than creating a duplicate (keyed by absolute path).
- Tracks per-tab dirty state; shows a dirty dot in the tab.

### Document (per tab)
State held per open tab:
- `absPath` — absolute file path.
- `diskContent` — last-known content on disk.
- `editorContent` — current content in the editor (may differ when dirty).
- `dirty` — `editorContent !== diskContent`.
- `viewMode` — `rendered` (default) or `source`.

### Renderer
- `markdown-it` configured for GFM: tables, task lists, strikethrough.
- Syntax-highlighted code fences.
- Follows macOS light/dark appearance.

### Source editor
- CodeMirror 6 in markdown mode.
- **⌘E** toggles `rendered ↔ source` for the active tab.
- Every tab opens in `rendered` mode by default.

### File watcher (Rust → frontend)
One watcher per open file path; dropped when the tab closes. On an external change
(e.g. Claude rewrites the file):
- If the tab is **clean** → auto-reload silently (update `diskContent` + `editorContent`,
  re-render).
- If the tab is **dirty** → show a non-destructive prompt: **Keep mine** / **Load disk**.

### Saver
- **⌘S** writes `editorContent` to disk, sets `diskContent = editorContent`, clears dirty.
- No autosave.

## Data Flow

```
Disk  ⇄  Rust core (read / write / watch)  ⇄  events + commands  ⇄  Frontend tabs
```

- Read: on open, Rust reads the file and sends contents to the frontend.
- Write: on ⌘S, frontend sends contents to Rust, which writes to disk.
- Watch: Rust watches each open path and emits `file-changed-on-disk` with the new
  contents (or a change signal the frontend reacts to). One watcher per open path,
  released on tab close.

## Edge Cases

- **Same file opened twice** → focus the existing tab (dedupe by absolute path).
- **File deleted on disk while open** → mark the tab (e.g. tab indicator), keep the
  in-memory content, allow ⌘S to recreate the file.
- **App launched with no file args** (Dock / Spotlight) → open an empty window showing a
  recent-docs list.
- **Save conflict** (tab is dirty *and* file changed on disk) → Keep mine / Load disk
  prompt; never silently clobber unsaved edits.
- **Relative path / varying cwd** → CLI resolves to an absolute path before forwarding.

## Defaults

- **Markdown flavor:** GFM.
- **Save:** explicit ⌘S, no autosave; dirty dot per tab.
- **Session restore:** reopen the last set of tabs on relaunch.
- **CLI install:** symlink `mdview` into the user's dotfiles bin and/or `/usr/local/bin`.
- **Appearance:** follow macOS light/dark.

## Success Criteria

- `mdview path/to/file.md` from any directory opens that file, formatted, in a tab in a
  single resident Glance window — launching the app first if needed.
- A second `mdview` call adds/focuses a tab without spawning a second process.
- ⌘E toggles the active tab between rendered and source; docs open rendered.
- When Claude rewrites an open, unedited file, its tab updates automatically; when the
  user has unsaved edits, they are prompted, not clobbered.
- ⌘S persists edits to disk.
- Closing and relaunching the app restores the previously open tabs.

## Open Implementation Questions (resolve during planning)

- Highlighter choice: `highlight.js` (simpler, runtime) vs Shiki (nicer themes, heavier).
- Watcher contents delivery: send full file contents on change vs send a signal and let
  the frontend re-request via Rust read.
- Session-restore storage location (Tauri app data dir vs a small JSON in app config).
