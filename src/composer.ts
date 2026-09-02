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

export type ComposerEvent = "escape" | "click-outside" | "submit" | "confirm-discard" | "keep";
export interface ComposerState { text: string; confirming: boolean }
export type ComposerOutcome =
  | { kind: "stay"; state: ComposerState; flash?: boolean }
  | { kind: "close"; note: string | null };

export function composerStep(state: ComposerState, ev: ComposerEvent): ComposerOutcome {
  const note = state.text.trim();

  if (ev === "submit") {
    return note ? { kind: "close", note } : { kind: "stay", state };
  }
  if (state.confirming && ev === "confirm-discard") {
    return { kind: "close", note: null };
  }
  if (state.confirming && ev === "keep") {
    return { kind: "stay", state: { ...state, confirming: false } };
  }
  if (ev === "escape") {
    if (!note || state.confirming) return { kind: "close", note: null };
    return { kind: "stay", state: { ...state, confirming: true } };
  }
  if (ev === "click-outside") {
    if (!note) return { kind: "close", note: null };
    return { kind: "stay", state, flash: true };
  }
  return { kind: "stay", state };
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
  // Clicking the card chrome (not the textarea/buttons) must not drop the text
  // selection in the view behind it.
  card.onmousedown = (e) => { if (e.target === card) e.preventDefault(); };

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
  const keys = document.createElement("span");
  keys.className = "composer-keys";
  keys.textContent = "⌘↩ comment · esc cancel";
  const actions = document.createElement("div");
  actions.className = "composer-actions";
  foot.append(keys, actions);

  card.append(head, quoteEl, ta, foot);
  let state: ComposerState = { text: "", confirming: false };

  const close = () => {
    document.removeEventListener("mousedown", onDocDown, true);
    card.remove();
  };
  const flash = () => {
    card.classList.remove("composer-flash");
    void card.offsetWidth;
    card.classList.add("composer-flash");
  };
  const renderFooter = () => {
    head.textContent = state.confirming ? "Discard this comment?" : "Add comment";
    const firstBtn = document.createElement("button");
    firstBtn.className = "composer-btn";
    const secondBtn = document.createElement("button");
    secondBtn.className = "composer-btn primary";
    if (state.confirming) {
      firstBtn.textContent = "Discard";
      firstBtn.onclick = () => dispatch("confirm-discard");
      secondBtn.textContent = "Keep";
      secondBtn.onclick = () => dispatch("keep");
    } else {
      firstBtn.textContent = "Cancel";
      firstBtn.onclick = () => dispatch("escape");
      secondBtn.textContent = "Comment";
      secondBtn.onclick = () => dispatch("submit");
    }
    actions.replaceChildren(firstBtn, secondBtn);
  };
  const dispatch = (event: ComposerEvent) => {
    const wasConfirming = state.confirming;
    const outcome = composerStep(state, event);
    if (outcome.kind === "close") {
      close();
      if (outcome.note === null) onCancel();
      else onSubmit(outcome.note);
      return;
    }
    state = outcome.state;
    if (outcome.flash) flash();
    if (state.confirming !== wasConfirming) {
      renderFooter();
      if (!state.confirming) ta.focus();
    }
  };

  ta.oninput = () => {
    state = { ...state, text: ta.value };
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  };
  ta.onkeydown = (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); dispatch("submit"); }
    else if (e.key === "Escape") { e.preventDefault(); dispatch("escape"); }
  };
  const onDocDown = (e: MouseEvent) => {
    if (!card.contains(e.target as Node)) dispatch("click-outside");
  };
  card.addEventListener("animationend", () => card.classList.remove("composer-flash"));

  renderFooter();
  document.body.appendChild(card);

  const pos = clampPopover(anchor, { width: card.offsetWidth, height: card.offsetHeight },
    { width: window.innerWidth, height: window.innerHeight });
  card.style.top = `${pos.top}px`;
  card.style.left = `${pos.left}px`;

  document.addEventListener("mousedown", onDocDown, true);
  ta.focus();
}
