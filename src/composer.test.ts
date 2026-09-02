import { describe, it, expect } from "vitest";
import { clampPopover, composerStep } from "./composer";

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

describe("composerStep", () => {
  it.each(["escape", "click-outside"] as const)("closes an empty draft on %s", (event) => {
    expect(composerStep({ text: "", confirming: false }, event)).toEqual({ kind: "close", note: null });
  });

  it("keeps and flashes a non-empty draft on click outside", () => {
    const state = { text: "draft", confirming: false };
    expect(composerStep(state, "click-outside")).toEqual({ kind: "stay", state, flash: true });
  });

  it("asks to confirm when escaping a non-empty draft", () => {
    expect(composerStep({ text: "draft", confirming: false }, "escape")).toEqual({
      kind: "stay",
      state: { text: "draft", confirming: true },
    });
  });

  it("discards a draft after confirmation", () => {
    expect(composerStep({ text: "draft", confirming: true }, "confirm-discard")).toEqual({
      kind: "close",
      note: null,
    });
  });

  it("returns to editing when keeping a draft", () => {
    expect(composerStep({ text: "draft", confirming: true }, "keep")).toEqual({
      kind: "stay",
      state: { text: "draft", confirming: false },
    });
  });

  it("discards a draft on a second escape", () => {
    expect(composerStep({ text: "draft", confirming: true }, "escape")).toEqual({
      kind: "close",
      note: null,
    });
  });

  it("submits a trimmed non-empty draft", () => {
    expect(composerStep({ text: "  finished note  ", confirming: false }, "submit")).toEqual({
      kind: "close",
      note: "finished note",
    });
  });

  it("keeps an empty draft open on submit", () => {
    const state = { text: "  ", confirming: false };
    expect(composerStep(state, "submit")).toEqual({ kind: "stay", state });
  });
});
