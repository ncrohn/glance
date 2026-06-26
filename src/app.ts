import "./styles.css";
import {
  State, emptyState, openDoc, closeDoc, setActive, getActive,
  toggleViewMode, updateEditorContent, markSaved, applyDiskChange, markRemoved,
  setDocAnnotations, setDocResolutions,
} from "./store";
import { isDirty, basename } from "./document";
import { renderMarkdown } from "./renderer";
import {
  readFile, writeFile, watchFile, unwatchFile, onOpenFile, onFileChanged, onFileRemoved, takeLaunchArgs,
  readAnnotations, writeAnnotations, resolveAnchors, ensureAnnotationStore,
  watchAnnotations, onAnnotationsChanged, onSetupResult,
} from "./ipc";
import { addAnnotation, removeAnnotation, genId, type Annotation } from "./annotations";
import { captureSelection } from "./anchor-capture";
import { renderRail, applyHighlights, mountSelectionToolbar } from "./annotation-ui";
import { mountEditor } from "./editor";
import { decideReload } from "./reload";
import { confirmReload, showNotice, promptText } from "./modal";
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
let teardownToolbar: (() => void) | null = null;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

async function loadAnnotations(absPath: string): Promise<void> {
  const store = await readAnnotations(absPath);
  state = setDocAnnotations(state, absPath, store.annotations);
  await refreshResolutions(absPath);
  render();
}

async function refreshResolutions(absPath: string): Promise<void> {
  const doc = state.docs.find((d) => d.absPath === absPath);
  if (!doc) return;
  const resList = await resolveAnchors(doc.editorContent, doc.annotations);
  const map: Record<string, import("./annotations").Resolution> = {};
  for (const r of resList) map[r.id] = r;
  state = setDocResolutions(state, absPath, map);
}

async function persistAnnotations(absPath: string): Promise<void> {
  const doc = state.docs.find((d) => d.absPath === absPath);
  if (!doc) return;
  await writeAnnotations({ docPath: absPath, annotations: doc.annotations });
  await refreshResolutions(absPath);
}

async function startComment(absPath: string): Promise<void> {
  const doc = state.docs.find((d) => d.absPath === absPath);
  if (!doc) return;
  const cap = captureSelection(doc.editorContent);
  if (!cap) return;
  const note = await promptText(`Comment on "${cap.quote.slice(0, 40)}…"`, "Your note…");
  if (!note) return;
  const annotation: Annotation = {
    id: genId(), quote: cap.quote, prefix: cap.prefix, suffix: cap.suffix,
    lineHint: cap.lineHint, note, status: "open", author: "user",
    createdAt: new Date().toISOString(),
  };
  state = setDocAnnotations(state, absPath, addAnnotation(doc.annotations, annotation));
  await persistAnnotations(absPath);
  render();
}

function renderRailFor(): void {
  const host = document.getElementById("rail");
  if (!host) return;
  const doc = getActive(state);
  if (!doc) { host.innerHTML = ""; return; }
  renderRail(host, doc.annotations, doc.resolutions, {
    onScrollTo: (a) => {
      const r = doc.resolutions[a.id];
      if (r?.startLine == null) return;
      const node = document.querySelector(`[data-sourceline="${r.startLine}"]`);
      node?.scrollIntoView({ behavior: "smooth", block: "center" });
    },
    onRemove: (a) => {
      state = setDocAnnotations(state, doc.absPath, removeAnnotation(doc.annotations, a.id));
      void persistAnnotations(doc.absPath);
      render();
    },
  });
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
  if (teardownToolbar) { teardownToolbar(); teardownToolbar = null; }
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
    applyHighlights(view, doc.resolutions);
    teardownToolbar = mountSelectionToolbar(view, () => void startComment(doc.absPath));
  }
}

export function render(): void {
  renderTabBar();
  renderActions();
  renderContent();
  renderRailFor();
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
  try {
    const storePath = await ensureAnnotationStore(absPath);
    await watchAnnotations(storePath, absPath);
  } catch (err) {
    console.warn("annotation store watch failed for", absPath, err);
  }
  await loadAnnotations(absPath);
}

export async function start(): Promise<void> {
  await onOpenFile((absPath) => { void openPath(absPath); });
  await onFileRemoved((path) => { state = markRemoved(state, path); render(); });
  await onSetupResult((steps) => {
    const ok = steps.every((s) => s.ok);
    const body = steps.map((s) => `${s.ok ? "✓" : "✗"} ${s.label}: ${s.message}`).join("\n");
    showNotice(body, ok);
  });
  await onAnnotationsChanged((docPath) => { void loadAnnotations(docPath); });
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
