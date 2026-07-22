import { describe, it, expect } from "vitest";
import { locateInSource } from "./anchor-capture";

describe("locateInSource", () => {
  it("matches an inline selection verbatim", () => {
    const src = "The quick brown fox jumps.";
    const span = locateInSource(src, "quick brown");
    expect(span).not.toBeNull();
    expect(src.slice(span!.start, span!.end)).toBe("quick brown");
  });

  it("anchors a hard-wrapped list item (rendered one line, source multi-line)", () => {
    // The item text wraps across two physical source lines with indentation; the
    // rendered selection collapses that to single spaces.
    const src = [
      "- first item",
      '- "Marketplace" connecting certified advocates',
      "  with qualified patients for care navigation.",
      "- last item",
    ].join("\n");
    const rendered =
      '"Marketplace" connecting certified advocates with qualified patients for care navigation.\n';
    const span = locateInSource(src, rendered);
    expect(span).not.toBeNull();
    const got = src.slice(span!.start, span!.end);
    // Spans from the item text through its wrapped continuation, in the source.
    expect(got.startsWith('"Marketplace" connecting')).toBe(true);
    expect(got.endsWith("care navigation.")).toBe(true);
    expect(got).toContain("\n  with qualified"); // the real source newline+indent
  });

  it("anchors a whole multi-item list (markers absent from rendered text)", () => {
    const src = "- buy milk\n- get eggs\n- bake bread";
    const rendered = "buy milk\nget eggs\nbake bread";
    const span = locateInSource(src, rendered);
    expect(span).not.toBeNull();
    const got = src.slice(span!.start, span!.end);
    expect(got.startsWith("buy milk")).toBe(true);
    expect(got.endsWith("bake bread")).toBe(true);
  });

  it("prefers an occurrence at/after the block offset for duplicate text", () => {
    const src = "alpha\n\nalpha";
    const span = locateInSource(src, "alpha", 7); // second block
    expect(span!.start).toBe(7);
  });

  it("returns null when the text isn't present", () => {
    expect(locateInSource("hello world", "nothing here")).toBeNull();
  });
});
