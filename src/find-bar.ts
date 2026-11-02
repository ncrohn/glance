// The ⌘F bar: a query field, an "n of m" count, previous/next and close. It
// lives on #workspace, outside #content, so a full render doesn't remove it.
// app.ts owns the matching and highlighting; this only reports what was asked.

export interface FindBarHandlers {
  onQuery(query: string): void;
  onStep(dir: 1 | -1): void;
  onClose(): void;
}

export interface FindBar {
  open(): void;
  close(): void;
  isOpen(): boolean;
  query(): string;
  setCount(current: number, count: number): void;
}

export function mountFindBar(host: HTMLElement, h: FindBarHandlers): FindBar {
  const bar = document.createElement("div");
  bar.className = "find-bar";
  bar.hidden = true;
  bar.setAttribute("role", "search");

  const input = document.createElement("input");
  input.type = "text";
  input.className = "find-input";
  input.placeholder = "Find";
  input.spellcheck = false;
  input.setAttribute("aria-label", "Find in file");

  const count = document.createElement("span");
  count.className = "find-count";
  count.setAttribute("aria-live", "polite");

  const button = (label: string, title: string, cls: string, act: () => void) => {
    const b = document.createElement("button");
    b.className = `find-btn ${cls}`;
    b.textContent = label;
    b.title = title;
    b.setAttribute("aria-label", title);
    // Keep focus in the field so Enter keeps stepping after a click.
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", act);
    return b;
  };
  const prev = button("‹", "Previous match (⇧⌘G)", "find-prev", () => h.onStep(-1));
  const next = button("›", "Next match (⌘G)", "find-next", () => h.onStep(1));
  const close = button("×", "Close (Esc)", "find-close", () => h.onClose());

  input.addEventListener("input", () => h.onQuery(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      h.onStep(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      h.onClose();
    }
  });

  bar.append(input, count, prev, next, close);
  host.appendChild(bar);

  return {
    open: () => {
      bar.hidden = false;
      input.focus();
      input.select();
    },
    close: () => { bar.hidden = true; },
    isOpen: () => !bar.hidden,
    query: () => input.value,
    setCount: (current, total) => {
      const empty = input.value === "";
      count.textContent = empty ? "" : total === 0 ? "No matches" : `${current + 1} of ${total}`;
      bar.classList.toggle("no-match", !empty && total === 0);
      prev.disabled = next.disabled = total === 0;
    },
  };
}
