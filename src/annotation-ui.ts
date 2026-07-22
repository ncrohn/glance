import type { Annotation, Resolution } from "./annotations";
import { locateQuote } from "./annotation-highlight";
import { inlineToText } from "./renderer";

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

export interface Grouped {
  open: Annotation[];
  resolved: Annotation[];
  orphaned: Annotation[];
}

/** Bucket annotations for the rail. An open annotation whose current
 *  resolution is "orphaned" is shown in the orphaned group. */
export function groupAnnotations(
  list: Annotation[],
  resolutions: Record<string, Resolution>,
): Grouped {
  const g: Grouped = { open: [], resolved: [], orphaned: [] };
  for (const a of list) {
    if (a.status === "resolved") { g.resolved.push(a); continue; }
    if (resolutions[a.id]?.anchor === "orphaned" || a.status === "orphaned") {
      g.orphaned.push(a);
      continue;
    }
    g.open.push(a);
  }
  return g;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export interface RailHandlers {
  onScrollTo: (a: Annotation) => void;
  onRemove: (a: Annotation) => void;
}

/** Render the annotations rail into `host`. Pure DOM construction. */
export function renderRail(
  host: HTMLElement,
  list: Annotation[],
  resolutions: Record<string, Resolution>,
  markers: Map<string, Marker>,
  handlers: RailHandlers,
): void {
  host.innerHTML = "";
  const g = groupAnnotations(list, resolutions);
  const total = list.length;
  if (total === 0) { host.classList.add("empty"); return; }
  host.classList.remove("empty");

  const section = (title: string, items: Annotation[], cls: string) => {
    if (!items.length) return;
    host.appendChild(el("div", "rail-head", `${title} (${items.length})`));
    for (const a of items) {
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
    }
  };

  section("Open", g.open, "open");
  section("Orphaned", g.orphaned, "orphaned");
  section("Resolved", g.resolved, "resolved");
}

/** Highlight the exact quoted text of each open annotation (a tinted <mark>),
 *  and place a numbered gutter marker in the left margin aligned to it. When the
 *  quote can't be located in the rendered text (multi-block span, or a formatted
 *  quote that doesn't match), fall back to a gutter marker only, aligned to the
 *  block. Purely a render pass over a freshly-rendered view. */
export function applyHighlights(
  renderedEl: HTMLElement,
  annotations: Annotation[],
  resolutions: Record<string, Resolution>,
  markers: Map<string, Marker>,
): void {
  clearHighlights(renderedEl);

  // Order by marker number so gutter stacking is stable top-to-bottom.
  const ordered = [...markers.keys()].sort(
    (a, b) => markers.get(a)!.number - markers.get(b)!.number,
  );
  const placed: { top: number; lane: number }[] = [];

  for (const id of ordered) {
    const a = annotations.find((x) => x.id === id);
    const r = resolutions[id];
    if (!a || !r || r.startLine == null) continue;
    const marker = markers.get(id)!;

    const block = blockAtLine(renderedEl, r.startLine);
    if (!block) continue;

    const marks = highlightQuoteIn(block, a, marker.color);
    placeGutterMarker(renderedEl, marks[0] ?? block, marker, id, placed);
  }
}

// Undo a previous pass (defensive — the view is normally re-rendered fresh).
function clearHighlights(renderedEl: HTMLElement): void {
  renderedEl.querySelectorAll("mark.anno-highlight").forEach((m) => {
    m.replaceWith(document.createTextNode(m.textContent ?? ""));
  });
  renderedEl.normalize();
  renderedEl.querySelectorAll(".anno-gutter-marker").forEach((m) => m.remove());
}

// The innermost [data-sourceline] block whose source range covers `line`.
function blockAtLine(renderedEl: HTMLElement, line: number): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestSpan = Infinity;
  renderedEl.querySelectorAll<HTMLElement>("[data-sourceline]").forEach((el) => {
    const s = parseInt(el.dataset.sourceline ?? "0", 10);
    const e = parseInt(el.dataset.sourcelineEnd ?? el.dataset.sourceline ?? "0", 10);
    if (s <= line && line <= e && e - s < bestSpan) {
      best = el;
      bestSpan = e - s;
    }
  });
  return best;
}

// Wrap the annotation's quote text inside `block` in <mark> spans. Returns the
// created marks (empty when the quote couldn't be located).
function highlightQuoteIn(
  block: HTMLElement,
  a: Annotation,
  color: string,
): HTMLElement[] {
  const nodes = textNodesIn(block);
  const text = nodes.map((n) => n.data).join("");
  const range = locateQuote(
    text,
    inlineToText(a.quote),
    inlineToText(a.prefix),
    inlineToText(a.suffix),
  );
  if (!range || range.end <= range.start) return [];
  return wrapTextRange(nodes, range.start, range.end, a.id, color);
}

function textNodesIn(root: Node): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const out: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

// Wrap [qs, qe) — offsets into the concatenation of `nodes` — in per-text-node
// <mark> spans (a selection can cross inline elements like <strong>, so we can't
// surroundContents the whole range).
function wrapTextRange(
  nodes: Text[],
  qs: number,
  qe: number,
  id: string,
  color: string,
): HTMLElement[] {
  const targets: { node: Text; s: number; e: number }[] = [];
  let pos = 0;
  for (const node of nodes) {
    const len = node.data.length;
    if (pos + len > qs && pos < qe) {
      targets.push({ node, s: Math.max(qs, pos) - pos, e: Math.min(qe, pos + len) - pos });
    }
    pos += len;
  }
  const marks: HTMLElement[] = [];
  for (const { node, s, e } of targets) {
    let mid = node;
    if (e < mid.data.length) mid.splitText(e); // trim tail first so `s` stays valid
    if (s > 0) mid = mid.splitText(s);
    const mark = document.createElement("mark");
    mark.className = "anno-highlight";
    mark.dataset.annotationId = id;
    mark.style.setProperty("--anno-color", color);
    mid.parentNode!.insertBefore(mark, mid);
    mark.appendChild(mid);
    marks.push(mark);
  }
  return marks;
}

const GUTTER_LANE_X = 14; // px from the rendered view's left edge (inside padding)
const GUTTER_LANE_STEP = 20;

// Place a numbered marker in the left gutter, vertically aligned to `anchorEl`.
// Markers landing on the same row fan out into adjacent lanes so they don't
// overlap — the key to tracking multiple annotations near each other.
function placeGutterMarker(
  renderedEl: HTMLElement,
  anchorEl: HTMLElement,
  marker: Marker,
  id: string,
  placed: { top: number; lane: number }[],
): void {
  const top = anchorEl.getBoundingClientRect().top - renderedEl.getBoundingClientRect().top;
  let lane = 0;
  for (const p of placed) {
    if (Math.abs(p.top - top) < 16) lane = Math.max(lane, p.lane + 1);
  }
  placed.push({ top, lane });

  const chip = el("span", "anno-gutter-marker", String(marker.number));
  chip.dataset.annotationId = id;
  chip.style.setProperty("--anno-color", marker.color);
  chip.style.top = `${top}px`;
  chip.style.left = `${GUTTER_LANE_X + lane * GUTTER_LANE_STEP}px`;
  renderedEl.appendChild(chip);
}

/** Show a floating "Comment" button when the user selects text in the view. */
export function mountSelectionToolbar(
  renderedEl: HTMLElement,
  onComment: () => void,
): () => void {
  const btn = el("button", "comment-fab", "Comment");
  btn.style.display = "none";
  document.body.appendChild(btn);
  btn.onmousedown = (e) => { e.preventDefault(); }; // keep selection alive
  btn.onclick = () => { btn.style.display = "none"; onComment(); };

  // The rendered view scrolls inside #content, not the window, so the button
  // (position: fixed) is placed in viewport coordinates and re-placed on scroll
  // so it tracks the selected text instead of sticking to the window. Hidden
  // when the selection is gone or has scrolled out of the scroller's viewport.
  const scroller = renderedEl.closest<HTMLElement>("#content");
  const place = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !renderedEl.contains(sel.anchorNode)) {
      btn.style.display = "none";
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const clip = scroller?.getBoundingClientRect();
    if (clip && (rect.bottom < clip.top || rect.top > clip.bottom)) {
      btn.style.display = "none";
      return;
    }
    btn.style.display = "block";
    btn.style.top = `${rect.top - 36}px`;
    btn.style.left = `${rect.left}px`;
  };
  document.addEventListener("mouseup", place);
  scroller?.addEventListener("scroll", place, { passive: true });
  window.addEventListener("resize", place);
  return () => {
    document.removeEventListener("mouseup", place);
    scroller?.removeEventListener("scroll", place);
    window.removeEventListener("resize", place);
    btn.remove();
  };
}

/** Bidirectional hover emphasis between rendered blocks/markers and rail cards. */
export function linkAnnotationHovers(renderedEl: HTMLElement, railEl: HTMLElement): () => void {
  const setEmphasis = (id: string, on: boolean) => {
    const sel = `mark.anno-highlight[data-annotation-id="${id}"], .anno-gutter-marker[data-annotation-id="${id}"], .note-card[data-annotation-id="${id}"]`;
    renderedEl.querySelectorAll(sel).forEach((n) => (n as HTMLElement).classList.toggle("anno-emphasis", on));
    railEl.querySelectorAll(sel).forEach((n) => (n as HTMLElement).classList.toggle("anno-emphasis", on));
  };
  const idsFrom = (t: HTMLElement): string[] => {
    if (t.dataset.annotationId) return [t.dataset.annotationId];
    if (t.dataset.annotationIds) return t.dataset.annotationIds.split(" ");
    return [];
  };
  const toggle = (on: boolean) => (e: Event) => {
    const t = (e.target as HTMLElement).closest("[data-annotation-id]") as HTMLElement | null;
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
