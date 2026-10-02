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
