import { describe, it, expect } from "vitest";
import { restoreTarget } from "./scroll-restore";

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
