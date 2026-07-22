import { describe, it, expect } from "vitest";
import { toVisible, buildVisible } from "./markdown-visible";

describe("toVisible", () => {
  it("strips paired inline markup to the visible text", () => {
    expect(toVisible("**billed** through")).toBe("billed through");
    expect(toVisible("see `code` here")).toBe("see code here");
    expect(toVisible("~~gone~~ now")).toBe("gone now");
    expect(toVisible("[the post](https://x.com) now")).toBe("the post now");
  });

  it("drops a DANGLING bold marker (selection ended mid-emphasis)", () => {
    // The reported bug: a quote sliced inside **NestJS** keeps a lone `**`.
    expect(toVisible("core = **NestJ")).toBe("core = NestJ");
    expect(toVisible("their core = **NestJS + Postgres")).toBe("their core = NestJS + Postgres");
  });

  it("keeps wikilinks literal (Glance does not process them)", () => {
    expect(toVisible("ref [[2026-note]] here")).toBe("ref [[2026-note]] here");
  });

  it("leaves single * / _ literal to protect snake_case and spaced asterisks", () => {
    expect(toVisible("my_var and 2 * 3")).toBe("my_var and 2 * 3");
  });

  it("collapses whitespace runs", () => {
    expect(toVisible("a   b\n  c")).toBe("a b c");
  });
});

describe("buildVisible map", () => {
  it("maps visible offsets back to real source positions", () => {
    const src = "x **bold** y";
    const { visible, map } = buildVisible(src);
    expect(visible).toBe("x bold y");
    // 'b' of "bold" in visible is at index 2; in source it's after "x **" → index 4
    expect(map[2]).toBe(src.indexOf("bold"));
    // sentinel maps to end of source
    expect(map[visible.length]).toBe(src.length);
  });
});
