import { describe, it, expect } from "vitest";
import { diffLinesDetailed } from "./diff";
import { pickChangedTokens, renderMarkdown, stampable } from "./renderer";

describe("stampable", () => {
  const token = (type: string, level: number, map: [number, number] | null = [0, 1]) =>
    ({ type, level, map });

  it("accepts top-level opens and mapped leaf blocks", () => {
    expect(stampable(token("paragraph_open", 0), [])).toBe(true);
    expect(stampable(token("list_item_open", 2), [])).toBe(true);
    expect(stampable(token("tr_open", 2), [])).toBe(true);
    expect(stampable(token("fence", 0), [])).toBe(true);
    expect(stampable(token("code_block", 1), [])).toBe(true);
    expect(stampable(token("hr", 0), [])).toBe(true);
    expect(stampable(token("html_block", 0), [])).toBe(true);
  });

  it("accepts selected nested blocks only inside a blockquote", () => {
    const quote = [{ type: "blockquote_open" }];
    expect(stampable(token("paragraph_open", 1), quote)).toBe(true);
    expect(stampable(token("heading_open", 1), quote)).toBe(true);
    expect(stampable(token("bullet_list_open", 1), quote)).toBe(true);
    expect(stampable(token("ordered_list_open", 1), quote)).toBe(true);
    expect(stampable(token("paragraph_open", 2), [{ type: "list_item_open" }])).toBe(false);
  });

  it("rejects unmapped tokens", () => {
    expect(stampable(token("paragraph_open", 0, null), [])).toBe(false);
  });
});

describe("pickChangedTokens", () => {
  const listTokens = [
    { idx: 0, start: 1, end: 3, level: 0 },
    { idx: 1, start: 1, end: 1, level: 1 },
    { idx: 6, start: 2, end: 2, level: 1 },
    { idx: 11, start: 3, end: 3, level: 1 },
  ];

  it("picks one changed list item instead of its list", () => {
    expect(pickChangedTokens(listTokens, new Set([2]))).toEqual([6]);
  });

  it("picks each changed list item instead of its list", () => {
    expect(pickChangedTokens(listTokens, new Set([1, 3]))).toEqual([1, 11]);
  });

  it("picks a changed top-level heading", () => {
    expect(
      pickChangedTokens(
        [{ idx: 4, start: 2, end: 2, level: 0 }],
        new Set([2]),
      ),
    ).toEqual([4]);
  });

  it("picks a blockquote paragraph instead of the blockquote", () => {
    expect(
      pickChangedTokens(
        [
          { idx: 0, start: 1, end: 3, level: 0 },
          { idx: 1, start: 1, end: 1, level: 1 },
        ],
        new Set([1]),
      ),
    ).toEqual([1]);
  });
});

describe("renderMarkdown", () => {
  it("renders headings", () => {
    const html = renderMarkdown("# Hi");
    expect(html).toContain("Hi</h1>");
    expect(html).toContain('data-sourceline="1"');
    expect(html).toContain('data-sourceline-end="1"');
  });

  it("stamps source line numbers on block elements", () => {
    const html = renderMarkdown("# Title\n\nsecond para on line 3");
    expect(html).toMatch(/<h1[^>]*data-sourceline="1"/);
    expect(html).toMatch(/<p[^>]*data-sourceline="3"/);
  });

  it("renders GFM tables", () => {
    const html = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain("<table");
    expect(html).toContain("<td>1</td>");
  });

  it("stamps source lines on table rows", () => {
    const html = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(html).toMatch(/<tr[^>]*data-sourceline="3"/);
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

  it("stamps source lines on fenced code", () => {
    const html = renderMarkdown("```js\nconst x = 1;\n```");
    expect(html).toMatch(/<(?:pre|code)[^>]*data-sourceline="1"/);
    expect(html).toContain('data-sourceline-end="3"');
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

describe("renderMarkdown frontmatter", () => {
  const src =
    "---\ntype: meeting\npeople: [Nicole K]\n---\n# Title\n\nbody on line 7";

  it("renders a frontmatter card instead of leaking the fence as a heading", () => {
    const html = renderMarkdown(src);
    expect(html).toContain("frontmatter-card");
    expect(html).toContain("meeting");
    // the closing --- must NOT have become a setext heading
    expect(html).not.toMatch(/<h[12][^>]*>type: meeting/);
  });

  it("renders list-valued frontmatter as chips", () => {
    const html = renderMarkdown(src);
    expect(html).toContain("frontmatter-chip");
    expect(html).toContain("Nicole K");
  });

  it("keeps body source lines aligned to the original file", () => {
    // '# Title' is on source line 5; the card must not shift its data-sourceline
    const html = renderMarkdown(src);
    expect(html).toMatch(/<h1[^>]*data-sourceline="5"/);
    expect(html).toMatch(/<p[^>]*data-sourceline="7"/);
  });

  it("still marks changed body lines correctly under a frontmatter offset", () => {
    const html = renderMarkdown(src, new Set([7]));
    expect(/<p[^>]*data-changed[^>]*>body on line 7<\/p>/.test(html)).toBe(true);
  });
});

describe("renderMarkdown leading meta paragraph", () => {
  it("tags a leading **Label:** paragraph before the first H2 as doc-meta", () => {
    const html = renderMarkdown("# T\n\n**Date:** today\n**Role:** dev\n");
    expect(/<p[^>]*class="[^"]*doc-meta/.test(html)).toBe(true);
  });

  it("does not tag an ordinary body paragraph", () => {
    const html = renderMarkdown("# T\n\nJust prose here.\n");
    expect(html).not.toContain("doc-meta");
  });

  it("does not tag a **Label:** paragraph that appears after an H2", () => {
    const html = renderMarkdown("# T\n\n## Section\n\n**Ask Nicole:** later\n");
    expect(html).not.toContain("doc-meta");
  });

  it("does not tag a **Label:** paragraph nested inside a blockquote", () => {
    const html = renderMarkdown("# T\n\n> **Date:** today\n\nbody\n");
    expect(html).not.toContain("doc-meta");
  });

  it("still tags the top-level meta paragraph even when a blockquote above it contains a heading", () => {
    // The nested `## Q` must NOT end the scan; the real top-level meta line follows.
    const html = renderMarkdown("# T\n\n> ## Q\n> quote\n\n**Date:** today\n");
    expect(/<p[^>]*class="[^"]*doc-meta/.test(html)).toBe(true);
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

  it("marks only the changed list item", () => {
    const html = renderMarkdown("- one\n- two\n- three", new Set([2]));
    expect(html).toMatch(/<li[^>]*data-changed[^>]*>two<\/li>/);
    expect(html).not.toMatch(/<ul[^>]*data-changed/);
    expect(html.match(/data-changed/g)).toHaveLength(1);
  });

  it("marks only the changed table row", () => {
    const html = renderMarkdown(
      "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |",
      new Set([4]),
    );
    expect(html).toMatch(/<tr[^>]*data-changed[^>]*>[\s\S]*?<td>3<\/td>/);
    expect(html).not.toMatch(/<table[^>]*data-changed/);
    expect(html.match(/data-changed/g)).toHaveLength(1);
  });

  it("marks a changed paragraph inside a blockquote", () => {
    const html = renderMarkdown("> first\n>\n> second", new Set([3]));
    expect(html).toMatch(/<p[^>]*data-changed[^>]*>second<\/p>/);
    expect(html).not.toMatch(/<blockquote[^>]*data-changed/);
    expect(html.match(/data-changed/g)).toHaveLength(1);
  });
});

describe("renderMarkdown deletion marking", () => {
  it("marks a deletion before the next block without marking it changed", () => {
    const current = "first\n\nthird";
    const diff = diffLinesDetailed("first\n\nsecond\n\nthird", current);
    const html = renderMarkdown(
      current,
      diff.changed,
      diff.deletedBefore,
    );
    expect(html).toMatch(/<p[^>]*data-deleted-before="true"[^>]*>third<\/p>/);
    expect(html).not.toContain("data-changed");
  });

  it("marks a trailing deletion after the last top-level block", () => {
    const html = renderMarkdown(
      "first\n\nsecond",
      new Set(),
      new Set([4]),
    );
    expect(html).toMatch(/<p[^>]*data-deleted-after="true"[^>]*>second<\/p>/);
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

describe("renderMarkdown source line ends", () => {
  it("stamps data-sourceline-end = last source line of each block", () => {
    // "# T"=1, ""=2, "para"=3, "more"=4  → paragraph spans lines 3..4
    const html = renderMarkdown("# T\n\npara\nmore");
    expect(/<h1[^>]*data-sourceline="1"[^>]*data-sourceline-end="1"/.test(html)).toBe(true);
    expect(/<p[^>]*data-sourceline="3"[^>]*data-sourceline-end="4"/.test(html)).toBe(true);
  });
});
