import { diffLines } from "./diff";

export type ViewMode = "rendered" | "source";

export interface Doc {
  id: string;
  absPath: string;
  fileName: string;
  diskContent: string;
  editorContent: string;
  reviewedContent: string;
  viewMode: ViewMode;
  existsOnDisk: boolean;
  annotations: import("./annotations").Annotation[];
  resolutions: Record<string, import("./annotations").Resolution>;
}

export function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

export function createDoc(absPath: string, diskContent: string): Doc {
  return {
    id: absPath,
    absPath,
    fileName: basename(absPath),
    diskContent,
    editorContent: diskContent,
    reviewedContent: diskContent,
    viewMode: "rendered",
    existsOnDisk: true,
    annotations: [],
    resolutions: {},
  };
}

export function isDirty(doc: Doc): boolean {
  return doc.editorContent !== doc.diskContent;
}

// Lines changed on screen since the last reviewed baseline (1-indexed).
export function changedLines(doc: Doc): Set<number> {
  return diffLines(doc.reviewedContent, doc.editorContent);
}

// Whether the on-disk content has moved past what the user last reviewed.
// Compares against diskContent (not editorContent) so unsaved typing does not
// light the tab badge / show the "Mark reviewed" button.
export function hasUnreviewedChanges(doc: Doc): boolean {
  return doc.reviewedContent !== doc.diskContent;
}
