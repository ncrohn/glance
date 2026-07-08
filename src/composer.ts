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
