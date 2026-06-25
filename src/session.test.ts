import { describe, it, expect } from "vitest";
import { openPaths, pushRecent } from "./session";
import { emptyState, openDoc } from "./store";

describe("session", () => {
  it("openPaths returns open docs in tab order", () => {
    let s = openDoc(emptyState(), "/a.md", "A");
    s = openDoc(s, "/b.md", "B");
    expect(openPaths(s)).toEqual(["/a.md", "/b.md"]);
  });

  it("pushRecent puts newest first and dedupes", () => {
    let r = pushRecent([], "/a.md");
    r = pushRecent(r, "/b.md");
    r = pushRecent(r, "/a.md"); // re-open moves to front
    expect(r).toEqual(["/a.md", "/b.md"]);
  });

  it("pushRecent caps length", () => {
    let r: string[] = [];
    for (let i = 0; i < 15; i++) r = pushRecent(r, `/f${i}.md`, 10);
    expect(r).toHaveLength(10);
    expect(r[0]).toBe("/f14.md");
  });
});
