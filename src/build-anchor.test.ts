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

  it("never splits a surrogate pair at a context bound", () => {
    // 32 units before QUOTE starts on the low half of the first emoji, and 32
    // after it ends on the high half of the second.
    const t = "a".repeat(10) + "\u{1F600}" + "b".repeat(31) + "QUOTE" + "c".repeat(31) + "\u{1F600}" + "tail";
    const start = t.indexOf("QUOTE");
    const a = buildAnchor(t, start, start + 5);
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(a.prefix).not.toMatch(lone);
    expect(a.suffix).not.toMatch(lone);
    expect(a.prefix).toBe("b".repeat(31));
    expect(a.suffix).toBe("c".repeat(31));
    // A pair wholly inside the window is kept.
    const b = buildAnchor(t, start, start + 5, 33);
    expect(b.prefix).toBe("\u{1F600}" + "b".repeat(31));
    expect(b.suffix).toBe("c".repeat(31) + "\u{1F600}");
  });
});
