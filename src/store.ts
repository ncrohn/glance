import { Doc, ViewMode, createDoc } from "./document";
import type { Annotation, Resolution } from "./annotations";

export interface State {
  docs: Doc[];
  activeId: string | null;
}

export function emptyState(): State {
  return { docs: [], activeId: null };
}

export function getActive(s: State): Doc | null {
  return s.docs.find((d) => d.id === s.activeId) ?? null;
}

function mapDoc(s: State, id: string, fn: (d: Doc) => Doc): State {
  return { ...s, docs: s.docs.map((d) => (d.id === id ? fn(d) : d)) };
}

export function openDoc(s: State, absPath: string, diskContent: string): State {
  const existing = s.docs.find((d) => d.absPath === absPath);
  if (existing) return { ...s, activeId: existing.id };
  const doc = createDoc(absPath, diskContent);
  return { docs: [...s.docs, doc], activeId: doc.id };
}

export function closeDoc(s: State, id: string): State {
  const idx = s.docs.findIndex((d) => d.id === id);
  if (idx === -1) return s;
  const docs = s.docs.filter((d) => d.id !== id);
  let activeId = s.activeId;
  if (activeId === id) {
    activeId = docs.length ? docs[Math.min(idx, docs.length - 1)].id : null;
  }
  return { docs, activeId };
}

export function setActive(s: State, id: string): State {
  return s.docs.some((d) => d.id === id) ? { ...s, activeId: id } : s;
}

export function updateEditorContent(s: State, id: string, content: string): State {
  return mapDoc(s, id, (d) => ({ ...d, editorContent: content }));
}

export function toggleViewMode(s: State, id: string): State {
  const next: Record<ViewMode, ViewMode> = { rendered: "source", source: "rendered" };
  return mapDoc(s, id, (d) => ({ ...d, viewMode: next[d.viewMode] }));
}

export function markSaved(s: State, id: string): State {
  return mapDoc(s, id, (d) => ({ ...d, diskContent: d.editorContent, existsOnDisk: true }));
}

export function markReviewed(s: State, id: string): State {
  return mapDoc(s, id, (d) => ({ ...d, reviewedContent: d.diskContent }));
}

export function setReviewedBaseline(s: State, id: string, content: string): State {
  return mapDoc(s, id, (d) => ({ ...d, reviewedContent: content }));
}

export function markRemoved(s: State, absPath: string): State {
  return { ...s, docs: s.docs.map((d) => d.absPath === absPath ? { ...d, existsOnDisk: false } : d) };
}

export function applyDiskChange(s: State, id: string, diskContent: string): State {
  return mapDoc(s, id, (d) => ({
    ...d,
    diskContent,
    editorContent: diskContent,
    existsOnDisk: true,
  }));
}

export function setDocAnnotations(s: State, id: string, annotations: Annotation[]): State {
  return mapDoc(s, id, (d) => ({ ...d, annotations }));
}

export function setDocResolutions(s: State, id: string, resolutions: Record<string, Resolution>): State {
  return mapDoc(s, id, (d) => ({ ...d, resolutions }));
}
