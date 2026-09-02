import { describe, it, expect } from "vitest";
import {
  addAnnotation, resolveAnnotation, removeAnnotation, patchAnnotation, appendReply,
  type Annotation,
} from "./annotations";

function ann(id: string, status: Annotation["status"] = "open"): Annotation {
  return {
    id, number: 0, quote: "q", prefix: "", suffix: "",
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

  describe("patchAnnotation", () => {
    it("changes the note of one annotation without mutating", () => {
      const a = [ann("a"), ann("b")];
      const b = patchAnnotation(a, "a", { note: "edited" });
      expect(b.find((x) => x.id === "a")!.note).toBe("edited");
      expect(b.find((x) => x.id === "b")!.note).toBe("n");
      expect(a[0].note).toBe("n");
    });

    it("resolve sets status, resolvedBy and resolvedAt", () => {
      const b = patchAnnotation([ann("a")], "a", {
        status: "resolved", resolvedBy: "user", resolvedAt: "2026-09-01T00:00:00Z",
      });
      expect(b[0]).toMatchObject({ status: "resolved", resolvedBy: "user", resolvedAt: "2026-09-01T00:00:00Z" });
    });

    it("reopen clears resolvedBy and resolvedAt", () => {
      const done: Annotation = { ...ann("a", "resolved"), resolvedBy: "claude", resolvedAt: "t" };
      const b = patchAnnotation([done], "a", { status: "open", resolvedBy: undefined, resolvedAt: undefined });
      expect(b[0].status).toBe("open");
      expect(b[0].resolvedBy).toBeUndefined();
      expect(b[0].resolvedAt).toBeUndefined();
    });

    it("re-anchor replaces the anchor fields and keeps id, number, note, and replies", () => {
      const reply = { author: "claude" as const, text: "r", createdAt: "t" };
      const moved: Annotation = { ...ann("a"), number: 7, replies: [reply] };
      const b = patchAnnotation([moved], "a", {
        quote: "new quote", prefix: "before ", suffix: " after", lineHint: { start: 12, end: 13 }, status: "open",
      });
      expect(b[0]).toMatchObject({
        id: "a", number: 7, note: "n", replies: [reply], status: "open",
        quote: "new quote", prefix: "before ", suffix: " after", lineHint: { start: 12, end: 13 },
      });
      expect(moved.quote).toBe("q");
    });

    it("leaves the list unchanged for an unknown id", () => {
      const a = [ann("a")];
      expect(patchAnnotation(a, "zzz", { note: "x" })).toEqual(a);
    });
  });

  describe("appendReply", () => {
    it("starts a thread on an annotation without one, leaving others alone", () => {
      const a = [ann("a"), ann("b")];
      const reply = { author: "user" as const, text: "why?", createdAt: "2026-09-01T00:00:00Z" };
      const b = appendReply(a, "a", reply);
      expect(b[0].replies).toEqual([reply]);
      expect(b[1].replies).toBeUndefined();
      expect(a[0].replies).toBeUndefined(); // original untouched
      expect(b[0].status).toBe("open");
    });

    it("appends in order to an existing thread", () => {
      const first = { author: "claude" as const, text: "Cut the cap", createdAt: "t1" };
      const second = { author: "user" as const, text: "thanks", createdAt: "t2" };
      const a: Annotation = { ...ann("a"), replies: [first] };
      const b = appendReply([a], "a", second);
      expect(b[0].replies).toEqual([first, second]);
      expect(a.replies).toEqual([first]);
    });
  });
});
