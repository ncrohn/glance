// WCAG 2.x contrast helpers. Pure; used by the palette test and nothing at
// runtime.

export type Rgb = [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const h = hex.trim().replace(/^#/, "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`bad hex color: ${hex}`);
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// `fg` at `pct` (0-100) over an opaque `bg`, mixing sRGB channels linearly.
// Matches `color-mix(in srgb, fg pct, transparent)` painted over `bg`.
export function mixOver(fg: Rgb, bg: Rgb, pct: number): Rgb {
  const p = pct / 100;
  return [
    fg[0] * p + bg[0] * (1 - p),
    fg[1] * p + bg[1] * (1 - p),
    fg[2] * p + bg[2] * (1 - p),
  ];
}
