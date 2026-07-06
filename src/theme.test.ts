import { describe, it, expect } from "vitest";
import {
  parsePref, resolveThemeId, appearanceOf, isThemeId,
  AUTO, AUTO_LIGHT, AUTO_DARK, THEMES,
} from "./theme";

describe("parsePref", () => {
  it("keeps 'auto'", () => {
    expect(parsePref(AUTO)).toBe(AUTO);
  });
  it("keeps a known theme id", () => {
    expect(parsePref("nord")).toBe("nord");
  });
  it("defaults null to auto", () => {
    expect(parsePref(null)).toBe(AUTO);
  });
  it("defaults an unknown id to auto", () => {
    expect(parsePref("dracula")).toBe(AUTO);
  });
});

describe("resolveThemeId", () => {
  it("auto follows the OS: light", () => {
    expect(resolveThemeId(AUTO, false)).toBe(AUTO_LIGHT);
  });
  it("auto follows the OS: dark", () => {
    expect(resolveThemeId(AUTO, true)).toBe(AUTO_DARK);
  });
  it("an explicit theme ignores the OS", () => {
    expect(resolveThemeId("nord", false)).toBe("nord");
    expect(resolveThemeId("paper", true)).toBe("paper");
  });
  it("falls back to the light default for an unknown pref", () => {
    expect(resolveThemeId("bogus", true)).toBe(AUTO_LIGHT);
  });
});

describe("appearanceOf", () => {
  it("maps known themes to their appearance", () => {
    expect(appearanceOf("paper")).toBe("light");
    expect(appearanceOf("ink")).toBe("dark");
    expect(appearanceOf("solarized-light")).toBe("light");
    expect(appearanceOf("nord")).toBe("dark");
  });
  it("defaults unknown ids to light", () => {
    expect(appearanceOf("bogus")).toBe("light");
  });
});

describe("registry", () => {
  it("isThemeId recognizes every registered theme", () => {
    for (const t of THEMES) expect(isThemeId(t.id)).toBe(true);
  });
  it("the auto light/dark targets are real themes", () => {
    expect(isThemeId(AUTO_LIGHT)).toBe(true);
    expect(isThemeId(AUTO_DARK)).toBe(true);
  });
  it("has unique ids", () => {
    const ids = THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
