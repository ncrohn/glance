import type { SetupStep } from "./ipc";
import { openExternal } from "./ipc";
import { AUTO, THEMES, type ThemePref } from "./theme";
import appIcon from "./assets/app-icon.png";

// Shared modal scaffold. Builds the overlay + card, wires Escape / backdrop
// click to a `close` callback, and returns the card so callers fill the body.
// Native window.alert/confirm/prompt are no-ops in the macOS WKWebview Tauri
// uses, so every dialog in the app is rolled by hand on this machinery.
interface ModalParts {
  overlay: HTMLDivElement;
  card: HTMLDivElement;
  body: HTMLDivElement;
  footer: HTMLDivElement;
  close: () => void;
}

function openModal(opts: { title: string; tone?: "default" | "error"; onEscape?: () => void }): ModalParts {
  const root = document.getElementById("modal-root")!;
  root.innerHTML = "";

  const overlay = document.createElement("div");
  overlay.className = "modal";

  const card = document.createElement("div");
  card.className = opts.tone === "error" ? "box error" : "box";

  const title = document.createElement("h2");
  title.className = "modal-title";
  title.textContent = opts.title;
  card.appendChild(title);

  const body = document.createElement("div");
  body.className = "modal-body";
  card.appendChild(body);

  const footer = document.createElement("div");
  footer.className = "modal-footer";
  card.appendChild(footer);

  const close = () => { root.innerHTML = ""; };

  overlay.appendChild(card);
  root.appendChild(overlay);

  overlay.onkeydown = (e) => {
    if (e.key === "Escape") { e.preventDefault(); opts.onEscape?.(); }
  };
  // Backdrop click closes only when there's a safe default (an Escape handler).
  overlay.onclick = (e) => { if (e.target === overlay) opts.onEscape?.(); };

  return { overlay, card, body, footer, close };
}

function button(label: string, primary = false): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = primary ? "modal-btn primary" : "modal-btn";
  b.textContent = label;
  return b;
}

export function confirmReload(fileName: string): Promise<"mine" | "disk"> {
  return new Promise((resolve) => {
    const m = openModal({ title: "File changed on disk" });
    const msg = document.createElement("p");
    const name = document.createElement("strong");
    name.textContent = fileName;
    msg.appendChild(name);
    msg.appendChild(document.createTextNode(" changed on disk while you have unsaved edits."));
    m.body.appendChild(msg);

    const done = (r: "mine" | "disk") => { m.close(); resolve(r); };
    const load = button("Load disk");
    const keep = button("Keep mine", true);
    keep.onclick = () => done("mine");
    load.onclick = () => done("disk");
    m.footer.append(load, keep);
  });
}

// Native window.prompt() is a no-op in the macOS WKWebview Tauri uses, so we
// roll our own text-input modal. Resolves with the trimmed text, or null if
// cancelled / left empty.
export function promptText(label: string, placeholder = ""): Promise<string | null> {
  return new Promise((resolve) => {
    const done = (r: string | null) => { m.close(); resolve(r); };
    const m = openModal({ title: label, onEscape: () => done(null) });

    const input = document.createElement("input");
    input.type = "text";
    input.className = "modal-input";
    input.placeholder = placeholder;
    m.body.appendChild(input);

    const submit = () => { const v = input.value.trim(); done(v ? v : null); };
    const cancel = button("Cancel");
    const save = button("Save", true);
    save.onclick = submit;
    cancel.onclick = () => done(null);
    input.onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
      else if (e.key === "Escape") { e.preventDefault(); done(null); }
    };
    m.footer.append(cancel, save);
    input.focus();
  });
}

export function showNotice(message: string, ok = true): void {
  const m = openModal({
    title: ok ? "Done" : "Something went wrong",
    tone: ok ? "default" : "error",
    onEscape: () => m.close(),
  });
  const msg = document.createElement("p");
  msg.textContent = message;
  m.body.appendChild(msg);
  const okBtn = button("OK", true);
  okBtn.onclick = m.close;
  m.footer.appendChild(okBtn);
  okBtn.focus();
}

// Setup runs several steps; show each as its own row (status glyph + label +
// detail) rather than one collapsed paragraph.
export function showSetupResult(steps: SetupStep[]): void {
  const ok = steps.every((s) => s.ok);
  const m = openModal({
    title: ok ? "Claude integration ready" : "Setup finished with issues",
    tone: ok ? "default" : "error",
    onEscape: () => m.close(),
  });

  const list = document.createElement("ul");
  list.className = "setup-steps";
  for (const s of steps) {
    const row = document.createElement("li");
    row.className = s.ok ? "setup-step ok" : "setup-step fail";

    const glyph = document.createElement("span");
    glyph.className = "setup-glyph";
    glyph.textContent = s.ok ? "✓" : "✗";

    const text = document.createElement("div");
    text.className = "setup-text";
    const label = document.createElement("div");
    label.className = "setup-label";
    label.textContent = s.label;
    const detail = document.createElement("div");
    detail.className = "setup-detail";
    detail.textContent = s.message;
    text.append(label, detail);

    row.append(glyph, text);
    list.appendChild(row);
  }
  m.body.appendChild(list);

  const okBtn = button("OK", true);
  okBtn.onclick = m.close;
  m.footer.appendChild(okBtn);
  okBtn.focus();
}

// Theme picker — a radio-style list of Auto + every built-in theme. Selecting a
// row previews it live (via onPreview) so the change is instantly visible;
// Done commits + persists, Cancel / Escape reverts to whatever was active on
// open.
export function showThemePicker(
  current: ThemePref,
  opts: { onPreview: (pref: ThemePref) => void; onCommit: (pref: ThemePref) => void },
): void {
  let selected = current;

  const revertAndClose = () => { opts.onPreview(current); m.close(); };
  const m = openModal({ title: "Theme", onEscape: revertAndClose });
  m.card.classList.add("theme-picker");

  const list = document.createElement("div");
  list.className = "theme-list";
  m.body.appendChild(list);

  const rows: HTMLButtonElement[] = [];
  const makeRow = (pref: ThemePref, name: string, tag: string, swatchId: string) => {
    const row = document.createElement("button");
    row.className = "theme-row";
    row.dataset.pref = pref;
    if (pref === selected) row.classList.add("active");

    const swatch = document.createElement("span");
    swatch.className = `theme-swatch theme-swatch--${swatchId}`;
    swatch.appendChild(document.createElement("i")); // accent dot

    const label = document.createElement("span");
    label.className = "theme-label";
    label.textContent = name;

    const tagEl = document.createElement("span");
    tagEl.className = "theme-tag";
    tagEl.textContent = tag;

    const check = document.createElement("span");
    check.className = "theme-check";
    check.textContent = "✓";

    row.append(swatch, label, tagEl, check);
    row.onclick = () => {
      selected = pref;
      for (const r of rows) r.classList.toggle("active", r.dataset.pref === pref);
      opts.onPreview(pref);
    };
    rows.push(row);
    list.appendChild(row);
  };

  makeRow(AUTO, "Auto", "Follows macOS", "auto");
  for (const t of THEMES) {
    makeRow(t.id, t.name, t.appearance === "dark" ? "Dark" : "Light", t.id);
  }

  const cancel = button("Cancel");
  cancel.onclick = revertAndClose;
  const done = button("Done", true);
  done.onclick = () => { opts.onCommit(selected); m.close(); };
  m.footer.append(cancel, done);
}

// About box — app icon, wordmark, version, and attribution. Centered layout,
// no title bar (the icon is the header).
export function showAbout(version: string): void {
  const m = openModal({ title: "", onEscape: () => m.close() });
  m.card.classList.add("about");
  m.card.querySelector(".modal-title")?.remove();

  const icon = document.createElement("img");
  icon.className = "about-icon";
  icon.src = appIcon;
  icon.alt = "Glance";

  const name = document.createElement("div");
  name.className = "about-name";
  name.textContent = "Glance";

  const tagline = document.createElement("div");
  tagline.className = "about-tagline";
  tagline.textContent = "A markdown companion for working with AI.";

  const ver = document.createElement("div");
  ver.className = "about-version";
  ver.textContent = `Version ${version}`;

  const meta = document.createElement("div");
  meta.className = "about-meta";
  const dev = document.createElement("div");
  dev.textContent = "Developed by Nick Crohn";
  const copy = document.createElement("div");
  copy.textContent = "© 2026 Escapement Labs, LLC";
  meta.append(dev, copy);

  // <a> for semantics, but preventDefault + openExternal so it opens in the
  // system browser instead of navigating (and replacing) the app webview.
  const link = document.createElement("a");
  link.className = "about-link";
  link.href = "https://escapementlab.com";
  link.textContent = "escapementlab.com";
  link.onclick = (e) => { e.preventDefault(); void openExternal("https://escapementlab.com"); };

  m.body.append(icon, name, tagline, ver, meta, link);

  const okBtn = button("OK", true);
  okBtn.onclick = m.close;
  m.footer.appendChild(okBtn);
  okBtn.focus();
}
