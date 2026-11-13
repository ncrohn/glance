import type { Doc } from "./document";
import { parentDir } from "./tab-menu";

// The left sidebar: open docs grouped by the folder that holds them. Pure;
// app.ts renders it.

export interface FolderGroup {
  dir: string;
  name: string;
  // The folder above `dir`, home collapsed to ~, so same-named folders in
  // different places can be told apart.
  parent: string;
  docs: Doc[];
}

export function tildePath(absPath: string): string {
  return absPath.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");
}

/** Groups in the order their first doc appears in the tab strip; docs keep tab order within a group. */
export function groupByFolder(docs: Doc[]): FolderGroup[] {
  const groups = new Map<string, FolderGroup>();
  for (const d of docs) {
    const dir = parentDir(d.absPath);
    let g = groups.get(dir);
    if (!g) {
      const name = dir === "/" ? "/" : dir.slice(dir.lastIndexOf("/") + 1);
      g = { dir, name, parent: dir === "/" ? "" : tildePath(parentDir(dir)), docs: [] };
      groups.set(dir, g);
    }
    g.docs.push(d);
  }
  return [...groups.values()];
}

export const LS_SIDEBAR = "glance.sidebar";

/** Open files show either in the sidebar or as titlebar tabs, never both.
 *  Tabs unless the user picked the sidebar. */
export function parseSidebarPref(raw: string | null): boolean {
  return raw === "shown";
}
