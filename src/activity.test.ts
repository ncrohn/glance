import { describe, it, expect } from "vitest";
import { diffActivity, activityMessage } from "./activity";
import type { Annotation, Reply } from "./annotations";

function anno(id: string, number: number, extra: Partial<Annotation> = {}): Annotation {
  return {
    id, number, quote: "q", prefix: "", suffix: "", lineHint: { start: 1, end: 1 },
    note: "n", status: "open", author: "user", createdAt: "2026-01-01T00:00:00Z",
    ...extra,
  };
}

function reply(author: Reply["author"]): Reply {
  return { author, text: "r", createdAt: "2026-01-01T00:00:00Z" };
}

describe("diffActivity", () => {
  it("counts a resolve by Claude", () => {
    const prev = [anno("a", 1)];
    const next = [anno("a", 1, { status: "resolved", resolvedBy: "claude" })];
    expect(diffActivity(prev, next)).toEqual({ resolved: ["a"], replied: [] });
  });

  it("ignores a resolve by the user", () => {
    const prev = [anno("a", 1)];
    const next = [anno("a", 1, { status: "resolved", resolvedBy: "user" })];
    expect(diffActivity(prev, next)).toEqual({ resolved: [], replied: [] });
  });

  it("counts a new Claude reply", () => {
    const prev = [anno("a", 1, { replies: [reply("user")] })];
    const next = [anno("a", 1, { replies: [reply("user"), reply("claude")] })];
    expect(diffActivity(prev, next)).toEqual({ resolved: [], replied: ["a"] });
  });

  it("ignores a new user reply", () => {
    const prev = [anno("a", 1, { replies: [reply("claude")] })];
    const next = [anno("a", 1, { replies: [reply("claude"), reply("user")] })];
    expect(diffActivity(prev, next)).toEqual({ resolved: [], replied: [] });
  });

  it("an unchanged list yields nothing", () => {
    const list = [
      anno("a", 1, { status: "resolved", resolvedBy: "claude" }),
      anno("b", 2, { replies: [reply("claude")] }),
    ];
    expect(diffActivity(list, list)).toEqual({ resolved: [], replied: [] });
  });

  it("first load with prev = next yields nothing", () => {
    const next = [anno("a", 1, { status: "resolved", resolvedBy: "claude", replies: [reply("claude")] })];
    expect(diffActivity(next, next)).toEqual({ resolved: [], replied: [] });
  });

  it("an id absent from prev counts when Claude resolved it", () => {
    const next = [anno("a", 1, { status: "resolved", resolvedBy: "claude" })];
    expect(diffActivity([], next)).toEqual({ resolved: ["a"], replied: [] });
  });

  it("orders ids by number", () => {
    const prev = [anno("b", 2), anno("a", 1)];
    const next = [
      anno("b", 2, { status: "resolved", resolvedBy: "claude" }),
      anno("a", 1, { status: "resolved", resolvedBy: "claude" }),
    ];
    expect(diffActivity(prev, next).resolved).toEqual(["a", "b"]);
  });
});

describe("activityMessage", () => {
  it("joins both parts", () => {
    expect(activityMessage({ resolved: ["a", "b"], replied: ["c"] })).toBe("Claude resolved 2, replied to 1");
  });

  it("omits the zero part", () => {
    expect(activityMessage({ resolved: [], replied: ["c", "d"] })).toBe("Claude replied to 2");
  });

  it("uses the singular count alone", () => {
    expect(activityMessage({ resolved: ["a"], replied: [] })).toBe("Claude resolved 1");
  });
});
