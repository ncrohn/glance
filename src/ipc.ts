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
}

export function readAnnotations(path: string): Promise<AnnotationStore> {
  return invoke<AnnotationStore>("read_annotations", { path });
}

export function writeAnnotations(store: AnnotationStore): Promise<void> {
  return invoke<void>("write_annotations", { store });
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

export function onSetupResult(cb: (steps: SetupStep[]) => void): Promise<UnlistenFn> {
  return listen<SetupStep[]>("setup-result", (e) => cb(e.payload));
}

export function onShowAbout(cb: () => void): Promise<UnlistenFn> {
  return listen("show-about", () => cb());
}

export function onShowTheme(cb: () => void): Promise<UnlistenFn> {
  return listen("show-theme", () => cb());
}
