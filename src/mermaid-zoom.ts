// A lightweight full-window pan/zoom viewer for a rendered mermaid diagram.
// Opened from the zoom button that block-expand.ts attaches to each diagram.
// Scroll wheel zooms toward the cursor, drag pans, Esc / backdrop / close button
// dismiss. No dependency on the mermaid library — it just transforms a clone of
// the already-rendered SVG.

const MIN_SCALE = 0.1;
const MAX_SCALE = 12;

export function openMermaidZoom(diagram: HTMLElement): void {
  const svg = diagram.querySelector("svg");
  if (!svg) return;

  const rect = svg.getBoundingClientRect();
  const baseW = rect.width || 400;
  const baseH = rect.height || 300;

  const overlay = document.createElement("div");
  overlay.className = "mermaid-zoom-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Diagram zoom viewer");

  const stage = document.createElement("div");
  stage.className = "mermaid-zoom-stage";
  const clone = svg.cloneNode(true) as SVGElement;
  clone.removeAttribute("style"); // drop mermaid's max-width cap
  clone.style.width = `${baseW}px`;
  clone.style.height = `${baseH}px`;
  clone.style.display = "block";
  stage.appendChild(clone);
  overlay.appendChild(stage);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "mermaid-zoom-close";
  close.setAttribute("aria-label", "Close");
  close.innerHTML =
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
  overlay.appendChild(close);

  const hint = document.createElement("div");
  hint.className = "mermaid-zoom-hint";
  hint.textContent = "scroll to zoom · drag to pan · Esc to close";
  overlay.appendChild(hint);

  document.body.appendChild(overlay);

  // Fit the diagram to the viewport on open, centered.
  const vw = overlay.clientWidth;
  const vh = overlay.clientHeight;
  let scale = Math.min(1, (vw - 96) / baseW, (vh - 120) / baseH);
  if (!Number.isFinite(scale) || scale <= 0) scale = 1;
  let tx = (vw - baseW * scale) / 2;
  let ty = (vh - baseH * scale) / 2;

  const apply = () => {
    stage.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  };
  apply();

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const r = overlay.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
    // Keep the point under the cursor fixed while scaling (origin 0 0).
    tx = px - (next / scale) * (px - tx);
    ty = py - (next / scale) * (py - ty);
    scale = next;
    apply();
  };

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    overlay.classList.add("dragging");
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    tx += e.clientX - lastX;
    ty += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    apply();
  };
  const onPointerUp = () => {
    dragging = false;
    overlay.classList.remove("dragging");
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") teardown();
  };

  function teardown(): void {
    overlay.removeEventListener("wheel", onWheel);
    overlay.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("keydown", onKey);
    overlay.remove();
  }

  overlay.addEventListener("wheel", onWheel, { passive: false });
  overlay.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("keydown", onKey);
  // Click on empty backdrop (not the diagram) closes; the close button too.
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) teardown();
  });
  close.addEventListener("click", teardown);
}
