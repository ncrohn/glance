import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

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
