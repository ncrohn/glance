import { describe, it, expect } from "vitest";
import { buildAnchor } from "./build-anchor";

const text = "The quick brown fox jumps over the lazy dog";

describe("buildAnchor", () => {
  it("captures quote with surrounding context", () => {
    const start = text.indexOf("brown fox");
    const end = start + "brown fox".length;
    const a = buildAnchor(text, start, end, 4);
    expect(a.quote).toBe("brown fox");
    expect(a.prefix).toBe("ick ");
    expect(a.suffix).toBe(" jum");
  });

  it("clamps context at string boundaries", () => {
    const a = buildAnchor(text, 0, 3, 10); // "The"
    expect(a.quote).toBe("The");
    expect(a.prefix).toBe("");
    expect(a.suffix).toBe(" quick bro");
  });
});
