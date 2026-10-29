import { describe, expect, it } from "vitest";
import { appendTarget, caretInSource, sliceLines, spliceLines, splicedCount, trimBlankTail, fenceBody } from "./block-edit";

describe("sliceLines", () => {
  it("returns the inclusive line range", () => {
    expect(sliceLines("a\nb\nc\nd", 2, 2)).toBe("b\nc");
  });
  it("is empty for a zero count", () => {
    expect(sliceLines("a\nb", 2, 0)).toBe("");
  });
});

describe("spliceLines", () => {
  it("replaces a block, growing or shrinking the file", () => {
    expect(spliceLines("# T\n\nold\n\nend\n", 3, 1, "new\nlines")).toBe("# T\n\nnew\nlines\n\nend\n");
    expect(spliceLines("a\nb\nc\n", 1, 2, "x")).toBe("x\nc\n");
  });
  it("inserts before a trailing newline with a gap line", () => {
    const { start, gap } = appendTarget("para\n");
    expect(spliceLines("para\n", start, 0, "next", gap)).toBe("para\n\nnext\n");
  });
  it("an emptied fresh block takes no lines, restoring the text", () => {
    const typed = spliceLines("a\n", 2, 0, "b", true, true);
    expect(typed).toBe("a\n\nb\n");
    expect(spliceLines(typed, 2, splicedCount("b", true, true), "", true, true)).toBe("a\n");
    expect(splicedCount("", true, true)).toBe(0);
  });
  it("adds no gap for an empty insertion", () => {
    expect(spliceLines("para\n", 2, 0, "", true)).toBe("para\n\n");
  });
  it("round-trips an unchanged block", () => {
    const text = "a\n\nb\nc\n\nd";
    expect(spliceLines(text, 3, 2, sliceLines(text, 3, 2))).toBe(text);
  });
});

describe("splicedCount", () => {
  it("counts the gap line only for a non-empty insertion", () => {
    expect(splicedCount("a\nb")).toBe(2);
    expect(splicedCount("a", true)).toBe(2);
    expect(splicedCount("", true)).toBe(1);
  });
});

describe("appendTarget", () => {
  it("handles empty and blank-terminated docs", () => {
    expect(appendTarget("")).toEqual({ start: 1, gap: false });
    expect(appendTarget("a\n\n")).toEqual({ start: 3, gap: false });
  });
  it("goes after the last line of a file without a trailing newline", () => {
    expect(appendTarget("a\nb")).toEqual({ start: 3, gap: true });
  });
});

describe("caretInSource", () => {
  it("maps rendered text through markdown syntax", () => {
    const src = "Some **bold** words here";
    expect(caretInSource(src, "Some bold wor")).toBe(src.indexOf("words") + 3);
  });
  it("skips list and heading markers for a click at the start", () => {
    expect(caretInSource("## Title", "")).toBe(3);
    expect(caretInSource("- [ ] task", "")).toBe(6);
  });
  it("falls back to the end of the first line", () => {
    expect(caretInSource("abc\ndef", "zzzz")).toBe(3);
  });
});

describe("trimBlankTail", () => {
  it("drops blank lines ending the range but keeps one line", () => {
    expect(trimBlankTail("- a\n- b\n\npara", 2, 2)).toBe(1);
    expect(trimBlankTail("\n\n", 1, 2)).toBe(1);
    expect(trimBlankTail("a\nb", 1, 2)).toBe(2);
  });
});

describe("fenceBody", () => {
  it("is the lines between the fences", () => {
    expect(fenceBody("x\n```ts\na\nb\n```\n", 2, 5)).toEqual({ start: 3, end: 4 });
    expect(fenceBody("~~~~\na\n~~~~", 1, 3)).toEqual({ start: 2, end: 2 });
  });
  it("runs an unclosed fence to the end", () => {
    expect(fenceBody("```\na\nb", 1, 3)).toEqual({ start: 2, end: 3 });
  });
  it("is null for an empty fence or indented code", () => {
    expect(fenceBody("```\n```", 1, 2)).toBeNull();
    expect(fenceBody("    code", 1, 1)).toBeNull();
  });
});
