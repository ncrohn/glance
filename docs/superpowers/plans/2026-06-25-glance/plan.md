# Glance Implementation Plan (Index)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A lightweight, always-resident macOS Tauri app that opens markdown files in a formatted view via a `mdview <file>` CLI, with a tabbed dual editor (⌘E rendered↔source), smart auto-reload, and explicit ⌘S save.

**Architecture:** Tauri v2. Rust core owns OS concerns (single-instance lock, CLI arg forwarding, file read/write, fs watching, native menu). A vanilla-TS web frontend owns UI + document state (tab manager, markdown-it renderer, CodeMirror 6 source editor). The two communicate via Tauri `invoke` commands and emitted events. Pure logic (document/dirty model, tab dedupe, rendering, reload decisions, CLI path resolution) is unit-tested; UI wiring is manually verified with explicit expected behavior.

**Tech Stack:** Tauri v2, Rust (notify, tauri-plugin-single-instance), TypeScript, Vite, vitest, markdown-it (+ markdown-it-task-lists), highlight.js, CodeMirror 6.

## Global Constraints

- **Platform:** macOS only. No cross-platform handling required or wanted.
- **Package manager:** `pnpm` / `pnpm exec` only. Never `npm`/`npx`.
- **Framework:** Tauri **v2** (not v1). Frontend is vanilla TS — no React/Vue.
- **Markdown flavor:** GFM — tables, task lists, strikethrough, fenced code with syntax highlight.
- **Default view mode:** every doc opens `rendered`. ⌘E toggles `rendered ↔ source`. No split view.
- **Save:** explicit ⌘S only. No autosave. Per-tab dirty dot.
- **Reload policy:** on external file change — clean tab auto-reloads silently; dirty tab prompts (Keep mine / Load disk). Never silently clobber unsaved edits.
- **Single instance:** exactly one Glance process; second `mdview` invocation forwards its path to the running instance and focuses it.
- **Tab dedupe:** keyed by absolute path; opening an already-open path focuses the existing tab.
- **Resolved open questions:** highlighter = `highlight.js`; watcher event carries full file contents; session restore persists open absolute paths in webview `localStorage`.

## Phases

Execute in order. Each phase file is self-contained with its own tasks and TDD steps.

1. [Phase 1 — Frontend logic core](plan-phase-1-frontend-core.md) — scaffold + pure, unit-tested modules (document model, store/tabs, renderer, reload decision). No UI yet.
2. [Phase 2 — Rust core](plan-phase-2-rust-core.md) — read/write commands, file watcher, single-instance + CLI path resolution.
3. [Phase 3 — UI + IPC wiring](plan-phase-3-ui-wiring.md) — DOM tab bar + panes, CodeMirror editor, ⌘E/⌘S, event wiring, conflict prompt, native menu, dark mode.
4. [Phase 4 — Companion polish](plan-phase-4-companion-polish.md) — session restore, `mdview` CLI + install, deleted-file + no-args recent-docs handling.

## Definition of Done (whole project)

- `mdview path/to/file.md` from any directory opens that file, rendered, in a tab in a single resident Glance window — launching the app first if needed.
- A second `mdview` call adds/focuses a tab without spawning a second process.
- ⌘E toggles the active tab between rendered and source; docs open rendered.
- Claude rewriting an open, unedited file updates its tab automatically; with unsaved edits the user is prompted, not clobbered.
- ⌘S persists edits to disk and clears the dirty dot.
- Relaunch restores the previously open tabs.
