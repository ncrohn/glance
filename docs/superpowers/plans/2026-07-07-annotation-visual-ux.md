# Annotation Highlighting & Comment UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the annotation highlight-coverage bug, add numbered + color-keyed identity linking each highlight to its rail comment, and replace the single-line comment dialog with an inline popover composer.

**Architecture:** A pure `assignMarkers` helper derives per-annotation `{number,color}` from document order; both the rail and the in-text highlights consume that one map. Highlights switch from first-line matching to block-span/annotation-range intersection (reusing the renderer's source-line maps, now with an end line). A new `composer.ts` renders an inline popover anchored to the text selection.

**Tech Stack:** TypeScript + vanilla DOM, markdown-it, Vitest. Rust untouched.

**Execution approach (controller):** Tasks 1, 2, and 4a are pure/TDD — dispatch to subagents with review. Tasks 3, 4b, 5 are interactive DOM/CSS glue verified by running the app; the controller implements and live-verifies those in-thread (the palette and popover need live tuning), then does a final whole-diff review. `app.ts`/`composer.ts` DOM mounting is not unit-tested, per repo convention.

## Global Constraints

- Package manager **pnpm only**.
- Logic modules stay pure and unit-tested; reducers/DOM-glue split preserved. `app.ts` is side-effectful glue, not unit-tested.
- Markdown rendering stays `html: false`.
- Highlights are **line/block-level** (Resolution gives `startLine`/`endLine`, no char offsets).
- Only **open, anchored** annotations get a marker/highlight; orphaned/resolved appear in the rail only (unchanged dimmed styling).
- The rail and the highlights MUST consume the **same** `assignMarkers` map so numbers/colors cannot drift.
- `PALETTE` is a **fixed curated** hex array (starter: 6 hues), legible across all themes (Paper/Ink/Solarized/Nord/High-Contrast); tuned live.
- No new IPC, no annotation store-format change.
- `token.map` is `[start,end)` 0-indexed half-open: block covers 1-indexed lines `map[0]+1 .. map[1]` inclusive, so `data-sourceline = map[0]+1`, `data-sourceline-end = map[1]`.

---

### Task 1: Renderer — stamp block end line

**Files:**
- Modify: `src/renderer.ts` (the `source_lines` core rule)
- Test: `src/renderer.test.ts`

**Interfaces:**
- Produces: every level-0 block-open token carries `data-sourceline-end` = `token.map[1]` (1-indexed inclusive last line) alongside the existing `data-sourceline`.

- [ ] **Step 1: Write the failing test**

Append to `src/renderer.test.ts`:

```typescript
describe("renderMarkdown source line ends", () => {
  it("stamps data-sourceline-end = last source line of each block", () => {
    // "# T"=1, ""=2, "para"=3, "more"=4  → paragraph spans lines 3..4
    const html = renderMarkdown("# T\n\npara\nmore");
    expect(/<h1[^>]*data-sourceline="1"[^>]*data-sourceline-end="1"/.test(html)).toBe(true);
    expect(/<p[^>]*data-sourceline="3"[^>]*data-sourceline-end="4"/.test(html)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/renderer.test.ts`
Expected: FAIL — no `data-sourceline-end` in output.

- [ ] **Step 3: Implement**

In `src/renderer.ts`, in the `source_lines` core rule, add the end stamp next to the existing one:

```typescript
md.core.ruler.push("source_lines", (state) => {
  for (const token of state.tokens) {
    if (token.level === 0 && token.map && token.type.endsWith("_open")) {
      token.attrSet("data-sourceline", String(token.map[0] + 1));
      token.attrSet("data-sourceline-end", String(token.map[1]));
    }
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/renderer.test.ts`
Expected: PASS (existing renderer tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/renderer.ts src/renderer.test.ts
git commit -m "feat(render): stamp data-sourceline-end for block-span mapping"
```

---

### Task 2: Pure marker + range-intersection helpers

**Files:**
- Modify: `src/annotation-ui.ts` (add `MARKER_PALETTE`, `Marker`, `assignMarkers`, `annotationsForBlock`)
- Test: `src/annotation-ui.test.ts`

**Interfaces:**
- Consumes: `Annotation`, `Resolution`.
- Produces:
  - `interface Marker { number: number; color: string }`
  - `const MARKER_PALETTE: string[]`
  - `assignMarkers(annotations: Annotation[], resolutions: Record<string, Resolution>): Map<string, Marker>` — open+anchored only, ordered by `startLine` (tie-break `createdAt` then `id`), `number` = 1-based index, `color` = `PALETTE[(number-1) % PALETTE.length]`.
  - `annotationsForBlock(blockStart: number, blockEnd: number, annotations: Annotation[], resolutions: Record<string, Resolution>): string[]` — ids of open annotations whose `[startLine,endLine]` intersects `[blockStart,blockEnd]`.

- [ ] **Step 1: Write the failing tests**

Append to `src/annotation-ui.test.ts` (reuse the existing `ann` helper; add a resolution builder):

```typescript
import { assignMarkers, annotationsForBlock, MARKER_PALETTE } from "./annotation-ui";

function res(id: string, startLine: number | null, endLine = startLine): Resolution {
  return { id, startLine, endLine, anchor: startLine == null ? "orphaned" : "exact" };
}
function annAt(id: string, createdAt = "t", status: Annotation["status"] = "open"): Annotation {
  return { id, quote: "q", prefix: "", suffix: "", lineHint: { start: 1, end: 1 }, note: "n", status, author: "user", createdAt };
}

describe("assignMarkers", () => {
  it("numbers open anchored annotations by startLine, recycling colors", () => {
    const list = [annAt("a"), annAt("b"), annAt("c")];
    const r = { a: res("a", 20), b: res("b", 5), c: res("c", 12) };
    const m = assignMarkers(list, r);
    expect(m.get("b")).toEqual({ number: 1, color: MARKER_PALETTE[0] });
    expect(m.get("c")).toEqual({ number: 2, color: MARKER_PALETTE[1] });
    expect(m.get("a")).toEqual({ number: 3, color: MARKER_PALETTE[2] });
  });

  it("excludes resolved and orphaned annotations", () => {
    const list = [annAt("a", "t", "resolved"), annAt("b"), annAt("c")];
    const r = { a: res("a", 3), b: res("b", 5), c: res("c", null) };
    const m = assignMarkers(list, r);
    expect([...m.keys()]).toEqual(["b"]);
    expect(m.get("b")!.number).toBe(1);
  });

  it("recycles the palette past its length", () => {
    const n = MARKER_PALETTE.length + 1;
    const list = Array.from({ length: n }, (_, i) => annAt(`x${i}`));
    const r: Record<string, Resolution> = {};
    list.forEach((a, i) => (r[a.id] = res(a.id, i + 1)));
    const m = assignMarkers(list, r);
    expect(m.get("x0")!.color).toBe(MARKER_PALETTE[0]);
    expect(m.get(`x${n - 1}`)!.color).toBe(MARKER_PALETTE[0]); // wrapped
    expect(m.get(`x${n - 1}`)!.number).toBe(n);
  });

  it("tie-breaks equal startLine by createdAt", () => {
    const list = [annAt("late", "2026-02"), annAt("early", "2026-01")];
    const r = { late: res("late", 5), early: res("early", 5) };
    const m = assignMarkers(list, r);
    expect(m.get("early")!.number).toBe(1);
    expect(m.get("late")!.number).toBe(2);
  });
});

describe("annotationsForBlock", () => {
  const list = [annAt("a"), annAt("b")];
  const r = { a: res("a", 3, 5), b: res("b", 10, 10) };
  it("includes an annotation whose range intersects the block span", () => {
    expect(annotationsForBlock(4, 4, list, r)).toEqual(["a"]); // mid-block anchor
    expect(annotationsForBlock(5, 8, list, r)).toEqual(["a"]); // overlaps at edge
    expect(annotationsForBlock(1, 3, list, r)).toEqual(["a"]); // overlaps first line
  });
  it("excludes a block that does not intersect", () => {
    expect(annotationsForBlock(6, 9, list, r)).toEqual([]);
  });
  it("returns multiple ids for a block covering several annotations", () => {
    expect(annotationsForBlock(1, 12, list, r).sort()).toEqual(["a", "b"]);
  });
  it("ignores resolved/orphaned annotations", () => {
    const l2 = [annAt("a", "t", "resolved"), annAt("c")];
    const r2 = { a: res("a", 3, 5), c: res("c", null) };
    expect(annotationsForBlock(1, 20, l2, r2)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/annotation-ui.test.ts`
Expected: FAIL — helpers not exported.

- [ ] **Step 3: Implement in `src/annotation-ui.ts`**

Add near the top (after imports):

```typescript
export interface Marker {
  number: number;
  color: string;
}

// Fixed curated palette; number disambiguates when colors recycle. Tuned live.
export const MARKER_PALETTE = [
  "#c9822b", // amber
  "#2f9e8f", // teal
  "#7c5cbf", // violet
  "#c0567e", // rose
  "#4f9d52", // green
  "#3d7fbf", // blue
];

// Per-annotation number + color for open, anchored annotations, ordered by
// document position. The rail and the highlights both consume this map.
export function assignMarkers(
  annotations: Annotation[],
  resolutions: Record<string, Resolution>,
): Map<string, Marker> {
  const eligible = annotations.filter(
    (a) => a.status === "open" && resolutions[a.id]?.startLine != null,
  );
  eligible.sort((x, y) => {
    const lx = resolutions[x.id]!.startLine!;
    const ly = resolutions[y.id]!.startLine!;
    if (lx !== ly) return lx - ly;
    if (x.createdAt !== y.createdAt) return x.createdAt < y.createdAt ? -1 : 1;
    return x.id < y.id ? -1 : 1;
  });
  const map = new Map<string, Marker>();
  eligible.forEach((a, i) => {
    map.set(a.id, { number: i + 1, color: MARKER_PALETTE[i % MARKER_PALETTE.length] });
  });
  return map;
}

// ids of open annotations whose resolved range intersects [blockStart, blockEnd].
export function annotationsForBlock(
  blockStart: number,
  blockEnd: number,
  annotations: Annotation[],
  resolutions: Record<string, Resolution>,
): string[] {
  const ids: string[] = [];
  for (const a of annotations) {
    if (a.status !== "open") continue;
    const r = resolutions[a.id];
    if (!r || r.startLine == null || r.endLine == null) continue;
    if (blockStart <= r.endLine && r.startLine <= blockEnd) ids.push(a.id);
  }
  return ids;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/annotation-ui.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/annotation-ui.ts src/annotation-ui.test.ts
git commit -m "feat(annotations): assignMarkers + block-range intersection helpers"
```

---

### Task 3: Highlights, rail chips, hover-link, pulse (DOM glue)

**Files:**
- Modify: `src/annotation-ui.ts` (`applyHighlights`, `renderRail`, add `linkAnnotationHovers`, `pulseBlock`)
- Modify: `src/app.ts` (call sites)

**Interfaces:**
- `applyHighlights(renderedEl, annotations, resolutions, markers)` — new signature (was `(renderedEl, resolutions)`).
- `renderRail(host, list, resolutions, markers, handlers)` — new `markers` param (4th).
- `linkAnnotationHovers(renderedEl: HTMLElement, railEl: HTMLElement): () => void` — bidirectional emphasis; returns teardown.
- `pulseBlock(node: Element | null): void`.

Not unit-tested (DOM glue). Verified by tsc + full suite staying green + manual run.

- [ ] **Step 1: Rewrite `applyHighlights` in `src/annotation-ui.ts`**

```typescript
/** Mark rendered blocks whose source span intersects any open annotation's
 *  range; inject colored number markers and stamp data-annotation-ids. */
export function applyHighlights(
  renderedEl: HTMLElement,
  annotations: Annotation[],
  resolutions: Record<string, Resolution>,
  markers: Map<string, Marker>,
): void {
  renderedEl.querySelectorAll<HTMLElement>("[data-sourceline]").forEach((node) => {
    node.classList.remove("annotated");
    node.style.removeProperty("--anno-color");
    node.removeAttribute("data-annotation-ids");
    node.querySelectorAll(".anno-marker-stack").forEach((m) => m.remove());

    const start = parseInt(node.dataset.sourceline ?? "0", 10);
    const end = parseInt(node.dataset.sourcelineEnd ?? node.dataset.sourceline ?? "0", 10);
    const ids = annotationsForBlock(start, end, annotations, resolutions)
      .filter((id) => markers.has(id))
      .sort((a, b) => markers.get(a)!.number - markers.get(b)!.number);
    if (!ids.length) return;

    node.classList.add("annotated");
    node.dataset.annotationIds = ids.join(" ");
    node.style.setProperty("--anno-color", markers.get(ids[0])!.color);

    const stack = document.createElement("span");
    stack.className = "anno-marker-stack";
    for (const id of ids) {
      const mk = markers.get(id)!;
      const chip = document.createElement("span");
      chip.className = "anno-marker";
      chip.textContent = String(mk.number);
      chip.style.setProperty("--anno-color", mk.color);
      chip.dataset.annotationId = id;
      stack.appendChild(chip);
    }
    node.appendChild(stack);
  });
}
```

- [ ] **Step 2: Update `renderRail` to render number chips**

In `renderRail`, change the signature to add `markers: Map<string, Marker>` as the 4th param (before `handlers`). Inside the `section` loop, set `card.dataset.annotationId = a.id;` and prepend a chip when a marker exists:

```typescript
      const card = el("div", `note-card ${cls}`);
      card.dataset.annotationId = a.id;
      const res = resolutions[a.id];
      const marker = markers.get(a.id);
      if (marker) {
        const chip = el("span", "note-chip", String(marker.number));
        chip.style.setProperty("--anno-color", marker.color);
        card.appendChild(chip);
      }
      const line = res?.startLine != null ? `L${res.startLine}` : "—";
      card.appendChild(el("span", "note-line", line));
      card.appendChild(el("span", "note-text", a.note));
      card.onclick = () => handlers.onScrollTo(a);
      const del = el("span", "note-del", "×");
      del.onclick = (ev) => { ev.stopPropagation(); handlers.onRemove(a); };
      card.appendChild(del);
      host.appendChild(card);
```

- [ ] **Step 3: Add `linkAnnotationHovers` and `pulseBlock`**

```typescript
/** Bidirectional hover emphasis between rendered blocks/markers and rail cards. */
export function linkAnnotationHovers(renderedEl: HTMLElement, railEl: HTMLElement): () => void {
  const setEmphasis = (id: string, on: boolean) => {
    const sel = `[data-annotation-ids~="${id}"], .anno-marker[data-annotation-id="${id}"], .note-card[data-annotation-id="${id}"]`;
    renderedEl.querySelectorAll(sel).forEach((n) => (n as HTMLElement).classList.toggle("anno-emphasis", on));
    railEl.querySelectorAll(sel).forEach((n) => (n as HTMLElement).classList.toggle("anno-emphasis", on));
  };
  const idsFrom = (t: HTMLElement): string[] => {
    if (t.dataset.annotationId) return [t.dataset.annotationId];
    if (t.dataset.annotationIds) return t.dataset.annotationIds.split(" ");
    return [];
  };
  const toggle = (on: boolean) => (e: Event) => {
    const t = (e.target as HTMLElement).closest("[data-annotation-id],[data-annotation-ids]") as HTMLElement | null;
    if (t) idsFrom(t).forEach((id) => setEmphasis(id, on));
  };
  const over = toggle(true);
  const out = toggle(false);
  for (const host of [renderedEl, railEl]) {
    host.addEventListener("mouseover", over);
    host.addEventListener("mouseout", out);
  }
  return () => {
    for (const host of [renderedEl, railEl]) {
      host.removeEventListener("mouseover", over);
      host.removeEventListener("mouseout", out);
    }
  };
}

/** Briefly pulse a block (restart the CSS animation). */
export function pulseBlock(node: Element | null): void {
  if (!node) return;
  const e = node as HTMLElement;
  e.classList.remove("anno-pulse");
  void e.offsetWidth; // force reflow so the animation restarts
  e.classList.add("anno-pulse");
}
```

- [ ] **Step 4: Wire `src/app.ts`**

1. Imports — add to the `./annotation-ui` import: `assignMarkers, linkAnnotationHovers, pulseBlock` (and keep `renderRail, applyHighlights, mountSelectionToolbar`).
2. Add a module-level teardown next to `teardownToolbar`:

```typescript
let teardownHovers: (() => void) | null = null;
```

3. In `renderRailFor`, compute markers and pass them, and pulse on scroll:

```typescript
function renderRailFor(): void {
  const host = document.getElementById("rail");
  if (!host) return;
  const doc = getActive(state);
  if (!doc) { host.innerHTML = ""; return; }
  const markers = assignMarkers(doc.annotations, doc.resolutions);
  renderRail(host, doc.annotations, doc.resolutions, markers, {
    onScrollTo: (a) => {
      const r = doc.resolutions[a.id];
      if (r?.startLine == null) return;
      const node = document.querySelector(`[data-sourceline="${r.startLine}"]`);
      node?.scrollIntoView({ behavior: "smooth", block: "center" });
      pulseBlock(node);
    },
    onRemove: (a) => {
      state = setDocAnnotations(state, doc.absPath, removeAnnotation(doc.annotations, a.id));
      void persistAnnotations(doc.absPath);
      render();
    },
  });
}
```

Note: `onScrollTo` scrolls to the block whose *first* line equals `startLine`. If the anchor is mid-block, `[data-sourceline="${startLine}"]` may not match; fall back to the annotated block. Replace the `node` lookup with:

```typescript
      const node = document.querySelector(`[data-annotation-ids~="${a.id}"]`)
        ?? document.querySelector(`[data-sourceline="${r.startLine}"]`);
```

4. In `renderContent`, update the `applyHighlights` call in the rendered branch:

```typescript
    const markers = assignMarkers(doc.annotations, doc.resolutions);
    applyHighlights(view, doc.annotations, doc.resolutions, markers);
```

5. In `render()`, after `renderRailFor();`, (re)mount hover linking:

```typescript
  if (teardownHovers) { teardownHovers(); teardownHovers = null; }
  const renderedView = document.querySelector<HTMLElement>(".rendered");
  const railEl = document.getElementById("rail");
  if (renderedView && railEl) teardownHovers = linkAnnotationHovers(renderedView, railEl);
```

- [ ] **Step 5: Verify**

Run: `pnpm exec tsc --noEmit` → 0 errors.
Run: `pnpm test` → all green (existing annotation-ui tests unaffected; `groupAnnotations`/`assignMarkers`/`annotationsForBlock` covered).

- [ ] **Step 6: Commit**

```bash
git add src/annotation-ui.ts src/app.ts
git commit -m "feat(annotations): range-based highlights, numbered markers, rail chips, hover-link"
```

---

### Task 4: Inline popover comment composer

**Files:**
- Create: `src/composer.ts` (`clampPopover` pure + `showCommentComposer` glue)
- Test: `src/composer.test.ts` (clampPopover only)
- Modify: `src/app.ts` (`startComment` uses the composer)

**Interfaces:**
- `clampPopover(anchor: {top;bottom;left}, size: {width;height}, viewport: {width;height}, gap?): {top;left}` — pure; prefer below the anchor, flip above if it would clip, clamp within viewport.
- `showCommentComposer(opts: { quote: string; anchor: DOMRect | {top;bottom;left}; onSubmit: (note: string) => void; onCancel: () => void }): void`.

- [ ] **Step 1 (4a, TDD): Write clampPopover tests**

Create `src/composer.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { clampPopover } from "./composer";

const vp = { width: 1000, height: 800 };
const size = { width: 300, height: 200 };

describe("clampPopover", () => {
  it("places below the anchor when there is room", () => {
    const p = clampPopover({ top: 100, bottom: 120, left: 50 }, size, vp);
    expect(p.top).toBe(128); // bottom + gap(8)
    expect(p.left).toBe(50);
  });
  it("flips above when below would clip the bottom", () => {
    const p = clampPopover({ top: 700, bottom: 720, left: 50 }, size, vp);
    expect(p.top).toBe(700 - 8 - 200); // above: top - gap - height = 492
  });
  it("clamps left so the card never runs off the right edge", () => {
    const p = clampPopover({ top: 100, bottom: 120, left: 900 }, size, vp);
    expect(p.left).toBe(1000 - 300 - 8); // 692
  });
  it("never returns a negative coordinate", () => {
    const p = clampPopover({ top: 5, bottom: 6, left: -20 }, size, vp);
    expect(p.top).toBeGreaterThanOrEqual(8);
    expect(p.left).toBeGreaterThanOrEqual(8);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm exec vitest run src/composer.test.ts`
Expected: FAIL — module/function missing.

- [ ] **Step 3: Implement `src/composer.ts`**

```typescript
interface Anchor { top: number; bottom: number; left: number }
interface Size { width: number; height: number }
interface Viewport { width: number; height: number }

/** Position a popover near an anchor, preferring below; flip above if it would
 *  clip the bottom, then clamp within the viewport. Viewport coordinates. */
export function clampPopover(anchor: Anchor, size: Size, viewport: Viewport, gap = 8): { top: number; left: number } {
  let top = anchor.bottom + gap;
  if (top + size.height > viewport.height && anchor.top - gap - size.height >= 0) {
    top = anchor.top - gap - size.height;
  }
  top = Math.max(gap, Math.min(top, viewport.height - size.height - gap));
  const left = Math.max(gap, Math.min(anchor.left, viewport.width - size.width - gap));
  return { top, left };
}

export function showCommentComposer(opts: {
  quote: string;
  anchor: { top: number; bottom: number; left: number };
  onSubmit: (note: string) => void;
  onCancel: () => void;
}): void {
  const { quote, anchor, onSubmit, onCancel } = opts;

  const card = document.createElement("div");
  card.className = "comment-composer";

  const head = document.createElement("div");
  head.className = "composer-head";
  head.textContent = "Add comment";

  const quoteEl = document.createElement("blockquote");
  quoteEl.className = "composer-quote";
  quoteEl.textContent = quote;

  const ta = document.createElement("textarea");
  ta.className = "composer-input";
  ta.placeholder = "Your note…";
  ta.rows = 3;

  const foot = document.createElement("div");
  foot.className = "composer-foot";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "composer-btn";
  cancelBtn.textContent = "Cancel";
  const saveBtn = document.createElement("button");
  saveBtn.className = "composer-btn primary";
  saveBtn.textContent = "Comment";
  foot.append(cancelBtn, saveBtn);

  card.append(head, quoteEl, ta, foot);
  document.body.appendChild(card);

  const pos = clampPopover(anchor, { width: card.offsetWidth, height: card.offsetHeight },
    { width: window.innerWidth, height: window.innerHeight });
  card.style.top = `${pos.top}px`;
  card.style.left = `${pos.left}px`;

  const close = () => { document.removeEventListener("mousedown", onDocDown, true); card.remove(); };
  const submit = () => { const v = ta.value.trim(); close(); if (v) onSubmit(v); else onCancel(); };
  const cancel = () => { close(); onCancel(); };
  saveBtn.onclick = submit;
  cancelBtn.onclick = cancel;
  ta.onkeydown = (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
    else if (e.key === "Escape") { e.preventDefault(); cancel(); }
  };
  const onDocDown = (e: MouseEvent) => { if (!card.contains(e.target as Node)) cancel(); };
  document.addEventListener("mousedown", onDocDown, true);
  ta.focus();
}
```

- [ ] **Step 4: Run clampPopover tests → pass**

Run: `pnpm exec vitest run src/composer.test.ts`
Expected: PASS.

- [ ] **Step 5 (4b, glue): Wire `startComment` in `src/app.ts`**

Replace the `promptText` import usage. Add `import { showCommentComposer } from "./composer";`. Rewrite `startComment`:

```typescript
function startComment(absPath: string): void {
  const doc = state.docs.find((d) => d.absPath === absPath);
  if (!doc) return;
  const cap = captureSelection(doc.editorContent);
  if (!cap) return;
  const sel = window.getSelection();
  const rect = sel && !sel.isCollapsed
    ? sel.getRangeAt(0).getBoundingClientRect()
    : ({ top: 120, bottom: 140, left: 120 } as DOMRect);
  showCommentComposer({
    quote: cap.quote,
    anchor: { top: rect.top, bottom: rect.bottom, left: rect.left },
    onSubmit: (note) => {
      const annotation: Annotation = {
        id: genId(), quote: cap.quote, prefix: cap.prefix, suffix: cap.suffix,
        lineHint: cap.lineHint, note, status: "open", author: "user",
        createdAt: new Date().toISOString(),
      };
      state = setDocAnnotations(state, absPath, addAnnotation(doc.annotations, annotation));
      void persistAnnotations(absPath);
      render();
    },
    onCancel: () => {},
  });
}
```

Update the caller in `renderContent` (it was `() => void startComment(doc.absPath)`) to `() => startComment(doc.absPath)`. Leave `promptText` imported only if still used elsewhere; otherwise drop it from the import (check: `promptText` was used only by comments — remove it from the `./modal` import to keep tsc clean).

- [ ] **Step 6: Verify**

Run: `pnpm exec tsc --noEmit` → 0 errors.
Run: `pnpm test` → all green.

- [ ] **Step 7: Commit**

```bash
git add src/composer.ts src/composer.test.ts src/app.ts
git commit -m "feat(annotations): inline popover comment composer with viewport clamp"
```

---

### Task 5: Styling — palette, markers, chips, emphasis, pulse, popover

**Files:**
- Modify: `src/styles.css`

Visual task; verified by running the app and tuned live. Replace the old `.rendered .annotated` rule and add the rest.

- [ ] **Step 1: Replace/extend the annotation CSS**

Replace the existing:

```css
.rendered .annotated {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  border-radius: 3px;
}
```

with block highlight keyed on `--anno-color`, gutter markers, rail chips, emphasis, pulse, and the popover. Starter values (tuned live):

```css
/* Annotated block: color-keyed bar + faint tint, marker(s) in the gutter. */
.rendered .annotated {
  position: relative;
  padding: 0.15em 0 0.15em 1.1em;
  margin-left: -1.1em;
  background: color-mix(in srgb, var(--anno-color, var(--accent)) 10%, transparent);
  border-radius: 4px;
}
.rendered .annotated::before {
  content: "";
  position: absolute;
  left: 0; top: 0.15em; bottom: 0.15em;
  width: 3px; border-radius: 99px;
  background: var(--anno-color, var(--accent));
  opacity: 0.85;
}
.anno-marker-stack {
  position: absolute;
  left: -2.1em; top: 0.1em;
  display: flex; flex-direction: column; gap: 3px;
}
.anno-marker {
  width: 18px; height: 18px; border-radius: 50%;
  display: grid; place-items: center;
  font: 600 11px/1 var(--font-mono, system-ui);
  color: #fff;
  background: var(--anno-color, var(--accent));
  cursor: default; user-select: none;
  box-shadow: 0 1px 3px rgba(0,0,0,.25);
}
.rendered .annotated.anno-emphasis {
  background: color-mix(in srgb, var(--anno-color, var(--accent)) 20%, transparent);
}
.anno-marker.anno-emphasis { transform: scale(1.15); }

/* Rail number chip mirrors the marker. */
.note-chip {
  flex: 0 0 auto;
  width: 18px; height: 18px; border-radius: 50%;
  display: grid; place-items: center;
  font: 600 11px/1 var(--font-mono, system-ui);
  color: #fff; background: var(--anno-color, var(--accent));
}
.note-card.anno-emphasis { background: var(--raised, #0001); outline: 1px solid var(--anno-color, var(--accent)); }

/* Click-to-scroll pulse. */
@keyframes anno-pulse {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--anno-color, var(--accent)) 55%, transparent); }
  100% { box-shadow: 0 0 0 10px transparent; }
}
.rendered .anno-pulse { animation: anno-pulse 0.7s ease-out 1; }

/* Inline popover composer. */
.comment-composer {
  position: fixed; z-index: 60; width: 320px; max-width: calc(100vw - 24px);
  background: var(--surface); color: var(--ink);
  border: 1px solid var(--border); border-radius: 10px;
  box-shadow: 0 8px 30px rgba(0,0,0,.28);
  padding: 12px; display: flex; flex-direction: column; gap: 10px;
}
.composer-head { font: 600 12px/1 var(--font-mono, system-ui); text-transform: uppercase; color: var(--faint); }
.composer-quote {
  margin: 0; padding: 6px 10px; border-left: 3px solid var(--accent-line, var(--accent));
  background: var(--raised, #0001); border-radius: 0 6px 6px 0;
  font-size: 13px; color: var(--ink-soft, var(--ink));
  max-height: 5.5em; overflow-y: auto;
}
.composer-input {
  width: 100%; box-sizing: border-box; resize: vertical; min-height: 3.5em;
  font-family: var(--font-body); font-size: 14px; line-height: 1.5;
  color: var(--ink); background: var(--bg); border: 1px solid var(--border);
  border-radius: 6px; padding: 8px 10px;
}
.composer-input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.composer-foot { display: flex; justify-content: flex-end; gap: 8px; }
.composer-btn {
  font: 500 13px/1 var(--font-body); padding: 6px 12px; border-radius: 6px;
  border: 1px solid var(--border); background: transparent; color: var(--ink); cursor: pointer;
}
.composer-btn.primary { background: var(--accent); border-color: var(--accent); color: var(--bg); }
```

- [ ] **Step 2: Verify build**

Run: `pnpm exec tsc --noEmit` → 0 errors. `pnpm build` → succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/styles.css
git commit -m "style(annotations): color-keyed highlights, gutter markers, chips, popover"
```

---

## Manual verification (controller, after all tasks — run the app)

```bash
pnpm tauri dev
```
On a multi-paragraph doc with 3+ annotations spanning single- and multi-line blocks:
1. **Coverage:** an annotation anchored to a non-first line of a multi-line block now highlights (previously missed).
2. **Identity:** each highlighted block shows a colored gutter number; the rail card shows the same colored number; a block with two annotations stacks two markers.
3. **Hover-link:** hovering a rail card emphasizes its block + marker and vice versa.
4. **Pulse:** clicking a rail card scrolls to and pulses the block.
5. **Composer:** selecting text → Comment opens the inline popover by the selection (clamped near screen edges); the quote shows as a blockquote; ⌘Enter saves, Esc/click-outside cancels; the new annotation appears with the next number/color.
Tune `MARKER_PALETTE` and the CSS live via HMR.

## Self-Review Notes

- **Spec coverage:** end-line (T1) → coverage fix (T3 `applyHighlights` range intersection); `assignMarkers`/`annotationsForBlock` (T2); markers + chips + hover + pulse (T3); inline composer + clamp (T4); palette/markers/emphasis/pulse/popover CSS (T5). All spec sections mapped.
- **Type consistency:** `assignMarkers`→`Map<string,Marker>` consumed by `applyHighlights`(T3) and `renderRail`(T3) and computed in both `renderContent`/`renderRailFor`(T3, app.ts) from the same `(doc.annotations, doc.resolutions)`. `annotationsForBlock` returns `string[]` filtered/sorted by the marker map. `clampPopover` signature identical in test (T4a) and impl (T4).
- **Scope excludes** (char-precise highlight, threads, persisted colors) implemented nowhere.
