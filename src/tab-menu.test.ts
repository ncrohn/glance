// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { emptyState, openDoc, markRemoved } from "./store";
import { tabMenuEntries, tabsToClose, parentDir, type TabMenuItem } from "./tab-menu";
import linkCases from "./fixtures/markdown-links.json";
import { renderMarkdown } from "./renderer";
import { classifyLink } from "./links";

const three = () => {
  let s = openDoc(emptyState(), "/a.md", "A");
  s = openDoc(s, "/b.md", "B");
  return openDoc(s, "/c.md", "C");
};
const enabled = (s: ReturnType<typeof three>, id: string) =>
  Object.fromEntries(
    tabMenuEntries(s, id).filter((e): e is TabMenuItem => e !== "separator").map((e) => [e.action, e.enabled]),
  );

describe("tabMenuEntries", () => {
  it("is empty for an unknown tab", () => {
    expect(tabMenuEntries(three(), "/nope.md")).toEqual([]);
  });

  it("disables directional close actions at the corresponding end of the tab bar", () => {
    const s = three();
    expect(enabled(s, "/a.md")["close-left"]).toBe(false);
    expect(enabled(s, "/b.md")["close-left"]).toBe(true);
    expect(enabled(s, "/c.md")["close-left"]).toBe(true);
    expect(enabled(s, "/b.md")["close-right"]).toBe(true);
    expect(enabled(s, "/c.md")["close-right"]).toBe(false);
  });

  it("disables Close Other Tabs when it is the only tab", () => {
    const s = openDoc(emptyState(), "/a.md", "A");
    expect(enabled(s, "/a.md")["close-others"]).toBe(false);
    expect(enabled(three(), "/a.md")["close-others"]).toBe(true);
  });

  it("disables Show in Finder for a file deleted on disk", () => {
    const s = markRemoved(three(), "/b.md");
    expect(enabled(s, "/b.md").reveal).toBe(false);
    expect(enabled(s, "/a.md").reveal).toBe(true);
  });
});

describe("tabsToClose", () => {
  it("closes just the one, the others, or those on either side", () => {
    const s = three();
    expect(tabsToClose(s, "/b.md", "close")).toEqual(["/b.md"]);
    expect(tabsToClose(s, "/b.md", "close-others")).toEqual(["/a.md", "/c.md"]);
    expect(tabsToClose(s, "/a.md", "close-left")).toEqual([]);
    expect(tabsToClose(s, "/b.md", "close-left")).toEqual(["/a.md"]);
    expect(tabsToClose(s, "/c.md", "close-left")).toEqual(["/a.md", "/b.md"]);
    expect(tabsToClose(s, "/nope.md", "close-left")).toEqual([]);
    expect(tabsToClose(s, "/a.md", "close-right")).toEqual(["/b.md", "/c.md"]);
    expect(tabsToClose(s, "/c.md", "close-right")).toEqual([]);
    expect(tabsToClose(s, "/nope.md", "close-others")).toEqual([]);
  });
});

describe("parentDir", () => {
  it("drops the file name", () => {
    expect(parentDir("/Users/me/notes/a.md")).toBe("/Users/me/notes");
    expect(parentDir("/a.md")).toBe("/");
  });
});

// Links copy_doc_to_clipboard builds; commands.rs checks it produces exactly
// these. Here: each renders as its literal filename and resolves to its path.
describe("markdown link fixture", () => {
  it.each(linkCases)("links back to the original file: $path", ({ path, link: md }) => {
    const fileName = path.slice(path.lastIndexOf("/") + 1);
    const container = document.createElement("div");
    container.innerHTML = renderMarkdown(md);
    const link = container.querySelector("a");
    expect(link?.textContent).toBe(fileName);
    expect(classifyLink(link?.getAttribute("href") ?? "", "/notes"))
      .toEqual({ kind: "markdown", path });
  });
});
