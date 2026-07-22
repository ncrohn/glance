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
const COPY_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.6"/><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4V9A1.5 1.5 0 0 0 4 10.5H5.5"/></svg>';
const CHECK_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5L6.5 12L13 4.5"/></svg>';

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
    // Code blocks (a bare <pre>) get a click-to-copy button.
    if (block.tagName === "PRE") {
      wrap.appendChild(makeCopyButton(block));
    }
    wrap.appendChild(makeButton(wrap));
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for webviews where the async Clipboard API is unavailable.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

function makeCopyButton(pre: HTMLElement): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "block-expand-btn block-copy-btn";
  btn.type = "button";
  btn.innerHTML = COPY_ICON;
  btn.setAttribute("aria-label", "Copy code");
  let resetTimer = 0;
  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const code = (pre.querySelector("code") ?? pre).textContent ?? "";
    const ok = await copyText(code.replace(/\n$/, ""));
    btn.innerHTML = ok ? CHECK_ICON : COPY_ICON;
    btn.classList.toggle("copied", ok);
    btn.setAttribute("aria-label", ok ? "Copied" : "Copy failed");
    clearTimeout(resetTimer);
    resetTimer = window.setTimeout(() => {
      btn.innerHTML = COPY_ICON;
      btn.classList.remove("copied");
      btn.setAttribute("aria-label", "Copy code");
    }, 1400);
  });
  return btn;
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
