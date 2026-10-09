// Pure YAML-frontmatter splitter for the common Obsidian/Jekyll preamble:
// a leading `---` fence holding flat `key: value` lines. Values are scalars,
// inline arrays (`[a, b]`) or block lists (`key:` then `- a` lines); nested
// maps and multiline strings are out of scope. Anchor resolution needs the body's source lines
// to stay 1:1 with the original file, so `lineOffset` reports how many lines
// the fence consumed for the renderer to add back.

export type FrontmatterValue = string | string[];
export interface FrontmatterEntry {
  key: string;
  value: FrontmatterValue;
}
export interface ParsedFrontmatter {
  entries: FrontmatterEntry[];
  body: string;
  lineOffset: number;
}

export function parseFrontmatter(src: string): ParsedFrontmatter {
  // A leading UTF-8 BOM would hide the fence. It isn't a line, so dropping it
  // leaves lineOffset unchanged.
  const text = src.startsWith("﻿") ? src.slice(1) : src;
  const none: ParsedFrontmatter = { entries: [], body: text, lineOffset: 0 };

  // Fence must open on the very first line.
  if (!/^---[ \t]*\r?\n/.test(text)) return none;

  const lines = text.split("\n");
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^---[ \t]*\r?$/.test(lines[i]) || lines[i].trimEnd() === "---") {
      close = i;
      break;
    }
  }
  if (close === -1) return none; // unterminated → ordinary content

  const entries: FrontmatterEntry[] = [];
  for (let i = 1; i < close; i++) {
    const entry = parseLine(lines[i]);
    if (entry) {
      entries.push(entry);
      continue;
    }
    // `key:` followed by `- item` lines is a YAML block list.
    const key = /^([^\s:-][^:]*):\s*$/.exec(lines[i])?.[1].trim();
    if (!key) continue;
    const items: string[] = [];
    while (i + 1 < close && /^\s*-(\s|$)/.test(lines[i + 1])) {
      i++;
      const item = unquote(lines[i].replace(/^\s*-/, "").trim());
      if (item !== "") items.push(item);
    }
    if (items.length) entries.push({ key, value: items });
  }

  const lineOffset = close + 1; // fence lines: open (0) .. close inclusive
  const body = lines.slice(close + 1).join("\n");
  return { entries, body, lineOffset };
}

function parseLine(line: string): FrontmatterEntry | null {
  const colon = line.indexOf(":");
  if (colon === -1) return null;
  const key = line.slice(0, colon).trim();
  if (!key) return null;
  const raw = line.slice(colon + 1).trim();
  if (raw === "") return null;

  if (raw.startsWith("[") && raw.endsWith("]")) {
    const items = splitArray(raw.slice(1, -1))
      .map((s) => unquote(s.trim()))
      .filter((s) => s !== "");
    return items.length ? { key, value: items } : null;
  }
  return { key, value: unquote(raw) };
}

// Split a flow-array body on commas, ignoring commas inside quotes so a quoted
// item like "hello, world" stays a single value.
function splitArray(inner: string): string[] {
  const items: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const ch of inner) {
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ",") {
      items.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  items.push(cur);
  return items;
}

function unquote(s: string): string {
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) {
    return s.slice(1, -1);
  }
  return s;
}
