export type ViewMode = "rendered" | "source";

export interface Doc {
  id: string;
  absPath: string;
  fileName: string;
  diskContent: string;
  editorContent: string;
  viewMode: ViewMode;
  existsOnDisk: boolean;
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
    viewMode: "rendered",
    existsOnDisk: true,
  };
}

export function isDirty(doc: Doc): boolean {
  return doc.editorContent !== doc.diskContent;
}
