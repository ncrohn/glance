import { describe, it, expect } from "vitest";
import {
  addAnnotation, resolveAnnotation, removeAnnotation, setAnnotations,
  type Annotation,
} from "./annotations";

function ann(id: string, status: Annotation["status"] = "open"): Annotation {
  return {
    id, quote: "q", prefix: "", suffix: "",
    lineHint: { start: 1, end: 1 }, note: "n",
    status, author: "user", createdAt: "t",
  };
}

describe("annotation reducers", () => {
  it("addAnnotation appends without mutating", () => {
    const a = [ann("a")];
    const b = addAnnotation(a, ann("b"));
    expect(b).toHaveLength(2);
    expect(a).toHaveLength(1); // original untouched
    expect(b[1].id).toBe("b");
  });

  it("resolveAnnotation flips status to resolved", () => {
    const a = [ann("a"), ann("b")];
    const b = resolveAnnotation(a, "a");
    expect(b.find((x) => x.id === "a")!.status).toBe("resolved");
    expect(b.find((x) => x.id === "b")!.status).toBe("open");
  });

  it("removeAnnotation drops by id", () => {
    const a = [ann("a"), ann("b")];
    expect(removeAnnotation(a, "a").map((x) => x.id)).toEqual(["b"]);
  });

  it("setAnnotations replaces the list", () => {
    expect(setAnnotations([ann("a")], [ann("z")]).map((x) => x.id)).toEqual(["z"]);
  });
});
