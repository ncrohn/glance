# Annotation Highlighting & Comment UX — Design

**Date:** 2026-07-07
**Status:** Approved design, ready for implementation planning
**Scope:** v1 = (a) fix the highlight-coverage bug, (b) numbered + color-keyed identity linking each highlight to its rail comment, (c) replace the comment dialog with an inline popover composer. One cohesive annotation-UX change; Rust backend untouched.

## Goal

Make the annotation review loop legible. Three problems today:

1. **Highlights silently miss.** `applyHighlights` marks a rendered block only when the block's *first* source line falls inside a resolution's `[startLine,endLine]`. Blocks span multiple source lines but only carry `data-sourceline` = their first line, so an anchor resolving to a non-first line of a multi-line block never highlights.
2. **No highlight↔comment mapping.** Every annotated block shares one `.annotated` class — nothing ties a specific highlight to a specific rail card, so with 2+ notes you can't tell which is which.
3. **The composer is bare.** `promptText` is a single-line `<input>` with the quote crammed into the modal title, truncated at 40 chars.

## Non-goals (v1)

- **Character-precise inline highlighting.** Resolutions are line-level (`startLine`/`endLine`), not character offsets. Highlighting stays block/line-level, matching the diff feature's granularity.
- **Claude-authored annotations / threads.** Out of scope, as before.
- **Persisting color/number assignments.** Markers are derived per-render from document order; nothing new is stored on disk. The annotation store format is unchanged.

## The highlight-coverage fix

`renderer.ts`'s existing `source_lines` core rule stamps `data-sourceline = token.map[0]+1` on each level-0 block-open token. Add `data-sourceline-end = token.map[1]` (the block's last source line, 1-indexed inclusive — `token.map` is `[start,end)` 0-indexed half-open, so `end` maps to the inclusive last 1-indexed line). One added `attrSet`.

`applyHighlights` then changes from first-line-membership to **range intersection**: a block `[blockStart, blockEnd]` is annotated iff it intersects any annotation's `[startLine, endLine]`. This is the same block-intersection the diff feature uses; mid-block anchors stop missing.

## Marker identity (numbered + color-keyed)

New pure helper in `annotation-ui.ts`:

```
assignMarkers(annotations, resolutions): Map<string, Marker>   // Marker = { number: number; color: string }
```

- Considers only **open, anchored** annotations (status `open` and resolution has a non-null `startLine`; orphaned/resolved excluded).
- Sorts by `startLine` ascending, tie-break by `createdAt` then `id` for stability.
- Assigns `number` = 1-based index in that order; `color` = `PALETTE[(number-1) % PALETTE.length]`.
- Pure, no DOM, unit-tested.

**Number is the source of truth** (unique, disambiguates when colors recycle past the palette length); **color is the fast group cue**. Both the rail and the highlights consume this single map so they cannot drift.

`PALETTE` is a fixed curated array of hex colors (starter: 6 hues — amber, teal, violet, rose, green, blue), defined once and tuned live during implementation. Each color must stay legible across all themes (Paper/Ink/Solarized/Nord/High-Contrast); the block tint is a low-alpha derivation (`color-mix` with transparent), the marker chip uses the solid color.

## Three surfaces, one mapping

- **In-text (rendered view):** each annotated block gets a colored left bar + faint tint and a colored circled **number marker** in the left gutter, positioned relative to the block (so it tracks the text column at any window width). It sits deeper into the gutter than the diff change-bar so the two coexist on a block that is both changed and annotated. A block hosting multiple annotations stacks its markers. Blocks carry `data-annotation-ids` (space-separated) for hover-linking.
- **Rail card:** leads with the same colored number chip + `L{startLine}`, then the note text. Orphaned/resolved cards show no chip (unchanged dimmed styling).
- **Interaction:**
  - Hover a rail card → its block(s) + marker(s) gain `.anno-emphasis`; hover a marker/block → its rail card gains `.anno-emphasis`. Bidirectional, keyed by annotation id.
  - Click a rail card → scroll to the block (existing `onScrollTo`) **and** briefly add `.anno-pulse` (a CSS keyframe) to the target block.

## Inline popover composer

New module `composer.ts` (keeps `modal.ts` focused):

```
showCommentComposer(opts: {
  quote: string;
  anchor: DOMRect;                 // selection rect, to position the card
  onSubmit: (note: string) => void;
  onCancel: () => void;
}): void
```

- A floating card appended to `document.body` (like the existing `comment-fab`), positioned adjacent to `anchor`, **clamped to the viewport** (flip above/below and shift horizontally so it never clips).
- Contents: a small "Add comment" header, the **quote rendered as a styled blockquote** (full text, wrapping, capped height with scroll), a **multiline `<textarea>`** (autofocused), and Cancel / Comment buttons.
- Keys: **⌘Enter** submits (trimmed; empty is ignored), **Esc** cancels, click-outside cancels. `onmousedown` preventDefault on the card so clicking it doesn't drop the text selection.

`app.ts` `startComment` wiring: it already runs from the selection-toolbar click while the selection is alive. Capture `window.getSelection().getRangeAt(0).getBoundingClientRect()` for `anchor`, call `showCommentComposer` instead of `promptText`; on submit, build the `Annotation` exactly as today and persist. `promptText` stays in `modal.ts` for any non-annotation use.

## Architecture / data flow

```
Resolutions already in state (refreshResolutions) before render
        │
render() ─┬─ renderContent: renderMarkdown(editorContent, {changedLines})
          │     → applyHighlights(view, annotations, resolutions, markerMap)
          │         · range-intersect blocks via data-sourceline / -end
          │         · add color bar+tint, inject colored number markers,
          │           stamp data-annotation-ids
          ├─ renderRailFor: renderRail(..., markerMap)   // same markers → chips
          └─ linkAnnotationHovers(view, railEl, markerMap)  // bidirectional, returns teardown

selection → comment-fab click → startComment
        → capture quote + selection rect
        → showCommentComposer(...)  → onSubmit → addAnnotation → persist → render
```

`markerMap = assignMarkers(annotations, resolutions)` is computed once per render and passed to both `applyHighlights` and `renderRail`.

## Components / files

- `renderer.ts` — add `data-sourceline-end` in `source_lines`.
- `annotation-ui.ts` — `assignMarkers` (pure); rewrite `applyHighlights` to range-intersection + marker injection + `data-annotation-ids`; `renderRail` takes the marker map and renders number chips; add `linkAnnotationHovers` (returns teardown) and a `pulseBlock` helper.
- `composer.ts` (new) — `showCommentComposer`.
- `app.ts` — pass `markerMap` through render; swap `promptText` → `showCommentComposer` in `startComment`; mount/teardown `linkAnnotationHovers` alongside the selection toolbar.
- `styles.css` — palette custom properties, block bar/tint, gutter number markers (+ stacking), rail number chips, `.anno-emphasis`, `.anno-pulse` keyframe, popover composer.

## Testing

- `annotation-ui.test.ts` — `assignMarkers`: order by `startLine`, tie-break stability, exclude orphaned/resolved, color recycling past palette length, empty input. Range-intersection helper: block span vs annotation range (first-line, last-line, mid-block, non-overlap, multi-annotation on one block).
- `renderer.test.ts` — `data-sourceline-end` present and correct on multi-line blocks.
- `composer.ts` pure bits (clamp/position math if extracted) — unit test the viewport-clamp function; the DOM mounting itself is glue (manual-verified, per `app.ts` convention).

## Conventions honored

New pure helpers (`assignMarkers`, clamp math, range intersection) are unit-tested; DOM mounting stays in the `annotation-ui`/`composer`/`app` glue. The rail and highlights consume one shared marker map so they cannot disagree. Marker rendering reuses the source-line-map decoration approach already used by annotations and the diff feature. No new IPC, no store format change.
