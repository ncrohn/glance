import { describe, it, expect } from "vitest";
import { parseFrontmatter } from "./frontmatter";

describe("parseFrontmatter", () => {
  it("returns the source unchanged when there is no frontmatter", () => {
    const src = "# Title\n\nBody text.";
    const r = parseFrontmatter(src);
    expect(r.entries).toEqual([]);
    expect(r.body).toBe(src);
    expect(r.lineOffset).toBe(0);
  });

  it("extracts scalar entries and strips the fence from the body", () => {
    const src = "---\ntype: meeting\ncreated: 2026-06-10\n---\n# Title\n";
    const r = parseFrontmatter(src);
    expect(r.entries).toEqual([
      { key: "type", value: "meeting" },
      { key: "created", value: "2026-06-10" },
    ]);
    expect(r.body).toBe("# Title\n");
  });

  it("reports the number of lines the frontmatter occupied as lineOffset", () => {
    const src = "---\ntype: meeting\ncreated: 2026-06-10\n---\n# Title\n";
    // 4 fenced lines (open, 2 keys, close) => body starts at source line 5
    expect(parseFrontmatter(src).lineOffset).toBe(4);
  });

  it("parses inline arrays into string lists", () => {
    const src = "---\ntags: [job-search, solace, recruiting]\n---\nbody";
    const r = parseFrontmatter(src);
    expect(r.entries).toEqual([
      { key: "tags", value: ["job-search", "solace", "recruiting"] },
    ]);
  });

  it("drops keys with empty values", () => {
    const src = "---\ntype: meeting\nproject:\n---\nbody";
    const r = parseFrontmatter(src);
    expect(r.entries).toEqual([{ key: "type", value: "meeting" }]);
  });

  it("strips surrounding quotes from scalar values", () => {
    const src = `---\ntitle: "Hello: World"\n---\nbody`;
    expect(parseFrontmatter(src).entries).toEqual([
      { key: "title", value: "Hello: World" },
    ]);
  });

  it("keeps a colon that appears in the value", () => {
    const src = "---\nwhen: 2026-06-10 08:00\n---\nbody";
    expect(parseFrontmatter(src).entries).toEqual([
      { key: "when", value: "2026-06-10 08:00" },
    ]);
  });

  it("ignores a fence that is not at the very start of the document", () => {
    const src = "intro\n---\ntype: meeting\n---\nbody";
    const r = parseFrontmatter(src);
    expect(r.entries).toEqual([]);
    expect(r.body).toBe(src);
  });

  it("treats an unterminated fence as ordinary content", () => {
    const src = "---\ntype: meeting\nno closing fence\n";
    const r = parseFrontmatter(src);
    expect(r.entries).toEqual([]);
    expect(r.body).toBe(src);
  });

  it("handles an empty array value", () => {
    const src = "---\ntags: []\n---\nbody";
    expect(parseFrontmatter(src).entries).toEqual([]);
  });

  it("does not split a quoted array item on its internal comma", () => {
    const src = `---\ntags: ["hello, world", "foo"]\n---\nbody`;
    expect(parseFrontmatter(src).entries).toEqual([
      { key: "tags", value: ["hello, world", "foo"] },
    ]);
  });
});
