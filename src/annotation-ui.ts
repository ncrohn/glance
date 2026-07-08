import type { Annotation, Resolution } from "./annotations";

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

  const onUp = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !renderedEl.contains(sel.anchorNode)) {
      btn.style.display = "none";
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    btn.style.display = "block";
    btn.style.top = `${window.scrollY + rect.top - 36}px`;
    btn.style.left = `${window.scrollX + rect.left}px`;
  };
  document.addEventListener("mouseup", onUp);
  return () => { document.removeEventListener("mouseup", onUp); btn.remove(); };
}

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
