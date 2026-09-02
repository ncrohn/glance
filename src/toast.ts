/** One transient message at a time, bottom-right of the window. Showing a new
 *  toast replaces the previous one. Returns a dismiss function. */

interface ToastOpts {
  actionLabel?: string;
  onAction?: () => void;
  ms?: number;
}

const DEFAULT_MS = 6000;

let current: { el: HTMLElement; timer: ReturnType<typeof setTimeout> } | null = null;

export function showToast(message: string, opts: ToastOpts = {}): () => void {
  if (current) {
    clearTimeout(current.timer);
    current.el.remove();
    current = null;
  }

  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "status");
  const text = document.createElement("span");
  text.className = "toast-text";
  text.textContent = message;
  el.appendChild(text);

  const entry = { el, timer: 0 as unknown as ReturnType<typeof setTimeout> };
  const dismiss = () => {
    if (current !== entry) return; // already replaced or dismissed
    clearTimeout(entry.timer);
    el.remove();
    current = null;
  };
  entry.timer = setTimeout(dismiss, opts.ms ?? DEFAULT_MS);

  if (opts.actionLabel) {
    const btn = document.createElement("button");
    btn.className = "toast-action";
    btn.textContent = opts.actionLabel;
    btn.onclick = () => { dismiss(); opts.onAction?.(); };
    el.appendChild(btn);
  }

  document.body.appendChild(el);
  current = entry;
  return dismiss;
}
