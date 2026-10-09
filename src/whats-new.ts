// "What's new" on the first launch of a new version. Pure helpers; the modal
// lives in modal.ts and the wiring in app.ts.

/** Show when the running version differs from the last one the user saw.
 *  A missing record counts as different, so the first launch after upgrading
 *  from a build that never recorded a version still shows the notes. */
export function shouldShowWhatsNew(lastSeen: string | null, current: string): boolean {
  return current !== "" && lastSeen !== current;
}

/** The version a `## ` heading names: `1.0`, `[1.0]`, or either followed by
 *  ` - date` as in Keep a Changelog. */
function headingVersion(heading: string): string {
  const text = heading.trim();
  const bracketed = /^\[([^\]]+)\]/.exec(text);
  if (bracketed) return bracketed[1].trim();
  return text.replace(/\s+[-–—]\s+.*$/, "");
}

/** Indexes of `## ` heading lines, skipping any inside fenced code. */
function h2Lines(lines: string[]): number[] {
  const found: number[] = [];
  let fence: string | null = null;
  lines.forEach((line, i) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
    } else if (marker) {
      fence = marker;
    } else if (/^##\s+/.test(line)) {
      found.push(i);
    }
  });
  return found;
}

/** The body of the `## <version>` section of a changelog: everything after
 *  that heading up to the next `## ` heading, trimmed. Null when absent. */
export function sectionFor(changelog: string, version: string): string | null {
  const lines = changelog.split("\n");
  const headings = h2Lines(lines);
  const at = headings.findIndex((i) => headingVersion(lines[i].replace(/^##\s+/, "")) === version);
  if (at === -1) return null;
  const end = headings[at + 1] ?? lines.length;
  const body = lines.slice(headings[at] + 1, end).join("\n").trim();
  return body.length ? body : null;
}
