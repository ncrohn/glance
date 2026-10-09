import { describe, expect, it } from "vitest";
import { CHECK_INTERVAL_MS, isCheckDue, isNewer, parseRelease } from "./update-check";

describe("isNewer", () => {
  it("compares each part numerically", () => {
    expect(isNewer("0.8.7", "0.8.6")).toBe(true);
    expect(isNewer("0.10.0", "0.9.9")).toBe(true);
    expect(isNewer("1.0.0", "0.99.99")).toBe(true);
  });

  it("is false for the same or an older version", () => {
    expect(isNewer("0.8.6", "0.8.6")).toBe(false);
    expect(isNewer("0.8.5", "0.8.6")).toBe(false);
    expect(isNewer("0.9.0", "1.0.0")).toBe(false);
  });

  it("accepts a leading v", () => {
    expect(isNewer("v0.8.7", "0.8.6")).toBe(true);
  });

  it("is false when either version does not parse", () => {
    expect(isNewer("0.9.0-beta.1", "0.8.6")).toBe(false);
    expect(isNewer("latest", "0.8.6")).toBe(false);
    expect(isNewer("0.9.0", "")).toBe(false);
  });
});

describe("parseRelease", () => {
  const base = { tag_name: "v0.8.7", html_url: "https://github.com/ncrohn/glance/releases/tag/v0.8.7", draft: false, prerelease: false };

  it("reads the version and release page", () => {
    expect(parseRelease(base)).toEqual({ version: "0.8.7", url: base.html_url });
  });

  it("rejects drafts and pre-releases", () => {
    expect(parseRelease({ ...base, draft: true })).toBeNull();
    expect(parseRelease({ ...base, prerelease: true })).toBeNull();
  });

  it("rejects a tag that is not a version", () => {
    expect(parseRelease({ ...base, tag_name: "nightly" })).toBeNull();
  });

  it("rejects a release page outside github.com", () => {
    expect(parseRelease({ ...base, html_url: "https://example.com/x" })).toBeNull();
  });

  it("rejects bodies that are not objects", () => {
    expect(parseRelease(null)).toBeNull();
    expect(parseRelease("v0.8.7")).toBeNull();
    expect(parseRelease({ message: "Not Found" })).toBeNull();
  });
});

describe("isCheckDue", () => {
  const now = 1_800_000_000_000;

  it("is due with no record", () => {
    expect(isCheckDue(null, now)).toBe(true);
    expect(isCheckDue("garbage", now)).toBe(true);
  });

  it("waits a full interval between checks", () => {
    expect(isCheckDue(String(now - CHECK_INTERVAL_MS + 1), now)).toBe(false);
    expect(isCheckDue(String(now - CHECK_INTERVAL_MS), now)).toBe(true);
  });

  it("is due when the clock moved backwards", () => {
    expect(isCheckDue(String(now + 60_000), now)).toBe(true);
  });
});
