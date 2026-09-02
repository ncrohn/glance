import { describe, it, expect } from "vitest";
import { groupAnnotations, assignMarkers, annotationsForBlock, cardModel, parseRailPref, MARKER_PALETTE } from "./annotation-ui";
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

  it("orders open annotations by document line, not store order", () => {
    const list = [annAt("a"), annAt("b"), annAt("c")];
    const r = { a: res("a", 9), b: res("b", 34), c: res("c", 21) };
    const g = groupAnnotations(list, r);
    expect(g.open.map((x) => x.id)).toEqual(["a", "c", "b"]);
  });

  it("puts open annotations without a line last, tie-breaking by createdAt then id", () => {
    const list = [annAt("noline", "2026-03"), annAt("b", "2026-02"), annAt("a", "2026-01"), annAt("z", "2026-01")];
    const r: Record<string, Resolution> = {
      b: res("b", 5), a: res("a", 5), z: res("z", 5),
      noline: { id: "noline", startLine: null, endLine: null, anchor: "exact" },
    };
    const g = groupAnnotations(list, r);
    expect(g.open.map((x) => x.id)).toEqual(["a", "z", "b", "noline"]);
  });

  it("orders orphaned and resolved newest first", () => {
    const list = [
      annAt("o1", "2026-01"), annAt("o2", "2026-02"),
      annAt("r1", "2026-01", "resolved"), annAt("r2", "2026-02", "resolved"),
    ];
    const r = { o1: res("o1", null), o2: res("o2", null), r1: res("r1", 1), r2: res("r2", 1) };
    const g = groupAnnotations(list, r);
    expect(g.orphaned.map((x) => x.id)).toEqual(["o2", "o1"]);
    expect(g.resolved.map((x) => x.id)).toEqual(["r2", "r1"]);
  });
});

describe("cardModel", () => {
  const marker = { number: 2, color: MARKER_PALETTE[1] };

  it("tags drifted as moved, orphaned as not found, exact as nothing", () => {
    const a = annAt("a");
    expect(cardModel(a, { id: "a", startLine: 4, endLine: 4, anchor: "drifted" }, marker).tag).toBe("moved");
    expect(cardModel(a, res("a", null), undefined).tag).toBe("not found");
    expect(cardModel(a, res("a", 4), marker).tag).toBeNull();
  });

  it("carries the marker number and color, and the anchor kind", () => {
    const m = cardModel(annAt("a"), res("a", 4), marker);
    expect(m).toMatchObject({ number: 2, color: MARKER_PALETTE[1], line: "L4", anchor: "exact", note: "n" });
    expect(cardModel(annAt("a"), undefined, undefined)).toMatchObject({ number: null, color: null, anchor: "none" });
  });

  it("shows a dash for the line when unresolved", () => {
    expect(cardModel(annAt("a"), undefined, undefined).line).toBe("—");
    expect(cardModel(annAt("a"), res("a", null), undefined).line).toBe("—");
  });

  it("collapses whitespace in the quote and cuts it at 80 chars", () => {
    const a = { ...annAt("a"), quote: "  one\n\n  two\tthree  " };
    expect(cardModel(a, undefined, undefined).quote).toBe("one two three");
    const long = { ...annAt("a"), quote: "x".repeat(100) };
    expect(cardModel(long, undefined, undefined).quote).toBe("x".repeat(80) + "…");
    const exact = { ...annAt("a"), quote: "y".repeat(80) };
    expect(cardModel(exact, undefined, undefined).quote).toBe("y".repeat(80));
  });

  it("marks a resolved annotation done, with no number and no tag", () => {
    const m = cardModel(annAt("a", "t", "resolved"), { id: "a", startLine: 4, endLine: 4, anchor: "drifted" }, marker);
    expect(m).toMatchObject({ done: true, number: null, tag: null, line: "L4" });
    expect(cardModel(annAt("a"), res("a", 4), marker).done).toBe(false);
  });
});

describe("parseRailPref", () => {
  it("returns collapsed only for the exact stored value", () => {
    expect(parseRailPref("collapsed")).toBe("collapsed");
  });
  it("falls back to open for anything else", () => {
    expect(parseRailPref("open")).toBe("open");
    expect(parseRailPref(null)).toBe("open");
    expect(parseRailPref("")).toBe("open");
    expect(parseRailPref("garbage")).toBe("open");
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
