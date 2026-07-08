import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Annotation, AnnotationStore, Resolution } from "./annotations";

export function appVersion(): Promise<string> {
  return getVersion();
}

// Open a URL in the user's default browser (never in the app webview).
export function openExternal(url: string): Promise<void> {
  return openUrl(url);
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

export function removeStoredAnnotation(docPath: string, id: string): Promise<void> {
  return invoke<void>("remove_annotation", { docPath, id });
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

export function onShowTheme(cb: () => void): Promise<UnlistenFn> {
  return listen("show-theme", () => cb());
}

export function onCloseActiveTab(cb: () => void): Promise<UnlistenFn> {
  return listen("close-active-tab", () => cb());
}

export function onMenuSave(cb: () => void): Promise<UnlistenFn> {
  return listen("menu-save", () => cb());
}

export function readReviewed(path: string): Promise<string | null> {
  return invoke<string | null>("read_reviewed", { path });
}

export function writeReviewed(path: string, content: string): Promise<void> {
  return invoke<void>("write_reviewed", { path, content });
}
