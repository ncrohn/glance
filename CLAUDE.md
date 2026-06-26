# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Glance is a macOS markdown viewer/editor built with **Tauri 2** (Rust backend + vanilla TypeScript frontend, no UI framework). The CLI entry point is `mdview <path>`, which opens files as tabs in a single reused window.

## Commands

```bash
pnpm install                 # install JS deps (pnpm only — see packageManager pin)
pnpm tauri dev               # run app with hot reload
pnpm test                    # frontend unit tests (vitest)
pnpm test:watch              # vitest watch mode
pnpm exec vitest run src/store.test.ts   # single test file
pnpm exec tsc --noEmit       # TypeScript type check
pnpm build                   # production JS build (tsc + vite)
cd src-tauri && cargo test   # Rust unit tests (CLI path resolution, anchor, annotations, setup)
cd src-tauri && cargo test --bin glance-mcp   # MCP server unit tests (view/resolve logic)
bash scripts/install.sh      # release build → copy Glance.app to /Applications + install mdview wrapper
```

## Architecture

Two halves talk only over Tauri's IPC (`invoke` for commands, `emit`/`listen` for events). The TS wrapper for every IPC call lives in `src/ipc.ts` — add new commands/events there, never call `invoke`/`listen` from elsewhere.

### Frontend (`src/`)

Pure-reducer pattern. `app.ts` holds a single `State` and fully re-renders the DOM on every change (`render()` → `renderTabBar`/`renderActions`/`renderContent`). The logic modules are pure and unit-tested in isolation; `app.ts` is the only side-effectful glue:

- `store.ts` — `State` reducers (`openDoc`, `closeDoc`, `toggleViewMode`, `applyDiskChange`, `markSaved`, …). Each returns a new state; never mutate. A `Doc`'s `id` is its `absPath`, so opening a duplicate path dedupes/focuses.
- `document.ts` — `Doc` shape; `isDirty` = `editorContent !== diskContent`.
- `reload.ts` — clean tab → `auto-reload`, dirty tab → `prompt`.
- `session.ts` — open-paths / recent-files lists (persisted to `localStorage`).
- `renderer.ts` — markdown-it + highlight.js (`html: false`).
- `editor.ts` — CodeMirror 6 source editor; theme reads CSS custom properties so it tracks light/dark.
- `annotations.ts` — `Annotation`/`Resolution` types and pure list reducers (`addAnnotation`, `resolveAnnotation`, `removeAnnotation`).
- `build-anchor.ts` / `anchor-capture.ts` — capture the user's text selection (quote + prefix/suffix context + source-line hint) for storage. Anchor _resolution_ (quote → current line numbers) always happens in Rust; TS only captures and renders.
- `annotation-ui.ts` — renders the annotation rail (open / orphaned / resolved sections with line badges), applies in-view highlights to annotated source lines, and mounts the floating "Comment" button that appears on text selection.

### Backend (`src-tauri/src/`)

- `lib.rs` — `run()`: registers the `tauri-plugin-single-instance` handler, builds the native macOS menu (incl. "Set up Claude Integration…"), and seeds first-launch CLI args.
- `commands.rs` — `read_file` / `write_file`.
- `watcher.rs` — `notify`-based per-path file watching; emits `file-changed` (Modify/Create) and `file-removed` (Remove).
- `cli.rs` — `md_paths_from_argv` (drops flags), `to_abs`/`normalize` (resolve relative paths against cwd). Pure, with the Rust tests.
- `cli_install.rs` — writes the `~/.local/bin/mdview` wrapper.
- `anchor.rs` — pure fuzzy anchor resolution. Given a stored `Annotation` (quote + prefix/suffix context + line hint), `resolve_anchor` tries in order: exact prefix+quote+suffix match → unique or nearest quote → line-hint fallback → orphan. Returns a `Resolution` (`startLine`/`endLine` or `None` when orphaned). Shared by the GUI (via IPC) and `glance-mcp`; no I/O.
- `annotations.rs` — on-disk annotation store at `~/.glance/annotations/<sha1(absPath)>.json`. Provides `read_store`/`write_store` plus the Tauri IPC commands `read_annotations`, `write_annotations`, `resolve_anchors`, `annotation_store_path`, and `ensure_annotation_store`.
- `setup.rs` — the one-click "Set up Claude Integration…" action: installs `mdview`, merges `glance-mcp` into `~/.claude.json` (preserving existing keys), idempotently appends review guidance to `~/.claude/CLAUDE.md`, writes the `glance` agent skill to `~/.claude/skills/glance/SKILL.md`, and installs `open-md-hook.sh` in the same directory plus a `PostToolUse`/`Write` entry in `~/.claude/settings.json` (the auto-open hook).
- `bin/glance-mcp.rs` — standalone stdio MCP server (second `[[bin]]` target, bundled inside `Glance.app`). Spawned by Claude Code as a subprocess. v1 tools: `list_annotations`, `get_annotation`, `resolve_annotation`; resource template `glance://annotations/{path}`. Re-anchors every annotation against the current file bytes on each read (`view_of` calls `resolve_anchor`).

### Key flows

- **Open a file.** Two paths into the same `open-file` handling:
  - *First launch:* `lib.rs` stores resolved args in `LaunchArgs`; the frontend drains them once via `take_launch_args` in `start()`.
  - *Subsequent `mdview` calls:* the single-instance plugin receives `argv`/`cwd`, resolves paths, and `emit`s `open-file` to the already-running window.
- **Auto-reload.** Opening a doc calls `watch_file`. On `file-changed`, the frontend first checks `editorContent === contents` to swallow the **echo from our own save**, then clean tabs reload silently and dirty tabs prompt Keep-mine/Load-disk.
- **mdview wrapper** launches the binary inside the installed `Glance.app` **detached** (`… "$@" &`) — without backgrounding, the first invocation of a session would *become* the GUI process and block the terminal. It targets `current_exe()`, so it survives app updates and doesn't depend on this checkout.

## Conventions

- ⌘E (toggle source/rendered) and ⌘S (save) are handled as in-window keydown listeners in `app.ts`, not menu items. Save is explicit — there is no autosave.
- Keep IPC wrappers in `ipc.ts` and logic modules pure so they stay unit-testable; the reducer style (new state, no mutation) is load-bearing for the full-rerender model.
