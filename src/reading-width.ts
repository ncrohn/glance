// Reading width: how wide the rendered text column may grow.
//
// The preference (localStorage `glance.readingWidth`) is a preset id. Applying
// it sets `--reading-w` on <html>, which styles.css uses as the max-width of
// `.rendered`. An inline bootstrap in index.html sets the same variable before
// first paint, so keep the two preset tables in step.

export interface ReadingWidth {
  id: string;
  name: string;
  value: string; // CSS length for --reading-w
}

export const DEFAULT_WIDTH = "standard";

// Order here is the order shown in the picker.
export const WIDTHS: ReadingWidth[] = [
  { id: "narrow", name: "Narrow", value: "40rem" },
  { id: "standard", name: "Standard", value: "47rem" },
  { id: "wide", name: "Wide", value: "62rem" },
  { id: "full", name: "Full width", value: "100%" },
];

const LS_WIDTH = "glance.readingWidth";

export function parseWidthPref(raw: string | null): string {
  return WIDTHS.some((w) => w.id === raw) ? (raw as string) : DEFAULT_WIDTH;
}

export function widthValue(id: string): string {
  return (WIDTHS.find((w) => w.id === id) ?? WIDTHS.find((w) => w.id === DEFAULT_WIDTH)!).value;
}

// ---- DOM side (not unit tested) -------------------------------------------

export function loadWidthPref(): string {
  try {
    return parseWidthPref(localStorage.getItem(LS_WIDTH));
  } catch {
    return DEFAULT_WIDTH;
  }
}

export function saveWidthPref(id: string): void {
  try {
    localStorage.setItem(LS_WIDTH, id);
  } catch {
    // Storage unavailable: the choice still applies for this session.
  }
}

export function applyWidth(id: string): void {
  document.documentElement.style.setProperty("--reading-w", widthValue(id));
}
