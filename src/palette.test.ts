import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrastRatio, hexToRgb, mixOver, type Rgb } from "./contrast";
import { THEMES } from "./theme";

// Every theme's annotation palette must keep highlighted text and the number
// chips legible. Reads styles.css directly so a hex tweak cannot regress
// silently.

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

interface ThemePalette {
  bg: Rgb;
  ink: Rgb;
  colors: Rgb[];
  tint: number;
  tintHover: number;
  chipInk: Rgb;
}

function themeBlock(id: string): string {
  const open = `:root[data-theme="${id}"] {`;
  const start = css.indexOf(open);
  if (start < 0) throw new Error(`no theme block for ${id}`);
  const end = css.indexOf("}", start);
  return css.slice(start + open.length, end);
}

function token(block: string, name: string): string | undefined {
  const m = block.match(new RegExp(`--${name}:\\s*([^;]+);`));
  return m?.[1].trim();
}

function parsePalette(id: string): ThemePalette {
  const block = themeBlock(id);
  const bgHex = token(block, "bg");
  const inkHex = token(block, "ink");
  if (!bgHex || !inkHex) throw new Error(`${id}: missing --bg or --ink`);
  const resolve = (v: string): Rgb => (v === "var(--bg)" ? hexToRgb(bgHex) : hexToRgb(v));
  const colors: Rgb[] = [];
  for (let i = 1; i <= 6; i++) {
    const v = token(block, `anno-${i}`);
    if (!v) throw new Error(`${id}: missing --anno-${i}`);
    colors.push(hexToRgb(v));
  }
  const pct = (name: string): number => {
    const v = token(block, name);
    if (!v || !/^\d+(\.\d+)?%$/.test(v)) throw new Error(`${id}: missing or non-percent --${name}`);
    return parseFloat(v);
  };
  const chip = token(block, "anno-chip-ink");
  if (!chip) throw new Error(`${id}: missing --anno-chip-ink`);
  return {
    bg: hexToRgb(bgHex),
    ink: hexToRgb(inkHex),
    colors,
    tint: pct("anno-tint"),
    tintHover: pct("anno-tint-hover"),
    chipInk: resolve(chip),
  };
}

// Solarized Dark's base ink contrast is only 5.6, so AAA at rest is out of
// reach there; it must still hold AA.
const REST_TARGET: Record<string, number> = { "solarized-dark": 4.5 };

describe("annotation palette", () => {
  for (const theme of THEMES) {
    describe(theme.id, () => {
      const p = parsePalette(theme.id);

      it("defines all six marker colors", () => {
        expect(p.colors).toHaveLength(6);
      });

      it("keeps highlighted text readable at rest", () => {
        const target = REST_TARGET[theme.id] ?? 7;
        p.colors.forEach((c, i) => {
          const ratio = contrastRatio(p.ink, mixOver(c, p.bg, p.tint));
          expect(ratio, `${theme.id} --anno-${i + 1} at ${p.tint}% tint: ${ratio.toFixed(2)} < ${target}`)
            .toBeGreaterThanOrEqual(target);
        });
      });

      it("keeps highlighted text readable on hover", () => {
        p.colors.forEach((c, i) => {
          const ratio = contrastRatio(p.ink, mixOver(c, p.bg, p.tintHover));
          expect(ratio, `${theme.id} --anno-${i + 1} at ${p.tintHover}% hover tint: ${ratio.toFixed(2)} < 4.5`)
            .toBeGreaterThanOrEqual(4.5);
        });
      });

      it("keeps chip numbers legible", () => {
        p.colors.forEach((c, i) => {
          const ratio = contrastRatio(p.chipInk, c);
          expect(ratio, `${theme.id} --anno-${i + 1} chip ink: ${ratio.toFixed(2)} < 4.5`)
            .toBeGreaterThanOrEqual(4.5);
        });
      });
    });
  }
});
