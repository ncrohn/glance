/** The tab strip's horizontal scroll state. */
export interface StripView {
  scrollLeft: number;
  clientWidth: number;
  scrollWidth: number;
}

/** A tab's horizontal extent in the strip's scrolled content (not the viewport). */
export interface TabSpan {
  left: number;
  right: number;
}

/** Room left beside a revealed tab so the neighbour's edge still shows. */
export const REVEAL_MARGIN = 12;

export function isTabVisible(view: StripView, tab: TabSpan): boolean {
  return tab.left >= view.scrollLeft && tab.right <= view.scrollLeft + view.clientWidth;
}

/** The smallest scroll that brings `tab` fully into view. A tab wider than the
 *  strip lines up its left edge. */
export function revealScrollLeft(view: StripView, tab: TabSpan, margin = REVEAL_MARGIN): number {
  const max = Math.max(0, view.scrollWidth - view.clientWidth);
  let next = view.scrollLeft;
  if (tab.right + margin > next + view.clientWidth) next = tab.right + margin - view.clientWidth;
  if (tab.left - margin < next) next = tab.left - margin;
  return Math.min(Math.max(next, 0), max);
}

export type RevealDecision = "reveal" | "defer" | "keep";

/** Whether a re-render should scroll the active tab into view.
 *  - A new active tab is always revealed, but not under the user's fingers:
 *    mid-scroll it waits until the scroll settles.
 *  - The same active tab is kept in view only if it was in view before the
 *    render, so a tab the user scrolled away from stays where they left it. */
export function revealDecision(input: { activeChanged: boolean; wasVisible: boolean; userScrolling: boolean }): RevealDecision {
  if (input.activeChanged) return input.userScrolling ? "defer" : "reveal";
  if (input.userScrolling) return "keep";
  return input.wasVisible ? "reveal" : "keep";
}
