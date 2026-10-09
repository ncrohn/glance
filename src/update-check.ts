// Compare the running version with the latest GitHub release. Pure helpers;
// the fetch and the UI live in app.ts and modal.ts.

export const LATEST_RELEASE_URL = "https://api.github.com/repos/ncrohn/glance/releases/latest";
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface Release { version: string; url: string }

/** `v1.2.3` or `1.2.3` → [1, 2, 3]. Null for anything else, including
 *  pre-release suffixes, so an odd tag never triggers a prompt. */
function parseVersion(v: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? m.slice(1).map(Number) : null;
}

export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/** The fields Glance needs from a `releases/latest` response. Null when the
 *  body is not a published release with a usable tag. */
export function parseRelease(body: unknown): Release | null {
  if (!body || typeof body !== "object") return null;
  const r = body as Record<string, unknown>;
  if (r.draft === true || r.prerelease === true) return null;
  if (typeof r.tag_name !== "string" || !parseVersion(r.tag_name)) return null;
  if (typeof r.html_url !== "string" || !r.html_url.startsWith("https://github.com/")) return null;
  return { version: r.tag_name.replace(/^v/, ""), url: r.html_url };
}

/** The launch check runs at most once per interval. A missing or unreadable
 *  timestamp counts as due. */
export function isCheckDue(lastChecked: string | null, now: number): boolean {
  const last = Number(lastChecked);
  if (!lastChecked || !Number.isFinite(last)) return true;
  return now - last >= CHECK_INTERVAL_MS || now < last;
}
