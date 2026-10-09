export interface CapturedAnchor {
  quote: string;
  prefix: string;
  suffix: string;
}

/**
 * Build a fuzzy anchor from a selection range over the document's source text.
 * `prefix`/`suffix` capture up to `ctx` chars around the quote so the Rust
 * resolver can re-find it after edits.
 */
export function buildAnchor(
  fullText: string,
  start: number,
  end: number,
  ctx = 32,
): CapturedAnchor {
  // A context bound that lands inside a surrogate pair would leave a lone half,
  // which Tauri's IPC (serde_json) rejects — the whole add/re-anchor then fails.
  // Shrink the context by one unit instead of splitting the pair.
  let pre = Math.max(0, start - ctx);
  if (pre > 0 && pre < start && isLow(fullText, pre) && isHigh(fullText, pre - 1)) pre++;
  let post = Math.min(fullText.length, end + ctx);
  if (post > end && post < fullText.length && isLow(fullText, post) && isHigh(fullText, post - 1)) post--;
  return {
    quote: fullText.slice(start, end),
    prefix: fullText.slice(pre, start),
    suffix: fullText.slice(end, post),
  };
}

function isHigh(s: string, i: number): boolean {
  const c = s.charCodeAt(i);
  return c >= 0xd800 && c <= 0xdbff;
}

function isLow(s: string, i: number): boolean {
  const c = s.charCodeAt(i);
  return c >= 0xdc00 && c <= 0xdfff;
}
