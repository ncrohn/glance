# Diff-Since-Last-View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Highlight, in Glance's rendered view, the blocks that changed since the user last marked a doc reviewed, with a per-tab indicator and a baseline that persists across restarts.

**Architecture:** A pure line-diff engine computes changed line numbers between the persisted "reviewed" baseline and the doc's current content. The markdown renderer stamps `data-changed` on rendered blocks whose source lines intersect that set; `app.ts` accents them via CSS, shows a tab badge, and offers a "Mark reviewed" action that advances and persists the baseline. The baseline is stored on disk in Rust, mirroring the existing annotation store.

**Tech Stack:** TypeScript + vanilla DOM (frontend), markdown-it, Vitest; Rust + Tauri IPC (backend), `sha1`/`serde_json`, `cargo test`.

## Global Constraints

- Package manager is **pnpm only** (see `packageManager` pin). Never invoke `npm`/`yarn`.
- All `invoke`/`listen` calls go through wrappers in `src/ipc.ts`; no other module calls `invoke`/`listen` directly.
- Logic modules stay **pure and unit-tested**; reducers return **new state, never mutate**. `app.ts` is the only side-effectful glue and is not unit-tested.
- Markdown rendering uses `html: false` (already set); do not enable raw HTML.
- Baseline store lives on disk at `~/.glance/reviewed/<sha1(absPath)>.md`, mirroring `~/.glance/annotations/`.
- Rendered-view + block-level only for v1. Out of scope (follow-ons): word-level intra-line diff, source-view (CodeMirror) highlighting, full open/resolved status counts.
- Styling must use existing per-theme custom properties (`--accent`, `--accent-tint`, `--accent-line`) so it tracks every theme, including High Contrast.

**Content-side definitions (used throughout — copy exactly):**
- `changedLines(doc)` diffs `doc.reviewedContent` → **`doc.editorContent`** (the content actually rendered on screen).
- `hasUnreviewedChanges(doc)` compares `doc.reviewedContent` !== **`doc.diskContent`** (disk state, so the user's own unsaved typing does not trigger the tab badge / button).
- `markReviewed` sets `reviewedContent = diskContent`; persistence writes `diskContent`.

For a clean tab, `editorContent === diskContent`, so both agree. The split only matters while a tab is dirty.

---

### Task 1: Line-diff engine

**Files:**
- Create: `src/diff.ts`
- Test: `src/diff.test.ts`

**Interfaces:**
- Consumes: nothing (standalone, no I/O, no DOM).
- Produces: `diffLines(oldText: string, newText: string): Set<number>` — returns the set of **1-indexed line numbers in `newText`** that are added or modified relative to `oldText`. A deletion is reported by marking the adjacent surviving line in `newText`.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/diff.test.ts
import { describe, it, expect } from "vitest";
import { diffLines } from "./diff";

const set = (...n: number[]) => new Set(n);

describe("diffLines", () => {
  it("returns empty when texts are identical", () => {
    expect(diffLines("a\nb\nc", "a\nb\nc")).toEqual(set());
  });

  it("ignores a differing trailing newline", () => {
    expect(diffLines("a\nb", "a\nb\n")).toEqual(set());
    expect(diffLines("a\nb\n", "a\nb")).toEqual(set());
  });

  it("marks an appended line", () => {
    expect(diffLines("a\nb", "a\nb\nc")).toEqual(set(3));
  });

  it("marks a modified middle line", () => {
    expect(diffLines("a\nb\nc", "a\nB\nc")).toEqual(set(2));
  });

  it("marks a modified leading line", () => {
    expect(diffLines("a\nb\nc", "A\nb\nc")).toEqual(set(1));
  });

  it("marks the adjacent surviving line for a deletion", () => {
    // 'b' removed; surviving neighbor in new text is line 2 ('c')
    expect(diffLines("a\nb\nc", "a\nc")).toEqual(set(2));
  });

  it("marks everything when growing from empty", () => {
    expect(diffLines("", "a\nb")).toEqual(set(1, 2));
  });

  it("returns empty when shrinking to empty", () => {
    // nothing left in new text to highlight
    expect(diffLines("a\nb", "")).toEqual(set());
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/diff.test.ts`
Expected: FAIL — `diffLines` is not defined / module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/diff.ts

// Split into lines, treating a single trailing newline as insignificant so
// "a\nb\n" and "a\nb" compare equal. An empty string yields no lines.
function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.replace(/\n$/, "").split("\n");
}

/**
 * Line-based LCS diff. Returns the 1-indexed line numbers in `newText` that
 * are added or modified relative to `oldText`. Deletions are attributed to the
 * adjacent surviving line in `newText` so a removed block stays discoverable.
 */
export function diffLines(oldText: string, newText: string): Set<number> {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const m = a.length;
  const n = b.length;
  const changed = new Set<number>();

  // dp[i][j] = length of LCS of a[i..] and b[j..]
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      // a[i] deleted — attribute to the surviving new line at position j
      changed.add(j + 1);
      i++;
    } else {
      // b[j] added
      changed.add(j + 1);
      j++;
    }
  }
  // trailing additions in new text
  while (j < n) {
    changed.add(j + 1);
    j++;
  }
  // trailing deletions: attribute to the last surviving new line, if any
  if (i < m && n > 0) changed.add(n);

  return changed;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/diff.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/diff.ts src/diff.test.ts
git commit -m "feat(diff): pure line-diff engine for changed-line detection"
```

---

### Task 2: State — baseline field, reducers, derivations

**Files:**
- Modify: `src/document.ts` (add `reviewedContent` to `Doc`; add derivations)
- Modify: `src/store.ts` (init `reviewedContent` in `createDoc`; add `markReviewed`, `setReviewedBaseline`)
- Test: `src/document.test.ts`, `src/store.test.ts`

**Interfaces:**
- Consumes: `diffLines` from Task 1.
- Produces:
  - `Doc.reviewedContent: string`
  - `changedLines(doc: Doc): Set<number>` (in `document.ts`)
  - `hasUnreviewedChanges(doc: Doc): boolean` (in `document.ts`)
  - `markReviewed(s: State, id: string): State` (in `store.ts`)
  - `setReviewedBaseline(s: State, id: string, content: string): State` (in `store.ts`)

- [ ] **Step 1: Write the failing tests**

Append to `src/document.test.ts`:

```typescript
import { createDoc, changedLines, hasUnreviewedChanges } from "./document";

describe("changedLines / hasUnreviewedChanges", () => {
  it("a freshly created doc has no changes", () => {
    const d = createDoc("/x.md", "a\nb\nc");
    expect(hasUnreviewedChanges(d)).toBe(false);
    expect(changedLines(d)).toEqual(new Set());
  });

  it("changedLines diffs the reviewed baseline against editorContent", () => {
    const d = { ...createDoc("/x.md", "a\nb\nc"), editorContent: "a\nB\nc" };
    expect(changedLines(d)).toEqual(new Set([2]));
  });

  it("hasUnreviewedChanges compares baseline against diskContent, not editor", () => {
    const base = createDoc("/x.md", "a\nb");
    // user typed but has not saved: disk still equals baseline -> no badge
    const dirty = { ...base, editorContent: "a\nb\nc" };
    expect(hasUnreviewedChanges(dirty)).toBe(false);
    // disk advanced (Claude edit) -> badge
    const edited = { ...base, diskContent: "a\nb\nc", editorContent: "a\nb\nc" };
    expect(hasUnreviewedChanges(edited)).toBe(true);
  });
});
```

Append to `src/store.test.ts`:

```typescript
import { markReviewed, setReviewedBaseline, applyDiskChange, openDoc, emptyState } from "./store";

describe("review baseline reducers", () => {
  it("markReviewed advances reviewedContent to diskContent", () => {
    let s = openDoc(emptyState(), "/x.md", "v1");
    s = applyDiskChange(s, "/x.md", "v2");
    expect(s.docs[0].reviewedContent).toBe("v1"); // applyDiskChange leaves it
    s = markReviewed(s, "/x.md");
    expect(s.docs[0].reviewedContent).toBe("v2");
  });

  it("applyDiskChange does not touch reviewedContent", () => {
    let s = openDoc(emptyState(), "/x.md", "v1");
    s = applyDiskChange(s, "/x.md", "v2");
    expect(s.docs[0].reviewedContent).toBe("v1");
    expect(s.docs[0].diskContent).toBe("v2");
  });

  it("setReviewedBaseline overrides the baseline (persisted-load path)", () => {
    let s = openDoc(emptyState(), "/x.md", "v2");
    s = setReviewedBaseline(s, "/x.md", "v1");
    expect(s.docs[0].reviewedContent).toBe("v1");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/document.test.ts src/store.test.ts`
Expected: FAIL — `changedLines`/`hasUnreviewedChanges`/`markReviewed`/`setReviewedBaseline` not exported; `reviewedContent` missing.

- [ ] **Step 3: Update `document.ts`**

Add `reviewedContent` to the `Doc` interface and initialize it in `createDoc`, then add the two derivations. Full new file:

```typescript
// src/document.ts
import { diffLines } from "./diff";

export type ViewMode = "rendered" | "source";

export interface Doc {
  id: string;
  absPath: string;
  fileName: string;
  diskContent: string;
  editorContent: string;
  reviewedContent: string;
  viewMode: ViewMode;
  existsOnDisk: boolean;
  annotations: import("./annotations").Annotation[];
  resolutions: Record<string, import("./annotations").Resolution>;
}

export function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

export function createDoc(absPath: string, diskContent: string): Doc {
  return {
    id: absPath,
    absPath,
    fileName: basename(absPath),
    diskContent,
    editorContent: diskContent,
    reviewedContent: diskContent,
    viewMode: "rendered",
    existsOnDisk: true,
    annotations: [],
    resolutions: {},
  };
}

export function isDirty(doc: Doc): boolean {
  return doc.editorContent !== doc.diskContent;
}

// Lines changed on screen since the last reviewed baseline (1-indexed).
export function changedLines(doc: Doc): Set<number> {
  return diffLines(doc.reviewedContent, doc.editorContent);
}

// Whether the on-disk content has moved past what the user last reviewed.
// Compares against diskContent (not editorContent) so unsaved typing does not
// light the tab badge / show the "Mark reviewed" button.
export function hasUnreviewedChanges(doc: Doc): boolean {
  return doc.reviewedContent !== doc.diskContent;
}
```

- [ ] **Step 4: Update `store.ts`**

Add the field init and two reducers. In `createDoc` the init is already handled in Task 2 Step 3 (`document.ts` owns `createDoc`). Add to `store.ts`, after `markSaved`:

```typescript
export function markReviewed(s: State, id: string): State {
  return mapDoc(s, id, (d) => ({ ...d, reviewedContent: d.diskContent }));
}

export function setReviewedBaseline(s: State, id: string, content: string): State {
  return mapDoc(s, id, (d) => ({ ...d, reviewedContent: content }));
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec vitest run src/document.test.ts src/store.test.ts`
Expected: PASS.

- [ ] **Step 6: Type-check the whole project**

Run: `pnpm exec tsc --noEmit`
Expected: no errors. (If any existing test builds a `Doc` object literal directly, add `reviewedContent`. Object literals created via `createDoc` need no change.)

- [ ] **Step 7: Commit**

```bash
git add src/document.ts src/store.ts src/document.test.ts src/store.test.ts
git commit -m "feat(store): reviewed baseline field, reducers, and change derivations"
```

---

### Task 3: Renderer — stamp `data-changed` on changed blocks

**Files:**
- Modify: `src/renderer.ts`
- Test: `src/renderer.test.ts`

**Interfaces:**
- Consumes: a `Set<number>` of 1-indexed changed line numbers (from `changedLines`).
- Produces: `renderMarkdown(src: string, changedLines?: Set<number>): string`. When `changedLines` is omitted or empty, output is unchanged from before. Otherwise, top-level block elements whose source lines intersect the set carry a `data-changed="true"` attribute.

**Indexing contract:** `changedLines` is 1-indexed; markdown-it `token.map` is `[start, end)` 0-indexed half-open. A token covers 1-indexed lines `map[0]+1 .. map[1]` inclusive. Get this boundary right — a test pins it.

- [ ] **Step 1: Write the failing tests**

Append to `src/renderer.test.ts`:

```typescript
import { renderMarkdown } from "./renderer";

describe("renderMarkdown changed-line marking", () => {
  const src = "# Title\n\nfirst para\n\nsecond para";
  // lines: 1='# Title', 2='', 3='first para', 4='', 5='second para'

  it("adds no data-changed when the set is empty or absent", () => {
    expect(renderMarkdown(src)).not.toContain("data-changed");
    expect(renderMarkdown(src, new Set())).not.toContain("data-changed");
  });

  it("marks only the block containing a changed line", () => {
    const html = renderMarkdown(src, new Set([5]));
    expect(html).toContain("data-changed");
    // the marked block is the second paragraph
    const secondMarked = /<p[^>]*data-changed[^>]*>second para<\/p>/.test(html);
    expect(secondMarked).toBe(true);
    // the first paragraph is not marked
    const firstMarked = /<p[^>]*data-changed[^>]*>first para<\/p>/.test(html);
    expect(firstMarked).toBe(false);
  });

  it("marks the heading when its source line changed", () => {
    const html = renderMarkdown(src, new Set([1]));
    expect(/<h1[^>]*data-changed[^>]*>/.test(html)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/renderer.test.ts`
Expected: FAIL — `renderMarkdown` ignores the second argument; no `data-changed` in output.

- [ ] **Step 3: Implement**

Add a core rule that reads `changedLines` from the render env, and thread env through `renderMarkdown`. Edit `src/renderer.ts`:

Replace the `source_lines` core rule block and the `renderMarkdown` export at the bottom with:

```typescript
// Stamp 1-based source line numbers onto top-level block-open tokens so the
// annotation layer can map a rendered selection back to a source line.
md.core.ruler.push("source_lines", (state) => {
  for (const token of state.tokens) {
    if (token.level === 0 && token.map && token.type.endsWith("_open")) {
      token.attrSet("data-sourceline", String(token.map[0] + 1));
    }
  }
});

// Mark top-level blocks whose source lines intersect the changed-line set
// (passed in via env). token.map is [start,end) 0-indexed; the block covers
// 1-indexed lines start+1 .. end inclusive.
md.core.ruler.push("changed_lines", (state) => {
  const changed = state.env?.changedLines as Set<number> | undefined;
  if (!changed || changed.size === 0) return;
  for (const token of state.tokens) {
    if (token.level === 0 && token.map && token.type.endsWith("_open")) {
      const start = token.map[0] + 1;
      const end = token.map[1];
      for (let ln = start; ln <= end; ln++) {
        if (changed.has(ln)) {
          token.attrSet("data-changed", "true");
          break;
        }
      }
    }
  }
});

export function renderMarkdown(src: string, changedLines?: Set<number>): string {
  return md.render(src, { changedLines });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/renderer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer.ts src/renderer.test.ts
git commit -m "feat(render): mark changed blocks with data-changed via changedLines env"
```

---

### Task 4: Rust — reviewed-baseline disk store + IPC

**Files:**
- Create: `src-tauri/src/reviewed.rs`
- Modify: `src-tauri/src/lib.rs` (declare module; register commands)
- Test: inline `#[cfg(test)]` in `reviewed.rs`

**Interfaces:**
- Consumes: `crate::annotations::sha1_hex` (already `pub`).
- Produces two Tauri commands:
  - `read_reviewed(path: String) -> Option<String>` — the stored baseline, or `None` if never reviewed.
  - `write_reviewed(path: String, content: String) -> Result<(), String>` — writes the baseline, creating `~/.glance/reviewed/` as needed.

- [ ] **Step 1: Write the failing tests + module**

Create `src-tauri/src/reviewed.rs`:

```rust
use crate::annotations::sha1_hex;
use std::path::PathBuf;

fn store_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".glance").join("reviewed"))
}

pub fn store_path_for(doc_path: &str) -> Option<PathBuf> {
    store_dir().map(|d| d.join(format!("{}.md", sha1_hex(doc_path))))
}

pub fn read_baseline(doc_path: &str) -> Option<String> {
    let path = store_path_for(doc_path)?;
    std::fs::read_to_string(&path).ok()
}

pub fn write_baseline(doc_path: &str, content: &str) -> Result<(), String> {
    let path = store_path_for(doc_path)
        .ok_or_else(|| "Could not determine $HOME for reviewed store".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_reviewed(path: String) -> Option<String> {
    read_baseline(&path)
}

#[tauri::command]
pub fn write_reviewed(path: String, content: String) -> Result<(), String> {
    write_baseline(&path, &content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_path_is_under_glance_reviewed() {
        std::env::set_var("HOME", "/tmp/glance-test-reviewed");
        let p = store_path_for("/x/y.md").unwrap();
        let s = p.to_string_lossy();
        assert!(s.contains("/.glance/reviewed/"));
        assert!(s.ends_with(".md"));
    }

    #[test]
    fn read_missing_baseline_returns_none() {
        std::env::set_var("HOME", "/tmp/glance-test-reviewed-missing");
        assert!(read_baseline("/no/such/file.md").is_none());
    }

    #[test]
    fn write_then_read_round_trips() {
        std::env::set_var("HOME", "/tmp/glance-test-reviewed-rt");
        let doc = "/a/b/round-trip.md";
        write_baseline(doc, "hello\nworld").unwrap();
        assert_eq!(read_baseline(doc).as_deref(), Some("hello\nworld"));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test reviewed 2>&1 | tail -20`
Expected: FAIL — `reviewed` module not declared / unresolved import (module not yet added to `lib.rs`).

- [ ] **Step 3: Register the module and commands in `lib.rs`**

Add the module declaration after line 2 (`pub mod annotations;`):

```rust
pub mod reviewed;
```

Add the two commands inside `tauri::generate_handler![ ... ]` (after `annotations::ensure_annotation_store,`):

```rust
            reviewed::read_reviewed,
            reviewed::write_reviewed,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test reviewed 2>&1 | tail -20`
Expected: PASS (3 tests). Also run `cd src-tauri && cargo build 2>&1 | tail -5` — expected: builds clean.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/reviewed.rs src-tauri/src/lib.rs
git commit -m "feat(reviewed): disk-backed review-baseline store + IPC commands"
```

---

### Task 5: Frontend wiring — IPC wrappers, app glue, styling

**Files:**
- Modify: `src/ipc.ts` (add `readReviewed`, `writeReviewed`)
- Modify: `src/app.ts` (load baseline on open; pass `changedLines` to render; tab badge; "Mark reviewed" action)
- Modify: `src/styles.css` (changed-block accent; tab change-dot; review button)

**Interfaces:**
- Consumes: `read_reviewed`/`write_reviewed` commands (Task 4); `changedLines`, `hasUnreviewedChanges` (Task 2); `markReviewed`, `setReviewedBaseline` (Task 2); `renderMarkdown(src, changedLines)` (Task 3).
- Produces: no exports consumed by other tasks (terminal glue task).

This task is side-effectful glue (not unit-tested, per convention). It is verified by type-check, the full test suite staying green, and a manual run.

- [ ] **Step 1: Add IPC wrappers**

Append to `src/ipc.ts`:

```typescript
export function readReviewed(path: string): Promise<string | null> {
  return invoke<string | null>("read_reviewed", { path });
}

export function writeReviewed(path: string, content: string): Promise<void> {
  return invoke<void>("write_reviewed", { path, content });
}
```

- [ ] **Step 2: Wire baseline load on open (`app.ts`)**

In `src/app.ts`, add to the imports from `./store`:

```typescript
  markReviewed, setReviewedBaseline,
```

add to the imports from `./document`:

```typescript
  changedLines, hasUnreviewedChanges,
```

and add to the imports from `./ipc`:

```typescript
  readReviewed, writeReviewed,
```

In `openPath`, after `state = openDoc(state, absPath, contents);` (line ~216), load the persisted baseline:

```typescript
  try {
    const baseline = await readReviewed(absPath);
    if (baseline != null) state = setReviewedBaseline(state, absPath, baseline);
  } catch (err) {
    console.warn("readReviewed failed for", absPath, err);
  }
```

- [ ] **Step 3: Pass changedLines into the rendered view (`app.ts`)**

In `renderContent`, change the rendered-view line:

```typescript
    view.innerHTML = renderMarkdown(doc.editorContent);
```

to:

```typescript
    view.innerHTML = renderMarkdown(doc.editorContent, changedLines(doc));
```

- [ ] **Step 4: Add the tab change-dot (`app.ts`)**

In `renderTabBar`, after the existing dirty-class line, add a distinct badge for unreviewed changes. Change:

```typescript
    if (isDirty(d)) tab.classList.add("dirty");
    tab.appendChild(el("span", "dot"));
```

to:

```typescript
    if (isDirty(d)) tab.classList.add("dirty");
    if (hasUnreviewedChanges(d)) tab.classList.add("has-changes");
    tab.appendChild(el("span", "dot"));
    if (hasUnreviewedChanges(d)) tab.appendChild(el("span", "change-dot"));
```

- [ ] **Step 5: Add the "Mark reviewed" action (`app.ts`)**

In `renderActions`, after the `host.appendChild(seg);` line, add:

```typescript
  if (hasUnreviewedChanges(doc)) {
    const review = el("button", "review-btn", "Mark reviewed");
    review.onclick = () => {
      state = markReviewed(state, doc.id);
      void writeReviewed(doc.absPath, doc.diskContent);
      render();
    };
    host.appendChild(review);
  }
```

- [ ] **Step 6: Styling (`styles.css`)**

Append:

```css
/* Blocks changed on disk since the doc was last marked reviewed. */
.rendered [data-changed] {
  position: relative;
  background: var(--accent-tint);
  box-shadow: inset 3px 0 0 var(--accent-line);
  border-radius: 3px;
}

/* Tab badge: a doc changed on disk since it was last reviewed. */
.tab .change-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  flex: 0 0 auto;
  margin-left: 2px;
}

/* "Mark reviewed" action in the titlebar. */
.review-btn {
  margin-left: 10px;
  padding: 3px 10px;
  font-size: 12px;
  border: 1px solid var(--accent-line);
  border-radius: 6px;
  background: var(--accent-tint);
  color: var(--accent);
  cursor: pointer;
}
.review-btn:hover { background: var(--accent); color: var(--bg); }
```

Note: if `--bg` is not defined in this codebase's theme blocks, use the existing page-background custom property instead (grep `styles.css` for the variable used on `body`/`.app` background and substitute it in the `:hover` rule).

- [ ] **Step 7: Type-check and run the full suite**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

Run: `pnpm test`
Expected: all tests pass.

Run: `cd src-tauri && cargo test 2>&1 | tail -10`
Expected: all tests pass.

- [ ] **Step 8: Manual verification (drive the real feature)**

```bash
pnpm tauri dev
```

Then:
1. `mdview /tmp/diff-demo.md` on a small markdown file (create one with a few paragraphs). Confirm: opens, **no** highlights, **no** tab dot, **no** "Mark reviewed" button.
2. Edit `/tmp/diff-demo.md` on disk from another process (e.g. append a paragraph via your editor or `printf`), leaving the tab clean. Confirm: the tab shows the accent change-dot, the changed paragraph gets the left accent bar + tint in the rendered view, and a "Mark reviewed" button appears.
3. Make a second external edit before reviewing. Confirm: both changes remain highlighted (deltas accumulate).
4. Click "Mark reviewed". Confirm: highlights clear, tab dot clears, button disappears.
5. Make another external edit, then quit and relaunch Glance, reopening the file. Confirm: the unreviewed change is still highlighted (baseline persisted). Verify `~/.glance/reviewed/` contains one `<sha1>.md` file.

- [ ] **Step 9: Commit**

```bash
git add src/ipc.ts src/app.ts src/styles.css
git commit -m "feat(ui): highlight changed blocks, tab badge, and Mark reviewed action"
```

---

## Self-Review Notes

- **Spec coverage:** baseline semantics (Task 2 + Task 4 persistence), diff engine (Task 1), rendered block highlight (Task 3 + Task 5 CSS), tab dot (Task 5), "Mark reviewed" dismissal (Task 5), disk persistence mirroring annotations (Task 4), accumulate-across-edits (Task 2 `applyDiskChange` untouched + test). All spec sections map to a task.
- **Scope excludes** (word-level, source-view highlight, status counts) are not implemented — confirmed absent from all tasks.
- **Type consistency:** `diffLines` (Task 1) ↔ `changedLines` (Task 2) ↔ `renderMarkdown(src, changedLines)` (Task 3) all use `Set<number>`, 1-indexed. `read_reviewed`→`readReviewed` returns `string | null`; `openPath` null-checks. `markReviewed`/`writeReviewed` both key off `diskContent`.
- **Content-side split** (`editorContent` for `changedLines`, `diskContent` for `hasUnreviewedChanges`) is stated once in Global Constraints and applied identically in Tasks 2 and 5.
