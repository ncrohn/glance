import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl, openPath as openWithDefaultApp, revealItemInDir } from "@tauri-apps/plugin-opener";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Annotation, AnnotationPatch, AnnotationStore, Resolution } from "./annotations";
import { LATEST_RELEASE_URL } from "./update-check";

export function appVersion(): Promise<string> {
  return getVersion();
}

// Open a URL in the user's default browser (never in the app webview).
export function openExternal(url: string): Promise<void> {
  return openUrl(url);
}

// Open a local file in its default macOS app (Preview for a PDF, etc.).
export function openFileExternal(path: string): Promise<void> {
  return openWithDefaultApp(path);
}

// Where a linked file really points, and whether opening it could run code.
export interface OpenTarget { path: string; confirm: boolean }
export function resolveOpenTarget(path: string): Promise<OpenTarget> {
  return invoke<OpenTarget>("resolve_open_target", { path });
}

// A URL the webview can load a local file from, via Tauri's asset protocol.
export function localFileUrl(path: string): string {
  return convertFileSrc(path);
}

// Find the file an Obsidian-style [[note]] points at. `path` is null when none
// was found; `capped` says the vault search stopped at its entry limit, so the
// note may exist further in.
export interface WikilinkMatch { path: string | null; capped: boolean }
export function resolveWikilink(docPath: string, target: string): Promise<WikilinkMatch> {
  return invoke<WikilinkMatch>("resolve_wikilink", { docPath, target });
}

// One spelling per file: symlinks, `..` and letter case resolved when the file
// exists, a lexical cleanup otherwise. Tabs and comment stores key on this.
export function canonicalizePath(path: string): Promise<string> {
  return invoke<string>("canonicalize_path", { path });
}

// Grey out / re-enable File → Show in Finder. Only the frontend knows whether
// the active tab has a file to reveal, so it pushes the state to the native menu.
export function setShowInFinderEnabled(enabled: boolean): Promise<void> {
  return invoke<void>("set_show_in_finder_enabled", { enabled });
}

// Reveal a file in Finder (opens its folder with the file selected).
export function revealInFinder(path: string): Promise<void> {
  return revealItemInDir(path);
}

export function readFile(path: string): Promise<string> {
  return invoke<string>("read_file", { path });
}

export function writeFile(path: string, contents: string): Promise<void> {
  return invoke<void>("write_file", { path, contents });
}

export function watchFile(path: string): Promise<void> {
  return invoke<void>("watch_file", { path });
}

export function unwatchFile(path: string): Promise<void> {
  return invoke<void>("unwatch_file", { path });
}

export function onOpenFile(cb: (absPath: string) => void): Promise<UnlistenFn> {
  return listen<string>("open-file", (e) => cb(e.payload));
}

export function onFileChanged(
  cb: (e: { path: string; contents: string }) => void,
): Promise<UnlistenFn> {
  return listen<{ path: string; contents: string }>("file-changed", (e) => cb(e.payload));
}

export function onFileRemoved(cb: (path: string) => void): Promise<UnlistenFn> {
  return listen<string>("file-removed", (e) => cb(e.payload));
}

// A watched file that can no longer be read as text (not UTF-8, permissions).
export function onFileError(cb: (e: { path: string; message: string }) => void): Promise<UnlistenFn> {
  return listen<{ path: string; message: string }>("file-error", (e) => cb(e.payload));
}

export function takeLaunchArgs(): Promise<string[]> {
  return invoke<string[]>("take_launch_args");
}

export interface SetupStep {
  ok: boolean;
  label: string;
  message: string;
  /** Section the result modal files this row under ("Shared" or a client name). */
  group: string;
}

export type IntegrationAction = "setup" | "remove";

/** Result of a Set up / Remove AI Integration run. `action` distinguishes the
 *  two so the UI can title the modal correctly. */
export interface SetupResult {
  action: IntegrationAction;
  steps: SetupStep[];
}

export interface CapabilityInfo {
  key: string;
  label: string;
  supported: boolean;
}

/** A client the picker can offer, with detection + per-capability eligibility. */
export interface ClientInfo {
  id: string;
  displayName: string;
  present: boolean;
  /** glance-mcp already registered with this client. */
  configured: boolean;
  capabilities: CapabilityInfo[];
}

/** Enumerate integration targets for the picker (no side effects). */
export function listIntegrationTargets(): Promise<ClientInfo[]> {
  return invoke<ClientInfo[]>("list_integration_targets");
}

/** Run the picker's selection: install/remove the chosen clients. */
export function runIntegration(action: IntegrationAction, ids: string[]): Promise<SetupStep[]> {
  return invoke<SetupStep[]>("run_integration", { action, ids });
}

export function readAnnotations(path: string): Promise<AnnotationStore> {
  return invoke<AnnotationStore>("read_annotations", { path });
}

// Granular, server-side-locked mutations. These replace a whole-store write so a
// concurrent resolve from glance-mcp can't be clobbered (the Rust side does the
// read-modify-write under a cross-process file lock).
export function addStoredAnnotation(docPath: string, annotation: Annotation): Promise<void> {
  return invoke<void>("add_annotation", { docPath, annotation });
}

/** Resolves to the annotation as the store held it when removed, or null when
 *  the store had no annotation with `id`. */
export function removeStoredAnnotation(docPath: string, id: string): Promise<Annotation | null> {
  return invoke<Annotation | null>("remove_annotation", { docPath, id });
}

/** `clearResolution` drops resolvedBy/resolvedAt on the server (a reopen);
 *  an `undefined` field can't say that over JSON. */
export type StoredAnnotationPatch = AnnotationPatch & { clearResolution?: boolean };

export function updateStoredAnnotation(docPath: string, id: string, patch: StoredAnnotationPatch): Promise<void> {
  return invoke<void>("update_annotation", { docPath, id, patch });
}

/** Append a user reply to an annotation's thread; the server stamps the time. */
export function addStoredReply(docPath: string, id: string, text: string): Promise<void> {
  return invoke<void>("add_reply", { docPath, id, text });
}

export function resolveAnchors(text: string, annotations: Annotation[]): Promise<Resolution[]> {
  return invoke<Resolution[]>("resolve_anchors", { text, annotations });
}

export function ensureAnnotationStore(path: string): Promise<string> {
  return invoke<string>("ensure_annotation_store", { path });
}

export function watchAnnotations(storePath: string, docPath: string): Promise<void> {
  return invoke<void>("watch_annotations", { storePath, docPath });
}

export function onAnnotationsChanged(cb: (docPath: string) => void): Promise<UnlistenFn> {
  return listen<string>("annotations-changed", (e) => cb(e.payload));
}

export function onShowIntegrationPicker(cb: (action: IntegrationAction) => void): Promise<UnlistenFn> {
  return listen<IntegrationAction>("show-integration-picker", (e) => cb(e.payload));
}

export function onShowAbout(cb: () => void): Promise<UnlistenFn> {
  return listen("show-about", () => cb());
}
export function onShowWhatsNew(cb: () => void): Promise<UnlistenFn> {
  return listen("show-whats-new", () => cb());
}
export function onCheckForUpdates(cb: () => void): Promise<UnlistenFn> {
  return listen("check-for-updates", () => cb());
}

// The raw `releases/latest` body from GitHub; update-check.ts validates it.
export async function fetchLatestRelease(): Promise<unknown> {
  const res = await fetch(LATEST_RELEASE_URL, {
    headers: { Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
  return res.json();
}

export function onShowTheme(cb: () => void): Promise<UnlistenFn> {
  return listen("show-theme", () => cb());
}

export function onCloseActiveTab(cb: () => void): Promise<UnlistenFn> {
  return listen("close-active-tab", () => cb());
}

export function onMenuSave(cb: () => void): Promise<UnlistenFn> {
  return listen("menu-save", () => cb());
}
export function onSelectAll(cb: () => void): Promise<UnlistenFn> {
  return listen("menu-select-all", () => cb());
}
export function onShowInFinder(cb: () => void): Promise<UnlistenFn> {
  return listen("show-in-finder", () => cb());
}

// Cmd+Q and the window's close button ask here first, so unsaved edits can be
// dealt with; `quitApp` then does the actual exit. The ack goes out first: the
// backend quits on its own if no ack arrives, in case the page has hung.
export function onQuitRequested(cb: () => void): Promise<UnlistenFn> {
  return listen("quit-requested", () => {
    void invoke<void>("quit_ack");
    cb();
  });
}
export function quitApp(): Promise<void> {
  return invoke<void>("quit_app");
}

export function readReviewed(path: string): Promise<string | null> {
  return invoke<string | null>("read_reviewed", { path });
}

export function writeReviewed(path: string, content: string): Promise<void> {
  return invoke<void>("write_reviewed", { path, content });
}
