// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { clampRailWidth, mountRailResizer, parseRailWidth, RAIL_DEFAULT, RAIL_MAX, RAIL_MIN } from "./rail-resize";

describe("mountRailResizer", () => {
  function setup() {
    const grip = document.createElement("div");
    const rail = document.createElement("div");
    Object.assign(grip, { setPointerCapture() {}, releasePointerCapture() {} });
    rail.getBoundingClientRect = () => ({ right: 1000 } as DOMRect);
    const commits: number[] = [];
    mountRailResizer(grip, rail, (w) => commits.push(w));
    const fire = (type: string, clientX = 0) => {
      const e = new MouseEvent(type, { button: 0, clientX }) as MouseEvent & { pointerId: number };
      e.pointerId = 1;
      grip.dispatchEvent(e);
    };
    return { commits, fire };
  }

  it("a click on the grip without dragging saves nothing", () => {
    const { commits, fire } = setup();
    fire("pointerdown");
    fire("pointerup");
    expect(commits).toEqual([]);
  });

  it("a drag saves the width it ended at", () => {
    const { commits, fire } = setup();
    fire("pointerdown", 700);
    fire("pointermove", 650);
    fire("pointerup", 650);
    expect(commits).toEqual([350]);
  });
});

describe("clampRailWidth", () => {
  it("keeps values inside the range", () => {
    expect(clampRailWidth(300)).toBe(300);
    expect(clampRailWidth(300.6)).toBe(301);
  });
  it("clamps below and above", () => {
    expect(clampRailWidth(10)).toBe(RAIL_MIN);
    expect(clampRailWidth(5000)).toBe(RAIL_MAX);
  });
  it("falls back for non-finite input", () => {
    expect(clampRailWidth(NaN)).toBe(RAIL_DEFAULT);
    expect(clampRailWidth(Infinity)).toBe(RAIL_DEFAULT);
  });
});

describe("parseRailWidth", () => {
  it("reads a stored number", () => {
    expect(parseRailWidth("320")).toBe(320);
  });
  it("defaults when missing, empty, or garbage", () => {
    expect(parseRailWidth(null)).toBe(RAIL_DEFAULT);
    expect(parseRailWidth("")).toBe(RAIL_DEFAULT);
    expect(parseRailWidth("wide")).toBe(RAIL_DEFAULT);
  });
  it("clamps stored values", () => {
    expect(parseRailWidth("50")).toBe(RAIL_MIN);
    expect(parseRailWidth("9999")).toBe(RAIL_MAX);
  });
});
