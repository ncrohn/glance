import { describe, it, expect } from "vitest";
import { createDoc, isDirty, basename, changedLines, hasUnreviewedChanges } from "./document";

describe("document", () => {
  it("createDoc starts clean, rendered, and exists", () => {
    const d = createDoc("/a/b/notes.md", "# Hi");
    expect(d.id).toBe("/a/b/notes.md");
    expect(d.absPath).toBe("/a/b/notes.md");
    expect(d.fileName).toBe("notes.md");
    expect(d.diskContent).toBe("# Hi");
    expect(d.editorContent).toBe("# Hi");
    expect(d.viewMode).toBe("rendered");
    expect(d.existsOnDisk).toBe(true);
    expect(isDirty(d)).toBe(false);
  });

  it("isDirty true once editorContent diverges", () => {
    const d = { ...createDoc("/x.md", "a"), editorContent: "b" };
    expect(isDirty(d)).toBe(true);
  });

  it("basename handles nested and bare paths", () => {
    expect(basename("/a/b/c.md")).toBe("c.md");
    expect(basename("c.md")).toBe("c.md");
  });
});

describe("changedLines / hasUnreviewedChanges", () => {
  it("a freshly created doc has no changes", () => {
    const d = createDoc("/x.md", "a\nb\nc");
    expect(hasUnreviewedChanges(d)).toBe(false);
    expect(changedLines(d)).toEqual(new Set());
  });

  it("changedLines diffs the reviewed baseline against editorContent", () => {
    const d = { ...createDoc("/x.md", "a\nb\nc"), editorContent: "a\nB\nc" };
    expect(changedLines(d)).toEqual(new Set([2]));
  });

  it("hasUnreviewedChanges compares baseline against diskContent, not editor", () => {
    const base = createDoc("/x.md", "a\nb");
    // user typed but has not saved: disk still equals baseline -> no badge
    const dirty = { ...base, editorContent: "a\nb\nc" };
    expect(hasUnreviewedChanges(dirty)).toBe(false);
    // disk advanced (Claude edit) -> badge
    const edited = { ...base, diskContent: "a\nb\nc", editorContent: "a\nb\nc" };
    expect(hasUnreviewedChanges(edited)).toBe(true);
  });
});
