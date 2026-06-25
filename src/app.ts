import "./styles.css";
import {
  State, emptyState, openDoc, closeDoc, setActive, getActive,
  toggleViewMode, updateEditorContent, markSaved, applyDiskChange, markRemoved,
} from "./store";
import { isDirty, basename } from "./document";
import { renderMarkdown } from "./renderer";
import { readFile, writeFile, watchFile, unwatchFile, onOpenFile, onFileChanged, onFileRemoved, takeLaunchArgs, onCliInstallResult } from "./ipc";
import { mountEditor } from "./editor";
import { decideReload } from "./reload";
import { confirmReload, showNotice } from "./modal";
import { openPaths, pushRecent } from "./session";

const LS_OPEN = "glance.openPaths";
const LS_RECENT = "glance.recent";

function loadRecent(): string[] {
  try { return JSON.parse(localStorage.getItem(LS_RECENT) || "[]"); } catch { return []; }
}
function saveSession(): void {
  localStorage.setItem(LS_OPEN, JSON.stringify(openPaths(state)));
}

let state: State = emptyState();
let activeEditor: { destroy(): void } | null = null;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function renderTabBar(): void {
  const bar = document.getElementById("tabs")!;
  bar.innerHTML = "";
  for (const d of state.docs) {
    const tab = el("div", "tab");
    if (d.id === state.activeId) tab.classList.add("active");
    if (isDirty(d)) tab.classList.add("dirty");
    tab.appendChild(el("span", "dot"));
    const label = el("span", "label", d.fileName);
    label.onclick = () => { state = setActive(state, d.id); render(); };
    tab.appendChild(label);
    if (!d.existsOnDisk) { const m = el("span", "removed", "(deleted)"); tab.appendChild(m); }
    const close = el("span", "close", "×");
    close.onclick = (ev) => { ev.stopPropagation(); closeTab(d.id); };
    tab.appendChild(close);
    bar.appendChild(tab);
  }
}

function renderActions(): void {
  const host = document.getElementById("titlebar-actions")!;
  host.innerHTML = "";
  const doc = getActive(state);
  if (!doc) return;
  const seg = el("div", "segmented");
  const read = el("button", doc.viewMode === "rendered" ? "on" : undefined, "Read");
  const edit = el("button", doc.viewMode === "source" ? "on" : undefined, "Edit");
  read.onclick = () => { if (doc.viewMode !== "rendered") { state = toggleViewMode(state, doc.id); render(); } };
  edit.onclick = () => { if (doc.viewMode !== "source") { state = toggleViewMode(state, doc.id); render(); } };
  seg.appendChild(read);
  seg.appendChild(edit);
  host.appendChild(seg);
}

function renderContent(): void {
  const host = document.getElementById("content")!;
  if (activeEditor) { activeEditor.destroy(); activeEditor = null; }
  host.innerHTML = "";
  const doc = getActive(state);
  if (!doc) {
    const empty = el("div", "empty");
    const wm = el("div", "wordmark");
    wm.appendChild(document.createTextNode("Glance"));
    wm.appendChild(el("span", "dot", "."));
    empty.appendChild(wm);
    empty.appendChild(el("div", "tagline", "A quiet place to read your markdown."));
    const recent = loadRecent();
    if (recent.length) {
      const wrap = el("div", "recent");
      wrap.appendChild(el("div", "recent-head", "Recent"));
      const ul = el("ul");
      for (const p of recent) {
        const li = el("li");
        li.appendChild(el("span", "name", basename(p)));
        li.appendChild(el("span", "path", p));
        li.onclick = () => { void openPath(p); };
        ul.appendChild(li);
      }
      wrap.appendChild(ul);
      empty.appendChild(wrap);
    }
    const hint = el("div", "hint");
    hint.innerHTML =
      'Open files with <kbd>mdview &lt;file&gt;</kbd> &nbsp;·&nbsp; ' +
      'toggle source <kbd>⌘E</kbd> &nbsp;·&nbsp; save <kbd>⌘S</kbd>';
    empty.appendChild(hint);
    host.appendChild(empty);
    return;
  }

  if (doc.viewMode === "source") {
    const cmHost = el("div", "cm-host");
    host.appendChild(cmHost);
    activeEditor = mountEditor(cmHost, doc.editorContent, (v) => {
      state = updateEditorContent(state, doc.id, v);
      renderTabBar(); // refresh dirty dot without tearing down the editor
    });
  } else {
    const view = el("div", "rendered");
    view.innerHTML = renderMarkdown(doc.editorContent);
    host.appendChild(view);
  }
}

export function render(): void {
  renderTabBar();
  renderActions();
  renderContent();
  saveSession();
}

function closeTab(id: string): void {
  const doc = state.docs.find((d) => d.id === id);
  if (doc) void unwatchFile(doc.absPath);
  state = closeDoc(state, id);
  render();
}

export async function openPath(absPath: string): Promise<void> {
  const already = state.docs.find((d) => d.absPath === absPath);
  if (already) { state = setActive(state, absPath); render(); return; }
  const contents = await readFile(absPath);
  state = openDoc(state, absPath, contents);
  try {
    await watchFile(absPath);
  } catch (err) {
    console.warn("watchFile failed for", absPath, err);
  }
  const recent = pushRecent(loadRecent(), absPath);
  localStorage.setItem(LS_RECENT, JSON.stringify(recent));
  render();
}

export async function start(): Promise<void> {
  await onOpenFile((absPath) => { void openPath(absPath); });
  await onFileRemoved((path) => { state = markRemoved(state, path); render(); });
  await onCliInstallResult((r) => { showNotice(r.message, r.ok); });
  await onFileChanged(async (e) => {
    const doc = state.docs.find((d) => d.absPath === e.path);
    if (!doc) return;
    if (doc.editorContent === e.contents) return; // our own save echo — no-op
    if (decideReload(doc) === "auto-reload") {
      state = applyDiskChange(state, doc.id, e.contents);
      render();
    } else {
      const choice = await confirmReload(doc.fileName);
      if (choice === "disk") {
        state = applyDiskChange(state, doc.id, e.contents);
        render();
      }
      // "mine" → keep editor content; user's edits stay dirty
    }
  });
  window.addEventListener("keydown", (e) => {
    if (e.metaKey && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      const doc = getActive(state);
      if (doc) {
        void writeFile(doc.absPath, doc.editorContent).then(() => {
          state = markSaved(state, doc.id);
          render();
        });
      }
    }
    if (e.metaKey && (e.key === "e" || e.key === "E")) {
      e.preventDefault();
      const doc = getActive(state);
      if (doc) { state = toggleViewMode(state, doc.id); render(); }
    }
  });
  const launchPaths = await takeLaunchArgs();
  for (const p of launchPaths) {
    try { await openPath(p); } catch { /* file gone or unreadable; skip */ }
  }
  let toRestore: string[] = [];
  try { toRestore = JSON.parse(localStorage.getItem(LS_OPEN) || "[]"); } catch { /* ignore */ }
  for (const p of toRestore) {
    try { await openPath(p); } catch { /* file gone; skip */ }
  }
  render();
}
