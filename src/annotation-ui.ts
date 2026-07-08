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
      const res = resolutions[a.id];
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

/** Wrap the resolved line ranges in the rendered view with a highlight class. */
export function applyHighlights(
  renderedEl: HTMLElement,
  resolutions: Record<string, Resolution>,
): void {
  const lines = new Set<number>();
  for (const r of Object.values(resolutions)) {
    if (r.startLine == null || r.endLine == null) continue;
    for (let l = r.startLine; l <= r.endLine; l++) lines.add(l);
  }
  renderedEl.querySelectorAll<HTMLElement>("[data-sourceline]").forEach((node) => {
    const l = parseInt(node.dataset.sourceline ?? "0", 10);
    node.classList.toggle("annotated", lines.has(l));
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
