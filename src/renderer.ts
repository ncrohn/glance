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

// Stamp 1-based source line numbers onto top-level block-open tokens so the
// annotation layer can map a rendered selection back to a source line. The body
// may have had a frontmatter fence stripped, so add its line count back
// (env.lineOffset) to keep these numbers aligned with the original file.
md.core.ruler.push("source_lines", (state) => {
  const offset = (state.env?.lineOffset as number | undefined) ?? 0;
  for (const token of state.tokens) {
    if (token.level === 0 && token.map && token.type.endsWith("_open")) {
      token.attrSet("data-sourceline", String(token.map[0] + 1 + offset));
      token.attrSet("data-sourceline-end", String(token.map[1] + offset));
    }
  }
});

// Tag a leading metadata paragraph (`**Date:** … **Role:** …`) so it can be
// styled like the frontmatter card. Conservative: only paragraphs before the
// first section heading (h2–h6) whose inline starts with a bold label ending
// in a colon — so ordinary body paragraphs like `**Ask Nicole:** …` that live
// under a section are left alone.
md.core.ruler.push("doc_meta", (state) => {
  for (const token of state.tokens) {
    if (token.type === "heading_open" && /^h[2-6]$/.test(token.tag)) break;
    if (token.type === "paragraph_open") {
      const inline = state.tokens[state.tokens.indexOf(token) + 1];
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

// Mark top-level blocks whose source lines intersect the changed-line set
// (passed in via env). token.map is [start,end) 0-indexed; the block covers
// 1-indexed lines start+1 .. end inclusive.
md.core.ruler.push("changed_lines", (state) => {
  const changed = state.env?.changedLines as Set<number> | undefined;
  if (!changed || changed.size === 0) return;
  const offset = (state.env?.lineOffset as number | undefined) ?? 0;
  for (const token of state.tokens) {
    if (token.level === 0 && token.map && token.type.endsWith("_open")) {
      const start = token.map[0] + 1 + offset;
      const end = token.map[1] + offset;
      for (let ln = start; ln <= end; ln++) {
        if (changed.has(ln)) {
          token.attrSet("data-changed", "true");
          break;
        }
      }
    }
  }
});

export function renderMarkdown(src: string, changedLines?: Set<number>): string {
  const { entries, body, lineOffset } = parseFrontmatter(src);
  const card = entries.length ? frontmatterCard(entries) : "";
  return card + md.render(body, { changedLines, lineOffset });
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
