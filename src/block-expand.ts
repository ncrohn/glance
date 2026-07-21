// Attaches an optional "expand" affordance to wide blocks (code and tables) in
// the rendered view. Clicking widens that single block to the full content pane
// (see the `.expanded` breakout rules in styles.css, driven by --pane-w) so a
// wide table or long code line is easier to read; clicking again restores it.
//
// This is ephemeral view glue, not document state: a full re-render replaces the
// view's innerHTML and remounts fresh (everything collapsed again). The mounter
// is idempotent so calling it twice on the same node is harmless.

import { openMermaidZoom } from "./mermaid-zoom";

const EXPAND_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2.5H13.5V6.5M6.5 13.5H2.5V9.5M13.5 2.5L9 7M2.5 13.5L7 9"/></svg>';
const COLLAPSE_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3L9.5 6.5M9.5 6.5V3M9.5 6.5H13M3 13L6.5 9.5M6.5 9.5V13M6.5 9.5H3"/></svg>';
const ZOOM_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="4.3"/><path d="M13.5 13.5L10.1 10.1M7 5.2V8.8M5.2 7H8.8"/></svg>';

export function mountBlockExpanders(view: HTMLElement): void {
  const blocks = view.querySelectorAll<HTMLElement>(
    "pre:not(.mermaid-block), .table-scroll, .mermaid-diagram",
  );
  for (const block of blocks) {
    // Idempotent: skip anything already wrapped.
    if (block.parentElement?.classList.contains("block-expand-wrap")) continue;
    // Wrap the block in a non-scrolling positioned box. The button anchors to
    // the wrapper (not the scroll container) so it stays put — and above the
    // block — when the code/table is scrolled horizontally. The wrapper is also
    // the element that animates its width when expanding.
    const wrap = document.createElement("div");
    wrap.className = "block-expand-wrap";
    block.parentNode?.insertBefore(wrap, block);
    wrap.appendChild(block);
    // Mermaid diagrams also get a zoom button (fine detail is easier in the
    // pan/zoom viewer than by widening the diagram in place).
    if (block.classList.contains("mermaid-diagram")) {
      wrap.appendChild(makeZoomButton(block));
    }
    wrap.appendChild(makeButton(wrap));
  }
}

function makeZoomButton(diagram: HTMLElement): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "block-expand-btn block-zoom-btn";
  btn.type = "button";
  btn.innerHTML = ZOOM_ICON;
  btn.setAttribute("aria-label", "Zoom diagram");
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openMermaidZoom(diagram);
  });
  return btn;
}

function makeButton(block: HTMLElement): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "block-expand-btn";
  btn.type = "button";
  btn.innerHTML = EXPAND_ICON;
  btn.setAttribute("aria-label", "Expand to fit window");
  btn.setAttribute("aria-expanded", "false");
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const expanded = block.classList.toggle("expanded");
    btn.innerHTML = expanded ? COLLAPSE_ICON : EXPAND_ICON;
    btn.setAttribute("aria-expanded", String(expanded));
    btn.setAttribute(
      "aria-label",
      expanded ? "Collapse to reading width" : "Expand to fit window",
    );
  });
  return btn;
}
