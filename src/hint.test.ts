import { describe, it, expect } from "vitest";
import { shouldShowCommentHint } from "./hint";

describe("shouldShowCommentHint", () => {
  it("shows for a doc with no comments when never dismissed", () => {
    expect(shouldShowCommentHint(null, 0)).toBe(true);
  });

  it("hides once dismissed", () => {
    expect(shouldShowCommentHint("1", 0)).toBe(false);
  });

  it("hides when the doc already has comments", () => {
    expect(shouldShowCommentHint(null, 2)).toBe(false);
  });
});
