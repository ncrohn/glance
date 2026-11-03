import type { State } from "./store";

// The right-click menu on a tab. Pure: which entries it shows, which are
// enabled, and which tabs a bulk close takes. app.ts pops it up and runs the
// picked action; the copy actions' text is built in Rust (copy_doc_to_clipboard).

export type TabMenuAction =
  | "copy-name" | "copy-path" | "copy-dir" | "copy-link"
  | "reveal"
  | "close" | "close-others" | "close-left" | "close-right";

export interface TabMenuItem { action: TabMenuAction; text: string; enabled: boolean }
export type TabMenuEntry = TabMenuItem | "separator";

export function tabMenuEntries(s: State, id: string): TabMenuEntry[] {
  const idx = s.docs.findIndex((d) => d.id === id);
  if (idx === -1) return [];
  const d = s.docs[idx];
  const item = (action: TabMenuAction, text: string, enabled = true): TabMenuItem => ({ action, text, enabled });
  return [
    item("copy-name", "Copy Filename"),
    item("copy-path", "Copy Path"),
    item("copy-dir", "Copy Folder Path"),
    item("copy-link", "Copy as Markdown Link"),
    "separator",
    item("reveal", "Show in Finder", d.existsOnDisk),
    "separator",
    item("close", "Close Tab"),
    item("close-others", "Close Other Tabs", s.docs.length > 1),
    item("close-left", "Close Tabs to the Left", idx > 0),
    item("close-right", "Close Tabs to the Right", idx < s.docs.length - 1),
  ];
}

// The tabs a close action takes, in tab order.
export function tabsToClose(s: State, id: string, action: "close" | "close-others" | "close-left" | "close-right"): string[] {
  const idx = s.docs.findIndex((d) => d.id === id);
  if (idx === -1) return [];
  if (action === "close") return [id];
  if (action === "close-others") return s.docs.filter((d) => d.id !== id).map((d) => d.id);
  if (action === "close-left") return s.docs.slice(0, idx).map((d) => d.id);
  return s.docs.slice(idx + 1).map((d) => d.id);
}

// The folder holding a file ("/" for a file at the root).
export function parentDir(absPath: string): string {
  const slash = absPath.lastIndexOf("/");
  return slash > 0 ? absPath.slice(0, slash) : "/";
}
