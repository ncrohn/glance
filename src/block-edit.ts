// Pure helpers for editing one rendered block's markdown in place. A block is a
// 1-based, inclusive source line range (the data-sourceline stamps); text is LF.

/** Lines `start`..`start + count - 1` of `text`, joined. */
export function sliceLines(text: string, start: number, count: number): string {
  return text.split("\n").slice(start - 1, start - 1 + count).join("\n");
}

/** `text` with `count` lines from `start` replaced by `replacement`. A zero
 *  `count` inserts before line `start`; `gap` puts a blank line in front of a
 *  non-empty insertion so it doesn't merge into the block above. A `fresh`
 *  block (one that didn't exist before) takes no lines at all when empty. */
export function spliceLines(
  text: string,
  start: number,
  count: number,
  replacement: string,
  gap = false,
  fresh = false,
): string {
  const lines = text.split("\n");
  lines.splice(start - 1, count, ...insertedLines(replacement, gap, fresh));
  return lines.join("\n");
}

/** Lines `replacement` occupies once spliced in (see spliceLines). */
export function splicedCount(replacement: string, gap = false, fresh = false): number {
  return insertedLines(replacement, gap, fresh).length;
}

function insertedLines(replacement: string, gap: boolean, fresh: boolean): string[] {
  if (replacement === "") return fresh ? [] : [""];
  return gap ? ["", ...replacement.split("\n")] : replacement.split("\n");
}

/** Where a new block typed below the last one goes: before a trailing newline,
 *  with a blank line in front unless the text already ends in one. */
export function appendTarget(text: string): { start: number; gap: boolean } {
  const lines = text.split("\n");
  const trailing = lines.length > 1 && lines[lines.length - 1] === "";
  const body = trailing ? lines.slice(0, -1) : lines;
  if (body.length === 1 && body[0] === "") return { start: 1, gap: false };
  return { start: body.length + 1, gap: body[body.length - 1].trim() !== "" };
}

/** Best guess at the source offset matching a click in the rendered text:
 *  `before` is the rendered text leading up to the caret, matched against
 *  `source` from its longest tail down. Falls back to the end of line 1. */
export function caretInSource(source: string, before: string): number {
  const tail = before.slice(-24);
  for (let n = tail.length; n >= 3; n--) {
    const needle = tail.slice(-n);
    const at = source.indexOf(needle);
    if (at !== -1) return at + needle.length;
  }
  if (before.trim() === "") {
    const firstLine = source.split("\n")[0];
    const lead = /^(\s*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s*)*)/.exec(firstLine);
    return lead ? lead[0].length : 0;
  }
  const nl = source.indexOf("\n");
  return nl === -1 ? source.length : nl;
}

/** `count` less any blank lines ending the range; markdown-it counts the gap
 *  after a list's last item as part of it. Keeps at least one line. */
export function trimBlankTail(text: string, start: number, count: number): number {
  const lines = text.split("\n");
  while (count > 1 && (lines[start + count - 2] ?? "").trim() === "") count--;
  return count;
}

/** The lines between a fenced code block's fences, so clicking code opens just
 *  the code. An unclosed fence runs to `end`; null when there's no fence or
 *  nothing between the fences. */
export function fenceBody(text: string, start: number, end: number): { start: number; end: number } | null {
  const lines = text.split("\n");
  const open = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[start - 1] ?? "");
  if (!open) return null;
  const close = (lines[end - 1] ?? "").trim();
  const closed = end > start && close.startsWith(open[1]) && /^[`~]+$/.test(close);
  const last = closed ? end - 1 : end;
  return last > start ? { start: start + 1, end: last } : null;
}
