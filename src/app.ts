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
import { classifyLink, dirname, parseWikilink, resolveLocalPath, slugify } from "./links";
import {
  addAnnotation, removeAnnotation, patchAnnotation, appendReply, genId, type Annotation, type AnnotationPatch,
} from "./annotations";
import { captureSelection } from "./anchor-capture";
import { resolveOpenTarget } from "./ipc";
import { showCommentComposer } from "./composer";
import { showToast } from "./toast";
import { applyRailWidth, mountRailResizer, parseRailWidth } from "./rail-resize";
import { sectionFor, shouldShowWhatsNew } from "./whats-new";
import changelog from "../CHANGELOG.md?raw";
import { diffActivity, activityMessage } from "./activity";
import {
  renderRail, applyHighlights, mountSelectionToolbar, assignMarkers, markerColor, linkAnnotationHovers, pulseBlock,
  focusRailCard, parseRailPref,
} from "./annotation-ui";
import { mountEditor, type EditorHandle } from "./editor";
import { decideReload } from "./reload";
import { restoreTarget, lineAtOffset, offsetForLine, type LineBlock } from "./scroll-restore";
import { confirmOpenFile, confirmReload, showNotice, showSetupResult, showIntegrationPicker, showAbout, showThemePicker, showWhatsNew } from "./modal";
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
      const node = document.querySelector(`mark.anno-highlight[data-annotation-id="${a.id}"]`)
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
      const card = host.querySelector<HTMLElement>(`.note-card[data-annotation-id="${a.id}"]`);
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
      // same annotation (id and number intact) after the remove has landed, so
      // the store stays consistent even if the app quits mid-toast.
      const cur = state.docs.find((d) => d.absPath === doc.absPath)?.annotations ?? doc.annotations;
      state = setDocAnnotations(state, doc.absPath, removeAnnotation(cur, a.id));
      render();
      const removed = persistComments(doc.absPath, cur, removeStoredAnnotation(doc.absPath, a.id));
      showToast(a.number > 0 ? `Comment ${a.number} deleted` : "Comment deleted", {
        actionLabel: "Undo",
        onAction: () => {
          void removed.then((ok) => {
            if (!ok) return; // the remove was rolled back; nothing to undo
            const now = state.docs.find((d) => d.absPath === doc.absPath)?.annotations ?? [];
            state = setDocAnnotations(state, doc.absPath, addAnnotation(now, a));
            render();
            return persistComments(doc.absPath, now, addStoredAnnotation(doc.absPath, a));
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
  const seg = el("div", "segmented");
  const read = el("button", doc.viewMode === "rendered" ? "on" : undefined, "Read");
  const edit = el("button", doc.viewMode === "source" ? "on" : undefined, "Edit");
  read.onclick = () => { if (doc.viewMode !== "rendered") switchViewMode(doc.id); };
  edit.onclick = () => { if (doc.viewMode !== "source") switchViewMode(doc.id); };
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
  const doc = getActive(state);
  // Same doc still in Edit mode: keep the editor (cursor, focus, undo history)
  // and only bring its text up to date if it changed outside the editor.
  if (doc && doc.viewMode === "source" && activeEditor && editorDocId === doc.id && host.querySelector(".cm-host")) {
    activeEditor.setContent(toLf(doc.editorContent));
    activeEditor.setDark(currentAppearance() === "dark");
    return;
  }
  if (activeEditor) { activeEditor.destroy(); activeEditor = null; editorDocId = null; }
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
      'toggle source <kbd>⌘E</kbd> &nbsp;·&nbsp; save <kbd>⌘S</kbd> &nbsp;·&nbsp; ' +
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
    const markers = assignMarkers(doc.annotations, doc.resolutions);
    applyHighlights(view, doc.annotations, doc.resolutions, markers, (id) => {
      const rail = document.getElementById("rail");
      if (rail) focusRailCard(rail, id);
    });
    toolbar = mountSelectionToolbar(view, () => startComment(doc.absPath));
  }
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
    state = applyDiskChange(state, doc.id, contents);
    render();
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
    .find((h) => slugify(h.textContent ?? "") === slug);
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
  const content = document.getElementById("content");
  pendingTopLine = activeEditor
    ? activeEditor.topLine()
    : content ? lineAtOffset(renderedBlocks(content), content.scrollTop) : null;
  state = toggleViewMode(state, id);
  render();
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
      if (doc && doc.viewMode === "rendered") { toolbar?.hide(); startComment(doc.absPath); }
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
  void openWhatsNew(false);
}

// Release notes for the running version. `force` (the menu item) always shows
// them; otherwise only on the first launch of a version not yet seen. A version
// with no changelog section is recorded silently so it never nags.
async function openWhatsNew(force: boolean): Promise<void> {
  let version = "";
  try { version = await appVersion(); } catch { return; }
  if (!force && !shouldShowWhatsNew(localStorage.getItem(LS_SEEN_VERSION), version)) return;
  const markSeen = () => localStorage.setItem(LS_SEEN_VERSION, version);
  const section = sectionFor(changelog, version);
  if (!section) { markSeen(); return; }
  showWhatsNew(version, renderMarkdown(section), markSeen);
}
