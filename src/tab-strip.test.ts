import { describe, it, expect } from "vitest";
import { isTabVisible, revealScrollLeft, revealDecision } from "./tab-strip";

const view = { scrollLeft: 200, clientWidth: 400, scrollWidth: 1500 };

describe("isTabVisible", () => {
  it("is true only when the whole tab is inside the viewport", () => {
    expect(isTabVisible(view, { left: 200, right: 600 })).toBe(true);
    expect(isTabVisible(view, { left: 190, right: 300 })).toBe(false);
    expect(isTabVisible(view, { left: 550, right: 610 })).toBe(false);
  });
});

describe("revealScrollLeft", () => {
  it("leaves a visible tab alone", () => {
    expect(revealScrollLeft(view, { left: 300, right: 400 })).toBe(200);
  });

  it("scrolls right just far enough for a tab off the right edge", () => {
    expect(revealScrollLeft(view, { left: 900, right: 1000 }, 12)).toBe(612);
  });

  it("scrolls left just far enough for a tab off the left edge", () => {
    expect(revealScrollLeft(view, { left: 50, right: 150 }, 12)).toBe(38);
  });

  it("clamps to the start and end of the strip", () => {
    expect(revealScrollLeft(view, { left: 0, right: 100 }, 12)).toBe(0);
    expect(revealScrollLeft(view, { left: 1400, right: 1500 }, 12)).toBe(1100);
  });

  it("lines up the left edge of a tab wider than the strip", () => {
    expect(revealScrollLeft(view, { left: 700, right: 1200 }, 0)).toBe(700);
  });
});

describe("revealDecision", () => {
  it("reveals a newly active tab", () => {
    expect(revealDecision({ activeChanged: true, wasVisible: false, userScrolling: false })).toBe("reveal");
  });

  it("defers a newly active tab while the user is scrolling the strip", () => {
    expect(revealDecision({ activeChanged: true, wasVisible: false, userScrolling: true })).toBe("defer");
  });

  it("keeps the same active tab in view when a render shifts it", () => {
    expect(revealDecision({ activeChanged: false, wasVisible: true, userScrolling: false })).toBe("reveal");
  });

  it("leaves the strip alone when the user had scrolled the active tab away", () => {
    expect(revealDecision({ activeChanged: false, wasVisible: false, userScrolling: false })).toBe("keep");
  });

  it("never moves the strip for the same tab mid-scroll", () => {
    expect(revealDecision({ activeChanged: false, wasVisible: true, userScrolling: true })).toBe("keep");
  });
});
