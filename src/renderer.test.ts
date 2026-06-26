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
});
