// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { annotationIdSelector, applyHighlights, assignMarkers, focusRailCard, linkAnnotationHovers, relayoutGutterMarkers } from "./annotation-ui";
import type { Annotation } from "./annotations";

const ids = ['a"b', "c\\d", "e]f", "line\nbreak", "plain"];

function card(rail: HTMLElement, id: string): HTMLElement {
  const c = document.createElement("div");
  c.className = "note-card";
  c.dataset.annotationId = id;
  rail.appendChild(c);
  return c;
}

afterEach(() => vi.unstubAllGlobals());

describe.each([
  ["CSS.escape", () => {}],
  ["the fallback escaper", () => vi.stubGlobal("CSS", undefined)],
])("annotation id selectors with %s", (_name, setup) => {
  it.each(ids)("matches exactly the element for id %j", (id) => {
    setup();
    const rail = document.createElement("div");
    const cards = ids.map((x) => card(rail, x));
    const hits = rail.querySelectorAll(`.note-card${annotationIdSelector(id)}`);
    expect(Array.from(hits)).toEqual([cards[ids.indexOf(id)]]);
  });

  it("focusRailCard and hover emphasis work for an id containing a quote", () => {
    setup();
    const rendered = document.createElement("div");
    const rail = document.createElement("div");
    const mark = document.createElement("mark");
    mark.className = "anno-highlight";
    mark.dataset.annotationId = 'x"y';
    rendered.appendChild(mark);
    const c = card(rail, 'x"y');
    c.scrollIntoView = () => {};
    expect(() => focusRailCard(rail, 'x"y')).not.toThrow();
    expect(c.classList.contains("anno-pulse-card")).toBe(true);
    c.classList.remove("anno-emphasis");
    const unlink = linkAnnotationHovers(rendered, rail);
    mark.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(c.classList.contains("anno-emphasis")).toBe(true);
    unlink();
  });
});

describe("relayoutGutterMarkers", () => {
  it("moves a marker to its quote's new position after the text re-wraps", () => {
    const rendered = document.createElement("div");
    rendered.innerHTML = '<p data-sourceline="1">alpha beta gamma</p>';
    document.body.appendChild(rendered);
    const a: Annotation = {
      id: "n1", number: 1, quote: "beta", prefix: "alpha ", suffix: " gamma",
      lineHint: { start: 1, end: 1 }, note: "", status: "open", author: "user", createdAt: "",
    };
    const res = { n1: { id: "n1", startLine: 1, endLine: 1, anchor: "exact" as const } };

    let markTop = 120;
    const rectAt = (top: number) => ({ top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON() {} });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return rectAt(this.matches("mark.anno-highlight") ? markTop : 0) as DOMRect;
    });

    applyHighlights(rendered, [a], res, assignMarkers([a], res));
    const chip = rendered.querySelector<HTMLElement>(".anno-gutter-marker")!;
    expect(chip.style.top).toBe("120px");

    markTop = 48; // a wider column: the quote now sits higher
    relayoutGutterMarkers(rendered);
    expect(chip.style.top).toBe("48px");
    expect(rendered.querySelectorAll("mark.anno-highlight")).toHaveLength(1);

    vi.restoreAllMocks();
    rendered.remove();
  });
});
