// Split into lines, treating a single trailing newline as insignificant so
// "a\nb\n" and "a\nb" compare equal. An empty string yields no lines. CRLF and
// LF compare equal: the editor hands back LF while the file on disk may be CRLF.
function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
}

export interface DetailedLineDiff {
  changed: Set<number>;
  deletedBefore: Set<number>;
}

// Myers' linear-space bisection (as in diff-match-patch): the point where the
// forward and reverse D-paths of a[aLo..aHi) vs b[bLo..bHi) meet, or null when
// the ranges share nothing.
function bisect(
  a: Int32Array, aLo: number, aHi: number,
  b: Int32Array, bLo: number, bHi: number,
): [number, number] | null {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const maxD = Math.ceil((n + m) / 2);
  const off = maxD;
  const len = 2 * maxD + 2;
  const v1 = new Int32Array(len).fill(-1);
  const v2 = new Int32Array(len).fill(-1);
  v1[off + 1] = 0;
  v2[off + 1] = 0;
  const delta = n - m;
  const front = delta % 2 !== 0;
  let k1start = 0, k1end = 0, k2start = 0, k2end = 0;
  for (let d = 0; d < maxD; d++) {
    for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
      const k1o = off + k1;
      let x1 = k1 === -d || (k1 !== d && v1[k1o - 1] < v1[k1o + 1]) ? v1[k1o + 1] : v1[k1o - 1] + 1;
      let y1 = x1 - k1;
      while (x1 < n && y1 < m && a[aLo + x1] === b[bLo + y1]) { x1++; y1++; }
      v1[k1o] = x1;
      if (x1 > n) k1end += 2;
      else if (y1 > m) k1start += 2;
      else if (front) {
        const k2o = off + delta - k1;
        if (k2o >= 0 && k2o < len && v2[k2o] !== -1 && x1 >= n - v2[k2o]) return [aLo + x1, bLo + y1];
      }
    }
    for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
      const k2o = off + k2;
      let x2 = k2 === -d || (k2 !== d && v2[k2o - 1] < v2[k2o + 1]) ? v2[k2o + 1] : v2[k2o - 1] + 1;
      let y2 = x2 - k2;
      while (x2 < n && y2 < m && a[aHi - x2 - 1] === b[bHi - y2 - 1]) { x2++; y2++; }
      v2[k2o] = x2;
      if (x2 > n) k2end += 2;
      else if (y2 > m) k2start += 2;
      else if (!front) {
        const k1o = off + delta - k2;
        if (k1o >= 0 && k1o < len && v1[k1o] !== -1) {
          const x1 = v1[k1o];
          const y1 = off + x1 - k1o;
          if (x1 >= n - x2) return [aLo + x1, bLo + y1];
        }
      }
    }
  }
  return null;
}

// Fill match[i] = j for every line a[i] kept as b[j] in a shortest edit script.
function matchRange(
  a: Int32Array, aLo: number, aHi: number,
  b: Int32Array, bLo: number, bHi: number,
  match: Int32Array,
): void {
  while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) match[aLo++] = bLo++;
  while (aLo < aHi && bLo < bHi && a[aHi - 1] === b[bHi - 1]) match[--aHi] = --bHi;
  if (aLo === aHi || bLo === bHi) return;
  const mid = bisect(a, aLo, aHi, b, bLo, bHi);
  if (!mid) return;
  matchRange(a, aLo, mid[0], b, bLo, mid[1], match);
  matchRange(a, mid[0], aHi, b, mid[1], bHi, match);
}

function compute(oldText: string, newText: string): DetailedLineDiff {
  const changed = new Set<number>();
  const deletedBefore = new Set<number>();
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  // Compare small ints, not strings, in the inner loops.
  const ids = new Map<string, number>();
  const intern = (lines: string[]) => Int32Array.from(lines, (l) => {
    let id = ids.get(l);
    if (id === undefined) { id = ids.size; ids.set(l, id); }
    return id;
  });
  const a = intern(oldLines);
  const b = intern(newLines);
  const match = new Int32Array(a.length).fill(-1);
  // A line that appears on only one side can never be kept, so leave it out of
  // the search: a rewrite with no lines in common then costs nothing, instead
  // of Myers' worst case.
  const inA = new Uint8Array(ids.size);
  const inB = new Uint8Array(ids.size);
  for (const id of a) inA[id] = 1;
  for (const id of b) inB[id] = 1;
  const aIdx = a.reduce<number[]>((acc, id, i) => { if (inB[id]) acc.push(i); return acc; }, []);
  const bIdx = b.reduce<number[]>((acc, id, j) => { if (inA[id]) acc.push(j); return acc; }, []);
  const aF = Int32Array.from(aIdx, (i) => a[i]);
  const bF = Int32Array.from(bIdx, (j) => b[j]);
  const matchF = new Int32Array(aF.length).fill(-1);
  matchRange(aF, 0, aF.length, bF, 0, bF.length, matchF);
  for (let f = 0; f < matchF.length; f++) if (matchF[f] >= 0) match[aIdx[f]] = bIdx[matchF[f]];

  // Walk the gaps between kept lines. Each gap is one hunk: its new lines are
  // changed, and if it removed more than it added, the rest is a deletion
  // marked before the next surviving line.
  let i = 0;
  let j = 0;
  const hunk = (nextI: number, nextJ: number) => {
    const oldCount = nextI - i;
    const newCount = nextJ - j;
    for (let line = j + 1; line <= nextJ; line++) changed.add(line);
    if (oldCount > newCount) deletedBefore.add(j + newCount + 1);
  };
  for (let k = 0; k < a.length; k++) {
    if (match[k] < 0) continue;
    if (k > i || match[k] > j) hunk(k, match[k]);
    i = k + 1;
    j = match[k] + 1;
  }
  if (i < a.length || j < b.length) hunk(a.length, b.length);
  return { changed, deletedBefore };
}

// Read mode diffs the same pair of texts several times per render, and again
// on every tab switch, so keep the last few results.
const CACHE_SIZE = 8;
const cache: Array<{ oldText: string; newText: string; result: DetailedLineDiff }> = [];

export function diffLinesDetailed(
  oldText: string,
  newText: string,
): DetailedLineDiff {
  if (oldText === newText) return { changed: new Set(), deletedBefore: new Set() };
  const idx = cache.findIndex((c) => c.oldText === oldText && c.newText === newText);
  if (idx >= 0) {
    const [hit] = cache.splice(idx, 1);
    cache.unshift(hit);
    return copy(hit.result);
  }
  const result = compute(oldText, newText);
  cache.unshift({ oldText, newText, result });
  if (cache.length > CACHE_SIZE) cache.pop();
  return copy(result);
}

// Callers get their own sets, so mutating one can't poison the cache.
function copy(r: DetailedLineDiff): DetailedLineDiff {
  return { changed: new Set(r.changed), deletedBefore: new Set(r.deletedBefore) };
}

/** Returns 1-indexed added or modified line numbers in `newText`. */
export function diffLines(oldText: string, newText: string): Set<number> {
  return diffLinesDetailed(oldText, newText).changed;
}
