import "./styles.css";
import "highlight.js/styles/github.css";
import {
  State, emptyState, openDoc, closeDoc, setActive, getActive,
  toggleViewMode, updateEditorContent, markSaved, applyDiskChange, markRemoved,
} from "./store";
import { isDirty } from "./document";
import { renderMarkdown } from "./renderer";
import { readFile, writeFile, watchFile, unwatchFile, onOpenFile, onFileChanged, onFileRemoved } from "./ipc";
import { mountEditor } from "./editor";
import { decideReload } from "./reload";
import { confirmReload } from "./modal";
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
  const bar = document.getElementById("tabbar")!;
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

function renderContent(): void {
  const host = document.getElementById("content")!;
  if (activeEditor) { activeEditor.destroy(); activeEditor = null; }
  host.innerHTML = "";
  const doc = getActive(state);
  if (!doc) {
    const empty = el("div", "empty");
    empty.appendChild(el("p", undefined, "No document open."));
    const recent = loadRecent();
    if (recent.length) {
      empty.appendChild(el("p", undefined, "Recent:"));
      const ul = el("ul");
      for (const p of recent) {
        const li = el("li", undefined, p);
        li.onclick = () => { void openPath(p); };
        ul.appendChild(li);
      }
      empty.appendChild(ul);
    }
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
  await watchFile(absPath);
  const recent = pushRecent(loadRecent(), absPath);
  localStorage.setItem(LS_RECENT, JSON.stringify(recent));
  render();
}

export async function start(): Promise<void> {
  await onOpenFile((absPath) => { void openPath(absPath); });
  await onFileRemoved((path) => { state = markRemoved(state, path); render(); });
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
  let toRestore: string[] = [];
  try { toRestore = JSON.parse(localStorage.getItem(LS_OPEN) || "[]"); } catch { /* ignore */ }
  for (const p of toRestore) {
    try { await openPath(p); } catch { /* file gone; skip */ }
  }
  render();
}
