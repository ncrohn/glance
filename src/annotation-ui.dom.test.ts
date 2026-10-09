// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { annotationIdSelector, focusRailCard, linkAnnotationHovers } from "./annotation-ui";

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
