import { describe, it, expect } from "vitest";
import { restoreTarget, lineAtOffset, offsetForLine } from "./scroll-restore";

describe("restoreTarget", () => {
  const saved = new Map([["a", 500], ["b", 120]]);

  it("same doc, same mode restores the saved position", () => {
    expect(restoreTarget({ id: "a", mode: "rendered" }, { id: "a", mode: "rendered" }, saved)).toBe(500);
  });

  it("same doc, mode change starts at the top", () => {
    expect(restoreTarget({ id: "a", mode: "rendered" }, { id: "a", mode: "source" }, saved)).toBe(0);
  });

  it("different doc with a saved position restores it", () => {
    expect(restoreTarget({ id: "a", mode: "rendered" }, { id: "b", mode: "rendered" }, saved)).toBe(120);
  });

  it("unknown doc starts at the top", () => {
    expect(restoreTarget({ id: "a", mode: "rendered" }, { id: "c", mode: "rendered" }, saved)).toBe(0);
    expect(restoreTarget({ id: "a", mode: "rendered" }, { id: null, mode: null }, saved)).toBe(0);
  });
});

describe("Read/Edit scroll mapping", () => {
  // Heading on line 1, a 10-line list at lines 3-12 with two items, paragraph at 14-15.
  const blocks = [
    { start: 1, end: 1, top: 0, height: 40 },
    { start: 3, end: 12, top: 60, height: 200 },
    { start: 3, end: 7, top: 60, height: 100 },
    { start: 8, end: 12, top: 160, height: 100 },
    { start: 14, end: 15, top: 300, height: 50 },
  ];

  it("finds the line at the top of the rendered view", () => {
    expect(lineAtOffset(blocks, 0)).toBe(1);
    expect(lineAtOffset(blocks, 160)).toBe(8);
    expect(lineAtOffset(blocks, 210)).toBe(10);
    expect(lineAtOffset(blocks, 300)).toBe(14);
  });

  it("finds the rendered offset for a source line", () => {
    expect(offsetForLine(blocks, 1)).toBe(0);
    expect(offsetForLine(blocks, 8)).toBe(160);
    expect(offsetForLine(blocks, 10)).toBe(200);
    expect(offsetForLine(blocks, 13)).toBe(260);
  });

  it("round-trips a block start", () => {
    expect(lineAtOffset(blocks, offsetForLine(blocks, 14))).toBe(14);
  });

  it("falls back to the top with no stamped blocks", () => {
    expect(lineAtOffset([], 500)).toBe(1);
    expect(offsetForLine([], 20)).toBe(0);
  });
});
