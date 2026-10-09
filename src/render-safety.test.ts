// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./renderer";

// The audit's XSS battery, checked against the parsed DOM rather than by regex
// so escaped text like `javascript:` in a paragraph doesn't count as a hit.
const payloads: [string, string][] = [
  ["raw html", "<img src=x onerror=alert(1)>"],
  ["raw svg", "<svg onload=alert(1)>"],
  ["script", "<script>alert(1)</script>"],
  ["js link", "[x](javascript:alert(1))"],
  ["js link entity", "[x](jav&#x61;script:alert(1))"],
  ["vbscript", "[x](vbscript:msgbox)"],
  ["data html link", "[x](data:text/html,<script>alert(1)</script>)"],
  ["autolink js", "<javascript:alert(1)>"],
  ["ref link", "[x][r]\n\n[r]: javascript:alert(1)"],
  ["file link quoting", "[x](file:javascript:alert(1)) <file:///x\"onmouseover=\"alert(1)>"],
  ["image onerror attr", '![x" onerror="alert(1)](x)'],
  ["image title", '![a](x "t\\" onerror=alert(1) x=\\"")'],
  ["frontmatter html", "---\ntitle: <img src=x onerror=alert(1)>\ntags: [<b>a</b>, \"<svg onload=alert(1)>\"]\nlist:\n  - <img src=x onerror=alert(1)>\n---\nbody"],
  ["bom frontmatter html", "﻿---\ntitle: <img src=x onerror=alert(1)>\n---\nbody"],
  ["wikilink label", "[[note|<img src=x onerror=alert(1)>]]"],
  ["wikilink raw", '[[a" onmouseover="alert(1)]]'],
  ["wikilink in link", '[a [[b" onmouseover="alert(1)]] c](https://x.example)'],
  ["comment", "<!-- --><img src=x onerror=alert(1)> -->"],
  ["comment block", "<!--\n<img src=x onerror=alert(1)>\n-->"],
  ["comment in list", "- <!-- a\n- <img src=x onerror=alert(1)> -->"],
  ["fence lang hljs-unknown", "```x\"><img/src=x/onerror=alert(1)>\ncode\n```"],
  ["fence lang known", "```js\"><img/src=x/onerror=alert(1)>\ncode\n```"],
  ["fence mermaid", "```mermaid\n<img src=x onerror=alert(1)>\n```"],
  ["fence tilde lang", "~~~a\"onmouseover=\"alert(1)\ncode\n~~~"],
  ["task list", "- [ ] <img src=x onerror=alert(1)>"],
  ["table", "| a |\n|---|\n| <img src=x onerror=alert(1)> |"],
  ["linkify", "www.x.example/\"onmouseover=\"alert(1) https://x.example/<img>"],
];

function dangers(html: string): string[] {
  const root = document.createElement("div");
  root.innerHTML = html;
  const found: string[] = [];
  for (const el of Array.from(root.querySelectorAll("*"))) {
    const tag = el.tagName.toLowerCase();
    if (["script", "iframe", "object", "embed", "style", "math", "svg"].includes(tag)) found.push(`<${tag}>`);
    if (tag === "img" && el.getAttribute("src") === "x" && !el.hasAttribute("alt")) found.push("raw <img>");
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name)) found.push(`${tag}[${attr.name}]`);
      if (/^(href|src)$/i.test(attr.name) && /^\s*(javascript|vbscript|data:(?!image\/))/i.test(attr.value)) {
        found.push(`${tag}[${attr.name}=${attr.value}]`);
      }
    }
  }
  return found;
}

describe("renderMarkdown output safety", () => {
  for (const [label, md] of payloads) {
    it(label, () => {
      expect(dangers(renderMarkdown(md))).toEqual([]);
    });
  }
});
