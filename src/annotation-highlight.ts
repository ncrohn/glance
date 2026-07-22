// Pure text-locating for inline annotation highlights. Given a block's visible
// text and an annotation's (already visible-form) quote plus surrounding
// context, find the character range of the quote in the text — tolerant of
// whitespace differences (collapsed runs, source hard-wraps) and disambiguated
// by prefix/suffix when the quote repeats. Returns offsets into `text`, or null.
// The caller converts the stored source anchor to visible text (via
// markdown-visible.toVisible) before calling this, and maps the returned offsets
// back to DOM text nodes.

export interface TextRange {
  start: number;
  end: number;
}

export function locateQuote(
  text: string,
  quote: string,
  prefix: string,
  suffix: string,
): TextRange | null {
  const { norm, map } = buildNorm(text);
  const q = normalizeWs(quote);
  if (!q) return null;

  const occ: number[] = [];
  for (let i = norm.indexOf(q); i !== -1; i = norm.indexOf(q, i + 1)) occ.push(i);
  if (occ.length === 0) return null;

  const p = normalizeWs(prefix);
  const s = normalizeWs(suffix);
  let best = occ[0];
  let bestScore = -1;
  for (const o of occ) {
    let score = 0;
    if (p && normalizeWs(norm.slice(0, o)).endsWith(p)) score += 2;
    if (s && normalizeWs(norm.slice(o + q.length)).startsWith(s)) score += 2;
    if (score > bestScore) {
      bestScore = score;
      best = o;
    }
  }

  return { start: map[best], end: map[best + q.length] };
}

interface Norm {
  norm: string;
  map: number[];
}

// Whitespace-collapsed view of `text`: every run of whitespace becomes one
// space; `map[i]` is the original offset of normalized char `i`, with a trailing
// sentinel mapping to text.length so a match ending at EOF resolves.
function buildNorm(text: string): Norm {
  const map: number[] = [];
  let norm = "";
  let inWs = false;
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) {
      if (!inWs) {
        norm += " ";
        map.push(i);
        inWs = true;
      }
    } else {
      norm += text[i];
      map.push(i);
      inWs = false;
    }
  }
  map.push(text.length);
  return { norm, map };
}

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
