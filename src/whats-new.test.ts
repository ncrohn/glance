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
  it("doesn't end a section at a ## line inside fenced code", () => {
    const log = "## 1.0\n```md\n## not a heading\n```\n~~~~\n## nor this\n```\n~~~~\n- a\n## 0.9\n- b";
    expect(sectionFor(log, "1.0")).toBe("```md\n## not a heading\n```\n~~~~\n## nor this\n```\n~~~~\n- a");
    expect(sectionFor("```\n## 2.0\n```\n## 1.0\n- a", "2.0")).toBeNull();
  });
  it("accepts Keep a Changelog headings", () => {
    const log = "## [Unreleased]\n- u\n## [1.0] - 2026-01-01\n- a\n## 0.9 - 2025-12-01\n- b\n## [0.8]\n- c";
    expect(sectionFor(log, "1.0")).toBe("- a");
    expect(sectionFor(log, "0.9")).toBe("- b");
    expect(sectionFor(log, "0.8")).toBe("- c");
    expect(sectionFor(log, "Unreleased")).toBe("- u");
  });
  it("handles CRLF changelogs", () => {
    expect(sectionFor("## 1.0\r\n- a\r\n## 0.9\r\n- b\r\n", "1.0")).toBe("- a");
  });
});
