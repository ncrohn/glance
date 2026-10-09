import { describe, expect, it } from "vitest";
import { classifyLink, dirname, parseWikilink, resolveLocalPath, slugify } from "./links";
import { renderMarkdown } from "./renderer";

const base = "/Users/nick/notes";

describe("resolveLocalPath", () => {
  it("resolves relative paths against the document folder", () => {
    expect(resolveLocalPath(base, "img/a.png")).toBe("/Users/nick/notes/img/a.png");
    expect(resolveLocalPath(base, "./a.png")).toBe("/Users/nick/notes/a.png");
    expect(resolveLocalPath(base, "../shots/a%20b.png")).toBe("/Users/nick/shots/a b.png");
  });

  it("keeps absolute and file:// paths", () => {
    expect(resolveLocalPath(base, "/tmp/a.png")).toBe("/tmp/a.png");
    expect(resolveLocalPath(base, "file:///tmp/a%20b.png")).toBe("/tmp/a b.png");
  });

  it("drops query and fragment", () => {
    expect(resolveLocalPath(base, "a.png?v=2#x")).toBe("/Users/nick/notes/a.png");
  });

  it("ignores remote and data URLs", () => {
    expect(resolveLocalPath(base, "https://x.com/a.png")).toBeNull();
    expect(resolveLocalPath(base, "//x.com/a.png")).toBeNull();
    expect(resolveLocalPath(base, "data:image/png;base64,AA")).toBeNull();
  });
});

describe("classifyLink", () => {
  it("sends web links to the browser", () => {
    expect(classifyLink("https://example.com", base)).toEqual({ kind: "external", url: "https://example.com" });
    expect(classifyLink("mailto:a@b.c", base)).toEqual({ kind: "external", url: "mailto:a@b.c" });
  });

  it("opens markdown links as tabs and other files externally", () => {
    expect(classifyLink("../plan.md#step", base)).toEqual({ kind: "markdown", path: "/Users/nick/plan.md" });
    expect(classifyLink("spec.pdf", base)).toEqual({ kind: "file", path: "/Users/nick/notes/spec.pdf" });
  });

  it("treats fragments as in-page anchors", () => {
    expect(classifyLink("#Some%20Heading", base)).toEqual({ kind: "anchor", id: "Some Heading" });
  });

  it("ignores relative links without a document folder and unknown schemes", () => {
    expect(classifyLink("spec.pdf", null)).toEqual({ kind: "ignore" });
    expect(classifyLink("javascript:alert(1)", base)).toEqual({ kind: "ignore" });
  });
});

describe("slugify", () => {
  it("matches GitHub heading anchors", () => {
    expect(slugify("Step 2: Ship it!")).toBe("step-2-ship-it");
  });
});

describe("dirname", () => {
  it("returns the parent folder", () => {
    expect(dirname("/a/b/c.md")).toBe("/a/b");
    expect(dirname("/c.md")).toBe("/");
  });
});

describe("renderMarkdown image rewriting", () => {
  it("passes local image src through the resolver and leaves remote ones", () => {
    const html = renderMarkdown("![a](img/a.png) ![b](https://x.com/b.png)", undefined, undefined, (src) =>
      src.startsWith("http") ? null : `asset://${src}`,
    );
    expect(html).toContain('src="asset://img/a.png"');
    expect(html).toContain('src="https://x.com/b.png"');
  });
});

describe("parseWikilink", () => {
  it("reads note, heading and label", () => {
    expect(parseWikilink("decisions")).toEqual({ raw: "decisions", note: "decisions", heading: "", label: "decisions" });
    expect(parseWikilink("../onboarding-drip/index|onboarding-drip")).toMatchObject({
      note: "../onboarding-drip/index", label: "onboarding-drip",
    });
    expect(parseWikilink("plan#Step 2")).toMatchObject({ note: "plan", heading: "Step 2", label: "plan › Step 2" });
    expect(parseWikilink("#Step 2")).toMatchObject({ note: "", heading: "Step 2", label: "Step 2" });
  });

  it("rejects empty or nested brackets", () => {
    expect(parseWikilink("")).toBeNull();
    expect(parseWikilink("a[b")).toBeNull();
  });
});

describe("renderMarkdown linkify", () => {
  it("leaves bare filenames as text", () => {
    const html = renderMarkdown("See AGENTS.md and src/lib.rs, run setup.sh, open Calculator.app");
    expect(html).not.toContain("<a");
    expect(html).not.toContain("http://");
  });

  it("still links URLs with a scheme and www. hosts", () => {
    const html = renderMarkdown("Go to https://example.com/a?b=1 or www.example.com/docs.");
    expect(html).toContain('<a href="https://example.com/a?b=1">https://example.com/a?b=1</a>');
    expect(html).toContain('<a href="http://www.example.com/docs">www.example.com/docs</a>.');
  });

  it("doesn't link www. in the middle of a word", () => {
    expect(renderMarkdown("notwww.example.com")).not.toContain("<a");
  });
});

describe("renderMarkdown file: links", () => {
  it("renders file:// links and autolinks so clicks reach classifyLink", () => {
    const html = renderMarkdown("[f](file:///Users/me/a.md) <file:///Users/me/b%20c.pdf>");
    expect(html).toContain('<a href="file:///Users/me/a.md">f</a>');
    expect(html).toContain('<a href="file:///Users/me/b%20c.pdf">');
    expect(classifyLink("file:///Users/me/a.md", base)).toEqual({ kind: "markdown", path: "/Users/me/a.md" });
    expect(classifyLink("file:///Users/me/b%20c.pdf", null)).toEqual({ kind: "file", path: "/Users/me/b c.pdf" });
  });

  it("maps file:// images through the resolver and drops them without one", () => {
    const resolve = (src: string) => {
      const path = resolveLocalPath(base, src);
      return path ? `asset://localhost${path}` : null;
    };
    const md = "![i](file:///Users/me/a.png)";
    expect(renderMarkdown(md, undefined, undefined, resolve)).toContain('src="asset://localhost/Users/me/a.png"');
    expect(renderMarkdown(md)).toContain('<img src="" alt="i">');
  });

  it("keeps script and non-image data URLs out of links", () => {
    for (const md of [
      "[x](javascript:alert(1))",
      "[x](jav&#x61;script:alert(1))",
      "[x](vbscript:msgbox)",
      "[x](data:text/html,hi)",
      "<javascript:alert(1)>",
      "[x][r]\n\n[r]: javascript:alert(1)",
    ]) {
      expect(renderMarkdown(md), md).not.toContain("<a");
    }
    expect(renderMarkdown("![x](data:image/png;base64,AA)")).toContain('src="data:image/png;base64,AA"');
  });
});

describe("renderMarkdown wikilinks inside links", () => {
  it("keeps the outer link and shows the wikilink as text", () => {
    expect(renderMarkdown("[see [[note]] here](https://x.example)")).toContain(
      '<a href="https://x.example">see [[note]] here</a>',
    );
  });

  it("still renders a wikilink next to an ordinary link", () => {
    const html = renderMarkdown("[a](https://x.example) [[note]] [b [c]](y.md)");
    expect(html).toContain('<a href="https://x.example">a</a>');
    expect(html).toContain('<a class="wikilink" data-wikilink="note">note</a>');
    expect(html).toContain('<a href="y.md">b [c]</a>');
  });
});

describe("renderMarkdown HTML comments in containers", () => {
  it("ends an unclosed comment with its list item", () => {
    const html = renderMarkdown("- <!-- start\n- second item -->\n- third");
    expect(html).not.toContain("start");
    expect(html).toContain("second item --&gt;</li>");
    expect(html).toContain("third</li>");
    expect(html.match(/<li/g)).toHaveLength(3);
  });

  it("hides a comment that closes inside its list item, across a blank line", () => {
    const html = renderMarkdown("- a <!-- x -->\n- <!-- hidden\n\n  still hidden -->\n- b");
    expect(html).not.toContain("hidden");
    expect(html).toContain('<li data-sourceline="5" data-sourceline-end="5">b</li>');
  });

  it("ends an unclosed comment with its blockquote", () => {
    const html = renderMarkdown("> - <!-- a\n> - b\n\nafter");
    expect(html).not.toContain("&lt;!--");
    expect(html).toContain("b</li>");
    expect(html).toContain("after");
  });

  it("shows an unclosed top-level comment instead of hiding the rest", () => {
    const html = renderMarkdown("<!-- oops\n\nBody");
    expect(html).toContain("&lt;!-- oops");
    expect(html).toContain("Body");
  });
});

describe("renderMarkdown wikilinks and comments", () => {
  it("renders [[links]] with their target", () => {
    const html = renderMarkdown("See [[decisions]] and [[../x/index|X]].");
    expect(html).toContain('<a class="wikilink" data-wikilink="decisions">decisions</a>');
    expect(html).toContain('<a class="wikilink" data-wikilink="../x/index">X</a>');
  });

  it("leaves [[ ]] inside code alone", () => {
    expect(renderMarkdown("`[[decisions]]`")).toContain("<code>[[decisions]]</code>");
  });

  it("hides block and inline HTML comments", () => {
    const html = renderMarkdown("# Title\n\n<!-- shape: slug=x\nstage=scaffold -->\n\nBody <!-- note --> text\n");
    expect(html).not.toContain("shape:");
    expect(html).not.toContain("note");
    expect(html).toContain("Body  text");
  });

  it("keeps comments inside code visible", () => {
    expect(renderMarkdown("`<!-- x -->`")).toContain("&lt;!-- x --&gt;");
    expect(renderMarkdown("```html\n<!-- x -->\n```")).toContain("&lt;!-- x --&gt;");
  });

  it("keeps source line stamps after a hidden comment", () => {
    expect(renderMarkdown("<!-- c -->\n\nPara\n")).toContain('data-sourceline="3"');
  });
});