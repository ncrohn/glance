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

  function selectText(node: Node, start: number, end: number) {
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }

  it("anchors the second copy of a phrase in one block to that copy", () => {
    const src = "# Plan\n\nFirst the plan is drafted, then the plan is reviewed by the team.\n";
    document.body.innerHTML =
      '<h1 data-sourceline="1" data-sourceline-end="1">Plan</h1>' +
      '<p data-sourceline="3" data-sourceline-end="3">First the plan is drafted, then the plan is reviewed by the team.</p>';
    const text = document.querySelector("p")!.firstChild!;
    const second = text.textContent!.lastIndexOf("the plan");
    selectText(text, second, second + "the plan".length);
    const cap = captureSelection(src)!;
    expect(cap.quote).toBe("the plan");
    expect(cap.prefix.endsWith("drafted, then ")).toBe(true);
    expect(cap.suffix.startsWith(" is reviewed")).toBe(true);
    expect(cap.lineHint).toEqual({ start: 3, end: 3 });
  });

  it("still anchors the first copy when it is the one selected", () => {
    const src = "First the plan is drafted, then the plan is reviewed by the team.\n";
    document.body.innerHTML =
      '<p data-sourceline="1" data-sourceline-end="1">First the plan is drafted, then the plan is reviewed by the team.</p>';
    const text = document.querySelector("p")!.firstChild!;
    selectText(text, 6, 6 + "the plan".length);
    const cap = captureSelection(src)!;
    expect(cap.prefix).toBe("First ");
    expect(cap.suffix.startsWith(" is drafted")).toBe(true);
  });

  it("counts copies past inline markup: bold, code and a link between them", () => {
    const src = "We drafted **the plan**, ran `the plan` and [read it](https://x.y), then the plan shipped.\n";
    document.body.innerHTML =
      '<p data-sourceline="1" data-sourceline-end="1">We drafted <strong>the plan</strong>, ran ' +
      '<code>the plan</code> and <a href="https://x.y">read it</a>, then the plan shipped.</p>';
    const p = document.querySelector("p")!;
    const tail = p.lastChild!;
    const at = tail.textContent!.indexOf("the plan");
    selectText(tail, at, at + "the plan".length);
    let cap = captureSelection(src)!;
    expect(cap.quote).toBe("the plan");
    expect(cap.suffix.startsWith(" shipped.")).toBe(true);

    selectText(p.querySelector("code")!.firstChild!, 0, "the plan".length);
    cap = captureSelection(src)!;
    expect(cap.quote).toBe("the plan");
    expect(cap.prefix.endsWith("ran `")).toBe(true);
  });

  it("anchors the first copy when markup splits it and a plain copy follows", () => {
    // Verbatim search only finds the later plain copy; the selected one is bold.
    const src = "Read the **plan** first, then the plan again.\n";
    document.body.innerHTML =
      '<p data-sourceline="1" data-sourceline-end="1">Read the <strong>plan</strong> first, then the plan again.</p>';
    const p = document.querySelector("p")!;
    const range = document.createRange();
    range.setStart(p.firstChild!, "Read ".length);
    range.setEnd(p.querySelector("strong")!.firstChild!, 4);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    const cap = captureSelection(src)!;
    expect(cap.displayQuote).toBe("the plan");
    expect(cap.quote).toBe("the **plan**");
    expect(cap.prefix).toBe("Read ");
  });
});
