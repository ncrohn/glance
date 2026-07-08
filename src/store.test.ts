import { describe, it, expect } from "vitest";
import {
  emptyState, openDoc, closeDoc, setActive, updateEditorContent,
  toggleViewMode, markSaved, applyDiskChange, markRemoved, getActive,
  markReviewed, setReviewedBaseline,
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

  it("markRemoved sets existsOnDisk=false on the matching doc, leaves others untouched", () => {
    let s = openDoc(emptyState(), "/a.md", "A");
    s = openDoc(s, "/b.md", "B");
    s = markRemoved(s, "/a.md");
    const a = s.docs.find((d) => d.absPath === "/a.md")!;
    const b = s.docs.find((d) => d.absPath === "/b.md")!;
    expect(a.existsOnDisk).toBe(false);
    expect(b.existsOnDisk).toBe(true);
  });
});

describe("review baseline reducers", () => {
  it("markReviewed advances reviewedContent to diskContent", () => {
    let s = openDoc(emptyState(), "/x.md", "v1");
    s = applyDiskChange(s, "/x.md", "v2");
    expect(s.docs[0].reviewedContent).toBe("v1"); // applyDiskChange leaves it
    s = markReviewed(s, "/x.md");
    expect(s.docs[0].reviewedContent).toBe("v2");
  });

  it("applyDiskChange does not touch reviewedContent", () => {
    let s = openDoc(emptyState(), "/x.md", "v1");
    s = applyDiskChange(s, "/x.md", "v2");
    expect(s.docs[0].reviewedContent).toBe("v1");
    expect(s.docs[0].diskContent).toBe("v2");
  });

  it("setReviewedBaseline overrides the baseline (persisted-load path)", () => {
    let s = openDoc(emptyState(), "/x.md", "v2");
    s = setReviewedBaseline(s, "/x.md", "v1");
    expect(s.docs[0].reviewedContent).toBe("v1");
  });
});
