import { describe, it, expect } from "vitest";
import { groupAnnotations } from "./annotation-ui";
import type { Annotation, Resolution } from "./annotations";

function ann(id: string, status: Annotation["status"] = "open"): Annotation {
  return { id, quote: "q", prefix: "", suffix: "", lineHint: { start: 1, end: 1 }, note: "n", status, author: "user", createdAt: "t" };
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
