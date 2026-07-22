import "./styles.css";
import {
  State, emptyState, openDoc, closeDoc, setActive, getActive,
  toggleViewMode, updateEditorContent, markSaved, applyDiskChange, markRemoved,
  setDocAnnotations, setDocResolutions,
  markReviewed, setReviewedBaseline,
} from "./store";
import { isDirty, basename, changedLines, hasUnreviewedChanges, type Doc } from "./document";
import { parseFrontmatter } from "./frontmatter";
import { renderMarkdown } from "./renderer";
import { renderMermaidBlocks } from "./mermaid";
import { mountBlockExpanders } from "./block-expand";
import { closeMermaidZoom } from "./mermaid-zoom";
import {
  readFile, writeFile, watchFile, unwatchFile, onOpenFile, onFileChanged, onFileRemoved, takeLaunchArgs,
  readAnnotations, addStoredAnnotation, removeStoredAnnotation, resolveAnchors, ensureAnnotationStore,
  watchAnnotations, onAnnotationsChanged, onShowIntegrationPicker, listIntegrationTargets, runIntegration,
  onShowAbout, onShowTheme, onCloseActiveTab, onMenuSave, onSelectAll, appVersion,
  readReviewed, writeReviewed,
} from "./ipc";
import { addAnnotation, removeAnnotation, genId, type Annotation } from "./annotations";
import { captureSelection } from "./anchor-capture";
import { showCommentComposer } from "./composer";
import {
  renderRail, applyHighlights, mountSelectionToolbar, assignMarkers, linkAnnotationHovers, pulseBlock,
} from "./annotation-ui";
import { mountEditor } from "./editor";
import { decideReload } from "./reload";
import { confirmReload, showNotice, showSetupResult, showIntegrationPicker, showAbout, showThemePicker } from "./modal";
import {
  applyTheme, loadThemePref, saveThemePref, currentAppearance, currentThemeId, type ThemePref,
} from "./theme";
import { openPaths, pushRecent } from "./session";
import { needsSetup } from "./integration";
import type { ClientInfo, IntegrationAction } from "./ipc";

const LS_OPEN = "glance.openPaths";
const LS_RECENT = "glance.recent";

// absPath → annotation store path, so closeTab can release the store's file
// watcher (keyed by store path, not doc path) instead of leaking it until exit.
const annotationStorePaths = new Map<string, string>();

function loadRecent(): string[] {
  try { return JSON.parse(localStorage.getItem(LS_RECENT) || "[]"); } catch { return []; }
}
function saveSession(): void {
  localStorage.setItem(LS_OPEN, JSON.stringify(openPaths(state)));
}

let state: State = emptyState();
let activeEditor: { destroy(): void; selectAll(): void } | null = null;
let teardownToolbar: (() => void) | null = null;
let teardownHovers: (() => void) | null = null;

// Integration targets, fetched at startup + after any setup/remove run, so the
// empty-state "set up AI integration" prompt reflects current config.
let integrationClients: ClientInfo[] = [];

async function refreshIntegration(): Promise<void> {
  try { integrationClients = await listIntegrationTargets(); } catch { integrationClients = []; }
}

// Open the picker, run the selection, show grouped results, then refresh so the
// empty-state prompt updates. Shared by the native menu and the empty-state CTA.
async function openIntegrationPicker(action: IntegrationAction): Promise<void> {
  const clients = await listIntegrationTargets();
  integrationClients = clients;
  showIntegrationPicker(action, clients, async (ids) => {
    const steps = await runIntegration(action, ids);
    showSetupResult({ action, steps });
    await refreshIntegration();
    render();
  });
}

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

function startComment(absPath: string): void {
  const doc = state.docs.find((d) => d.absPath === absPath);
  if (!doc) return;
  const cap = captureSelection(doc.editorContent);
  if (!cap) return;
  const sel = window.getSelection();
  const rect = sel && !sel.isCollapsed
    ? sel.getRangeAt(0).getBoundingClientRect()
    : ({ top: 120, bottom: 140, left: 120 } as DOMRect);
  showCommentComposer({
    quote: cap.quote,
    anchor: { top: rect.top, bottom: rect.bottom, left: rect.left },
    onSubmit: (note) => {
      const annotation: Annotation = {
        id: genId(), quote: cap.quote, prefix: cap.prefix, suffix: cap.suffix,
        lineHint: cap.lineHint, note, status: "open", author: "user",
        createdAt: new Date().toISOString(),
      };
      // Optimistically add to the local list for instant feedback (re-read from
      // current state, not the list captured when the composer opened). The
      // server-side add is locked and merges against disk, and loadAnnotations
      // then reconciles local state with the merged truth.
      const cur = state.docs.find((d) => d.absPath === absPath)?.annotations ?? doc.annotations;
      state = setDocAnnotations(state, absPath, addAnnotation(cur, annotation));
      render();
      void addStoredAnnotation(absPath, annotation).then(() => loadAnnotations(absPath));
    },
    onCancel: () => {},
  });
}

function renderRailFor(): void {
  const host = document.getElementById("rail");
  if (!host) return;
  const doc = getActive(state);
  if (!doc) { host.innerHTML = ""; return; }
  const markers = assignMarkers(doc.annotations, doc.resolutions);
  renderRail(host, doc.annotations, doc.resolutions, markers, {
    onScrollTo: (a) => {
      const r = doc.resolutions[a.id];
      if (r?.startLine == null) return;
      const node = document.querySelector(`[data-annotation-ids~="${a.id}"]`)
        ?? document.querySelector(`[data-sourceline="${r.startLine}"]`);
      node?.scrollIntoView({ behavior: "smooth", block: "center" });
      pulseBlock(node);
    },
    onRemove: (a) => {
      // Optimistic local remove (fresh from state), then the locked server-side
      // remove, then reconcile with the merged on-disk truth.
      const cur = state.docs.find((d) => d.absPath === doc.absPath)?.annotations ?? doc.annotations;
      state = setDocAnnotations(state, doc.absPath, removeAnnotation(cur, a.id));
      render();
      void removeStoredAnnotation(doc.absPath, a.id).then(() => loadAnnotations(doc.absPath));
    },
  });
}

// Click handling is delegated once onto the #tabs container rather than bound
// per-tab. This fixes two flaky-click causes: (1) the whole tab is now a live
// hit target — previously only the inner .label span selected, so clicks on the
// padding / dirty dot / "(deleted)" tag did nothing; (2) the listener lives on
// the container, which survives the innerHTML teardown, so a re-render mid-click
// can't strip the handler off the node being clicked.
function bindTabBar(bar: HTMLElement): void {
  if (bar.dataset.bound) return;
  bar.dataset.bound = "1";
  bar.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    const tab = target.closest<HTMLElement>(".tab");
    const id = tab?.dataset.id;
    if (!id) return;
    if (target.closest(".close")) { closeTab(id); return; }
    if (id !== state.activeId) { state = setActive(state, id); render(); }
  });
  bindTabHover(bar);
}

function renderTabBar(): void {
  const bar = document.getElementById("tabs")!;
  bindTabBar(bar);
  hideTabPreview(); // rebuilding the nodes invalidates any open preview's anchor
  bar.innerHTML = "";
  for (const d of state.docs) {
    const tab = el("div", "tab");
    tab.dataset.id = d.id;
    if (d.id === state.activeId) tab.classList.add("active");
    if (isDirty(d)) tab.classList.add("dirty");
    if (hasUnreviewedChanges(d)) tab.classList.add("has-changes");
    tab.appendChild(el("span", "dot"));
    if (hasUnreviewedChanges(d)) tab.appendChild(el("span", "change-dot"));
    tab.appendChild(el("span", "label", d.fileName));
    if (!d.existsOnDisk) tab.appendChild(el("span", "removed", "(deleted)"));
    tab.appendChild(el("span", "close", "×"));
    bar.appendChild(tab);
  }
}

// Lightweight update for the typing path: only the dirty dot changes while the
// user edits, so toggle that class in place instead of tearing down and
// rebuilding every tab node (which discarded any in-flight click).
function refreshTabDirty(): void {
  const bar = document.getElementById("tabs");
  if (!bar) return;
  for (const tab of Array.from(bar.children) as HTMLElement[]) {
    const d = state.docs.find((x) => x.id === tab.dataset.id);
    if (d) tab.classList.toggle("dirty", isDirty(d));
  }
}

// ---- Tab hover preview --------------------------------------------------
// A single floating card, reused across tabs, that appears on hover: the doc's
// frontmatter/preamble if it has any, otherwise basic file details.

let tabPreviewEl: HTMLElement | null = null;
let tabPreviewTimer: number | null = null;
let tabPreviewFor: string | null = null;

function hideTabPreview(): void {
  if (tabPreviewTimer) { clearTimeout(tabPreviewTimer); tabPreviewTimer = null; }
  tabPreviewFor = null;
  if (tabPreviewEl) tabPreviewEl.classList.remove("visible");
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function metaRow(key: string, value: string): HTMLElement {
  const row = el("div", "tab-preview-row");
  row.appendChild(el("span", "tab-preview-key", key));
  row.appendChild(el("span", "tab-preview-value", value));
  return row;
}

// The directory a doc lives in, home collapsed to ~ (macOS app). Shown on every
// preview so same-named files across folders (e.g. many index.md) are tellable
// apart at a glance.
function dirLabel(absPath: string): string {
  const slash = absPath.lastIndexOf("/");
  const dir = slash > 0 ? absPath.slice(0, slash) : absPath;
  return dir.replace(/^\/Users\/[^/]+/, "~");
}

function buildTabPreview(host: HTMLElement, d: Doc): void {
  host.innerHTML = "";
  host.appendChild(el("div", "tab-preview-name", d.fileName));
  host.appendChild(el("div", "tab-preview-path", dirLabel(d.absPath)));

  const { entries } = parseFrontmatter(d.editorContent);
  if (entries.length) {
    const meta = el("div", "tab-preview-meta");
    for (const e of entries) {
      if (Array.isArray(e.value)) {
        const row = el("div", "tab-preview-row");
        row.appendChild(el("span", "tab-preview-key", e.key));
        const chips = el("span", "tab-preview-chips");
        for (const v of e.value) chips.appendChild(el("span", "tab-preview-chip", v));
        row.appendChild(chips);
        meta.appendChild(row);
      } else {
        meta.appendChild(metaRow(e.key, e.value));
      }
    }
    host.appendChild(meta);
    return;
  }

  // No preamble — fall back to basic file details, all derivable in-memory.
  const details = el("div", "tab-preview-meta");
  details.appendChild(metaRow("lines", String(d.editorContent.split("\n").length)));
  details.appendChild(metaRow("size", humanSize(new TextEncoder().encode(d.editorContent).length)));
  const status = [
    isDirty(d) ? "unsaved" : null,
    hasUnreviewedChanges(d) ? "unreviewed changes" : null,
    !d.existsOnDisk ? "deleted on disk" : null,
  ].filter(Boolean).join(" · ") || "clean";
  details.appendChild(metaRow("status", status));
  host.appendChild(details);
}

function positionTabPreview(host: HTMLElement, tab: HTMLElement): void {
  const r = tab.getBoundingClientRect();
  host.classList.add("visible");
  const maxLeft = window.innerWidth - host.offsetWidth - 8;
  host.style.left = `${Math.max(8, Math.min(r.left, maxLeft))}px`;
  host.style.top = `${r.bottom + 6}px`;
}

function bindTabHover(bar: HTMLElement): void {
  bar.addEventListener("mouseover", (ev) => {
    const tab = (ev.target as HTMLElement).closest<HTMLElement>(".tab");
    const id = tab?.dataset.id;
    if (!tab || !id || tabPreviewFor === id) return;
    tabPreviewFor = id;
    if (tabPreviewTimer) clearTimeout(tabPreviewTimer);
    tabPreviewTimer = window.setTimeout(() => {
      const d = state.docs.find((x) => x.id === id);
      if (!d || !tab.isConnected) return;
      if (!tabPreviewEl) {
        tabPreviewEl = el("div", "tab-preview");
        tabPreviewEl.setAttribute("role", "tooltip");
        document.body.appendChild(tabPreviewEl);
      }
      buildTabPreview(tabPreviewEl, d);
      positionTabPreview(tabPreviewEl, tab);
    }, 350);
  });
  bar.addEventListener("mouseout", (ev) => {
    const to = ev.relatedTarget as HTMLElement | null;
    if (to?.closest?.("#tabs")) return; // moving between spans within the bar
    hideTabPreview();
  });
  bar.addEventListener("scroll", hideTabPreview, true);
  bar.addEventListener("click", hideTabPreview);
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
  if (hasUnreviewedChanges(doc)) {
    const review = el("button", "review-btn", "Mark reviewed");
    review.onclick = () => {
      state = markReviewed(state, doc.id);
      const reviewed = getActive(state);
      if (reviewed) void writeReviewed(reviewed.absPath, reviewed.reviewedContent);
      render();
    };
    host.appendChild(review);
  }
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
    // Cap the empty-state list at the 5 most-recent so it can't push the
    // wordmark off the top of the window.
    const recent = loadRecent().slice(0, 5);
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

    // Prompt to wire Glance into a detected coding client, until they do.
    if (needsSetup(integrationClients)) {
      const cta = el("div", "setup-cta");
      const body = el("div", "setup-cta-text");
      body.appendChild(el("div", "setup-cta-title", "Set up AI integration"));
      body.appendChild(el("div", "setup-cta-sub", "Review your docs with Claude Code or Cursor — comments flow back as edits."));
      const btn = el("button", "setup-cta-btn", "Set up");
      btn.onclick = () => { void openIntegrationPicker("setup"); };
      cta.append(body, btn);
      empty.appendChild(cta);
    }

    host.appendChild(empty);
    return;
  }

  if (doc.viewMode === "source") {
    const cmHost = el("div", "cm-host");
    host.appendChild(cmHost);
    activeEditor = mountEditor(cmHost, doc.editorContent, (v) => {
      state = updateEditorContent(state, doc.id, v);
      refreshTabDirty(); // toggle dirty dot in place; don't rebuild tab nodes mid-interaction
    }, currentAppearance() === "dark");
  } else {
    const view = el("div", "rendered");
    view.innerHTML = renderMarkdown(doc.editorContent, changedLines(doc));
    host.appendChild(view);
    const mermaidDone = renderMermaidBlocks(view, currentThemeId(), currentAppearance());
    mountBlockExpanders(view); // code/tables + any synchronously-cached diagrams
    void mermaidDone.then(() => mountBlockExpanders(view)); // first-render diagrams
    const markers = assignMarkers(doc.annotations, doc.resolutions);
    applyHighlights(view, doc.annotations, doc.resolutions, markers);
    teardownToolbar = mountSelectionToolbar(view, () => startComment(doc.absPath));
  }
}

export function render(): void {
  // The mermaid zoom overlay lives on document.body, outside the rendered view,
  // so it would otherwise survive a tab switch / re-render on top of the new
  // content. Dismiss it here (same discipline as the selection toolbar).
  closeMermaidZoom();
  renderTabBar();
  renderActions();
  renderContent();
  renderRailFor();
  if (teardownHovers) { teardownHovers(); teardownHovers = null; }
  const renderedView = document.querySelector<HTMLElement>(".rendered");
  const railEl = document.getElementById("rail");
  if (renderedView && railEl) teardownHovers = linkAnnotationHovers(renderedView, railEl);
  saveSession();
}

// Cmd+A, routed from the native Edit menu (lib.rs) so we can do a real
// full-document select-all. In source mode the native selectAll: would grab only
// CodeMirror's visible (virtualized) lines, so we run CodeMirror's own command;
// in read mode we select the whole rendered view.
function selectAllContent(): void {
  // A focused text field (comment composer, rename/theme modal input) owns Cmd+A
  // — select its own text, not the document behind it. CodeMirror's editable is a
  // contenteditable div, not an input/textarea, so it correctly falls through.
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    active.select();
    return;
  }
  const doc = getActive(state);
  if (doc?.viewMode === "source" && activeEditor) {
    activeEditor.selectAll();
    return;
  }
  const view = document.querySelector<HTMLElement>(".rendered");
  const sel = window.getSelection();
  if (!view || !sel) return;
  const range = document.createRange();
  range.selectNodeContents(view);
  sel.removeAllRanges();
  sel.addRange(range);
}

function closeTab(id: string): void {
  const doc = state.docs.find((d) => d.id === id);
  if (doc) {
    void unwatchFile(doc.absPath);
    const storePath = annotationStorePaths.get(doc.absPath);
    if (storePath) { void unwatchFile(storePath); annotationStorePaths.delete(doc.absPath); }
  }
  state = closeDoc(state, id);
  render();
}

// Save the active doc to disk. Shared by the File▸Save menu item (⌘S). On
// failure the doc stays dirty (markSaved never runs) and the error is surfaced.
function saveActive(): void {
  const doc = getActive(state);
  if (!doc) return;
  void writeFile(doc.absPath, doc.editorContent).then(() => {
    state = markSaved(state, doc.id);
    const saved = state.docs.find((d) => d.id === doc.id);
    if (saved) void writeReviewed(saved.absPath, saved.reviewedContent);
    render();
  }).catch((err) => {
    showNotice(`Couldn't save ${doc.fileName}: ${err}`, false);
  });
}

export async function openPath(absPath: string): Promise<void> {
  const already = state.docs.find((d) => d.absPath === absPath);
  if (already) { state = setActive(state, absPath); render(); return; }
  const contents = await readFile(absPath);
  state = openDoc(state, absPath, contents);
  try {
    const baseline = await readReviewed(absPath);
    if (baseline != null) state = setReviewedBaseline(state, absPath, baseline);
  } catch (err) {
    console.warn("readReviewed failed for", absPath, err);
  }
  try {
    await watchFile(absPath);
  } catch (err) {
    console.warn("watchFile failed for", absPath, err);
  }
  const recent = pushRecent(loadRecent(), absPath);
  localStorage.setItem(LS_RECENT, JSON.stringify(recent));
  try {
    const storePath = await ensureAnnotationStore(absPath);
    annotationStorePaths.set(absPath, storePath);
    await watchAnnotations(storePath, absPath);
  } catch (err) {
    console.warn("annotation store watch failed for", absPath, err);
  }
  await loadAnnotations(absPath);
}

function changeTheme(pref: ThemePref): void {
  saveThemePref(pref);
  applyTheme(pref, render);
  render(); // remount editor so its dark flag matches the new appearance
}

// Publish the content pane's inner width as --pane-w so an expanded code/table
// block can break out to fill it (see block-expand.ts + styles.css). Tracks the
// pane, not the window, so it stays correct when the annotation rail (a sibling
// of #content) opens and shrinks the pane.
function trackPaneWidth(): void {
  const content = document.getElementById("content");
  if (!content) return;
  const publish = () =>
    document.documentElement.style.setProperty("--pane-w", `${content.clientWidth}px`);
  publish();
  new ResizeObserver(publish).observe(content);
}

export async function start(): Promise<void> {
  // Adopt the persisted theme (and wire the OS-follow listener for Auto). The
  // inline bootstrap in index.html already set data-theme to avoid a flash;
  // this re-applies it and, for Auto, keeps it in sync with the OS.
  applyTheme(loadThemePref(), render);
  trackPaneWidth();

  await onOpenFile((absPath) => { void openPath(absPath); });
  await onFileRemoved((path) => { state = markRemoved(state, path); render(); });
  await onShowIntegrationPicker((action) => { void openIntegrationPicker(action); });
  await onShowAbout(async () => { showAbout(await appVersion()); });
  await onShowTheme(() => {
    showThemePicker(loadThemePref(), {
      onPreview: (pref) => applyTheme(pref, render),
      onCommit: changeTheme,
    });
  });
  await onCloseActiveTab(() => { const d = getActive(state); if (d) closeTab(d.id); });
  await onMenuSave(() => saveActive());
  await onSelectAll(() => selectAllContent());
  await onAnnotationsChanged((docPath) => { void loadAnnotations(docPath); });
  await onFileChanged(async (e) => {
    const doc = state.docs.find((d) => d.absPath === e.path);
    if (!doc) return;
    // Our own save echo — no-op. Guard on existsOnDisk so a file that was
    // deleted and then recreated with content identical to the editor still
    // clears the "(deleted)" state instead of being swallowed as an echo.
    if (doc.existsOnDisk && doc.editorContent === e.contents) return;
    if (decideReload(doc) === "auto-reload") {
      state = applyDiskChange(state, doc.id, e.contents);
      render();
    } else {
      // Dismiss any open zoom overlay first — it sits above the modal layer, so
      // the reload prompt would otherwise be unreachable underneath it.
      closeMermaidZoom();
      const choice = await confirmReload(doc.fileName);
      if (choice === "disk") {
        state = applyDiskChange(state, doc.id, e.contents);
        render();
      }
      // "mine" → keep editor content; user's edits stay dirty
    }
  });
  window.addEventListener("keydown", (e) => {
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
  await refreshIntegration();
  render();
}
