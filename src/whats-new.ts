// "What's new" on the first launch of a new version. Pure helpers; the modal
// lives in modal.ts and the wiring in app.ts.

/** Show when the running version differs from the last one the user saw.
 *  A missing record counts as different, so the first launch after upgrading
 *  from a build that never recorded a version still shows the notes. */
export function shouldShowWhatsNew(lastSeen: string | null, current: string): boolean {
  return current !== "" && lastSeen !== current;
}

/** The body of the `## <version>` section of a changelog: everything after
 *  that heading up to the next `## ` heading, trimmed. Null when absent. */
export function sectionFor(changelog: string, version: string): string | null {
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) => /^##\s+/.test(l) && l.replace(/^##\s+/, "").trim() === version);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }
  const body = lines.slice(start + 1, end).join("\n").trim();
  return body.length ? body : null;
}
