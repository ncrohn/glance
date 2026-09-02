import { describe, expect, it } from "vitest";
import { contrastRatio, hexToRgb, mixOver, relativeLuminance } from "./contrast";

describe("hexToRgb", () => {
  it("parses 6-digit and 3-digit hex", () => {
    expect(hexToRgb("#ff8000")).toEqual([255, 128, 0]);
    expect(hexToRgb("#f80")).toEqual([255, 136, 0]);
    expect(hexToRgb("abc")).toEqual([170, 187, 204]);
  });
  it("rejects malformed input", () => {
    expect(() => hexToRgb("#12345")).toThrow();
    expect(() => hexToRgb("#gggggg")).toThrow();
  });
});

describe("relativeLuminance", () => {
  it("is 0 for black and 1 for white", () => {
    expect(relativeLuminance([0, 0, 0])).toBe(0);
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 10);
  });
});

describe("contrastRatio", () => {
  it("is 21 for black on white, in either order", () => {
    expect(contrastRatio(hexToRgb("#000"), hexToRgb("#fff"))).toBeCloseTo(21, 5);
    expect(contrastRatio(hexToRgb("#fff"), hexToRgb("#000"))).toBeCloseTo(21, 5);
  });
  it("is 1 for the same color", () => {
    expect(contrastRatio(hexToRgb("#3d7fbf"), hexToRgb("#3d7fbf"))).toBe(1);
  });
  it("matches a known pair", () => {
    expect(contrastRatio(hexToRgb("#777"), hexToRgb("#fff"))).toBeCloseTo(4.48, 2);
  });
});

describe("mixOver", () => {
  const c = hexToRgb("#c9822b");
  const bg = hexToRgb("#faf5ea");
  it("returns bg at 0% and fg at 100%", () => {
    expect(mixOver(c, bg, 0)).toEqual(bg);
    expect(mixOver(c, bg, 100)).toEqual(c);
  });
  it("interpolates each channel linearly", () => {
    expect(mixOver([0, 0, 0], [255, 255, 255], 50)).toEqual([127.5, 127.5, 127.5]);
  });
});
