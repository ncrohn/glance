import { describe, it, expect } from "vitest";
import { createDoc, isDirty, basename } from "./document";

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
