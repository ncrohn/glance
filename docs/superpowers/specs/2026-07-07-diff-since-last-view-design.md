# Diff-Since-Last-View — Design

**Date:** 2026-07-07
**Status:** Approved design, ready for implementation planning
**Scope:** v1 = highlight, in the rendered view, the blocks that changed on disk since the user last marked the document reviewed; surface a per-tab indicator; persist the review baseline across restarts.

## Goal

Tighten the human side of the Glance ↔ Claude spec/plan loop. Today, when Claude edits a doc on disk, a clean tab auto-reloads silently and the user must re-read the **whole** document to find what changed. This is the biggest flow drag in iterating on a spec.

Diff-since-last-view makes the loop legible: after Claude edits, the user sees **only the deltas** highlighted in the rendered reading view, plus a tab indicator that the doc changed while they weren't looking. When done, the user marks the doc reviewed, which clears the highlights and advances the baseline.

This is the first slice of the broader "tighten the loop" theme (diff + review-status + annotation threads). It ships alone.

## Non-goals (v1)

Deferred to follow-on work, in priority order:

- **Word-level / intra-line diff.** v1 highlights whole changed blocks only.
- **Source-view (CodeMirror) highlighting.** v1 highlights the rendered view only; toggling to source shows no diff decoration.
- **Full review-status counts** (open / orphaned / resolved on the tab). v1 ships a binary tab dot only.

The data model and diff engine are built so these three are clean additions, not rewrites.

## Baseline semantics (the core decision)

The baseline that deltas are measured against is **the content the user last marked reviewed** — the "seen baseline."

- **On open:** load the persisted baseline for the file's path if one exists; otherwise the baseline is the current disk content (a freshly opened file shows no deltas — you only diff against what you have already seen).
- **On external edit** (Claude writes the file; the tab auto-reloads): disk content advances, the baseline is **left untouched**, so deltas **accumulate** across any number of edit rounds until the user reviews.
- **On "Mark reviewed":** the baseline is set to the current disk content; highlights and the tab dot clear.

Two derived signals, both computed — no extra stored flags:

- `hasUnreviewedChanges(doc)` = `reviewedContent !== diskContent` → drives the tab dot and the visibility of the "Mark reviewed" action.
- `changedLines(doc)` = line-diff(`reviewedContent` → `diskContent`) → the set of changed line numbers that drives block highlighting.

## Architecture

```
Claude edits spec.md on disk
        │  file-changed event → clean tab auto-reload
        ▼
applyDiskChange(diskContent)          [store.ts]
  diskContent ← new                    reviewedContent ← UNCHANGED
        │
        ▼
changedLines = diff(reviewedContent, diskContent)   [diff.ts, pure]
        │
        ├──► renderer.ts: mark block tokens whose source-line
        │      range intersects changedLines → data-changed class
        │      → styles.css accent bar + tint (theme-aware)
        │
        └──► app.ts: tab dot (renderTabBar) +
               "Mark reviewed" button (renderActions)

User clicks "Mark reviewed"
        ▼
markReviewed(id)   [store.ts]         reviewedContent ← diskContent
        │
        └──► write_reviewed (IPC → Rust)  persist to disk
               ~/.glance/reviewed/<sha1(absPath)>.md
```

Two halves talk only over IPC, per project convention; all new IPC wrappers go in `ipc.ts`.

## Components

### 1. State — `store.ts` / `document.ts`

- `Doc` gains one field: `reviewedContent: string`.
- `createDoc(absPath, diskContent)` initializes `reviewedContent = diskContent`. (On open, `app.ts` overrides it from the persisted store if a baseline exists — see Persistence.)
- New reducer `markReviewed(s, id)`: returns a new state with `reviewedContent = diskContent` for that doc. Pure, no mutation.
- `applyDiskChange` is unchanged in behavior: it advances `diskContent` and `editorContent` and does **not** touch `reviewedContent`, so deltas accumulate.
- Derived helpers (in `document.ts`, pure, unit-tested):
  - `hasUnreviewedChanges(doc): boolean`
  - `changedLines(doc): Set<number>` — thin wrapper delegating to the diff engine.

### 2. Diff engine — new pure module `diff.ts`

- `diffLines(oldText: string, newText: string): Set<number>` — line-based LCS diff. Returns the set of **1-indexed line numbers in `newText`** that are added or modified relative to `oldText`.
- Pure, no I/O, no DOM. Unit-tested (`diff.test.ts`) against: no change, pure additions, pure deletions, mid-file edits, leading/trailing edits, empty↔nonempty, trailing-newline differences.
- Keep the implementation small and dependency-light (standard LCS over lines). Deletions collapse to marking the adjacent surviving line so a removed block is still discoverable in the rendered view.

### 3. Render integration — `renderer.ts`

- `render()` gains an optional second parameter `changedLines?: Set<number>`.
- Implementation: `md.parse(src, env)` → iterate tokens; for each **block-level** token carrying a `.map` (`[startLine, endLine)`, 0-indexed half-open), if any line in that range is in `changedLines`, push a `data-changed` attribute (or a class) onto the token. Then `md.renderer.render(tokens, md.options, env)`.
- **Indexing contract:** `changedLines` holds 1-indexed line numbers; `token.map` is 0-indexed half-open. A token covers 1-indexed lines `map[0]+1 .. map[1]` inclusive. The intersection test must convert on this boundary — this is the one off-by-one to get right, and a `renderer.test.ts` case pins it.
- When `changedLines` is absent or empty, output is byte-identical to today's render path (no behavior change for docs with nothing to review).

### 4. Styling — `styles.css`

- `[data-changed]` in the rendered content gets a left accent bar + subtle background tint, using existing theme custom properties so it tracks the active theme (Paper/Ink/Solarized/Nord/High-Contrast). Must be legible in every theme, including High Contrast.

### 5. UI surfaces — `app.ts`

- **Tab dot:** `renderTabBar` renders a small dot/marker on any tab whose doc `hasUnreviewedChanges`. Clears reactively when the doc is reviewed (full re-render model).
- **"Mark reviewed" action:** `renderActions` shows a "Mark reviewed" control only when the active doc `hasUnreviewedChanges`. Click → dispatch `markReviewed` → persist via IPC → re-render (highlights + dot vanish).
- `renderContent` passes `changedLines(activeDoc)` into `render()`.

### 6. Persistence — Rust store + IPC (mirrors `annotations.rs`)

- On-disk store at `~/.glance/reviewed/<sha1(absPath)>.md` holding the last-reviewed content verbatim. Disk (not localStorage) keeps potentially large content out of localStorage and matches the existing annotation-store pattern.
- New Rust module (or additions alongside `annotations.rs`) providing IPC commands:
  - `read_reviewed(abs_path) -> Option<String>` — returns the stored baseline, or `None` if never reviewed.
  - `write_reviewed(abs_path, content)` — writes the baseline (creates the dir as needed, like the annotation store).
- `ipc.ts` gains `readReviewed` / `writeReviewed` wrappers. Nothing else calls `invoke` directly.
- `app.ts`: on open, call `readReviewed`; if present, set `reviewedContent` to it (so in-flight review state survives restart). On `markReviewed`, call `writeReviewed`.
- Rust unit tests for the store round-trip, mirroring the annotation-store tests.

## Key flows

- **Claude edits a clean tab.** `file-changed` → auto-reload → `applyDiskChange` advances `diskContent`, baseline untouched → `changedLines` non-empty → rendered blocks get accents, tab dot lights. User reads only the deltas, clicks "Mark reviewed" → baseline advances, persisted, highlights clear.
- **Multiple edits before review.** Each edit advances `diskContent`; the baseline stays put, so deltas from **all** rounds remain highlighted until the single "Mark reviewed".
- **Fresh open, never reviewed.** `readReviewed` returns `None` → baseline = disk content → no deltas → no dot. First edit after that is the first thing that can show a delta.
- **Reopen after restart mid-review.** `readReviewed` returns the stored baseline → unreviewed deltas are still highlighted against it.
- **Dirty tab + external edit.** Unchanged from today: the existing Keep-mine / Load-disk prompt runs. Choosing Load-disk routes through `applyDiskChange`, so diff highlighting appears with no special-casing. Keep-mine leaves disk content as-is; whatever the resulting `diskContent` is, `changedLines` derives from it against the baseline.

## Testing

- `diff.test.ts` — the diff engine cases listed in §2.
- `document.test.ts` — `hasUnreviewedChanges` and `changedLines` derivations.
- `store.test.ts` — `markReviewed` reducer; confirm `applyDiskChange` leaves `reviewedContent` untouched.
- `renderer.test.ts` — `render` with `changedLines` marks the right blocks and is a no-op when empty.
- Rust — reviewed-store read/write round-trip and path hashing.

## Conventions honored

- New IPC wrappers live in `ipc.ts`; logic modules (`diff.ts`, reducers, derivations) stay pure and unit-tested; reducers return new state without mutation. Highlighting reuses the source-line-map decoration approach already used for annotations, and the disk-store pattern already used for annotations.
