import { describe, it, expect } from "vitest";
import { locateQuote } from "./annotation-highlight";

// locateQuote works on ALREADY-VISIBLE text (the caller converts the stored
// source anchor to visible text via the markdown renderer first). It only does
// whitespace-tolerant matching + prefix/suffix disambiguation, returning offsets
// into the given `text`.
describe("locateQuote", () => {
  it("finds a plain quote and returns offsets into the text", () => {
    const text = "Solace pairs Medicare patients with certified advocates.";
    const r = locateQuote(text, "Medicare patients", "", "")!;
    expect(text.slice(r.start, r.end)).toBe("Medicare patients");
  });

  it("matches across a whitespace difference (collapsed runs / newlines)", () => {
    const text = "navigate the system today";
    const r = locateQuote(text, "navigate the\nsystem", "", "")!;
    expect(text.slice(r.start, r.end)).toBe("navigate the system");
  });

  it("uses prefix and suffix to disambiguate repeated text", () => {
    const text = "the cat sat. the cat ran.";
    const r = locateQuote(text, "cat", "the ", " ran")!;
    expect(r.start).toBe(text.indexOf("cat", 5)); // second occurrence
    expect(text.slice(r.start, r.end)).toBe("cat");
  });

  it("returns null when the quote is not present", () => {
    expect(locateQuote("hello world", "xyzzy", "", "")).toBeNull();
  });

  it("returns the first occurrence when prefix/suffix are empty", () => {
    const r = locateQuote("cat cat cat", "cat", "", "")!;
    expect(r.start).toBe(0);
  });

  it("prefers the occurrence whose suffix matches even without a prefix", () => {
    const text = "cat dog. cat fish.";
    const r = locateQuote(text, "cat", "", " fish")!;
    expect(text.slice(r.start, r.end)).toBe("cat");
    expect(r.start).toBe(text.indexOf("cat fish"));
  });
});
