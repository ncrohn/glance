import { buildAnchor } from "./build-anchor";
import { buildVisible, type Visible } from "./markdown-visible";
import type { LineHint } from "./annotations";

export interface CapturedSelection {
  quote: string; // source slice — what the Rust resolver re-finds
  displayQuote: string; // the exact rendered selection — what the composer shows
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

  const lines = sourceText.split("\n");
  const lineStart = (l: number) => lines.slice(0, l - 1).join("\n").length + (l > 1 ? 1 : 0);
  const lineEnd = (l: number) => lines.slice(0, l).join("\n").length;

  // Source range of the covered block(s), from their data-sourceline stamps.
  let blockSpan: Span | null = null;
  if (startBlock) {
    const endBlock = blockOf(range.endContainer) ?? startBlock;
    const l0 = parseInt(startBlock.dataset.sourceline ?? "1", 10);
    const l1 = parseInt(
      endBlock.dataset.sourcelineEnd ?? endBlock.dataset.sourceline ?? String(l0), 10);
    blockSpan = { start: lineStart(Math.min(l0, l1)), end: lineEnd(Math.max(l0, l1)) };
  }

  // When the block repeats the selected text, take the copy the user selected.
  let span = startBlock && blockSpan
    ? locateSelectedCopy(sourceText, quote, startBlock, range, blockSpan)
    : null;
  // Otherwise locate the selection in the source, preferring an occurrence
  // inside the selected block(s), then at/after the block's line, so duplicate
  // text elsewhere resolves to the selected instance.
  span ??= locateInSource(sourceText, quote, lineStart(blockLine), blockSpan?.end);
  // A match that starts outside the selected block(s) is a copy of the text
  // somewhere else; the block itself is the better anchor.
  if (span && blockSpan && (span.start < blockSpan.start || span.start > blockSpan.end)) {
    span = blockSpan;
  }

  // Last resort: the rendered view strips markup the source has — blockquote
  // `> ` prefixes, `**bold**`, `[links](…)`, headings — so the selection text
  // can't be found in the raw source at all. Anchor to the source line range of
  // the covered block(s). Coarser (whole block) but always resolves, so the
  // composer always opens.
  if (!span && blockSpan) span = blockSpan;
  if (!span) return null;
  const { start, end } = span;

  // Store the *source* slice as the quote so the Rust resolver can re-find it
  // verbatim later (for an exact match it equals the rendered selection).
  const sourceQuote = sourceText.slice(start, end);
  const before = sourceText.slice(0, start);
  const startLine = before.split("\n").length;
  const endLine = startLine + (sourceQuote.split("\n").length - 1);

  const { prefix, suffix } = buildAnchor(sourceText, start, end);
  return {
    quote: sourceQuote,
    displayQuote: quote,
    prefix,
    suffix,
    lineHint: { start: startLine, end: endLine },
  };
}

interface Span { start: number; end: number }

const collapseWs = (s: string) => s.replace(/\s+/g, " ");

function occurrences(text: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) out.push(i);
  return out;
}

/**
 * Source span of the copy of `quote` the user selected, when the block holds
 * more than one copy. Counts which copy the selection starts on in the block's
 * rendered text, then takes the same-numbered copy in the markup-stripped view
 * of the block's source (the view the rendered text corresponds to, so
 * `**bold**`, `code` and links between copies don't skew the count). Null when
 * there is one copy or fewer, or the two views disagree on how many there are.
 */
function locateSelectedCopy(
  sourceText: string,
  quote: string,
  block: HTMLElement,
  range: Range,
  blockSpan: Span,
): Span | null {
  const q = collapseWs(quote).trim();
  if (!q || !block.contains(range.startContainer)) return null;

  const whole = document.createRange();
  whole.selectNodeContents(block);
  const rendered = occurrences(collapseWs(whole.toString()), q);
  if (rendered.length < 2) return null;
  const before = document.createRange();
  before.setStart(block, 0);
  before.setEnd(range.startContainer, range.startOffset);
  const lead = quote.length - quote.trimStart().length;
  const at = collapseWs(before.toString() + quote.slice(0, lead)).length;
  const nth = Math.min(rendered.filter((p) => p < at).length, rendered.length - 1);

  const { visible, map } = buildVisible(sourceText);
  let from = 0;
  while (from < map.length && map[from] < blockSpan.start) from++;
  const inBlock = occurrences(visible.slice(from), q)
    .map((i) => i + from)
    .filter((i) => map[i + q.length] <= blockSpan.end);
  if (inBlock.length !== rendered.length) return null;

  const vi = inBlock[nth];
  const start = map[vi];
  // A copy without markup inside it is stored verbatim, as the plain path would.
  if (start >= lead && sourceText.startsWith(quote, start - lead)) {
    return { start: start - lead, end: start - lead + quote.length };
  }
  return { start, end: map[vi + q.length] };
}

/**
 * Locate a rendered selection `quote` within the markdown `sourceText`, returning
 * the real source `[start, end)` or null. Tries a verbatim match first (fast path
 * for inline selections), then a whitespace-normalized match so hard-wrapped
 * source (a long list item / paragraph split across physical lines) and list
 * markers still anchor, then a markup-tolerant match for selections that cross
 * inline markup. All three passes look inside the selected block first
 * (`[fromOffset, toOffset]`), then anywhere at/after `fromOffset`, and only then
 * anywhere in the document — a verbatim duplicate elsewhere must not beat a
 * fuzzier match in the block the user actually selected. Exported for testing.
 */
export function locateInSource(
  sourceText: string,
  quote: string,
  fromOffset = 0,
  toOffset?: number,
): Span | null {
  let nm: Norm | null = null;
  let vis: Visible | null = null;
  const passes: Array<(from: number) => Span | null> = [
    (from) => {
      const i = sourceText.indexOf(quote, from);
      return i === -1 ? null : { start: i, end: i + quote.length };
    },
    // Whitespace-normalized: handles hard-wrapped source, list markers.
    (from) => locateNorm((nm ??= buildNorm(sourceText)), quote, from),
    // Markdown-tolerant: the rendered selection strips inline markup the source
    // still has (**bold**, `code`, [links]), so a selection that crosses such a
    // boundary matches neither pass above. Match against a "visible view" of the
    // source — inline markup removed, whitespace collapsed — that carries an
    // offset map back to real source positions, then map the hit back so the
    // stored quote is a tight source slice the resolver can re-find.
    (from) => locateInVisible((vis ??= buildVisible(sourceText)), quote, from),
  ];
  if (toOffset != null) {
    for (const pass of passes) {
      const hit = pass(fromOffset);
      if (hit && hit.end <= toOffset) return hit;
    }
  }
  for (const from of fromOffset > 0 ? [fromOffset, 0] : [0]) {
    for (const pass of passes) {
      const hit = pass(from);
      if (hit) return hit;
    }
  }
  return null;
}

// A multi-line selection matches its first and last line separately, so the
// list markers / indentation between them in the source don't matter.
function locateNorm(nm: Norm, quote: string, from: number): Span | null {
  const segs = quote.split("\n").map((s) => s.trim()).filter(Boolean);
  if (segs.length === 0) return null;
  const first = findNorm(nm, segs[0], from);
  if (!first || segs.length === 1) return first;
  const last = findNorm(nm, segs[segs.length - 1], first.end);
  return { start: first.start, end: last ? last.end : first.end };
}

function locateInVisible({ visible, map }: Visible, quote: string, fromOffset: number): Span | null {
  const q = quote.replace(/\s+/g, " ").trim();
  if (!q) return null;
  let fromVis = 0;
  while (fromVis < map.length && map[fromVis] < fromOffset) fromVis++;
  const i = visible.indexOf(q, fromVis);
  if (i === -1) return null;
  return { start: map[i], end: map[i + q.length] };
}

// Nearest ancestor element that carries a source line range.
function blockOf(n: Node | null): HTMLElement | null {
  const e = n instanceof Element ? n : n?.parentElement ?? null;
  return (e?.closest("[data-sourceline]") as HTMLElement | null) ?? null;
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
function findNorm(nm: Norm, needle: string, fromSrc: number): Span | null {
  const nn = needle.replace(/\s+/g, " ").trim();
  if (!nn) return null;
  let fromNorm = 0;
  while (fromNorm < nm.map.length && nm.map[fromNorm] < fromSrc) fromNorm++;
  const ni = nm.norm.indexOf(nn, fromNorm);
  if (ni === -1) return null;
  return { start: nm.map[ni], end: nm.map[ni + nn.length] };
}
