// The single source of truth for "what does this markdown source look like once
// rendered, as plain text" — used by BOTH annotation capture (to locate a
// rendered selection back in the source) and annotation highlighting (to locate
// a stored source quote in the rendered DOM). Keeping one implementation means
// the two directions can't drift apart.
//
// It strips inline markup — paired OR dangling **bold**/__/~~strikethrough~~
// markers and code backticks — and unwraps [text](url) links to their text,
// collapsing whitespace. Single * / _ are left literal (see below). It
// deliberately leaves `[[wikilinks]]` literal, because Glance
// does not process them, so they render literally. Unlike routing through
// markdown-it, it drops a dangling marker (e.g. a selection that ends mid-way
// through `**bold**` yields the source slice `**bold`), which markdown-it would
// keep literal and which would then fail to match the rendered text.

export interface Visible {
  visible: string;
  map: number[]; // map[i] = source offset of visible char i; sentinel → source.length
}

export function buildVisible(source: string): Visible {
  const map: number[] = [];
  let visible = "";
  let inWs = false;
  const emit = (ch: string, at: number) => { visible += ch; map.push(at); inWs = false; };
  const space = (at: number) => { if (!inWs) { visible += " "; map.push(at); inWs = true; } };

  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    if (/\s/.test(c)) { space(i); i++; continue; }
    const c2 = source[i + 1];
    if ((c === "*" && c2 === "*") || (c === "_" && c2 === "_") || (c === "~" && c2 === "~")) {
      i += 2; continue; // paired or dangling emphasis / strikethrough markers
    }
    // Single * / _ are left literal on purpose: stripping them would corrupt
    // intra-word underscores (snake_case) and spaced asterisks (2 * 3), which
    // markdown renders literally anyway. A selection crossing single-emphasis is
    // rare and degrades to a marker-only annotation.
    if (c === "`") { i++; continue; } // code span backtick
    if (c === "[") {
      const close = source.indexOf("]", i + 1);
      if (close !== -1 && source[close + 1] === "(") {
        const paren = source.indexOf(")", close + 2);
        if (paren !== -1) {
          for (let j = i + 1; j < close; j++) {
            if (/\s/.test(source[j])) space(j);
            else emit(source[j], j);
          }
          i = paren + 1;
          continue;
        }
      }
    }
    emit(c, i);
    i++;
  }
  map.push(n);
  return { visible, map };
}

// Visible text only (no offset map) — for locating a stored quote in the DOM.
export function toVisible(source: string): string {
  return buildVisible(source).visible;
}
