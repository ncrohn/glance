// First-run cue that commenting exists. Shown only until dismissed or the
// reader leaves a comment; a doc that already has comments needs no cue.
export function shouldShowCommentHint(seen: string | null, annotationCount: number): boolean {
  return seen !== "1" && annotationCount === 0;
}
