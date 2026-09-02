import type { AnchorKind, Annotation, Reply, Resolution } from "./annotations";
import { locateQuote } from "./annotation-highlight";
import { toVisible } from "./markdown-visible";

export interface Marker {
  number: number;
  color: string;
}

// Six marker slots; number disambiguates when colors recycle. Each theme
// defines the actual colors as --anno-1..6 in styles.css (hue order is always
// amber, teal, violet, rose, green, blue), and palette.test.ts holds every
// theme to WCAG contrast targets.
export const MARKER_PALETTE = [
  "var(--anno-1)", // amber
  "var(--anno-2)", // teal
  "var(--anno-3)", // violet
  "var(--anno-4)", // rose
  "var(--anno-5)", // green
  "var(--anno-6)", // blue
];

// Color for a stored number: 1 → first slot, wrapping. 0 (server add still
// in flight) takes the first slot too.
export function markerColor(number: number): string {
  return MARKER_PALETTE[number > 0 ? (number - 1) % MARKER_PALETTE.length : 0];
}

// What a chip shows for a number; 0 is a placeholder until the store answers.
export function markerLabel(number: number): string {
  return number > 0 ? String(number) : "\u00b7";
}

// Per-annotation number + color for open, anchored annotations. The number is
// the one the store assigned at creation and never changes, so adding a
// comment above does not renumber the ones below. The rail and the
// highlights both consume this map.
export function assignMarkers(
  annotations: Annotation[],
  resolutions: Record<string, Resolution>,
): Map<string, Marker> {
  const map = new Map<string, Marker>();
  for (const a of annotations) {
    if (a.status !== "open" || resolutions[a.id]?.startLine == null) continue;
    map.set(a.id, { number: a.number, color: markerColor(a.number) });
  }
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

function byCreatedThenId(x: Annotation, y: Annotation): number {
  if (x.createdAt !== y.createdAt) return x.createdAt < y.createdAt ? -1 : 1;
  if (x.id !== y.id) return x.id < y.id ? -1 : 1;
  return 0;
}

/** Bucket annotations for the rail. An open annotation whose current
 *  resolution is "orphaned" is shown in the orphaned group. Open is in
 *  document order (unresolved lines last); orphaned is newest first;
 *  resolved is most recently resolved first (createdAt when resolvedAt is
 *  missing, as on stores written before it existed). */
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
  g.open.sort((x, y) => {
    const lx = resolutions[x.id]?.startLine ?? null;
    const ly = resolutions[y.id]?.startLine ?? null;
    if (lx == null && ly != null) return 1;
    if (lx != null && ly == null) return -1;
    if (lx != null && ly != null && lx !== ly) return lx - ly;
    return byCreatedThenId(x, y);
  });
  const newestFirst = (x: Annotation, y: Annotation) => -byCreatedThenId(x, y);
  g.orphaned.sort(newestFirst);
  g.resolved.sort((x, y) => {
    const rx = x.resolvedAt ?? x.createdAt;
    const ry = y.resolvedAt ?? y.createdAt;
    if (rx !== ry) return rx < ry ? 1 : -1;
    return newestFirst(x, y);
  });
  return g;
}

export type RailPref = "open" | "collapsed";

/** Parse the persisted rail preference; anything unrecognised is "open". */
export function parseRailPref(raw: string | null): RailPref {
  return raw === "collapsed" ? "collapsed" : "open";
}

export interface CardModel {
  number: number | null;
  color: string | null;
  line: string;
  anchor: AnchorKind | "none";
  author: Annotation["author"];
  tag: string | null;
  note: string;
  quote: string;
  replies: Reply[];
  done: boolean;
}

const QUOTE_MAX = 80;

/** Everything a rail card displays, derived from the annotation, its current
 *  resolution, and its marker (if any). Pure; `renderRail` builds DOM from it. */
export function cardModel(
  a: Annotation,
  res: Resolution | undefined,
  marker: Marker | undefined,
): CardModel {
  const anchor: AnchorKind | "none" = res?.anchor ?? "none";
  const done = a.status === "resolved";
  const orphaned = anchor === "orphaned" || a.status === "orphaned";
  const tag = done ? null : anchor === "drifted" ? "moved" : orphaned ? "not found" : null;
  const collapsed = a.quote.replace(/\s+/g, " ").trim();
  const quote = collapsed.length > QUOTE_MAX ? collapsed.slice(0, QUOTE_MAX).trimEnd() + "…" : collapsed;
  return {
    number: done ? null : marker?.number ?? null,
    color: marker?.color ?? null,
    line: res?.startLine != null ? `L${res.startLine}` : "—",
    anchor,
    author: a.author,
    tag,
    note: a.note,
    quote,
    replies: a.replies ?? [],
    done,
  };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export interface RailHandlers {
  onScrollTo: (a: Annotation) => void;
  onResolve: (a: Annotation) => void;
  onReopen: (a: Annotation) => void;
  onEdit: (a: Annotation) => void;
  onReply: (a: Annotation, text: string) => void;
  onRemove: (a: Annotation) => void;
  onClearResolved: (ids: string[]) => void;
}

export interface RailOpts {
  pref: RailPref;
  resolvedOpen: boolean;
  onTogglePref: () => void;
  onToggleResolved: () => void;
}

/** Render the annotations rail into `host`. Pure DOM construction. */
export function renderRail(
  host: HTMLElement,
  list: Annotation[],
  resolutions: Record<string, Resolution>,
  markers: Map<string, Marker>,
  handlers: RailHandlers,
  opts: RailOpts,
): void {
  host.innerHTML = "";
  const g = groupAnnotations(list, resolutions);
  const total = list.length;
  if (total === 0) { host.classList.add("empty"); return; }
  host.classList.remove("empty");

  const collapsed = opts.pref === "collapsed";
  host.classList.toggle("collapsed", collapsed);

  const bar = el("div", "rail-bar");
  if (!collapsed) bar.appendChild(el("span", "rail-title", "Comments"));
  bar.appendChild(el("span", "rail-count", `${g.open.length} open`));
  if (!collapsed) bar.appendChild(el("span", "note-spacer"));
  const toggle = el("button", "rail-collapse", collapsed ? "›" : "‹");
  toggle.title = collapsed ? "Show comments" : "Hide comments";
  toggle.onclick = (ev) => { ev.stopPropagation(); opts.onTogglePref(); };
  bar.appendChild(toggle);
  host.appendChild(bar);
  if (collapsed) return;

  // A null title means the caller already rendered the header (Resolved).
  const section = (title: string | null, items: Annotation[], cls: string) => {
    if (!items.length) return;
    if (title) host.appendChild(el("div", "rail-head", `${title} (${items.length})`));
    for (const a of items) {
      const m = cardModel(a, resolutions[a.id], markers.get(a.id));
      const card = el("div", `note-card ${cls}`);
      if (m.anchor === "drifted") card.classList.add("drifted");
      if (m.author === "claude") card.classList.add("by-claude");
      card.dataset.annotationId = a.id;
      if (m.color) card.style.setProperty("--anno-color", m.color);

      const head = el("div", "note-head");
      if (m.done) head.appendChild(el("span", "note-chip done", "✓"));
      else if (m.number != null) head.appendChild(el("span", "note-chip", markerLabel(m.number)));
      head.appendChild(el("span", "note-line", m.line));
      if (m.author === "claude") head.appendChild(el("span", "note-tag", "Claude"));
      if (m.tag) head.appendChild(el("span", "note-tag", m.tag));
      head.appendChild(el("span", "note-spacer"));
      const actions = el("div", "note-actions");
      const action = (glyph: string, title: string, run: () => void) => {
        const btn = el("button", "note-action", glyph);
        btn.title = title;
        btn.onclick = (ev) => { ev.stopPropagation(); run(); };
        actions.appendChild(btn);
      };
      // Replies sit between the note and the quote; the reply box, when open,
      // goes under them. Both stop mouse events so the card's scroll-to
      // does not fire while the user is reading or typing.
      const replies = el("div", "note-replies");
      for (const r of m.replies) {
        const row = el("div", "note-reply");
        row.appendChild(el("span", "note-reply-author", r.author === "claude" ? "Claude" : "You"));
        row.appendChild(el("span", "note-reply-text", r.text));
        replies.appendChild(row);
      }
      const openReplyBox = () => {
        if (replies.querySelector(".note-reply-box")) {
          replies.querySelector<HTMLTextAreaElement>(".note-reply-box textarea")?.focus();
          return;
        }
        const box = el("div", "note-reply-box");
        const input = el("textarea");
        input.rows = 1;
        input.placeholder = "Reply…";
        const close = () => box.remove();
        const send = () => {
          const text = input.value.trim();
          if (!text) return;
          handlers.onReply(a, text);
          close();
        };
        input.onkeydown = (ev) => {
          if (ev.key === "Escape") { ev.preventDefault(); close(); }
          else if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); send(); }
        };
        box.onmousedown = (ev) => ev.stopPropagation();
        box.onclick = (ev) => ev.stopPropagation();
        box.appendChild(input);
        replies.appendChild(box);
        input.focus();
      };
      if (m.done) {
        action("↺", "Reopen", () => handlers.onReopen(a));
      } else {
        action("✓", "Resolve", () => handlers.onResolve(a));
        action("✎", "Edit", () => handlers.onEdit(a));
        action("↩", "Reply", openReplyBox);
        action("×", "Delete", () => handlers.onRemove(a));
      }
      head.appendChild(actions);
      card.appendChild(head);

      const noteEl = el("div", "note-text", m.note);
      card.appendChild(noteEl);
      if (m.replies.length || !m.done) card.appendChild(replies);
      if (m.quote) card.appendChild(el("div", "note-quote", m.quote));
      card.onclick = () => handlers.onScrollTo(a);
      host.appendChild(card);

      // Clamp is CSS; only offer "more" when it actually cut something off.
      if (noteEl.scrollHeight > noteEl.clientHeight + 1) {
        const more = el("button", "note-more", "more");
        more.onclick = (ev) => {
          ev.stopPropagation();
          const expanded = noteEl.classList.toggle("expanded");
          more.textContent = expanded ? "less" : "more";
        };
        noteEl.insertAdjacentElement("afterend", more);
      }
    }
  };

  section("Open", g.open, "open");
  section("Orphaned", g.orphaned, "orphaned");

  if (g.resolved.length) {
    const row = el("div", "rail-head rail-toggle");
    row.appendChild(el("span", "rail-glyph", opts.resolvedOpen ? "▾" : "▸"));
    row.appendChild(el("span", undefined, `Resolved (${g.resolved.length})`));
    row.appendChild(el("span", "note-spacer"));
    const clear = el("button", "rail-clear", "Clear");
    clear.onclick = (ev) => {
      ev.stopPropagation();
      handlers.onClearResolved(g.resolved.map((a) => a.id));
    };
    row.appendChild(clear);
    row.onclick = () => opts.onToggleResolved();
    host.appendChild(row);
    if (opts.resolvedOpen) section(null, g.resolved, "resolved");
  }
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
  onActivate?: (id: string) => void,
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
    for (const mark of marks) {
      // A drag-selection that ends on a highlight is not a click.
      mark.onclick = (e) => {
        if (window.getSelection()?.isCollapsed) {
          e.stopPropagation();
          onActivate?.(id);
        }
      };
    }
    placeGutterMarker(renderedEl, marks[0] ?? block, marker, id, r.anchor, a.author, placed, onActivate);
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
    toVisible(a.quote),
    toVisible(a.prefix),
    toVisible(a.suffix),
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
  anchor: AnchorKind,
  author: Annotation["author"],
  placed: { top: number; lane: number }[],
  onActivate?: (id: string) => void,
): void {
  const top = anchorEl.getBoundingClientRect().top - renderedEl.getBoundingClientRect().top;
  let lane = 0;
  for (const p of placed) {
    if (Math.abs(p.top - top) < 16) lane = Math.max(lane, p.lane + 1);
  }
  placed.push({ top, lane });

  const chip = el("span", "anno-gutter-marker", markerLabel(marker.number));
  if (anchor === "drifted") chip.classList.add("drifted");
  if (author === "claude") chip.classList.add("by-claude");
  chip.dataset.annotationId = id;
  chip.style.setProperty("--anno-color", marker.color);
  chip.style.top = `${top}px`;
  chip.style.left = `${GUTTER_LANE_X + lane * GUTTER_LANE_STEP}px`;
  chip.onclick = (e) => { e.stopPropagation(); onActivate?.(id); };
  renderedEl.appendChild(chip);
}

export interface Box { top: number; bottom: number; left: number; right: number }

/**
 * Where to put the floating Comment button for selection `sel` inside the
 * scroller `clip`. Prefers above the selection; flips below when there is no
 * room above. `left` is clamped so the button stays inside `clip`. Returns
 * null when the selection has scrolled entirely out of `clip`.
 */
export function fabPosition(
  sel: Box,
  clip: Box,
  size: { width: number; height: number },
  gap = 8,
): { top: number; left: number } | null {
  if (sel.bottom < clip.top || sel.top > clip.bottom) return null;
  const pad = 4;
  let top = sel.top - size.height - gap;
  if (top < clip.top + pad) top = sel.bottom + gap;
  const minLeft = clip.left + pad;
  const maxLeft = clip.right - size.width - pad;
  const left = Math.max(minLeft, Math.min(sel.left, maxLeft));
  return { top, left };
}

const FAB_FALLBACK_SIZE = { width: 96, height: 26 };

/** Show a floating "Comment" button whenever the user has text selected in the view. */
export function mountSelectionToolbar(
  renderedEl: HTMLElement,
  onComment: () => void,
): { hide(): void; destroy(): void } {
  const btn = el("button", "comment-fab", "Comment");
  btn.appendChild(el("kbd", undefined, "\u2318\u21e7M"));
  btn.style.display = "none";
  document.body.appendChild(btn);
  btn.onmousedown = (e) => { e.preventDefault(); }; // keep selection alive
  const hide = () => { btn.style.display = "none"; };
  btn.onclick = () => { hide(); onComment(); };

  // The rendered view scrolls inside #content, not the window, so the button
  // (position: fixed) is placed in viewport coordinates and re-placed on scroll
  // so it tracks the selected text instead of sticking to the window. Hidden
  // when the selection is gone or has scrolled out of the scroller's viewport.
  const scroller = renderedEl.closest<HTMLElement>("#content");
  const measure = (): { width: number; height: number } => {
    if (btn.style.display !== "none") return { width: btn.offsetWidth, height: btn.offsetHeight };
    btn.style.visibility = "hidden";
    btn.style.display = "block";
    const size = { width: btn.offsetWidth, height: btn.offsetHeight };
    btn.style.display = "none";
    btn.style.visibility = "";
    return size.width > 0 && size.height > 0 ? size : FAB_FALLBACK_SIZE;
  };
  const place = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !renderedEl.contains(sel.anchorNode)) {
      hide();
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const clip = scroller?.getBoundingClientRect() ?? {
      top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth,
    };
    const pos = fabPosition(rect, clip, measure());
    if (!pos) { hide(); return; }
    btn.style.display = "block";
    btn.style.top = `${pos.top}px`;
    btn.style.left = `${pos.left}px`;
  };
  let pending: ReturnType<typeof setTimeout> | null = null;
  const onSelectionChange = () => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => { pending = null; place(); }, 80);
  };
  document.addEventListener("selectionchange", onSelectionChange);
  scroller?.addEventListener("scroll", place, { passive: true });
  window.addEventListener("resize", place);
  return {
    hide,
    destroy() {
      if (pending) { clearTimeout(pending); pending = null; }
      document.removeEventListener("selectionchange", onSelectionChange);
      scroller?.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
      btn.remove();
    },
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

/** Scroll the rail to an annotation's card and pulse it (text → card). */
export function focusRailCard(railEl: HTMLElement, id: string): void {
  const card = railEl.querySelector<HTMLElement>(`.note-card[data-annotation-id="${id}"]`);
  if (!card) return;
  card.scrollIntoView({ block: "nearest", behavior: "smooth" });
  card.classList.remove("anno-emphasis", "anno-pulse-card");
  void card.offsetWidth; // force reflow so the animation restarts
  card.classList.add("anno-emphasis", "anno-pulse-card");
  if (card.dataset.emphasisTimer) clearTimeout(Number(card.dataset.emphasisTimer));
  card.dataset.emphasisTimer = String(setTimeout(() => {
    card.classList.remove("anno-emphasis", "anno-pulse-card");
    delete card.dataset.emphasisTimer;
  }, 1500));
}
