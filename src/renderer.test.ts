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

describe("renderMarkdown changed-line marking — multi-line block boundary", () => {
  // Two paragraphs; the first spans two source lines (1-2), the second is a
  // single line (4). This pins the boundary the review plan flagged risky:
  // a multi-line block must be marked when EITHER its first or its last
  // source line is in the changed set, not just an interior line.
  const src = "alpha\nbeta\n\ngamma";
  // lines: 1='alpha', 2='beta' (both part of paragraph 1), 3='', 4='gamma' (paragraph 2)

  it("marks the multi-line block when only its FIRST source line changed", () => {
    const html = renderMarkdown(src, new Set([1]));
    expect(/<p[^>]*data-changed[^>]*>alpha\nbeta<\/p>/.test(html)).toBe(true);
    expect(/<p[^>]*data-changed[^>]*>gamma<\/p>/.test(html)).toBe(false);
  });

  it("marks the multi-line block when only its LAST source line changed", () => {
    const html = renderMarkdown(src, new Set([2]));
    expect(/<p[^>]*data-changed[^>]*>alpha\nbeta<\/p>/.test(html)).toBe(true);
    expect(/<p[^>]*data-changed[^>]*>gamma<\/p>/.test(html)).toBe(false);
  });

  it("control: a change on the other paragraph's line marks only that block", () => {
    const html = renderMarkdown(src, new Set([4]));
    expect(/<p[^>]*data-changed[^>]*>gamma<\/p>/.test(html)).toBe(true);
    expect(/<p[^>]*data-changed[^>]*>alpha\nbeta<\/p>/.test(html)).toBe(false);
  });
});
