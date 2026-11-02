import { describe, it, expect } from "vitest";
import { parseWidthPref, widthValue, DEFAULT_WIDTH, WIDTHS } from "./reading-width";

describe("parseWidthPref", () => {
  it("keeps a known preset", () => {
    expect(parseWidthPref("wide")).toBe("wide");
  });
  it("defaults null to standard", () => {
    expect(parseWidthPref(null)).toBe(DEFAULT_WIDTH);
  });
  it("defaults an unknown id to standard", () => {
    expect(parseWidthPref("huge")).toBe(DEFAULT_WIDTH);
  });
});

describe("widthValue", () => {
  it("standard keeps the original 47rem column", () => {
    expect(widthValue("standard")).toBe("47rem");
  });
  it("full width fills the pane", () => {
    expect(widthValue("full")).toBe("100%");
  });
  it("an unknown id falls back to the default", () => {
    expect(widthValue("huge")).toBe(widthValue(DEFAULT_WIDTH));
  });
  it("preset ids are unique", () => {
    expect(new Set(WIDTHS.map((w) => w.id)).size).toBe(WIDTHS.length);
  });
});
