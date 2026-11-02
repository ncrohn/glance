// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { clampIndex, collectText, findMatches, rangesFor, stepIndex } from "./find";
import { mountFindBar } from "./find-bar";

describe("findMatches", () => {
  it("matches case-insensitively without overlap", () => {
    expect(findMatches("Aaa aA", "aa")).toEqual([{ from: 0, to: 2 }, { from: 4, to: 6 }]);
  });

  it("finds nothing for an empty query", () => {
    expect(findMatches("text", "")).toEqual([]);
  });

  it("keeps offsets for characters whose lowercase form is longer", () => {
    expect(findMatches("İx X", "x")).toEqual([{ from: 1, to: 2 }, { from: 3, to: 4 }]);
  });

  it("lets a space in the query match a line break or a run of spaces", () => {
    expect(findMatches("the quick\nbrown  fox", "quick brown fox")).toEqual([{ from: 4, to: 20 }]);
  });

  it("treats regex characters in the query literally", () => {
    expect(findMatches("a.b axb (c)", "a.b")).toEqual([{ from: 0, to: 3 }]);
    expect(findMatches("a.b axb (c)", "(c)")).toEqual([{ from: 8, to: 11 }]);
  });
});

describe("stepIndex", () => {
  it("wraps both ways", () => {
    expect(stepIndex(2, 3, 1)).toBe(0);
    expect(stepIndex(0, 3, -1)).toBe(2);
  });

  it("starts at the first or last match when none is current", () => {
    expect(stepIndex(-1, 3, 1)).toBe(0);
    expect(stepIndex(-1, 3, -1)).toBe(2);
    expect(stepIndex(0, 0, 1)).toBe(-1);
  });
});

describe("clampIndex", () => {
  it("keeps the index while it exists, else falls back to the last", () => {
    expect(clampIndex(1, 3)).toBe(1);
    expect(clampIndex(5, 3)).toBe(2);
    expect(clampIndex(1, 0)).toBe(-1);
  });
});

function view(html: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "rendered";
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

describe("collectText and rangesFor", () => {
  it("finds a match split across inline elements", () => {
    const v = view("<p>a <strong>bo</strong>ld word</p>");
    const { text, pieces } = collectText(v);
    const ranges = rangesFor(pieces, findMatches(text, "bold"));
    expect(ranges).toHaveLength(1);
    expect(ranges[0].toString()).toBe("bold");
  });

  it("does not match across two paragraphs", () => {
    const v = view("<p>end</p>\n<p>start</p>");
    const { text } = collectText(v);
    expect(findMatches(text, "endstart")).toEqual([]);
    expect(findMatches(text, "end start")).toEqual([]);
  });

  it("matches a phrase across a soft line break", () => {
    const v = view("<p>the quick\nbrown fox</p>");
    const { text, pieces } = collectText(v);
    const [r] = rangesFor(pieces, findMatches(text, "quick brown"));
    expect(r.toString()).toBe("quick\nbrown");
  });

  it("skips a diagram's source before mermaid draws it", () => {
    const v = view('<pre class="mermaid-block">graph TD; cat</pre><p>cat</p>');
    const { text } = collectText(v);
    expect(findMatches(text, "cat")).toHaveLength(1);
  });

  it("places many matches across many nodes in one pass", () => {
    const v = view(Array.from({ length: 2000 }, (_, i) => `<p>a<em>b</em>a ${i}</p>`).join(""));
    const { text, pieces } = collectText(v);
    const ranges = rangesFor(pieces, findMatches(text, "a"));
    expect(ranges).toHaveLength(4000);
    expect(ranges[3999].toString()).toBe("a");
    expect(ranges[3999].startContainer.parentElement?.tagName).toBe("P");
  });

  it("skips gutter markers, buttons and the block editor", () => {
    const v = view(
      '<p>one<span class="anno-gutter-marker">one</span></p><button>one</button><div class="block-editor">one</div>',
    );
    const { text, pieces } = collectText(v);
    const ranges = rangesFor(pieces, findMatches(text, "one"));
    expect(ranges).toHaveLength(1);
    expect(ranges[0].startContainer.parentElement?.tagName).toBe("P");
  });

  it("ends a match at the end of its own node", () => {
    const v = view("<p>ab<em>cd</em></p>");
    const { text, pieces } = collectText(v);
    const [r] = rangesFor(pieces, findMatches(text, "ab"));
    expect(r.endContainer.textContent).toBe("ab");
    expect(r.endOffset).toBe(2);
  });
});

describe("find bar", () => {
  it("reports queries, steps on Enter and Shift+Enter, closes on Escape", () => {
    const host = document.createElement("div");
    const calls: string[] = [];
    const bar = mountFindBar(host, {
      onQuery: (q) => calls.push(`q:${q}`),
      onStep: (d) => calls.push(`step:${d}`),
      onClose: () => calls.push("close"),
    });
    bar.open();
    const input = host.querySelector("input")!;
    input.value = "hi";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(calls).toEqual(["q:hi", "step:1", "step:-1", "close"]);
  });

  it("shows the count, or No matches", () => {
    const host = document.createElement("div");
    const bar = mountFindBar(host, { onQuery() {}, onStep() {}, onClose() {} });
    host.querySelector("input")!.value = "x";
    bar.setCount(1, 4);
    expect(host.querySelector(".find-count")!.textContent).toBe("2 of 4");
    bar.setCount(-1, 0);
    expect(host.querySelector(".find-count")!.textContent).toBe("No matches");
    expect(host.querySelector<HTMLButtonElement>(".find-next")!.disabled).toBe(true);
  });
});
