export type RenderKey = { id: string | null; mode: string | null };

// Where #content.scrollTop should land after a re-render. Source and rendered
// heights don't correspond, so a mode toggle on the same doc starts at the top;
// everything else restores whatever was saved for the doc (0 if nothing was).
export function restoreTarget(prev: RenderKey, next: RenderKey, saved: Map<string, number>): number {
  if (!next.id) return 0;
  if (prev.id === next.id && prev.mode !== next.mode) return 0;
  return saved.get(next.id) ?? 0;
}
