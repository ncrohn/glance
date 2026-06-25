import { describe, it, expect } from "vitest";
import {
  emptyState, openDoc, closeDoc, setActive, updateEditorContent,
  toggleViewMode, markSaved, applyDiskChange, getActive,
} from "./store";
import { isDirty } from "./document";

describe("store", () => {
  it("opens a doc and makes it active", () => {
    const s = openDoc(emptyState(), "/a.md", "A");
    expect(s.docs).toHaveLength(1);
    expect(s.activeId).toBe("/a.md");
  });

  it("dedupes by absPath and just focuses", () => {
    let s = openDoc(emptyState(), "/a.md", "A");
    s = openDoc(s, "/b.md", "B");
    s = openDoc(s, "/a.md", "A-newer"); // already open
    expect(s.docs).toHaveLength(2);
    expect(s.activeId).toBe("/a.md");
    expect(getActive(s)!.diskContent).toBe("A"); // not replaced
  });

  it("closing the active doc activates a neighbor", () => {
    let s = openDoc(emptyState(), "/a.md", "A");
    s = openDoc(s, "/b.md", "B");
    s = closeDoc(s, "/b.md");
    expect(s.docs).toHaveLength(1);
    expect(s.activeId).toBe("/a.md");
  });

  it("closing the last doc clears active", () => {
    let s = openDoc(emptyState(), "/a.md", "A");
    s = closeDoc(s, "/a.md");
    expect(s.docs).toHaveLength(0);
    expect(s.activeId).toBeNull();
  });

  it("edits mark dirty; markSaved clears it", () => {
    let s = openDoc(emptyState(), "/a.md", "A");
    s = updateEditorContent(s, "/a.md", "A!");
    expect(isDirty(getActive(s)!)).toBe(true);
    s = markSaved(s, "/a.md");
    expect(isDirty(getActive(s)!)).toBe(false);
    expect(getActive(s)!.diskContent).toBe("A!");
  });

  it("toggleViewMode flips rendered/source", () => {
    let s = openDoc(emptyState(), "/a.md", "A");
    expect(getActive(s)!.viewMode).toBe("rendered");
    s = toggleViewMode(s, "/a.md");
    expect(getActive(s)!.viewMode).toBe("source");
    s = toggleViewMode(s, "/a.md");
    expect(getActive(s)!.viewMode).toBe("rendered");
  });

  it("applyDiskChange replaces both disk and editor content", () => {
    let s = openDoc(emptyState(), "/a.md", "A");
    s = applyDiskChange(s, "/a.md", "A-from-disk");
    const d = getActive(s)!;
    expect(d.diskContent).toBe("A-from-disk");
    expect(d.editorContent).toBe("A-from-disk");
    expect(isDirty(d)).toBe(false);
  });

  it("setActive switches the active tab", () => {
    let s = openDoc(emptyState(), "/a.md", "A");
    s = openDoc(s, "/b.md", "B");
    s = setActive(s, "/a.md");
    expect(s.activeId).toBe("/a.md");
  });
});
