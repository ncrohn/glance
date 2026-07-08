import { describe, it, expect } from "vitest";
import { groupAnnotations, assignMarkers, annotationsForBlock, MARKER_PALETTE } from "./annotation-ui";
import type { Annotation, Resolution } from "./annotations";

function ann(id: string, status: Annotation["status"] = "open"): Annotation {
  return { id, quote: "q", prefix: "", suffix: "", lineHint: { start: 1, end: 1 }, note: "n", status, author: "user", createdAt: "t" };
}

function res(id: string, startLine: number | null, endLine = startLine): Resolution {
  return { id, startLine, endLine, anchor: startLine == null ? "orphaned" : "exact" };
}

function annAt(id: string, createdAt = "t", status: Annotation["status"] = "open"): Annotation {
  return { id, quote: "q", prefix: "", suffix: "", lineHint: { start: 1, end: 1 }, note: "n", status, author: "user", createdAt };
}

describe("groupAnnotations", () => {
  it("buckets by status, treating orphaned resolution as orphaned", () => {
    const list = [ann("a", "open"), ann("b", "resolved"), ann("c", "open")];
    const resolutions: Record<string, Resolution> = {
      a: { id: "a", startLine: 2, endLine: 2, anchor: "exact" },
      c: { id: "c", startLine: null, endLine: null, anchor: "orphaned" },
    };
    const g = groupAnnotations(list, resolutions);
    expect(g.open.map((x) => x.id)).toEqual(["a"]);
    expect(g.resolved.map((x) => x.id)).toEqual(["b"]);
    expect(g.orphaned.map((x) => x.id)).toEqual(["c"]);
  });
});

describe("assignMarkers", () => {
  it("numbers open anchored annotations by startLine, recycling colors", () => {
    const list = [annAt("a"), annAt("b"), annAt("c")];
    const r = { a: res("a", 20), b: res("b", 5), c: res("c", 12) };
    const m = assignMarkers(list, r);
    expect(m.get("b")).toEqual({ number: 1, color: MARKER_PALETTE[0] });
    expect(m.get("c")).toEqual({ number: 2, color: MARKER_PALETTE[1] });
    expect(m.get("a")).toEqual({ number: 3, color: MARKER_PALETTE[2] });
  });

  it("excludes resolved and orphaned annotations", () => {
    const list = [annAt("a", "t", "resolved"), annAt("b"), annAt("c")];
    const r = { a: res("a", 3), b: res("b", 5), c: res("c", null) };
    const m = assignMarkers(list, r);
    expect([...m.keys()]).toEqual(["b"]);
    expect(m.get("b")!.number).toBe(1);
  });

  it("recycles the palette past its length", () => {
    const n = MARKER_PALETTE.length + 1;
    const list = Array.from({ length: n }, (_, i) => annAt(`x${i}`));
    const r: Record<string, Resolution> = {};
    list.forEach((a, i) => (r[a.id] = res(a.id, i + 1)));
    const m = assignMarkers(list, r);
    expect(m.get("x0")!.color).toBe(MARKER_PALETTE[0]);
    expect(m.get(`x${n - 1}`)!.color).toBe(MARKER_PALETTE[0]); // wrapped
    expect(m.get(`x${n - 1}`)!.number).toBe(n);
  });

  it("tie-breaks equal startLine by createdAt", () => {
    const list = [annAt("late", "2026-02"), annAt("early", "2026-01")];
    const r = { late: res("late", 5), early: res("early", 5) };
    const m = assignMarkers(list, r);
    expect(m.get("early")!.number).toBe(1);
    expect(m.get("late")!.number).toBe(2);
  });
});

describe("annotationsForBlock", () => {
  const list = [annAt("a"), annAt("b")];
  const r = { a: res("a", 3, 5), b: res("b", 10, 10) };
  it("includes an annotation whose range intersects the block span", () => {
    expect(annotationsForBlock(4, 4, list, r)).toEqual(["a"]); // mid-block anchor
    expect(annotationsForBlock(5, 8, list, r)).toEqual(["a"]); // overlaps at edge
    expect(annotationsForBlock(1, 3, list, r)).toEqual(["a"]); // overlaps first line
  });
  it("excludes a block that does not intersect", () => {
    expect(annotationsForBlock(6, 9, list, r)).toEqual([]);
  });
  it("returns multiple ids for a block covering several annotations", () => {
    expect(annotationsForBlock(1, 12, list, r).sort()).toEqual(["a", "b"]);
  });
  it("ignores resolved/orphaned annotations", () => {
    const l2 = [annAt("a", "t", "resolved"), annAt("c")];
    const r2 = { a: res("a", 3, 5), c: res("c", null) };
    expect(annotationsForBlock(1, 20, l2, r2)).toEqual([]);
  });
});
