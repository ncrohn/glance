// Drag-to-resize for the annotation rail. Pure helpers are exported for tests;
// mountRailResizer is DOM glue.

export const RAIL_MIN = 200;
export const RAIL_MAX = 640;
export const RAIL_DEFAULT = 260;

export function clampRailWidth(w: number): number {
  if (!Number.isFinite(w)) return RAIL_DEFAULT;
  return Math.min(RAIL_MAX, Math.max(RAIL_MIN, Math.round(w)));
}

/** Parse a persisted width; anything unusable yields the default. */
export function parseRailWidth(raw: string | null): number {
  if (raw == null || raw === "") return RAIL_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) ? clampRailWidth(n) : RAIL_DEFAULT;
}

export function applyRailWidth(w: number): void {
  document.documentElement.style.setProperty("--rail-w", `${w}px`);
}

/** Mount the grip. Dragging sets --rail-w live; release commits the width.
 *  Double-click resets to the default. Returns a teardown. */
export function mountRailResizer(
  grip: HTMLElement,
  rail: HTMLElement,
  onCommit: (w: number) => void,
): () => void {
  let dragging = false;
  let width = RAIL_DEFAULT;

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    dragging = true;
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add("rail-resizing");
    e.preventDefault();
  };
  const onMove = (e: PointerEvent) => {
    if (!dragging) return;
    // The rail sits on the right edge; its width is the distance from the
    // pointer to its right edge.
    width = clampRailWidth(rail.getBoundingClientRect().right - e.clientX);
    applyRailWidth(width);
  };
  const onUp = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    grip.releasePointerCapture(e.pointerId);
    document.body.classList.remove("rail-resizing");
    onCommit(width);
  };
  const onReset = () => {
    width = RAIL_DEFAULT;
    applyRailWidth(width);
    onCommit(width);
  };

  grip.addEventListener("pointerdown", onDown);
  grip.addEventListener("pointermove", onMove);
  grip.addEventListener("pointerup", onUp);
  grip.addEventListener("pointercancel", onUp);
  grip.addEventListener("dblclick", onReset);
  return () => {
    grip.removeEventListener("pointerdown", onDown);
    grip.removeEventListener("pointermove", onMove);
    grip.removeEventListener("pointerup", onUp);
    grip.removeEventListener("pointercancel", onUp);
    grip.removeEventListener("dblclick", onReset);
  };
}
