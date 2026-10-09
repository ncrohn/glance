import { diffLines, diffLinesDetailed } from "./diff";

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
  // Ids Claude resolved or replied to while this doc was in a background tab;
  // pulsed and cleared when the tab is next shown.
  claudeActivity: string[];
  // The file's line ending. The editor works in LF, so its text is put back
  // into this form before it lands in editorContent and on disk.
  eol: LineEnding;
}

// A lone "\r" is a line break to CodeMirror too (old Mac files), so it's
// handled like the others; otherwise the editor and the stored text never agree.
export type LineEnding = "\n" | "\r\n" | "\r";

/** The line ending of the first line break, LF when there is none. */
export function detectEol(text: string): LineEnding {
  const m = /\r\n|\r|\n/.exec(text);
  return m ? (m[0] as LineEnding) : "\n";
}

export function toLf(text: string): string {
  return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

/** Editor text (LF) in the file's own line ending. */
export function withEol(lfText: string, eol: LineEnding): string {
  return eol === "\n" ? lfText : toLf(lfText).replace(/\n/g, eol);
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
    claudeActivity: [],
    eol: detectEol(diskContent),
  };
}

export function isDirty(doc: Doc): boolean {
  return doc.editorContent !== doc.diskContent;
}

// changedLines vs. hasUnreviewedChanges intentionally diff against different
// baselines: changedLines compares editorContent (matches what's actually
// rendered on screen, including unsaved edits), while hasUnreviewedChanges
// compares diskContent (so unsaved typing doesn't light the tab badge). On a
// dirty tab the two can transiently disagree; they converge once the doc is
// saved, since markSaved advances reviewedContent along with diskContent.

// Lines changed on screen since the last reviewed baseline (1-indexed).
export function changedLines(doc: Doc): Set<number> {
  return diffLines(doc.reviewedContent, doc.editorContent);
}

export function deletedBefore(doc: Doc): Set<number> {
  return diffLinesDetailed(doc.reviewedContent, doc.editorContent).deletedBefore;
}

// Whether the on-disk content has moved past what the user last reviewed.
// Compares against diskContent (not editorContent) so unsaved typing does not
// light the tab badge / show the "Mark reviewed" button.
export function hasUnreviewedChanges(doc: Doc): boolean {
  return doc.reviewedContent !== doc.diskContent;
}
