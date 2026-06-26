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

  // Find the nearest block element carrying a source line number.
  const node = sel.anchorNode;
  const el = node instanceof Element ? node : node?.parentElement ?? null;
  const block = el?.closest("[data-sourceline]") as HTMLElement | null;
  const blockLine = block ? parseInt(block.dataset.sourceline ?? "1", 10) : 1;

  // Locate the quote in the source, preferring an occurrence at/after the block
  // line so duplicate text resolves to the selected instance.
  const lines = sourceText.split("\n");
  const lineStartOffset = lines.slice(0, blockLine - 1).join("\n").length + (blockLine > 1 ? 1 : 0);
  let start = sourceText.indexOf(quote, lineStartOffset);
  if (start === -1) start = sourceText.indexOf(quote);
  if (start === -1) return null;
  const end = start + quote.length;

  const before = sourceText.slice(0, start);
  const startLine = before.split("\n").length;
  const endLine = startLine + (quote.split("\n").length - 1);

  const { prefix, suffix } = buildAnchor(sourceText, start, end);
  return { quote, prefix, suffix, lineHint: { start: startLine, end: endLine } };
}
