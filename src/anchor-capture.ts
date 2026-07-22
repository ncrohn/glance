import { buildAnchor } from "./build-anchor";
import type { LineHint } from "./annotations";

export interface CapturedSelection {
  quote: string;
  prefix: string;
  suffix: string;
  lineHint: LineHint;
}

/**
 * Capture the current text selection inside the rendered markdown view.
 * Returns null when there is no usable selection. `sourceText` is the document's
 * editor/source content; `start`/`end` offsets are computed against it by
 * locating the selected text near the anchored block's source line.
 */
export function captureSelection(sourceText: string): CapturedSelection | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const quote = sel.toString();
  if (!quote.trim()) return null;

  // Blocks carry their source line range as data-sourceline / -end.
  const range = sel.getRangeAt(0);
  const startBlock = blockOf(range.startContainer) ?? blockOf(sel.anchorNode);
  const blockLine = startBlock ? parseInt(startBlock.dataset.sourceline ?? "1", 10) : 1;

  // Locate the selection in the source, preferring an occurrence at/after the
  // block's line so duplicate text resolves to the selected instance.
  const lines = sourceText.split("\n");
  const lineStartOffset =
    lines.slice(0, blockLine - 1).join("\n").length + (blockLine > 1 ? 1 : 0);

  let span = locateInSource(sourceText, quote, lineStartOffset);

  // Last resort: the rendered view strips markup the source has — blockquote
  // `> ` prefixes, `**bold**`, `[links](…)`, headings — so the selection text
  // can't be found in the raw source at all. Anchor to the source line range of
  // the covered block(s) via their data-sourceline stamps. Coarser (whole block)
  // but always resolves, so the composer always opens.
  if (!span && startBlock) {
    const endBlock = blockOf(range.endContainer) ?? startBlock;
    const l0 = parseInt(startBlock.dataset.sourceline ?? "1", 10);
    const l1 = parseInt(
      endBlock.dataset.sourcelineEnd ?? endBlock.dataset.sourceline ?? String(l0), 10);
    const a = Math.min(l0, l1);
    const b = Math.max(l0, l1);
    span = {
      start: lines.slice(0, a - 1).join("\n").length + (a > 1 ? 1 : 0),
      end: lines.slice(0, b).join("\n").length,
    };
  }
  if (!span) return null;
  const { start, end } = span;

  // Store the *source* slice as the quote so the Rust resolver can re-find it
  // verbatim later (for an exact match it equals the rendered selection).
  const sourceQuote = sourceText.slice(start, end);
  const before = sourceText.slice(0, start);
  const startLine = before.split("\n").length;
  const endLine = startLine + (sourceQuote.split("\n").length - 1);

  const { prefix, suffix } = buildAnchor(sourceText, start, end);
  return { quote: sourceQuote, prefix, suffix, lineHint: { start: startLine, end: endLine } };
}

/**
 * Locate a rendered selection `quote` within the markdown `sourceText`, returning
 * the real source `[start, end)` or null. Tries a verbatim match first (fast path
 * for inline selections), then falls back to a whitespace-normalized match so
 * hard-wrapped source (a long list item / paragraph split across physical lines),
 * list markers, and inline markup still anchor. Exported for testing.
 */
export function locateInSource(
  sourceText: string,
  quote: string,
  fromOffset = 0,
): { start: number; end: number } | null {
  const exact = indexFrom(sourceText, quote, fromOffset);
  if (exact !== -1) return { start: exact, end: exact + quote.length };

  const nm = buildNorm(sourceText);
  const segs = quote.split("\n").map((s) => s.trim()).filter(Boolean);
  if (segs.length === 0) return null;
  const first = findNorm(nm, segs[0], fromOffset);
  if (!first) return null;
  if (segs.length === 1) return { start: first.start, end: first.end };
  const last = findNorm(nm, segs[segs.length - 1], first.end);
  return { start: first.start, end: last ? last.end : first.end };
}

// Nearest ancestor element that carries a source line range.
function blockOf(n: Node | null): HTMLElement | null {
  const e = n instanceof Element ? n : n?.parentElement ?? null;
  return (e?.closest("[data-sourceline]") as HTMLElement | null) ?? null;
}

// indexOf preferring a hit at/after `from`, else anywhere in the text.
function indexFrom(haystack: string, needle: string, from: number): number {
  const i = haystack.indexOf(needle, from);
  return i === -1 ? haystack.indexOf(needle) : i;
}

interface Norm { norm: string; map: number[] }

// Whitespace-normalized view of the source: every run of whitespace collapses to
// one space, and `map[i]` is the original source offset of normalized char `i`.
// A trailing sentinel maps to source.length so a match ending at EOF resolves.
function buildNorm(source: string): Norm {
  const map: number[] = [];
  let norm = "";
  let inWs = false;
  for (let i = 0; i < source.length; i++) {
    if (/\s/.test(source[i])) {
      if (!inWs) { norm += " "; map.push(i); inWs = true; }
    } else {
      norm += source[i]; map.push(i); inWs = false;
    }
  }
  map.push(source.length);
  return { norm, map };
}

// Find `needle` in the normalized source (its own whitespace collapsed), at/after
// source offset `fromSrc`, and return the matching real source range. `end` is the
// offset of the char after the match (excludes trailing whitespace).
function findNorm(nm: Norm, needle: string, fromSrc: number): { start: number; end: number } | null {
  const nn = needle.replace(/\s+/g, " ").trim();
  if (!nn) return null;
  let fromNorm = 0;
  while (fromNorm < nm.map.length && nm.map[fromNorm] < fromSrc) fromNorm++;
  let ni = nm.norm.indexOf(nn, fromNorm);
  if (ni === -1) ni = nm.norm.indexOf(nn);
  if (ni === -1) return null;
  return { start: nm.map[ni], end: nm.map[ni + nn.length] };
}
