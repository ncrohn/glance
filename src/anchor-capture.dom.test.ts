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
});
