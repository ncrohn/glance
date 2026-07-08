import { describe, it, expect } from "vitest";
import { diffLines } from "./diff";

const set = (...n: number[]) => new Set(n);

describe("diffLines", () => {
  it("returns empty when texts are identical", () => {
    expect(diffLines("a\nb\nc", "a\nb\nc")).toEqual(set());
  });

  it("ignores a differing trailing newline", () => {
    expect(diffLines("a\nb", "a\nb\n")).toEqual(set());
    expect(diffLines("a\nb\n", "a\nb")).toEqual(set());
  });

  it("marks an appended line", () => {
    expect(diffLines("a\nb", "a\nb\nc")).toEqual(set(3));
  });

  it("marks a modified middle line", () => {
    expect(diffLines("a\nb\nc", "a\nB\nc")).toEqual(set(2));
  });

  it("marks a modified leading line", () => {
    expect(diffLines("a\nb\nc", "A\nb\nc")).toEqual(set(1));
  });

  it("marks the adjacent surviving line for a deletion", () => {
    // 'b' removed; surviving neighbor in new text is line 2 ('c')
    expect(diffLines("a\nb\nc", "a\nc")).toEqual(set(2));
  });

  it("marks everything when growing from empty", () => {
    expect(diffLines("", "a\nb")).toEqual(set(1, 2));
  });

  it("returns empty when shrinking to empty", () => {
    // nothing left in new text to highlight
    expect(diffLines("a\nb", "")).toEqual(set());
  });
});
