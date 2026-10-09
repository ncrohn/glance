// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { captureSelection } from "./anchor-capture";

describe("captureSelection", () => {
  it("anchors a selection across bold to its own block, not a later plain duplicate", () => {
    const src = "We should **ship the plan** now.\n\nWe should ship the plan now.\n";
    document.body.innerHTML =
      '<p data-sourceline="1" data-sourceline-end="1">We should <strong>ship the plan</strong> now.</p>' +
      '<p data-sourceline="3" data-sourceline-end="3">We should ship the plan now.</p>';
    const p = document.querySelector("p")!;
    const range = document.createRange();
    range.setStart(p.querySelector("strong")!.firstChild!, 0);
    range.setEnd(p.lastChild!, 4); // " now"
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    const cap = captureSelection(src)!;
    expect(cap.displayQuote).toBe("ship the plan now");
    expect(cap.quote).toBe("ship the plan** now");
    expect(cap.lineHint).toEqual({ start: 1, end: 1 });
  });

  it("falls back to the selected block when only a duplicate elsewhere matches", () => {
    // Single-* emphasis isn't stripped by the markup-tolerant pass, so the
    // selection can't be matched inside its own block; the plain copy on line
    // 1 must not win.
    const src = "should really ship it\n\nWe should *really* ship it.\n";
    document.body.innerHTML =
      '<p data-sourceline="1" data-sourceline-end="1">should really ship it</p>' +
      '<p data-sourceline="3" data-sourceline-end="3">We <span>should <em>really</em> ship it</span>.</p>';
    const span = document.querySelectorAll("p")[1].querySelector("span")!;
    const range = document.createRange();
    range.selectNodeContents(span);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    const cap = captureSelection(src)!;
    expect(cap.lineHint).toEqual({ start: 3, end: 3 });
  });
});
