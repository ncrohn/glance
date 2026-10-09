// Images and links in a document are written relative to the document's own
// folder, but the webview resolves them against the app's origin. These helpers
// turn them into absolute filesystem paths and decide where a clicked link goes.

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export function dirname(absPath: string): string {
  const i = absPath.lastIndexOf("/");
  return i <= 0 ? "/" : absPath.slice(0, i);
}

function stripQueryAndHash(ref: string): string {
  return ref.replace(/[?#].*$/, "");
}

function normalize(absPath: string): string {
  const out: string[] = [];
  for (const part of absPath.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
}

function decode(ref: string): string {
  try {
    return decodeURIComponent(ref);
  } catch {
    return ref;
  }
}

/** Resolve a document-relative or `file://` reference to an absolute path, or
 *  null when the reference points somewhere other than the local filesystem. */
export function resolveLocalPath(baseDir: string, ref: string): string | null {
  const trimmed = ref.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  if (/^file:\/\//i.test(trimmed)) {
    return normalize(decode(stripQueryAndHash(trimmed.replace(/^file:\/\/[^/]*/i, ""))));
  }
  if (SCHEME.test(trimmed) || trimmed.startsWith("//")) return null;
  const path = decode(stripQueryAndHash(trimmed));
  if (!path) return null;
  return normalize(path.startsWith("/") ? path : `${baseDir}/${path}`);
}

export type LinkTarget =
  | { kind: "external"; url: string }
  | { kind: "anchor"; id: string }
  | { kind: "markdown"; path: string }
  | { kind: "file"; path: string }
  | { kind: "ignore" };

/** Decide what a click on `href` should do. `baseDir` is the folder of the
 *  document the link sits in, or null when there is no backing file. */
export function classifyLink(href: string, baseDir: string | null): LinkTarget {
  const ref = href.trim();
  if (!ref) return { kind: "ignore" };
  if (ref.startsWith("#")) return { kind: "anchor", id: decode(ref.slice(1)) };
  if (/^(https?|mailto|tel):/i.test(ref)) return { kind: "external", url: ref };
  if (ref.startsWith("//")) return { kind: "external", url: `https:${ref}` };
  if (SCHEME.test(ref) && !/^file:/i.test(ref)) return { kind: "ignore" };
  const path = resolveLocalPath(baseDir ?? "/", ref);
  if (!path || (baseDir === null && !ref.startsWith("/") && !/^file:/i.test(ref))) {
    return { kind: "ignore" };
  }
  return /\.(md|markdown)$/i.test(path) ? { kind: "markdown", path } : { kind: "file", path };
}

// Documents and media whose default macOS app only displays them. Anything
// else — .command, .app, .terminal, a bare executable, .html — can run code
// when handed to `open`, so a click on it asks first.
const VIEW_ONLY = new Set([
  "pdf", "png", "jpg", "jpeg", "gif", "webp", "heic", "tif", "tiff", "bmp",
  "txt", "csv", "tsv", "json", "yaml", "yml", "toml", "xml", "log", "rtf",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "pages", "numbers", "key",
  "mp3", "m4a", "wav", "mp4", "mov", "m4v",
]);

/** True when opening `path` in its default app should be confirmed first. */
export function needsOpenConfirmation(path: string): boolean {
  const name = path.replace(/\/+$/, "").split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return true;
  return !VIEW_ONLY.has(name.slice(dot + 1).toLowerCase());
}

/** GitHub-style heading slug, so `[x](#some-heading)` finds `## Some Heading`. */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

export interface Wikilink {
  raw: string;
  note: string;
  heading: string;
  label: string;
}

/** Parse the inside of `[[…]]`: `note`, `note|label`, `note#Heading`, `#Heading`. */
export function parseWikilink(inner: string): Wikilink | null {
  if (!inner.trim() || inner.includes("\n") || inner.includes("[")) return null;
  const bar = inner.indexOf("|");
  const raw = (bar === -1 ? inner : inner.slice(0, bar)).trim();
  const alias = bar === -1 ? "" : inner.slice(bar + 1).trim();
  const hash = raw.indexOf("#");
  const note = (hash === -1 ? raw : raw.slice(0, hash)).trim();
  const heading = hash === -1 ? "" : raw.slice(hash + 1).trim();
  if (!note && !heading) return null;
  const label = alias || (note ? (heading ? `${note} › ${heading}` : note) : heading);
  return { raw, note, heading, label };
}
