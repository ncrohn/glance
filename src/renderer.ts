import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import hljs from "highlight.js";
import { parseFrontmatter, type FrontmatterEntry } from "./frontmatter";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
  highlight(code, lang): string {
    // Mermaid fences become placeholders holding the escaped source; the
    // mermaid module swaps them for rendered SVG once the DOM is mounted.
    if (lang === "mermaid") {
      return `<pre class="mermaid-block">${md.utils.escapeHtml(code)}</pre>`;
    }
    const language = lang && hljs.getLanguage(lang) ? lang : "";
    const cls = `hljs language-${lang || "plaintext"}`;
    if (language) {
      try {
        const out = hljs.highlight(code, { language }).value;
        return `<pre><code class="${cls}">${out}</code></pre>`;
      } catch {
        /* fall through to escaped */
      }
    }
    const escaped = md.utils.escapeHtml(code);
    return `<pre><code class="${cls}">${escaped}</code></pre>`;
  },
});

md.use(taskLists);

// Wrap every table in a horizontally-scrollable container so wide tables scroll
// instead of crushing their columns into the fixed reading width. renderToken
// preserves the table_open token's attrs (e.g. the data-sourceline stamp below).
md.renderer.rules.table_open = (tokens, idx, options, _env, self) =>
  `<div class="table-scroll">${self.renderToken(tokens, idx, options)}`;
md.renderer.rules.table_close = (tokens, idx, options, _env, self) =>
  `${self.renderToken(tokens, idx, options)}</div>`;

const defaultFence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const rendered = defaultFence(tokens, idx, options, env, self);
  const attrs = self.renderAttrs(tokens[idx]);
  if (!attrs) return rendered;
  if (tokens[idx].info.trim().split(/\s+/, 1)[0] === "mermaid") {
    return `<div${attrs}>${rendered}</div>`;
  }
  return rendered.replace(/^(<pre\b[^>]*)(>)/, `$1${attrs}$2`);
};

export interface SourceToken {
  type: string;
  level: number;
  map: [number, number] | null;
}

interface ParentToken {
  type: string;
}

const mappedLeafTypes = new Set([
  "list_item_open",
  "tr_open",
  "fence",
  "code_block",
  "hr",
  "html_block",
]);
const blockquoteChildTypes = new Set([
  "paragraph_open",
  "heading_open",
  "bullet_list_open",
  "ordered_list_open",
  "fence",
]);

export function stampable(
  token: SourceToken,
  parents: readonly ParentToken[],
): boolean {
  if (!token.map) return false;
  if (token.level === 0 && token.type.endsWith("_open")) return true;
  if (mappedLeafTypes.has(token.type)) return true;
  return (
    blockquoteChildTypes.has(token.type) &&
    parents.some((parent) => parent.type === "blockquote_open")
  );
}

export interface ChangedToken {
  idx: number;
  start: number;
  end: number;
  level: number;
}

function intersects(token: ChangedToken, changed: Set<number>): boolean {
  for (let line = token.start; line <= token.end; line++) {
    if (changed.has(line)) return true;
  }
  return false;
}

function isDescendant(child: ChangedToken, parent: ChangedToken): boolean {
  return (
    child.idx > parent.idx &&
    child.level > parent.level &&
    child.start >= parent.start &&
    child.end <= parent.end
  );
}

export function pickChangedTokens(
  tokens: ChangedToken[],
  changed: Set<number>,
): number[] {
  const intersecting = tokens.filter((token) => intersects(token, changed));
  return intersecting
    .filter(
      (token) =>
        !intersecting.some((candidate) => isDescendant(candidate, token)),
    )
    .map((token) => token.idx);
}

// Stamp 1-based source line numbers onto top-level block-open tokens so the
// annotation layer can map a rendered selection back to a source line. The body
// may have had a frontmatter fence stripped, so add its line count back
// (env.lineOffset) to keep these numbers aligned with the original file.
md.core.ruler.push("source_lines", (state) => {
  const offset = (state.env?.lineOffset as number | undefined) ?? 0;
  const parents: ParentToken[] = [];
  for (const token of state.tokens) {
    if (token.nesting === -1) parents.pop();
    if (stampable(token, parents)) {
      const [start, end] = token.map!;
      token.attrSet("data-sourceline", String(start + 1 + offset));
      token.attrSet("data-sourceline-end", String(end + offset));
    }
    if (token.nesting === 1) parents.push(token);
  }
});

// Tag a leading metadata paragraph (`**Date:** … **Role:** …`) so it can be
// styled like the frontmatter card. Conservative: only paragraphs before the
// first section heading (h2–h6) whose inline starts with a bold label ending
// in a colon — so ordinary body paragraphs like `**Ask Nicole:** …` that live
// under a section are left alone.
md.core.ruler.push("doc_meta", (state) => {
  for (let i = 0; i < state.tokens.length; i++) {
    const token = state.tokens[i];
    // Only consider top-level blocks (level 0), like source_lines/changed_lines
    // do — so headings and paragraphs nested in blockquotes or list items
    // neither end the scan early nor get mistakenly tagged.
    if (token.level !== 0) continue;
    if (token.type === "heading_open" && /^h[2-6]$/.test(token.tag)) break;
    if (token.type === "paragraph_open") {
      const inline = state.tokens[i + 1];
      if (inline?.type === "inline" && startsWithBoldLabel(inline.children)) {
        token.attrJoin("class", "doc-meta");
      }
    }
  }
});

function startsWithBoldLabel(
  children: ReturnType<MarkdownIt["parseInline"]>[number]["children"],
): boolean {
  if (!children) return false;
  // markdown-it may emit a leading empty text token before the strong run.
  const toks = children.filter(
    (c) => !(c.type === "text" && c.content === ""),
  );
  return (
    toks.length >= 2 &&
    toks[0].type === "strong_open" &&
    toks[1].type === "text" &&
    toks[1].content.trimEnd().endsWith(":")
  );
}

md.core.ruler.push("changed_lines", (state) => {
  const offset = (state.env?.lineOffset as number | undefined) ?? 0;
  const stamped: ChangedToken[] = [];
  for (let idx = 0; idx < state.tokens.length; idx++) {
    const token = state.tokens[idx];
    if (!token.map || token.attrGet("data-sourceline") === null) continue;
    stamped.push({
      idx,
      start: token.map[0] + 1 + offset,
      end: token.map[1] + offset,
      level: token.level,
    });
  }

  const changed = state.env?.changedLines as Set<number> | undefined;
  if (changed?.size) {
    for (const idx of pickChangedTokens(stamped, changed)) {
      state.tokens[idx].attrSet("data-changed", "true");
    }
  }

  const deletedBefore = state.env?.deletedBefore as Set<number> | undefined;
  if (!deletedBefore?.size) return;
  const startingAfterDeletion = stamped.filter((token) =>
    deletedBefore.has(token.start),
  );
  for (const token of startingAfterDeletion) {
    if (
      !startingAfterDeletion.some((candidate) => isDescendant(candidate, token))
    ) {
      state.tokens[token.idx].attrSet("data-deleted-before", "true");
    }
  }

  const sourceLineCount = state.env?.sourceLineCount as number | undefined;
  if (sourceLineCount !== undefined && deletedBefore.has(sourceLineCount + 1)) {
    for (let i = stamped.length - 1; i >= 0; i--) {
      if (stamped[i].level === 0) {
        state.tokens[stamped[i].idx].attrSet("data-deleted-after", "true");
        break;
      }
    }
  }
});

export function renderMarkdown(
  src: string,
  changedLines?: Set<number>,
  deletedBefore?: Set<number>,
): string {
  const { entries, body, lineOffset } = parseFrontmatter(src);
  const card = entries.length ? frontmatterCard(entries) : "";
  const sourceLineCount = src.length
    ? src.replace(/\n$/, "").split("\n").length
    : 0;
  return (
    card +
    md.render(body, { changedLines, deletedBefore, lineOffset, sourceLineCount })
  );
}

// Render parsed frontmatter as a compact key→value card. Labels are muted,
// scalar values plain, and list values (people/tags/…) become chips.
function frontmatterCard(entries: FrontmatterEntry[]): string {
  const esc = md.utils.escapeHtml;
  const rows = entries
    .map((e) => {
      const value = Array.isArray(e.value)
        ? `<span class="frontmatter-chips">${e.value
            .map((v) => `<span class="frontmatter-chip">${esc(v)}</span>`)
            .join("")}</span>`
        : `<span class="frontmatter-value">${esc(e.value)}</span>`;
      return `<div class="frontmatter-row"><span class="frontmatter-key">${esc(
        e.key,
      )}</span>${value}</div>`;
    })
    .join("");
  return `<div class="frontmatter-card" aria-label="Document metadata">${rows}</div>`;
}
