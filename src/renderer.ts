import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import hljs from "highlight.js";

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
// annotation layer can map a rendered selection back to a source line.
md.core.ruler.push("source_lines", (state) => {
  for (const token of state.tokens) {
    if (token.level === 0 && token.map && token.type.endsWith("_open")) {
      token.attrSet("data-sourceline", String(token.map[0] + 1));
    }
  }
});

// Mark top-level blocks whose source lines intersect the changed-line set
// (passed in via env). token.map is [start,end) 0-indexed; the block covers
// 1-indexed lines start+1 .. end inclusive.
md.core.ruler.push("changed_lines", (state) => {
  const changed = state.env?.changedLines as Set<number> | undefined;
  if (!changed || changed.size === 0) return;
  for (const token of state.tokens) {
    if (token.level === 0 && token.map && token.type.endsWith("_open")) {
      const start = token.map[0] + 1;
      const end = token.map[1];
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
  return md.render(src, { changedLines });
}
