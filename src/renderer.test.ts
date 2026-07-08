import { describe, it, expect } from "vitest";
import { renderMarkdown } from "./renderer";

describe("renderMarkdown", () => {
  it("renders headings", () => {
    const html = renderMarkdown("# Hi");
    expect(html).toContain("Hi</h1>");
    expect(html).toContain('data-sourceline="1"');
  });

  it("stamps source line numbers on block elements", () => {
    const html = renderMarkdown("# Title\n\nsecond para on line 3");
    expect(html).toMatch(/<h1 data-sourceline="1">/);
    expect(html).toMatch(/<p data-sourceline="3">/);
  });

  it("renders GFM tables", () => {
    const html = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain("<table");
    expect(html).toContain("<td>1</td>");
  });

  it("renders task lists as checkboxes", () => {
    const html = renderMarkdown("- [x] done\n- [ ] todo");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("checked");
  });

  it("renders strikethrough", () => {
    expect(renderMarkdown("~~gone~~")).toContain("<s>gone</s>");
  });

  it("highlights fenced code with a language class", () => {
    const html = renderMarkdown("```js\nconst x = 1;\n```");
    expect(html).toContain("hljs");
    expect(html).toContain("language-js");
  });

  it("emits a mermaid placeholder for mermaid fences", () => {
    const html = renderMarkdown("```mermaid\ngraph TD;\n  A-->B;\n```");
    expect(html).toContain('<pre class="mermaid-block">');
    expect(html).toContain("A--&gt;B;");
    expect(html).not.toContain("hljs");
  });

  it("escapes html inside mermaid fences", () => {
    const html = renderMarkdown('```mermaid\ngraph TD;\n  A["<script>"]\n```');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("renderMarkdown changed-line marking", () => {
  const src = "# Title\n\nfirst para\n\nsecond para";
  // lines: 1='# Title', 2='', 3='first para', 4='', 5='second para'

  it("adds no data-changed when the set is empty or absent", () => {
    expect(renderMarkdown(src)).not.toContain("data-changed");
    expect(renderMarkdown(src, new Set())).not.toContain("data-changed");
  });

  it("marks only the block containing a changed line", () => {
    const html = renderMarkdown(src, new Set([5]));
    expect(html).toContain("data-changed");
    // the marked block is the second paragraph
    const secondMarked = /<p[^>]*data-changed[^>]*>second para<\/p>/.test(html);
    expect(secondMarked).toBe(true);
    // the first paragraph is not marked
    const firstMarked = /<p[^>]*data-changed[^>]*>first para<\/p>/.test(html);
    expect(firstMarked).toBe(false);
  });

  it("marks the heading when its source line changed", () => {
    const html = renderMarkdown(src, new Set([1]));
    expect(/<h1[^>]*data-changed[^>]*>/.test(html)).toBe(true);
  });
});
