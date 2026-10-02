export type RenderKey = { id: string | null; mode: string | null };

// Where #content.scrollTop should land after a re-render. Source and rendered
// heights don't correspond, so a mode toggle on the same doc starts at the top
// here and app.ts then moves to the same source line (see lineAtOffset);
// everything else restores whatever was saved for the doc (0 if nothing was).
export function restoreTarget(prev: RenderKey, next: RenderKey, saved: Map<string, number>): number {
  if (!next.id) return 0;
  if (prev.id === next.id && prev.mode !== next.mode) return 0;
  return saved.get(next.id) ?? 0;
}

/** A rendered element stamped with the source lines it came from (inclusive),
 *  and where it sits in the scrolled content. Listed in document order. */
export interface LineBlock {
  start: number;
  end: number;
  top: number;
  height: number;
}

function blockAt(blocks: LineBlock[], test: (b: LineBlock) => boolean): LineBlock | null {
  let hit: LineBlock | null = null;
  for (const b of blocks) if (test(b)) hit = b;
  return hit;
}

/** The source line shown at scroll offset `offset` in the rendered view. */
export function lineAtOffset(blocks: LineBlock[], offset: number): number {
  const b = blockAt(blocks, (x) => x.top <= offset + 1);
  if (!b) return 1;
  const count = b.end - b.start + 1;
  const f = b.height > 0 ? Math.min(Math.max((offset - b.top) / b.height, 0), 1) : 0;
  return Math.min(b.start + Math.floor(f * count), b.end);
}

/** The rendered-view scroll offset that puts source line `line` at the top. */
export function offsetForLine(blocks: LineBlock[], line: number): number {
  const b = blockAt(blocks, (x) => x.start <= line);
  if (!b) return 0;
  const count = b.end - b.start + 1;
  const f = Math.min(Math.max((line - b.start) / count, 0), 1);
  return Math.max(b.top + f * b.height, 0);
}
