// Find in file (⌘F). The pure half matches a query against plain text; the DOM
// half maps those matches onto the rendered view's text nodes as Ranges, which
// app.ts paints with the CSS Custom Highlight API so the view's DOM is never
// touched (the next full render would throw any inserted marks away).

export interface Match { from: number; to: number }

// Lowercase one character at a time, keeping any character whose lowercase form
// changes length (e.g. "İ"), so offsets in the folded text line up with the
// original.
export function foldCase(text: string): string {
  let out = "";
  for (const ch of text) {
    const lower = ch.toLowerCase();
    out += lower.length === ch.length ? lower : ch;
  }
  return out;
}

/** Case-insensitive, non-overlapping matches of `query` in `text`. */
export function findMatches(text: string, query: string): Match[] {
  if (!query) return [];
  const hay = foldCase(text);
  const needle = foldCase(query);
  const out: Match[] = [];
  let at = hay.indexOf(needle);
  while (at >= 0) {
    out.push({ from: at, to: at + needle.length });
    at = hay.indexOf(needle, at + needle.length);
  }
  return out;
}

/** Step through `count` matches with wraparound. */
export function stepIndex(current: number, count: number, dir: 1 | -1): number {
  if (count === 0) return -1;
  if (current < 0) return dir === 1 ? 0 : count - 1;
  return (current + dir + count) % count;
}

/** The match index to keep after the match list was rebuilt: the same one if it
 *  still exists, else the last. */
export function clampIndex(current: number, count: number): number {
  if (count === 0) return -1;
  return Math.min(Math.max(current, 0), count - 1);
}

// Gutter comment markers, code-block buttons and diagram SVGs aren't part of
// the document's text.
const SKIP = "button, svg, .anno-gutter-marker, .block-editor, [aria-hidden='true']";
const BLOCK = "p, li, h1, h2, h3, h4, h5, h6, pre, td, th, blockquote, dd, dt, figcaption, div";

interface Piece { node: Text; start: number }

/** The view's searchable text plus where each text node starts in it. Text in
 *  different blocks is joined with a newline so a match can't run from the end
 *  of one paragraph into the next. */
export function collectText(root: HTMLElement): { text: string; pieces: Piece[] } {
  const pieces: Piece[] = [];
  let text = "";
  let lastBlock: Element | null = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text;
    const block = node.parentElement?.closest(BLOCK) ?? null;
    if (text && block !== lastBlock) text += "\n";
    lastBlock = block;
    pieces.push({ node, start: text.length });
    text += node.data;
  }
  return { text, pieces };
}

/** A DOM Range for each match, spanning text nodes where needed. */
export function rangesFor(pieces: Piece[], matches: Match[]): Range[] {
  const point = (offset: number, end: boolean): [Text, number] | null => {
    for (const p of pieces) {
      const len = p.node.data.length;
      // A match ending exactly where a node ends belongs to that node, not the next.
      if (offset >= p.start && (end ? offset <= p.start + len : offset < p.start + len)) {
        return [p.node, offset - p.start];
      }
    }
    return null;
  };
  const out: Range[] = [];
  for (const m of matches) {
    const a = point(m.from, false);
    const b = point(m.to, true);
    if (!a || !b) continue;
    const r = document.createRange();
    r.setStart(a[0], a[1]);
    r.setEnd(b[0], b[1]);
    out.push(r);
  }
  return out;
}
