import "./styles.css";
import {
  State, emptyState, openDoc, closeDoc, setActive, getActive,
  toggleViewMode, updateEditorContent, markSaved, applyDiskChange, markRemoved,
  setDocAnnotations, setDocResolutions, setDocActivity, clearDocActivity,
  markReviewed, setReviewedBaseline, canRevealActive, setDiskContent,
} from "./store";
import { isDirty, basename, changedLines, deletedBefore, hasUnreviewedChanges, toLf, withEol, type Doc } from "./document";
import { parseFrontmatter } from "./frontmatter";
import { renderMarkdown } from "./renderer";
import { renderMermaidBlocks } from "./mermaid";
import { mountBlockExpanders } from "./block-expand";
import { closeMermaidZoom } from "./mermaid-zoom";
import {
  readFile, writeFile, watchFile, unwatchFile, onOpenFile, onFileChanged, onFileRemoved, takeLaunchArgs,
  readAnnotations, addStoredAnnotation, removeStoredAnnotation, updateStoredAnnotation, addStoredReply, resolveAnchors, ensureAnnotationStore,
  watchAnnotations, onAnnotationsChanged, onShowIntegrationPicker, listIntegrationTargets, runIntegration,
  onShowAbout, onShowWhatsNew, onShowTheme, onCloseActiveTab, onMenuSave, onSelectAll, appVersion,
  onShowInFinder, revealInFinder, setShowInFinderEnabled, onQuitRequested, quitApp,
  readReviewed, writeReviewed, openExternal, openFileExternal, localFileUrl, resolveWikilink,
  canonicalizePath, onFileError,
} from "./ipc";
import { classifyLink, dirname, headingSlugs, parseWikilink, resolveLocalPath, slugify } from "./links";
import {
  addAnnotation, removeAnnotation, patchAnnotation, appendReply, genId, type Annotation, type AnnotationPatch,
} from "./annotations";
import { captureSelection } from "./anchor-capture";
import { resolveOpenTarget } from "./ipc";
import { showCommentComposer } from "./composer";
import { showToast } from "./toast";
import { applyRailWidth, mountRailResizer, parseRailWidth } from "./rail-resize";
import { sectionFor, shouldShowWhatsNew } from "./whats-new";
import { isCheckDue, isNewer, parseRelease } from "./update-check";
import changelog from "../CHANGELOG.md?raw";
import { diffActivity, activityMessage } from "./activity";
import {
  renderRail, applyHighlights, mountSelectionToolbar, assignMarkers, markerColor, linkAnnotationHovers, pulseBlock,
  focusRailCard, parseRailPref,
} from "./annotation-ui";
import { annotationIdSelector } from "./annotation-ui";
import { mountBlockEditor, mountEditor, type BlockEditorHandle, type EditorHandle } from "./editor";
import { appendTarget, caretInSource, fenceBody, sliceLines, spliceLines, splicedCount, trimBlankTail } from "./block-edit";
import { decideReload } from "./reload";
import { restoreTarget, lineAtOffset, offsetForLine, type LineBlock } from "./scroll-restore";
import { confirmOpenFile, confirmReload, showNotice, showSetupResult, showIntegrationPicker, showAbout, showThemePicker, showWhatsNew } from "./modal";
import { showUpdateAvailable, showUpToDate } from "./modal";
import { fetchLatestRelease, onCheckForUpdates } from "./ipc";
import {
  applyTheme, loadThemePref, saveThemePref, currentAppearance, currentThemeId, type ThemePref,
} from "./theme";
import { openPaths, pushRecent } from "./session";
import { needsSetup } from "./integration";
import { shouldShowCommentHint } from "./hint";
import type { ClientInfo, IntegrationAction } from "./ipc";
import { confirmUnsaved } from "./modal";

const LS_OPEN = "glance.openPaths";
const LS_RECENT = "glance.recent";
const LS_RAIL = "glance.rail";
const LS_HINT = "glance.commentHintSeen";
const LS_RAIL_W = "glance.railWidth";
const LS_SEEN_VERSION = "glance.seenVersion";
const LS_UPDATE_CHECKED = "glance.updateCheckedAt";

// absPath → annotation store path, so closeTab can release the store's file
// watcher (keyed by store path, not doc path) instead of leaking it until exit.
const annotationStorePaths = new Map<string, string>();

function loadRecent(): string[] {
  try { return JSON.parse(localStorage.getItem(LS_RECENT) || "[]"); } catch { return []; }
}
// True while start() reopens the saved session. render() runs per opened tab,
// and saving then would replace the saved list with a partial one.
let restoringSession = false;

function saveSession(): void {
  if (restoringSession) return;
  localStorage.setItem(LS_OPEN, JSON.stringify(openPaths(state)));
}

let state: State = emptyState();
let activeEditor: EditorHandle | null = null;
// The doc activeEditor was mounted for.
let editorDocId: string | null = null;
// Source line at the top of the view when Read/Edit was toggled, so the other
// mode opens at the same place instead of the top.
let pendingTopLine: number | null = null;
let toolbar: { hide(): void; destroy(): void } | null = null;

// The rendered block being edited in place. It took over source lines `start`
// onward; `occupied` is how many lines its text fills now (0 for a new block at
// the end not yet typed into), `origLines` how many it filled when opened.
// `gap` adds a blank line above a new block.
interface BlockEdit {
  docId: string;
  start: number;
  occupied: number;
  origLines: number;
  gap: boolean;
  host: HTMLElement;
  handle: BlockEditorHandle;
  // The text it opened with and when, to tell a double-click from an edit.
  initial: string;
  openedAt: number;
}
let blockEdit: BlockEdit | null = null;
// The rendered view renderContent last built, so click-to-edit only ever acts
// on the live one.
let renderedView: HTMLElement | null = null;
// A mousedown outside the block editor: its mouseup decides what the click
// means, so the blur that mousedown causes mustn't close the editor first.
let pointerDown = false;
let teardownHovers: (() => void) | null = null;

// #content is the scroll container and renderContent() wipes it on every state
// change. Remember each doc's scrollTop (DOM state, so it lives here and not in
// State) and put it back after the rebuild.
const scrollPositions = new Map<string, number>();
let lastRenderedId: string | null = null;
let lastRenderedMode: string | null = null;

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

// Paths whose store has been read at least once. The first read has no
// baseline to diff against, so it must not report Claude activity.
const annotationsLoaded = new Set<string>();

const ERROR_TOAST_MS = 12000;

async function loadAnnotations(absPath: string): Promise<void> {
  let store;
  try {
    store = await readAnnotations(absPath);
  } catch (err) {
    showToast(`Couldn't load comments for ${basename(absPath)}. ${err}`, { ms: ERROR_TOAST_MS });
    return;
  }
  const next = store.annotations;
  const before = state.docs.find((d) => d.absPath === absPath);
  if (!before) return; // closed while the read was in flight
  const prev = annotationsLoaded.has(absPath) ? before.annotations : next;
  annotationsLoaded.add(absPath);
  state = setDocAnnotations(state, absPath, next);
  await refreshResolutions(absPath);
  render();
  const doc = state.docs.find((d) => d.absPath === absPath);
  if (!doc) return;
  const act = diffActivity(prev, next);
  const ids = [...act.resolved, ...act.replied];
  if (ids.length === 0) return;
  if (doc.id === state.activeId) {
    const rail = document.getElementById("rail");
    if (!rail) return;
    for (const id of ids) focusRailCard(rail, id);
    showToast(activityMessage(act), { actionLabel: "Show", onAction: () => focusRailCard(rail, ids[0]) });
  } else {
    state = setDocActivity(state, doc.id, ids);
    render();
  }
}

// Land an optimistic comment change: on success reconcile with the merged
// on-disk truth; on failure put back the list from before the change and say
// why. Resolves true when the store accepted the write.
function persistComments(absPath: string, before: Annotation[], write: Promise<unknown>): Promise<boolean> {
  return write.then(
    () => loadAnnotations(absPath).then(() => true),
    (err) => {
      state = setDocAnnotations(state, absPath, before);
      render();
      showToast(`Couldn't save the comment change on ${basename(absPath)}. ${err}`, { ms: ERROR_TOAST_MS });
      return false;
    },
  );
}

// absPath → the newest resolve started for it, so a slower resolve for older
// text or comments (or for a tab closed since) can't overwrite a newer one. The
// counter is global so a reopened tab never matches a resolve from before.
let resolveCounter = 0;
const latestResolve = new Map<string, number>();
// absPath → the text the doc's current resolutions were computed against.
const resolvedText = new Map<string, string>();

// Resolves true when this call's result was stored.
async function refreshResolutions(absPath: string): Promise<boolean> {
  const doc = state.docs.find((d) => d.absPath === absPath);
  if (!doc) return false;
  const seq = ++resolveCounter;
  latestResolve.set(absPath, seq);
  const text = doc.editorContent;
  const resList = await resolveAnchors(text, doc.annotations);
  if (latestResolve.get(absPath) !== seq) return false;
  const map: Record<string, import("./annotations").Resolution> = {};
  for (const r of resList) map[r.id] = r;
  state = setDocResolutions(state, absPath, map);
  resolvedText.set(absPath, text);
  return true;
}

// Comment positions are resolved against the doc's text, so they go stale when
// the text changes outside a store reload (a disk change, typing in Edit).
// Resolves true when it stored fresh resolutions.
async function catchUpResolutions(absPath: string): Promise<boolean> {
  const doc = state.docs.find((d) => d.absPath === absPath);
  if (!doc || resolvedText.get(absPath) === doc.editorContent) return false;
  try {
    return await refreshResolutions(absPath);
  } catch (err) {
    console.warn("resolveAnchors failed for", absPath, err);
    return false;
  }
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
    quote: cap.displayQuote,
    anchor: { top: rect.top, bottom: rect.bottom, left: rect.left },
    onSubmit: (note) => {
      localStorage.setItem(LS_HINT, "1");
      const annotation: Annotation = {
        id: genId(), number: 0, quote: cap.quote, prefix: cap.prefix, suffix: cap.suffix,
        lineHint: cap.lineHint, note, status: "open", author: "user",
        createdAt: new Date().toISOString(), replies: [],
      };
      // Optimistically add to the local list for instant feedback (re-read from
      // current state, not the list captured when the composer opened). The
      // server-side add is locked and merges against disk, and loadAnnotations
      // then reconciles local state with the merged truth.
      const cur = state.docs.find((d) => d.absPath === absPath)?.annotations ?? doc.annotations;
      state = setDocAnnotations(state, absPath, addAnnotation(cur, annotation));
      render();
      void persistComments(absPath, cur, addStoredAnnotation(absPath, annotation));
    },
    onCancel: () => {},
  });
}

let railPref = parseRailPref(localStorage.getItem(LS_RAIL));
let resolvedOpen = false;

function renderRailFor(): void {
  const host = document.getElementById("rail");
  if (!host) return;
  const doc = getActive(state);
  if (!doc) { host.innerHTML = ""; return; }
  // The rail's cards can't scroll-to or highlight anything in the editor.
  if (doc.viewMode === "source") { host.classList.add("empty"); host.innerHTML = ""; return; }
  const markers = assignMarkers(doc.annotations, doc.resolutions);
  // Optimistic local patch (fresh from state), then the locked server-side
  // update, then reconcile with the merged on-disk truth. `clearResolution`
  // tells the server to drop resolvedBy/resolvedAt, which `undefined` can't.
  const patch = (a: Annotation, local: AnnotationPatch, clearResolution = false) => {
    const cur = state.docs.find((d) => d.absPath === doc.absPath)?.annotations ?? doc.annotations;
    state = setDocAnnotations(state, doc.absPath, patchAnnotation(cur, a.id, local));
    render();
    const stored = clearResolution ? { ...local, clearResolution } : local;
    void persistComments(doc.absPath, cur, updateStoredAnnotation(doc.absPath, a.id, stored));
  };
  renderRail(host, doc.annotations, doc.resolutions, markers, {
    onScrollTo: (a) => {
      const r = doc.resolutions[a.id];
      if (r?.startLine == null) return;
      const node = document.querySelector(`mark.anno-highlight${annotationIdSelector(a.id)}`)
        ?? document.querySelector(`[data-sourceline="${r.startLine}"]`);
      node?.scrollIntoView({ behavior: "smooth", block: "center" });
      pulseBlock(node);
    },
    onResolve: (a) => {
      patch(a, { status: "resolved", resolvedBy: "user", resolvedAt: new Date().toISOString() });
    },
    onReopen: (a) => {
      patch(a, { status: "open", resolvedBy: undefined, resolvedAt: undefined }, true);
    },
    onEdit: (a) => {
      const card = host.querySelector<HTMLElement>(`.note-card${annotationIdSelector(a.id)}`);
      const rect = card?.getBoundingClientRect() ?? ({ top: 120, bottom: 140, left: 120 } as DOMRect);
      showCommentComposer({
        quote: a.quote,
        anchor: { top: rect.top, bottom: rect.bottom, left: rect.left },
        initial: a.note,
        mode: "edit",
        onSubmit: (note) => { if (note !== a.note) patch(a, { note }); },
        onCancel: () => {},
      });
    },
    onReanchor: (a) => {
      // Re-capture the anchor from the current selection; the comment keeps its
      // id, number, note, and replies and goes back to Open. refreshResolutions
      // runs inside loadAnnotations, so the card regains its number and line.
      const cap = captureSelection(doc.editorContent);
      if (!cap) { showToast("Select text in the document first"); return; }
      patch(a, { quote: cap.quote, prefix: cap.prefix, suffix: cap.suffix, lineHint: cap.lineHint, status: "open" });
      showToast(a.number > 0 ? `Comment ${a.number} re-anchored` : "Comment re-anchored");
    },
    onReply: (a, text) => {
      // Same shape as `patch`: optimistic append, then the locked server-side
      // add (which stamps its own time), then reconcile.
      const cur = state.docs.find((d) => d.absPath === doc.absPath)?.annotations ?? doc.annotations;
      const reply = { author: "user" as const, text, createdAt: new Date().toISOString() };
      state = setDocAnnotations(state, doc.absPath, appendReply(cur, a.id, reply));
      render();
      void persistComments(doc.absPath, cur, addStoredReply(doc.absPath, a.id, text));
    },
    onRemove: (a) => {
      // Optimistic local remove (fresh from state), then the locked server-side
      // remove, then reconcile with the merged on-disk truth. Undo re-adds the
      // annotation as the store held it when removed (its assigned number, and
      // replies or a resolution that landed after the rail rendered) once the
      // remove has landed, so the store stays consistent even if the app quits
      // mid-toast.
      const cur = state.docs.find((d) => d.absPath === doc.absPath)?.annotations ?? doc.annotations;
      const local = cur.find((x) => x.id === a.id) ?? a;
      state = setDocAnnotations(state, doc.absPath, removeAnnotation(cur, a.id));
      render();
      const removal = removeStoredAnnotation(doc.absPath, a.id);
      const removed = persistComments(doc.absPath, cur, removal);
      showToast(local.number > 0 ? `Comment ${local.number} deleted` : "Comment deleted", {
        actionLabel: "Undo",
        onAction: () => {
          void removed.then(async (ok) => {
            if (!ok) return; // the remove was rolled back; nothing to undo
            const restored = (await removal) ?? local;
            const now = state.docs.find((d) => d.absPath === doc.absPath)?.annotations ?? [];
            state = setDocAnnotations(state, doc.absPath, addAnnotation(now, restored));
            render();
            return persistComments(doc.absPath, now, addStoredAnnotation(doc.absPath, restored));
          });
        },
      });
    },
    onClearResolved: (ids) => {
      const before = state.docs.find((d) => d.absPath === doc.absPath)?.annotations ?? doc.annotations;
      let cur = before;
      for (const id of ids) cur = removeAnnotation(cur, id);
      state = setDocAnnotations(state, doc.absPath, cur);
      render();
      void persistComments(doc.absPath, before, Promise.all(ids.map((id) => removeStoredAnnotation(doc.absPath, id))));
    },
  }, {
    pref: railPref,
    resolvedOpen,
    onTogglePref: () => {
      railPref = railPref === "collapsed" ? "open" : "collapsed";
      localStorage.setItem(LS_RAIL, railPref);
      render();
    },
    onToggleResolved: () => { resolvedOpen = !resolvedOpen; render(); },
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
    if (target.closest(".close")) { void closeTab(id); return; }
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
    if (d.claudeActivity.length > 0) {
      const dot = el("span", "claude-dot");
      const first = d.annotations.find((a) => a.id === d.claudeActivity[0]);
      if (first) dot.style.setProperty("--anno-color", markerColor(first.number));
      tab.appendChild(dot);
    }
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
  // Editing happens in place by clicking a block; ⌘E's whole-file source view
  // is the escape hatch, and this is the way back out of it.
  if (doc.viewMode === "source") {
    const seg = el("div", "segmented");
    const back = el("button", "on", "Source");
    back.title = "Back to the formatted view (⌘E)";
    back.onclick = () => switchViewMode(doc.id);
    seg.appendChild(back);
    host.appendChild(seg);
  }
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
  const doc = getActive(state);
  // Same doc still in Edit mode: keep the editor (cursor, focus, undo history)
  // and only bring its text up to date if it changed outside the editor.
  if (doc && doc.viewMode === "source" && activeEditor && editorDocId === doc.id && host.querySelector(".cm-host")) {
    activeEditor.setContent(toLf(doc.editorContent));
    activeEditor.setDark(currentAppearance() === "dark");
    return;
  }
  // Same for a block being edited, as long as the doc still holds its text
  // where we left it (a reload from disk may have moved or replaced it).
  if (blockEdit) {
    if (doc && blockEditStillFits(doc, blockEdit)) return;
    dropBlockEdit();
  }
  if (activeEditor) { activeEditor.destroy(); activeEditor = null; editorDocId = null; }
  renderedView = null;
  host.innerHTML = "";
  if (toolbar) { toolbar.destroy(); toolbar = null; }
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
        li.onclick = () => {
          void openPath(p).catch((err) => {
            if (isNotFound(err)) { forgetRecent(p); render(); }
            showNotice(`Couldn't open ${p}: ${err}`, false);
          });
        };
        ul.appendChild(li);
      }
      wrap.appendChild(ul);
      empty.appendChild(wrap);
    }
    const hint = el("div", "hint");
    hint.innerHTML =
      'Open files with <kbd>mdview &lt;file&gt;</kbd> &nbsp;·&nbsp; ' +
      'click to edit, whole-file source <kbd>⌘E</kbd> &nbsp;·&nbsp; save <kbd>⌘S</kbd> &nbsp;·&nbsp; ' +
      'comment <kbd>⌘⇧M</kbd>';
    empty.appendChild(hint);

    // Prompt to wire Glance into a detected coding client, until they do.
    if (needsSetup(integrationClients)) {
      const cta = el("div", "setup-cta");
      const body = el("div", "setup-cta-text");
      body.appendChild(el("div", "setup-cta-title", "Set up AI integration"));
      body.appendChild(el("div", "setup-cta-sub", "Review your docs with Claude Code, Codex, or Cursor — comments flow back as edits."));
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
      const eol = state.docs.find((d) => d.id === doc.id)?.eol ?? doc.eol;
      state = updateEditorContent(state, doc.id, withEol(v, eol));
      refreshTabDirty(); // toggle dirty dot in place; don't rebuild tab nodes mid-interaction
    }, currentAppearance() === "dark");
    editorDocId = doc.id;
  } else {
    const view = el("div", "rendered");
    renderedView = view;
    view.innerHTML = renderMarkdown(
      doc.editorContent,
      changedLines(doc),
      deletedBefore(doc),
      (src) => {
        const path = resolveLocalPath(dirname(doc.absPath), src);
        return path ? localFileUrl(path) : null;
      },
    );
    if (shouldShowCommentHint(localStorage.getItem(LS_HINT), doc.annotations.length)) {
      const strip = el("div", "comment-hint");
      const text = el("span", "comment-hint-text");
      text.innerHTML = "Select any text and press <kbd>⌘⇧M</kbd> to leave a comment for Claude.";
      const close = el("button", "comment-hint-close", "×");
      close.title = "Dismiss";
      close.onclick = () => {
        localStorage.setItem(LS_HINT, "1");
        strip.remove();
      };
      strip.append(text, close);
      host.appendChild(strip);
    }
    host.appendChild(view);
    const mermaidDone = renderMermaidBlocks(view, currentThemeId(), currentAppearance());
    mountBlockExpanders(view); // code/tables + any synchronously-cached diagrams
    void mermaidDone.then(() => mountBlockExpanders(view)); // first-render diagrams
    highlightComments(view, doc);
    toolbar = mountSelectionToolbar(view, () => startComment(doc.absPath));
  }
}

function highlightComments(view: HTMLElement, doc: Doc): void {
  const markers = assignMarkers(doc.annotations, doc.resolutions);
  applyHighlights(view, doc.annotations, doc.resolutions, markers, (id) => {
    const rail = document.getElementById("rail");
    if (rail) focusRailCard(rail, id);
  });
}

// Bring the active doc's highlights and rail up to date in place. A full
// render() would rebuild #content and undo a scroll restore still pending from
// the render just before it.
function redrawComments(id: string): void {
  const doc = getActive(state);
  const view = document.querySelector<HTMLElement>("#content .rendered");
  if (!doc || doc.id !== id || doc.viewMode !== "rendered" || !view) return;
  // Highlighting walks the view's text and would reach into the block editor.
  if (blockEdit?.docId !== id) highlightComments(view, doc);
  renderRailFor();
}

// What we last told the native menu. `null` until the first render: the item is
// created disabled in lib.rs, but a webview reload resets this module while the
// native MenuItem keeps whatever it was last set to, so the first sync always
// crosses the boundary rather than assuming.
let showInFinderEnabled: boolean | null = null;

// render() runs on every state change, so only cross the IPC boundary when the
// answer actually flips.
function syncShowInFinderMenu(): void {
  const enabled = canRevealActive(state);
  if (enabled === showInFinderEnabled) return;
  // Record optimistically so a burst of renders sends one invoke, but clear it
  // on failure so the next render retries instead of leaving the menu stale.
  showInFinderEnabled = enabled;
  void setShowInFinderEnabled(enabled).catch(() => { showInFinderEnabled = null; });
}

export function render(): void {
  // The mermaid zoom overlay lives on document.body, outside the rendered view,
  // so it would otherwise survive a tab switch / re-render on top of the new
  // content. Dismiss it here (same discipline as the selection toolbar).
  closeMermaidZoom();
  const content = document.getElementById("content");
  if (content && lastRenderedId) scrollPositions.set(lastRenderedId, content.scrollTop);
  renderTabBar();
  renderActions();
  renderContent();
  renderRailFor();
  const active = getActive(state);
  if (active && active.claudeActivity.length > 0) {
    const ids = active.claudeActivity;
    const rail = document.getElementById("rail");
    // The rail was just rebuilt; pulse after layout so scrollIntoView lands.
    requestAnimationFrame(() => { if (rail) for (const id of ids) focusRailCard(rail, id); });
    // Tab bar only: a full render() here would recurse.
    state = clearDocActivity(state, active.id);
    renderTabBar();
  }
  const next = { id: active?.id ?? null, mode: active?.viewMode ?? null };
  const target = restoreTarget({ id: lastRenderedId, mode: lastRenderedMode }, next, scrollPositions);
  // Mermaid blocks render async after renderContent(), so defer a frame.
  const topLine = pendingTopLine;
  pendingTopLine = null;
  if (content) requestAnimationFrame(() => {
    content.scrollTop = target;
    if (topLine !== null) scrollToSourceLine(content, topLine);
  });
  lastRenderedId = next.id;
  lastRenderedMode = next.mode;
  syncShowInFinderMenu();
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
  if (blockEdit?.handle.hasFocus()) {
    blockEdit.handle.selectAll();
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

// Ask what to do with a doc's unsaved edits. Resolves true when the doc can go:
// it was clean, it saved, or the user chose Don't Save.
async function settleUnsaved(id: string): Promise<boolean> {
  const doc = state.docs.find((d) => d.id === id);
  if (!doc || !isDirty(doc)) return true;
  closeMermaidZoom(); // the zoom overlay sits above the modal layer
  const choice = await confirmUnsaved(doc.fileName);
  if (choice === "cancel") return false;
  // Another prompt for this doc (Cmd+W, then Cmd+Q) may have settled it already.
  const now = state.docs.find((d) => d.id === id);
  if (!now || !isDirty(now) || choice === "discard") return true;
  return saveDoc(id);
}

// Tabs with an unsaved-changes prompt open, so a repeated Cmd+W doesn't stack
// a second prompt for the same doc.
const closing = new Set<string>();

async function closeTab(id: string): Promise<void> {
  if (closing.has(id)) return;
  closing.add(id);
  try {
    if (!(await settleUnsaved(id))) return;
  } finally {
    closing.delete(id);
  }
  const pending = pendingReloads.get(id);
  if (pending) { pending.live = false; pendingReloads.delete(id); }
  const doc = state.docs.find((d) => d.id === id);
  if (doc) {
    void unwatchFile(doc.absPath);
    const storePath = annotationStorePaths.get(doc.absPath);
    if (storePath) { void unwatchFile(storePath); annotationStorePaths.delete(doc.absPath); }
    annotationsLoaded.delete(doc.absPath);
    latestResolve.delete(doc.absPath);
    resolvedText.delete(doc.absPath);
  }
  state = closeDoc(state, id);
  render();
  scrollPositions.delete(id); // after render(), which re-saves the outgoing doc's position
}

// absPath → texts our saves are writing right now. The watcher can report a
// save's own write before the write call returns; matching it here keeps that
// echo from looking like an outside change.
const inFlightWrites = new Map<string, string[]>();

// doc id → newest disk text seen while a "changed on disk" prompt is open for
// that doc. Save is refused meanwhile (it would overwrite the change being
// asked about), and further changes update the open prompt instead of opening
// another. Closing the tab marks the entry dead: the doc id is its path, so a
// reopened tab must not inherit a prompt that was about the closed one.
interface PendingReload { latest: string; live: boolean }
const pendingReloads = new Map<string, PendingReload>();

// Write a doc to disk. On failure the doc stays dirty (markSaved never runs)
// and the error is surfaced. Resolves true once the text is on disk.
async function saveDoc(id: string): Promise<boolean> {
  const doc = state.docs.find((d) => d.id === id);
  if (!doc) return false;
  if (pendingReloads.has(id)) {
    showToast(`${doc.fileName} changed on disk. Choose Keep mine or Load disk before saving.`);
    return false;
  }
  const written = doc.editorContent;
  const writes = inFlightWrites.get(doc.absPath) ?? [];
  writes.push(written);
  inFlightWrites.set(doc.absPath, writes);
  try {
    await writeFile(doc.absPath, written);
  } catch (err) {
    showNotice(`Couldn't save ${doc.fileName}: ${err}`, false);
    return false;
  } finally {
    writes.splice(writes.indexOf(written), 1);
    if (!writes.length) inFlightWrites.delete(doc.absPath);
  }
  state = markSaved(state, id, written);
  const saved = state.docs.find((d) => d.id === id);
  if (saved) void writeReviewed(saved.absPath, saved.reviewedContent);
  render();
  if (saved) void catchUpResolutions(saved.absPath).then((fresh) => { if (fresh) redrawComments(id); });
  return true;
}

// File▸Save (⌘S).
function saveActive(): void {
  const doc = getActive(state);
  if (doc) void saveDoc(doc.id);
}

let quitting = false;

// Cmd+Q / the window's close button. Walks the dirty docs one at a time
// (showing each), and quits only if every one was saved or let go.
async function requestQuit(): Promise<void> {
  if (quitting) return;
  quitting = true;
  try {
    for (const doc of state.docs.filter(isDirty)) {
      if (state.activeId !== doc.id) { state = setActive(state, doc.id); render(); }
      if (!(await settleUnsaved(doc.id))) return;
    }
    await quitApp().catch((err) => showNotice(`Couldn't quit: ${err}`, false));
  } finally {
    quitting = false;
  }
}

// A change event whose text we already account for: what we last saw on disk,
// what the editor holds, or what one of our saves is writing.
function isKnownContent(doc: Doc, contents: string): boolean {
  if (inFlightWrites.get(doc.absPath)?.includes(contents)) return true;
  // Guard on existsOnDisk so a file that was deleted and then recreated with
  // content identical to the editor still clears the "(deleted)" state.
  if (!doc.existsOnDisk) return false;
  return contents === doc.diskContent || contents === doc.editorContent;
}

async function handleDiskChange(path: string, contents: string): Promise<void> {
  const doc = state.docs.find((d) => d.absPath === path);
  if (!doc) return;
  const open = pendingReloads.get(doc.id);
  if (open) { open.latest = contents; return; }
  if (isKnownContent(doc, contents)) return;
  if (decideReload(doc) === "auto-reload") {
    // Render before resolving: until render() remounts the editor, a keystroke
    // would write the old text back over the disk change.
    state = applyDiskChange(state, doc.id, contents);
    render();
    void catchUpResolutions(doc.absPath).then((fresh) => { if (fresh) redrawComments(doc.id); });
    return;
  }
  const pending: PendingReload = { latest: contents, live: true };
  pendingReloads.set(doc.id, pending);
  // Dismiss any open zoom overlay first — it sits above the modal layer, so
  // the reload prompt would otherwise be unreachable underneath it.
  closeMermaidZoom();
  const choice = await confirmReload(doc.fileName);
  if (pendingReloads.get(doc.id) === pending) pendingReloads.delete(doc.id);
  if (!pending.live || !state.docs.some((d) => d.id === doc.id)) return;
  const latest = pending.latest;
  if (choice === "disk") {
    state = applyDiskChange(state, doc.id, latest);
    render();
    void catchUpResolutions(doc.absPath).then((fresh) => { if (fresh) redrawComments(doc.id); });
  } else {
    // "mine": keep the editor text (still dirty) but record what disk holds now.
    state = setDiskContent(state, doc.id, latest);
    renderTabBar();
    renderActions();
  }
}

// One spelling per file, so a symlink, `..` or different letter case finds the
// tab that is already open instead of opening a second one.
async function canonical(path: string): Promise<string> {
  try { return await canonicalizePath(path); } catch { return path; }
}

const isNotFound = (err: unknown) => /os error 2\b|No such file/i.test(String(err));

function forgetRecent(path: string): void {
  localStorage.setItem(LS_RECENT, JSON.stringify(loadRecent().filter((p) => p !== path)));
}

export async function openPath(requested: string): Promise<void> {
  const absPath = await canonical(requested);
  const already = state.docs.find((d) => d.absPath === absPath);
  if (already) { state = setActive(state, already.id); render(); return; }
  const contents = await readFile(absPath);
  state = openDoc(state, absPath, contents);
  // The tab can be closed while any of the awaits below is pending. closeTab
  // can only release watchers that exist by then, so each step checks and
  // releases its own.
  const isOpen = () => state.docs.some((d) => d.absPath === absPath);
  // The first baseline and store calls use the spelling the doc arrived with:
  // older versions filed its data under that spelling, and the backend moves
  // it to the resolved path when it sees it. Later calls use absPath.
  try {
    const baseline = await readReviewed(requested);
    if (baseline != null) state = setReviewedBaseline(state, absPath, baseline);
  } catch (err) {
    console.warn("readReviewed failed for", absPath, err);
  }
  try {
    await watchFile(absPath);
  } catch (err) {
    console.warn("watchFile failed for", absPath, err);
  }
  if (!isOpen()) { void unwatchFile(absPath); return; }
  const recent = pushRecent(loadRecent().filter((p) => p !== requested), absPath);
  localStorage.setItem(LS_RECENT, JSON.stringify(recent));
  try {
    const storePath = await ensureAnnotationStore(requested);
    if (!isOpen()) return;
    annotationStorePaths.set(absPath, storePath);
    await watchAnnotations(storePath, absPath);
    if (!isOpen()) {
      void unwatchFile(storePath);
      if (annotationStorePaths.get(absPath) === storePath) annotationStorePaths.delete(absPath);
      return;
    }
  } catch (err) {
    console.warn("annotation store watch failed for", absPath, err);
  }
  await loadAnnotations(absPath);
}

// Every link click is routed here: the webview must never navigate away from
// the app. Web links go to the default browser, .md links open as Glance tabs,
// other local files open in their default app, and #fragments scroll in place.
// Mermaid renders diagram links as SVG <a xlink:href>, which `a[href]` misses.
const XLINK = "http://www.w3.org/1999/xlink";

function handleLinkClick(ev: MouseEvent): void {
  if (ev.defaultPrevented || ev.button !== 0) return;
  const a = (ev.target as Element | null)?.closest?.("a[href], a[data-wikilink], a[*|href]");
  if (!a) return;
  ev.preventDefault();
  const doc = getActive(state);
  const wikilink = a.getAttribute("data-wikilink");
  if (wikilink !== null) {
    if (doc) void followWikilink(doc.absPath, wikilink);
    return;
  }
  const href = a.getAttribute("href") ?? a.getAttributeNS(XLINK, "href") ?? "";
  const target = classifyLink(href, doc ? dirname(doc.absPath) : null);
  switch (target.kind) {
    case "external":
      void openExternal(target.url).catch(() => showNotice(`Couldn't open ${target.url}.`, false));
      break;
    case "markdown":
      void openPath(target.path).catch(() => showNotice(`Couldn't open ${target.path}.`, false));
      break;
    case "file":
      void openLinkedFile(target.path);
      break;
    case "anchor":
      scrollToHeading(target.id);
      break;
  }
}

async function openLinkedFile(path: string): Promise<void> {
  try {
    const target = await resolveOpenTarget(path);
    if (target.confirm && !(await confirmOpenFile(target.path))) return;
    await openFileExternal(target.path);
  } catch {
    showNotice(`Couldn't open ${path}.`, false);
  }
}

function scrollToHeading(id: string): void {
  const view = document.querySelector("#content .rendered");
  const byId = view?.querySelector(`[id="${CSS.escape(id)}"]`);
  const slug = slugify(id);
  const heading = byId ?? Array.from(view?.querySelectorAll("h1, h2, h3, h4, h5, h6") ?? [])
    .find((h) => {
      const box = h.querySelector<HTMLInputElement>(":scope > .task-list-item-checkbox");
      return headingSlugs(h.textContent ?? "", box ? box.checked : undefined).includes(slug);
    });
  heading?.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function followWikilink(docPath: string, raw: string): Promise<void> {
  const link = parseWikilink(raw);
  if (!link) return;
  if (!link.note) { scrollToHeading(link.heading); return; }
  const match = await resolveWikilink(docPath, link.note).catch(() => null);
  const path = match?.path;
  if (!path) {
    showNotice(match?.capped
      ? `No note named "${link.note}" was found. The vault is too large to search in full, so it may still exist.`
      : `No note named "${link.note}" was found.`, false);
    return;
  }
  if (!/\.(md|markdown)$/i.test(path)) {
    void openLinkedFile(path);
    return;
  }
  await openPath(path).catch(() => showNotice(`Couldn't open ${path}.`, false));
  // render() restores scroll in a frame; land on the heading after that.
  if (link.heading) requestAnimationFrame(() => requestAnimationFrame(() => scrollToHeading(link.heading)));
}

// ---- Click-to-edit -------------------------------------------------------

// The smallest rendered element a click opens: a paragraph or heading (also one
// inside a quote), a list item's own text, a table row, a code block's code, a
// diagram, a rule, or the frontmatter card. Containers (lists, tables, quotes)
// never open whole; a click on their padding goes to the unit level with it.
const STAMPED = "[data-sourceline], [data-frontmatter-lines]";
const NOT_EDITABLE = "a, button, input, textarea, select, mark.anno-highlight, .block-editor";

function hasStampedInside(el: Element, except?: string): boolean {
  return Array.from(el.querySelectorAll("[data-sourceline]")).some((d) => !except || !d.matches(except));
}

function isUnit(el: HTMLElement): boolean {
  if (el.dataset.frontmatterLines || el.tagName === "TR") return true;
  // A list item owns its text; its nested items are units of their own.
  if (el.tagName === "LI") return !hasStampedInside(el, "li, ul, ol");
  return !hasStampedInside(el);
}

function editUnits(view: HTMLElement): HTMLElement[] {
  return Array.from(view.querySelectorAll<HTMLElement>(STAMPED)).filter(isUnit);
}

function unitAt(view: HTMLElement, node: Element, y: number): HTMLElement | null {
  const el = node.closest<HTMLElement>(STAMPED);
  if (!el || !view.contains(el)) return null;
  if (isUnit(el)) return el;
  const inside = editUnits(el);
  let best: HTMLElement | null = null;
  let bestGap = Infinity;
  for (const u of inside) {
    const r = u.getBoundingClientRect();
    const gap = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    if (gap <= bestGap) { best = u; bestGap = gap; }
  }
  return best;
}

// An element's identity across a redraw: its start line and tag.
interface UnitKey { line: number; tag: string }

function keyOf(el: HTMLElement): UnitKey {
  return { line: el.dataset.frontmatterLines ? 0 : Number(el.dataset.sourceline), tag: el.tagName };
}

function unitFor(view: HTMLElement, key: UnitKey): HTMLElement | null {
  if (key.line === 0) return view.querySelector<HTMLElement>("[data-frontmatter-lines]");
  return Array.from(view.querySelectorAll<HTMLElement>(`[data-sourceline="${key.line}"]`))
    .find((e) => e.tagName === key.tag && isUnit(e)) ?? null;
}

// The source lines a unit opens (1-based, inclusive), and whether they're code.
function unitRange(el: HTMLElement, text: string): { start: number; end: number; code: boolean } {
  const fm = el.dataset.frontmatterLines;
  if (fm) return { start: 1, end: Number(fm), code: false };
  const start = Number(el.dataset.sourceline);
  let end = Number(el.dataset.sourcelineEnd ?? start);
  if (el.tagName === "PRE") {
    const body = fenceBody(text, start, end);
    if (body) return { ...body, code: true };
    if (!/^\s{0,3}(`{3,}|~{3,})/.test(text.split("\n")[start - 1] ?? "")) return { start, end, code: true };
  }
  if (el.tagName === "LI") {
    const nested = Array.from(el.querySelectorAll<HTMLElement>("li[data-sourceline]"), (n) => Number(n.dataset.sourceline));
    if (nested.length) end = Math.min(...nested) - 1;
  }
  return { start, end: start + trimBlankTail(text, start, end - start + 1) - 1, code: false };
}

// Put the editor where the unit's content was, so it keeps the unit's spacing
// and typography. The unit is rebuilt by the render that closes the editor.
function mountInUnit(el: HTMLElement, host: HTMLElement): void {
  switch (el.tagName) {
    case "TR": {
      const td = document.createElement("td");
      td.colSpan = Math.max(el.children.length, 1);
      td.appendChild(host);
      el.replaceChildren(td);
      return;
    }
    case "HR":
      el.replaceWith(host);
      return;
    case "LI":
      el.classList.add("block-editing");
      for (const child of Array.from(el.childNodes)) {
        if (!(child instanceof HTMLElement && /^(UL|OL)$/.test(child.tagName))) child.remove();
      }
      el.prepend(host);
      return;
    default:
      if (el.dataset.frontmatterLines || el.querySelector(".mermaid-diagram, .mermaid-error, pre.mermaid-block")) {
        host.classList.add("raw");
      }
      el.replaceChildren(host);
  }
}

// The rendered text from the start of `el` up to the point clicked.
function textBefore(el: Element, x: number, y: number): string {
  const caret = document.caretRangeFromPoint?.(x, y);
  if (!caret || !el.contains(caret.startContainer)) return el.textContent ?? "";
  const r = document.createRange();
  r.setStart(el, 0);
  r.setEnd(caret.startContainer, caret.startOffset);
  return r.toString();
}

function blockEditText(be: BlockEdit): string {
  const text = be.handle.text();
  return be.gap && text !== "" ? `\n${text}` : text;
}

function blockEditStillFits(doc: Doc, be: BlockEdit): boolean {
  if (doc.id !== be.docId || doc.viewMode !== "rendered" || !be.host.isConnected) return false;
  const want = be.occupied === 0 ? "" : blockEditText(be);
  return sliceLines(toLf(doc.editorContent), be.start, be.occupied) === want;
}

// The view still shows the text from before the open edit, so lines below the
// unit being edited are stale by however many lines the edit added or removed.
function currentLine(line: number, be: BlockEdit | null): number {
  if (!be) return line;
  const origEnd = be.start + be.origLines - 1;
  return line > origEnd ? line + be.occupied - be.origLines : line;
}

// Close the editor without redrawing; the doc already holds every keystroke.
function dropBlockEdit(): void {
  const be = blockEdit;
  if (!be) return;
  blockEdit = null;
  be.handle.destroy();
  be.host.remove();
  // Typing doesn't re-resolve comment anchors, so they catch up here.
  const doc = state.docs.find((d) => d.id === be.docId);
  if (doc) void catchUpResolutions(doc.absPath).then((fresh) => { if (fresh) redrawComments(be.docId); });
}

// Close the editor and show the unit formatted again. An editor no longer on
// the page was already swept away by a newer render, which mustn't be undone.
function finishBlockEdit(): void {
  if (!blockEdit) return;
  const live = blockEdit.host.isConnected;
  dropBlockEdit();
  if (live) render();
}

// A point in the rendered text, kept as (unit line, tag, text offset) so it can
// be found again after a redraw rebuilds every node.
interface TextPoint { line: number; tag: string; offset: number }

function textPoint(view: HTMLElement, node: Node, offset: number): TextPoint | null {
  const el = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>("[data-sourceline]");
  if (!el || !view.contains(el) || el.closest(".block-editor")) return null;
  const r = document.createRange();
  r.setStart(el, 0);
  r.setEnd(node, offset);
  return { line: Number(el.dataset.sourceline), tag: el.tagName, offset: r.toString().length };
}

function nodeAt(view: HTMLElement, p: TextPoint): [Node, number] | null {
  const el = Array.from(view.querySelectorAll<HTMLElement>(`[data-sourceline="${p.line}"]`)).find((e) => e.tagName === p.tag);
  if (!el) return null;
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let left = p.offset;
  let last: Text | null = null;
  for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) {
    if (left <= n.data.length) return [n, left];
    left -= n.data.length;
    last = n;
  }
  return last ? [last, last.data.length] : [el, 0];
}

// Close the editor but keep a selection the user just made elsewhere in the
// view, so it can still be commented on.
function finishKeepingSelection(view: HTMLElement): void {
  const be = blockEdit;
  const sel = window.getSelection();
  const a = sel?.anchorNode ? textPoint(view, sel.anchorNode, sel.anchorOffset) : null;
  const f = sel?.focusNode ? textPoint(view, sel.focusNode, sel.focusOffset) : null;
  finishBlockEdit();
  const fresh = renderedView;
  if (!a || !f || !fresh || !sel) return;
  const an = nodeAt(fresh, { ...a, line: currentLine(a.line, be) });
  const fn = nodeAt(fresh, { ...f, line: currentLine(f.line, be) });
  if (an && fn) sel.setBaseAndExtent(an[0], an[1], fn[0], fn[1]);
}

// Select the word under (x, y) in the rendered view.
function selectWordAt(x: number, y: number): void {
  const caret = document.caretRangeFromPoint?.(x, y);
  const node = caret?.startContainer;
  if (!caret || !(node instanceof Text)) return;
  const word = /[\p{L}\p{N}_'’]/u;
  let from = caret.startOffset;
  let to = caret.startOffset;
  while (from > 0 && word.test(node.data[from - 1])) from--;
  while (to < node.data.length && word.test(node.data[to])) to++;
  if (to > from) window.getSelection()?.setBaseAndExtent(node, from, node, to);
}

type Caret = { before: string } | "start" | "end";

function beginBlockEdit(target: UnitKey | "append", caret: Caret): void {
  const doc = getActive(state);
  const view = renderedView;
  if (!doc || doc.viewMode !== "rendered" || !view?.isConnected) return;
  const text = toLf(doc.editorContent);
  const host = el("div", "block-editor");
  let start: number, occupied: number, gap = false, code = false;
  if (target === "append") {
    ({ start, gap } = appendTarget(text));
    occupied = 0;
    view.appendChild(host);
  } else {
    const unit = unitFor(view, target);
    if (!unit) return;
    const r = unitRange(unit, text);
    start = r.start;
    occupied = r.end - r.start + 1;
    code = r.code;
    mountInUnit(unit, host);
  }
  const src = occupied ? sliceLines(text, start, occupied) : "";
  const cursor = caret === "end" ? src.length
    : caret === "start" ? (code ? 0 : caretInSource(src, ""))
    : caretInSource(src, caret.before);
  toolbar?.hide();
  const be: BlockEdit = {
    docId: doc.id, start, occupied, origLines: occupied, gap, host, initial: src, openedAt: performance.now(),
    handle: null as unknown as BlockEditorHandle,
  };
  blockEdit = be;
  be.handle = mountBlockEditor(host, src, {
    dark: currentAppearance() === "dark",
    lang: code ? "plain" : "markdown",
    cursor,
    onChange: (v) => {
      const d = state.docs.find((x) => x.id === be.docId);
      if (!d || blockEdit !== be) return;
      const next = spliceLines(toLf(d.editorContent), be.start, be.occupied, v, be.gap);
      be.occupied = splicedCount(v, be.gap);
      state = updateEditorContent(state, d.id, withEol(next, d.eol));
      refreshTabDirty();
    },
    onExit: (via) => {
      if (via === "escape") { finishBlockEdit(); return; }
      const lines = be.handle.text().split("\n").length;
      const first = be.start + (be.gap && be.handle.text() !== "" ? 1 : 0);
      const last = first + lines - 1;
      finishBlockEdit();
      const fresh = renderedView;
      const d = getActive(state);
      if (!fresh || !d) return;
      const now = toLf(d.editorContent);
      const ranged = editUnits(fresh).map((u) => ({ u, r: unitRange(u, now) }));
      const next = via === "up"
        ? ranged.filter((x) => x.r.end < first).pop()
        : ranged.find((x) => x.r.start > last);
      if (next) beginBlockEdit(keyOf(next.u), via === "up" ? "end" : "start");
    },
    onBlur: () => {
      // Leaving the window keeps the editor open; a click elsewhere is handled
      // by its mouseup. Anything else (Tab, a modal taking focus) closes it.
      setTimeout(() => {
        if (blockEdit !== be || pointerDown || !document.hasFocus() || be.handle.hasFocus()) return;
        finishBlockEdit();
      }, 0);
    },
  });
}

// A double-click opens the unit on its first click. If nothing was typed yet,
// the second click undoes that and selects the word instead, as it would on
// plain text, so double-click-to-comment still works.
function handleEditMouseDown(e: MouseEvent): void {
  const be = blockEdit;
  if (!be) return;
  const target = e.target as Node;
  if (!be.host.contains(target)) { pointerDown = true; return; }
  if (e.detail < 2 || be.handle.text() !== be.initial || performance.now() - be.openedAt > 1000) return;
  e.preventDefault();
  e.stopPropagation();
  finishBlockEdit();
  selectWordAt(e.clientX, e.clientY);
}

function handleEditClick(e: MouseEvent): void {
  const wasDown = pointerDown;
  pointerDown = false;
  if (e.button !== 0) return;
  const target = e.target as Element | null;
  const be = blockEdit;
  if (!target || be?.host.contains(target)) return;
  const doc = getActive(state);
  const content = document.getElementById("content");
  const view = renderedView?.isConnected ? renderedView : null;
  const sel = window.getSelection();
  const selected = !!sel && !sel.isCollapsed;
  if (doc?.viewMode === "rendered" && view && content?.contains(target)) {
    // A drag or double/triple-click selection is for commenting, not editing.
    if (selected) {
      if (be && wasDown) finishKeepingSelection(view);
      return;
    }
    if (e.detail === 1 && !target.closest(NOT_EDITABLE) && !target.closest(".comment-hint")) {
      let unit: HTMLElement | null = null;
      let append = false;
      if (view.contains(target) && target !== view) {
        unit = unitAt(view, target, e.clientY);
      } else {
        // The margins and the space below: the unit level with the click, or a
        // new block at the end.
        const units = editUnits(view);
        unit = units.filter((u) => {
          const r = u.getBoundingClientRect();
          return e.clientY >= r.top && e.clientY <= r.bottom;
        }).pop() ?? null;
        const last = view.lastElementChild;
        if (!unit && (!last || e.clientY > last.getBoundingClientRect().bottom)) append = true;
      }
      if (unit || append) {
        const before = unit ? (target === view || !unit.contains(target) ? unit.textContent ?? "" : textBefore(unit, e.clientX, e.clientY)) : "";
        const key = unit ? keyOf(unit) : null;
        if (key && key.line) key.line = currentLine(key.line, be);
        if (be) finishBlockEdit();
        beginBlockEdit(key ?? "append", { before });
        return;
      }
    }
  }
  // Defer, so a link clicked on the way out still gets its click event.
  if (be && wasDown) setTimeout(() => { if (blockEdit === be) finishBlockEdit(); }, 0);
}

function renderedBlocks(content: HTMLElement): LineBlock[] {
  const view = content.querySelector(".rendered");
  if (!view) return [];
  const origin = content.getBoundingClientRect().top - content.scrollTop;
  return Array.from(view.querySelectorAll<HTMLElement>("[data-sourceline]")).map((el) => {
    const r = el.getBoundingClientRect();
    const start = Number(el.dataset.sourceline);
    return { start, end: Number(el.dataset.sourcelineEnd ?? start), top: r.top - origin, height: r.height };
  });
}

function switchViewMode(id: string): void {
  dropBlockEdit();
  const content = document.getElementById("content");
  pendingTopLine = activeEditor
    ? activeEditor.topLine()
    : content ? lineAtOffset(renderedBlocks(content), content.scrollTop) : null;
  state = toggleViewMode(state, id);
  render();
  // Typing doesn't re-resolve (an IPC per keystroke, for a view that isn't
  // showing), so comment positions catch up on the way back to Read.
  const doc = state.docs.find((d) => d.id === id);
  if (doc?.viewMode === "rendered") {
    void catchUpResolutions(doc.absPath).then((fresh) => { if (fresh) redrawComments(id); });
  }
}

function scrollToSourceLine(content: HTMLElement, line: number): void {
  if (activeEditor) activeEditor.scrollToLine(line);
  else content.scrollTop = offsetForLine(renderedBlocks(content), line);
}

function changeTheme(pref: ThemePref): void {
  saveThemePref(pref);
  applyTheme(pref, render);
  render(); // so the editor's dark flag matches the new appearance
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
  applyRailWidth(parseRailWidth(localStorage.getItem(LS_RAIL_W)));
  const grip = document.getElementById("rail-grip");
  const railEl = document.getElementById("rail");
  if (grip && railEl) mountRailResizer(grip, railEl, (w) => localStorage.setItem(LS_RAIL_W, String(w)));

  document.addEventListener("click", handleLinkClick);
  document.addEventListener("mousedown", handleEditMouseDown, true);
  document.addEventListener("mouseup", handleEditClick);
  await onOpenFile((absPath) => {
    void openPath(absPath).catch((err) => showNotice(`Couldn't open ${absPath}: ${err}`, false));
  });
  await onFileRemoved((path) => { state = markRemoved(state, path); render(); });
  await onFileError(({ path, message }) => {
    const doc = state.docs.find((d) => d.absPath === path);
    if (!doc) return;
    showToast(`${doc.fileName} changed on disk but can't be read: ${message}. The tab shows the last version Glance could read.`, { ms: ERROR_TOAST_MS });
  });
  await onShowIntegrationPicker((action) => { void openIntegrationPicker(action); });
  await onShowAbout(async () => { showAbout(await appVersion()); });
  await onShowWhatsNew(() => { void openWhatsNew(true); });
  await onCheckForUpdates(() => { void checkForUpdates(true); });
  await onShowTheme(() => {
    showThemePicker(loadThemePref(), {
      onPreview: (pref) => applyTheme(pref, render),
      onCommit: changeTheme,
    });
  });
  await onCloseActiveTab(() => { const d = getActive(state); if (d) void closeTab(d.id); });
  await onQuitRequested(() => { void requestQuit(); });
  await onMenuSave(() => saveActive());
  await onSelectAll(() => selectAllContent());
  await onShowInFinder(() => {
    // The menu item is greyed out unless canRevealActive(state), so these guards
    // only fire if the file vanishes between the last render and the click.
    const d = getActive(state);
    if (!d) return;
    if (!d.existsOnDisk) { showNotice(`${d.fileName} no longer exists on disk.`, false); return; }
    void revealInFinder(d.absPath).catch(() => showNotice(`Couldn't show ${d.absPath} in Finder.`, false));
  });
  await onAnnotationsChanged((docPath) => { void loadAnnotations(docPath); });
  await onFileChanged((e) => handleDiskChange(e.path, e.contents));
  window.addEventListener("keydown", (e) => {
    if (e.metaKey && (e.key === "e" || e.key === "E")) {
      e.preventDefault();
      const doc = getActive(state);
      if (doc) switchViewMode(doc.id);
      return;
    }
    if (e.metaKey && e.shiftKey && (e.key === "m" || e.key === "M")) {
      e.preventDefault();
      const doc = getActive(state);
      if (doc && doc.viewMode === "rendered" && !blockEdit) { toolbar?.hide(); startComment(doc.absPath); }
    }
  });
  let toRestore: unknown = [];
  try { toRestore = JSON.parse(localStorage.getItem(LS_OPEN) || "[]"); } catch { /* ignore */ }
  const launchPaths = await takeLaunchArgs();
  restoringSession = true;
  try {
    for (const p of Array.isArray(toRestore) ? toRestore : []) {
      if (typeof p !== "string") continue;
      // A file gone since last time drops out of the session and the recent list.
      try { await openPath(p); } catch (err) { if (isNotFound(err)) forgetRecent(p); }
    }
    // Launch files last, so the file just opened ends up as the active tab.
    for (const p of launchPaths) {
      try { await openPath(p); } catch (err) { showNotice(`Couldn't open ${p}: ${err}`, false); }
    }
  } finally {
    restoringSession = false;
  }
  await refreshIntegration();
  render();
  // The update toast would draw under the What's New modal, so wait for it.
  void openWhatsNew(false).finally(() => checkForUpdates(false));
}

// Compare the running version with the latest GitHub release. The menu item
// (`manual`) always checks and always answers; the launch check runs at most
// once a day and stays silent unless a newer version exists. A newer-version
// toast only counts as checked once it ran its full time or was clicked, so a
// toast replaced by another one shows again next launch.
async function checkForUpdates(manual: boolean): Promise<void> {
  if (!manual && !isCheckDue(localStorage.getItem(LS_UPDATE_CHECKED), Date.now())) return;
  let current = "";
  let release = null;
  try {
    current = await appVersion();
    release = parseRelease(await fetchLatestRelease());
    if (!release) throw new Error("GitHub didn't return a usable release");
  } catch (err) {
    if (manual) showNotice(`Couldn't check for updates. ${err instanceof Error ? err.message : err}`, false);
    return;
  }
  const markChecked = () => localStorage.setItem(LS_UPDATE_CHECKED, String(Date.now()));
  const { version, url } = release;
  if (!isNewer(version, current)) {
    markChecked();
    if (manual) showUpToDate(current);
    return;
  }
  if (manual) { markChecked(); showUpdateAvailable(current, version, url); return; }
  showToast(`Glance ${version} is available.`, {
    actionLabel: "Details",
    onAction: () => { markChecked(); showUpdateAvailable(current, version, url); },
    onExpire: markChecked,
    ms: ERROR_TOAST_MS,
  });
}

// Release notes for the running version. `force` (the menu item) always shows
// them; otherwise only on the first launch of a version not yet seen. A version
// with no changelog section is recorded silently so it never nags. Resolves
// once the modal closes, or right away when it isn't shown.
async function openWhatsNew(force: boolean): Promise<void> {
  let version = "";
  try { version = await appVersion(); } catch { return; }
  if (!force && !shouldShowWhatsNew(localStorage.getItem(LS_SEEN_VERSION), version)) return;
  const markSeen = () => localStorage.setItem(LS_SEEN_VERSION, version);
  const section = sectionFor(changelog, version);
  if (!section) { markSeen(); return; }
  const html = renderMarkdown(section);
  await new Promise<void>((resolve) => showWhatsNew(version, html, () => { markSeen(); resolve(); }));
}
