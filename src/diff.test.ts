import { describe, it, expect } from "vitest";
import { diffLines, diffLinesDetailed } from "./diff";

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

  it("does not mark an adjacent surviving line for a deletion", () => {
    expect(diffLines("a\nb\nc", "a\nc")).toEqual(set());
  });

  it("marks everything when growing from empty", () => {
    expect(diffLines("", "a\nb")).toEqual(set(1, 2));
  });

  it("returns empty when shrinking to empty", () => {
    // nothing left in new text to highlight
    expect(diffLines("a\nb", "")).toEqual(set());
  });
});

describe("diffLinesDetailed", () => {
  it("places a middle deletion before the next surviving line", () => {
    expect(diffLinesDetailed("a\nb\nc", "a\nc")).toEqual({
      changed: set(),
      deletedBefore: set(2),
    });
  });

  it("places a trailing deletion after the last surviving line", () => {
    expect(diffLinesDetailed("a\nb\nc", "a\nb")).toEqual({
      changed: set(),
      deletedBefore: set(3),
    });
  });

  it("separates an adjacent edit from a deletion", () => {
    expect(diffLinesDetailed("a\nb\nc\nd", "a\nB\nd")).toEqual({
      changed: set(2),
      deletedBefore: set(3),
    });
  });
});
