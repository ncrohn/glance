import "./styles.css";
import "highlight.js/styles/github.css";
import {
  State, emptyState, openDoc, closeDoc, setActive, getActive,
} from "./store";
import { isDirty } from "./document";
import { renderMarkdown } from "./renderer";
import { readFile, watchFile, unwatchFile, onOpenFile, onFileChanged } from "./ipc";

let state: State = emptyState();

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
    const close = el("span", "close", "×");
    close.onclick = (ev) => { ev.stopPropagation(); closeTab(d.id); };
    tab.appendChild(close);
    bar.appendChild(tab);
  }
}

function renderContent(): void {
  const host = document.getElementById("content")!;
  host.innerHTML = "";
  const doc = getActive(state);
  if (!doc) {
    host.appendChild(el("div", "empty", "No document open."));
    return;
  }
  // Phase 3 Task 3 replaces this branch with the source editor when viewMode === "source".
  const view = el("div", "rendered");
  view.innerHTML = renderMarkdown(doc.editorContent);
  host.appendChild(view);
}

export function render(): void {
  renderTabBar();
  renderContent();
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
  render();
}

export async function start(): Promise<void> {
  await onOpenFile((absPath) => { void openPath(absPath); });
  await onFileChanged((e) => { /* Task 4 wires reload logic here */ void e; });
  render();
}
