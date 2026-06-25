import { State } from "./store";

export function openPaths(s: State): string[] {
  return s.docs.map((d) => d.absPath);
}

export function pushRecent(recent: string[], absPath: string, max = 10): string[] {
  const next = [absPath, ...recent.filter((p) => p !== absPath)];
  return next.slice(0, max);
}
