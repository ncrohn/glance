# Glance ↔ Claude Annotation Integration — Design

**Date:** 2026-06-25
**Status:** Approved design, ready for implementation planning
**Scope:** v1 = user→Claude annotation review loop + one-click Claude integration setup. Claude→user highlighting deferred to v2.

## Goal

Let a Claude session and Glance share a markdown document so that:

1. **Auto-open (A):** when Claude creates/updates a markdown file the user should review, it opens the file in Glance with `mdview`.
2. **Annotation review loop (B):** the user highlights sections in Glance and attaches notes ("tighten this", "this contradicts the intro"). Claude reads those notes as **concrete, current line/section references** via an MCP server — instead of the user describing in prose what to change — acts on them, and marks them resolved.

The whole thing must be set up from **within the app** with one action, and work on **any machine** (no Node/pnpm/runtime assumptions).

## Non-goals (v1)

- Claude **writing** annotations or highlighting regions for the user (Claude→user direction) — deferred to v2. The data model and watcher reserve room for it (`author: claude`, live store watching) but no write tools ship in v1.
- Multi-user / shared-network annotations. Store is local per-machine.
- Annotation persistence across machines / sync.

## Architecture

```
┌──────────────┐   selects text + comment    ┌─────────────────────┐
│   You (GUI)  │ ──────────────────────────▶ │  Glance (Tauri app) │
└──────────────┘                             │  - annotation UI     │
                                             │  - watches store     │
                                             └──────────┬───────────┘
                                                        │ read/write (IPC → Rust)
                                                        ▼
                                          ┌──────────────────────────┐
                                          │  Annotation store (disk)  │
                                          │  ~/.glance/annotations/   │
                                          │     <sha1(absPath)>.json  │
                                          └──────────┬────────────────┘
                                                     │ read/write
                                                     ▼
                                          ┌──────────────────────────┐
       Claude session  ◀── MCP tools ───▶ │  glance-mcp (Rust bin)   │
                                          │  bundled in Glance.app    │
                                          └──────────────────────────┘
```

**Core principle: decouple storage from transport.**

- Annotations persist as JSON on disk, one file per document, keyed by `sha1(absolutePath)`.
- **Glance** owns the UI and reuses its existing `notify` watcher to pick up store changes live (also lays groundwork for v2's Claude-written anchors appearing without restart).
- **glance-mcp** is a standalone **stdio MCP server**, a native Rust binary bundled inside `Glance.app`, that Claude spawns. It only touches the JSON store, so it works whether or not Glance is running and needs no network server in the GUI app.
- The store file is the sync point; the watcher is the live channel.

This honors "MCP as the transport" (Claude's interface is MCP tools) while keeping the GUI app free of an embedded server.

### Why a native Rust binary (not TypeScript)

A TS MCP server requires Node and installed dependencies on every target machine — unacceptable for the "works on various machines" constraint. Instead:

- `glance-mcp` is a second `[[bin]]` in `src-tauri`, compiled to a self-contained native binary and **bundled inside `Glance.app`** next to the main binary. Zero runtime deps.
- The **anchor resolution logic lives in Rust** (`anchor.rs` inside `glance_lib`), shared by both the GUI (via an IPC command) and the MCP binary directly — single source of truth, written and tested once.
- JavaScript keeps only the DOM-selection → quote/prefix/suffix **capture** at create time (it needs the DOM). All **resolution** (stored annotation + current document bytes → current line range or orphan) is Rust.

## Data model

Store file: `~/.glance/annotations/<sha1(absPath)>.json`

```jsonc
{
  "docPath": "/Users/me/notes.md",
  "annotations": [
    {
      "id": "a1b2c3",              // stable, generated on create
      "quote": "Defaults to formatted view.",  // exact selected text
      "prefix": "markdown viewer. ",            // ~32 chars before the quote
      "suffix": " Designed as a companion",     // ~32 chars after the quote
      "lineHint": { "start": 3, "end": 3 },     // source line range at create time
      "note": "tighten this sentence",          // the user's comment
      "status": "open",            // open | resolved | orphaned
      "author": "user",            // user | claude  (claude reserved for v2)
      "createdAt": "2026-06-25T12:34:56Z"
    }
  ]
}
```

Notes:
- `id` is generated on create (stable across edits) — a short random/uuid string.
- `status: resolved` is set by Claude (via MCP) or the user. `orphaned` is computed at resolution time, persisted back so the rail can list it.
- `drifted` is a transient resolution result (quote gone, fell back to line hint) surfaced in the UI but not necessarily a stored status — see anchoring.

## Anchoring (the heart of the system)

Annotations must survive Claude rewriting the file wholesale, so anchors do **not** depend on line stability. Quote + context + line hint, resolved on every load/reload and on every MCP read.

Resolution algorithm, given the annotation and the document's current text:

1. **Exact match** — find `prefix + quote + suffix` in current text → re-anchor, recompute line range. Survives edits elsewhere in the doc.
2. **Quote-only fallback** — if surrounding context shifted, search for `quote` alone. If unique → re-anchor. If multiple matches → use `lineHint` to pick the nearest occurrence.
3. **Line-hint fallback** — quote not found but the line range still exists → anchor to `lineHint`, flag result as `drifted` (shown visually distinct; the user/Claude is warned the anchor is approximate).
4. **Orphaned** — none of the above → `status: orphaned`. Shown in the sidebar rail only (no inline anchor). User can delete or re-point.

This is the GitHub / Hypothes.is fuzzy-anchor model.

**Implementation:** a pure Rust module `anchor.rs` in `glance_lib`.
- Input: `current_text: &str`, `annotation`.
- Output: `Resolved { start_line, end_line, kind: Exact | QuoteOnly | Drifted } | Orphaned`.
- No I/O, no globals — fully unit-testable against synthetic Claude rewrites.
- Consumed by: the GUI (IPC command `resolve_anchors(text, annotations) -> [resolved]`) and `glance-mcp` (direct function call).

This module gets the heaviest test coverage in the project because the risk concentrates here.

## MCP tool surface (glance-mcp, v1)

v1 is read-focused — the user authors annotations, Claude consumes them.

| Tool | Args | Returns |
|---|---|---|
| `list_annotations` | `path`, `status?` (default `open`) | array of `{id, note, quote, lineStart, lineEnd, status, kind}` with line numbers resolved against the **current** file |
| `get_annotation` | `path`, `id` | one annotation plus surrounding context lines from the current file |
| `resolve_annotation` | `path`, `id` | marks `status: resolved`; returns updated annotation |

Plus an MCP **resource** `glance://annotations/{path}` returning the whole open-annotation set, so Claude can pull it as context without an explicit tool call.

**Re-anchoring on read:** before returning, `glance-mcp` runs the shared `anchor.rs` resolution against the document's current bytes, so the line numbers Claude sees are always current — never stale stored values.

**Write tools (`add_annotation`, highlight) are deferred to v2** (Claude→user direction). In v1, Claude is read + resolve only.

### Typical loop

1. You select a sentence in Glance, type "this contradicts the intro" → stored to `~/.glance/annotations/<hash>.json`.
2. In the Claude session: `list_annotations(path)` → Claude sees `{lineStart: 3, lineEnd: 3, note: "this contradicts the intro", quote: "..."}`.
3. Claude edits those exact lines, calls `resolve_annotation(path, id)`.
4. Glance's watcher sees the store change → the annotation's dot turns resolved in the rail.

## Glance UI

**Creating (rendered view):**
- Select text → a small floating "Comment" button appears near the selection → click → inline note input → save.
- Capture `quote`, `prefix` (~32 chars before), `suffix` (~32 chars after) from the DOM `Selection`.
- Capture `lineHint` by mapping the selection back to source offsets. The renderer stamps `data-line` attributes on block-level elements (markdown-it exposes source line maps via `token.map`); the selected DOM range's nearest block(s) yield the source line range.

**Viewing:**
- Annotated ranges get a highlight underlay in the rendered view; hovering shows the note.
- A right-margin **annotations rail** lists all notes for the doc, grouped open / resolved / orphaned, click-to-scroll. Orphaned annotations live here only (no inline anchor).
- The tab gets an annotation-count badge.

**State & wiring:**
- Annotations are a new slice in `State`, loaded per-doc when a doc is opened, kept in memory.
- New **pure reducers** in `src/annotations.ts` (`setAnnotations`, `addAnnotation`, `resolveAnnotation`, `removeAnnotation`) mirroring the existing `Doc` reducer style (new state, no mutation — load-bearing for the full-rerender model).
- New IPC pair `read_annotations(path)` / `write_annotations(path, data)` → Rust commands reading/writing the store JSON.
- New IPC command `resolve_anchors(path|text, annotations)` → Rust, calling `anchor.rs`, used during render to place highlights.
- The existing `notify` watcher gains the store-file path so external changes (Claude's `resolve_annotation`) reflect live in the rail.

## Files & changes

**New (frontend):**
- `src/anchor-capture.ts` — DOM selection → `{quote, prefix, suffix, lineHint}` (capture only; resolution is Rust).
- `src/annotations.ts` — store slice + pure reducers.
- `src/annotation-ui.ts` — selection toolbar, inline note input, annotations rail rendering, highlight underlay.

**Changed (frontend):**
- `src/renderer.ts` — stamp `data-line` on block elements from markdown-it `token.map`.
- `src/app.ts` — load annotations on open, wire rail/highlights into the render path, handle resolve events from the watcher.
- `src/ipc.ts` — wrappers for `read_annotations`, `write_annotations`, `resolve_anchors`, and the annotation store-change event.
- `src/store.ts` / `src/document.ts` — extend `Doc`/`State` with the annotations slice.

**New (Rust):**
- `src-tauri/src/anchor.rs` — pure anchor resolution (the heart), in `glance_lib`.
- `src-tauri/src/annotations.rs` — store read/write commands + store path derivation (`~/.glance/annotations/<sha1(path)>.json`).
- `src-tauri/src/bin/glance_mcp.rs` (or a second `[[bin]]`) — the stdio MCP server using `anchor.rs` + the store. Uses the official Rust MCP SDK (`rmcp`) or a minimal stdio JSON-RPC implementation if that proves lighter.
- Extend `src-tauri/src/cli_install.rs` (or a new `setup.rs`) with the one-click integration setup.

**Changed (Rust):**
- `src-tauri/src/lib.rs` — register new commands; add a "Set up Claude Integration" menu item.
- `src-tauri/src/watcher.rs` — already generic; the frontend just also watches the store path.
- `src-tauri/Cargo.toml` — add the `[[bin]]` for `glance-mcp`, `sha1`/`sha2`, and MCP SDK deps.

## One-click setup from the app

Existing menu gains **"Set up Claude Integration"** (the current "Install 'mdview' Command Line Tool" item is folded into or sits beside it). On click, on any machine, it performs and individually reports:

1. **Install `mdview` wrapper** — today's behavior (detached launcher pointing at `current_exe()`).
2. **Register `glance-mcp`** into the user's Claude config, pointing at the bundled binary via `current_exe()`'s sibling path inside `Glance.app` — correct wherever the app is installed. Reuses the existing `AppTranslocation` guard in `cli_install.rs` (refuse from a quarantined copy, tell user to move to /Applications). Mechanism: prefer the `claude mcp add` CLI if present on PATH; otherwise edit `~/.claude.json` directly (merge, don't clobber existing servers).
3. **Append review-loop guidance** to `~/.claude/CLAUDE.md` (idempotent — skip if the marker block already present):

   > When you create or update a markdown file the user should review, open it with `mdview <absolute-path>`. To read the user's review comments on that file, use the Glance MCP tools (`list_annotations`, `get_annotation`) and call `resolve_annotation` after applying each change.

Each step reports success/failure into the existing notice UI (`cli-install-result` → `showNotice`, generalized to a multi-step result). Portability comes from deriving every path from the running app at click time — nothing hardcoded.

## Distribution / build

- `glance-mcp` builds as part of the normal `cargo`/`tauri` release build (second binary in the same crate) and is bundled into `Glance.app`'s `Contents/MacOS/`.
- `scripts/install.sh` unchanged in spirit — builds release, copies `Glance.app` to `/Applications`. The bundled MCP binary rides along automatically.
- No separate `mcp/` directory, no Node, no pnpm dependency for end users.

## Testing strategy

- **`anchor.rs`** — heavy `cargo test` coverage: edits above and below the anchor, in-place reflow, duplicate quotes disambiguated by line hint, deletion → orphan, context-shift → quote-only, quote-gone-line-stays → drifted. The project's risk lives here.
- **`annotations.ts` reducers** — vitest unit tests mirroring the existing `store.test.ts` style.
- **`annotations.rs` store** — `cargo test` round-trip read/write + path derivation, mirroring the existing CLI tests.
- **`glance-mcp`** — unit tests exercising each tool against fixture store files + a sample document, asserting re-anchored line numbers reflect the current file.
- **Setup action** — test path derivation and idempotent CLAUDE.md/`~/.claude.json` merge logic in isolation (no real filesystem mutation in tests; inject paths).

## Open questions (resolved for the spec)

- **MCP registration mechanism:** prefer `claude mcp add` if on PATH, fall back to a careful merge-edit of `~/.claude.json`. Both implemented; CLI preferred.
- **Rust MCP SDK vs. hand-rolled stdio JSON-RPC:** start with `rmcp` (official); if it bloats the binary or complicates the single-crate build, fall back to a minimal stdio JSON-RPC handler (the v1 surface is only 3 tools + 1 resource).

## v2 preview (not in scope, for context)

- `add_annotation` / `highlight` MCP write tools → Claude marks regions ("see section 3.2") → store → Glance watcher → live highlight + scroll-to. The `author: claude` field, the live store watching, and the rail UI all already exist to support this.
