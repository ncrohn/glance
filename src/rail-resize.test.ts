import { describe, expect, it } from "vitest";
import { clampRailWidth, parseRailWidth, RAIL_DEFAULT, RAIL_MAX, RAIL_MIN } from "./rail-resize";

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
