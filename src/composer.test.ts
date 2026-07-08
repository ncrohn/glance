import { describe, it, expect } from "vitest";
import { clampPopover } from "./composer";

const vp = { width: 1000, height: 800 };
const size = { width: 300, height: 200 };

describe("clampPopover", () => {
  it("places below the anchor when there is room", () => {
    const p = clampPopover({ top: 100, bottom: 120, left: 50 }, size, vp);
    expect(p.top).toBe(128); // bottom + gap(8)
    expect(p.left).toBe(50);
  });
  it("flips above when below would clip the bottom", () => {
    const p = clampPopover({ top: 700, bottom: 720, left: 50 }, size, vp);
    expect(p.top).toBe(700 - 8 - 200); // above: top - gap - height = 492
  });
  it("clamps left so the card never runs off the right edge", () => {
    const p = clampPopover({ top: 100, bottom: 120, left: 900 }, size, vp);
    expect(p.left).toBe(1000 - 300 - 8); // 692
  });
  it("never returns a negative coordinate", () => {
    const p = clampPopover({ top: 5, bottom: 6, left: -20 }, size, vp);
    expect(p.top).toBeGreaterThanOrEqual(8);
    expect(p.left).toBeGreaterThanOrEqual(8);
  });
});
