import { describe, it, expect } from "vitest";
import { decideReload } from "./reload";
import { createDoc } from "./document";

describe("decideReload", () => {
  it("auto-reloads a clean doc", () => {
    expect(decideReload(createDoc("/a.md", "A"))).toBe("auto-reload");
  });

  it("prompts when the doc is dirty", () => {
    const dirty = { ...createDoc("/a.md", "A"), editorContent: "A-edited" };
    expect(decideReload(dirty)).toBe("prompt");
  });
});
