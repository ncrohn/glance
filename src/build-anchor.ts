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
  return {
    quote: fullText.slice(start, end),
    prefix: fullText.slice(Math.max(0, start - ctx), start),
    suffix: fullText.slice(end, Math.min(fullText.length, end + ctx)),
  };
}
