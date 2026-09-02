import { describe, expect, it } from "vitest";
import { sectionFor, shouldShowWhatsNew } from "./whats-new";

const LOG = `# Changelog

## 0.8.0

Big one.

### Rail

- Header.

## 0.7.2

- Fix.
`;

describe("shouldShowWhatsNew", () => {
  it("shows when nothing was recorded", () => {
    expect(shouldShowWhatsNew(null, "0.8.0")).toBe(true);
  });
  it("shows when the recorded version differs", () => {
    expect(shouldShowWhatsNew("0.7.2", "0.8.0")).toBe(true);
  });
  it("stays quiet on the same version", () => {
    expect(shouldShowWhatsNew("0.8.0", "0.8.0")).toBe(false);
  });
  it("never shows for an empty version string", () => {
    expect(shouldShowWhatsNew(null, "")).toBe(false);
  });
});

describe("sectionFor", () => {
  it("returns the body between the version heading and the next", () => {
    expect(sectionFor(LOG, "0.8.0")).toBe("Big one.\n\n### Rail\n\n- Header.");
  });
  it("returns the last section to end of file", () => {
    expect(sectionFor(LOG, "0.7.2")).toBe("- Fix.");
  });
  it("returns null for an unknown version or an empty section", () => {
    expect(sectionFor(LOG, "0.9.0")).toBeNull();
    expect(sectionFor("## 1.0.0\n\n## 0.9.0\n- x\n", "1.0.0")).toBeNull();
  });
});
