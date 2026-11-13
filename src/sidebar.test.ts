import { describe, it, expect } from "vitest";
import { emptyState, openDoc } from "./store";
import { folderMarks, groupByFolder, parseSidebarPref, tildePath } from "./sidebar";

const docsFor = (...paths: string[]) => paths.reduce((s, p) => openDoc(s, p, ""), emptyState()).docs;

describe("groupByFolder", () => {
  it("groups docs by their folder, in first-tab order", () => {
    const groups = groupByFolder(docsFor(
      "/Users/nick/dev/glance/README.md",
      "/Users/nick/notes/today.md",
      "/Users/nick/dev/glance/CHANGELOG.md",
    ));
    expect(groups.map((g) => g.dir)).toEqual(["/Users/nick/dev/glance", "/Users/nick/notes"]);
    expect(groups[0].docs.map((d) => d.fileName)).toEqual(["README.md", "CHANGELOG.md"]);
  });

  it("names a group by its folder and shows the folder above it", () => {
    const [g] = groupByFolder(docsFor("/Users/nick/dev/glance/docs/plan.md"));
    expect(g.name).toBe("docs");
    expect(g.parent).toBe("~/dev/glance");
  });

  it("keeps same-named folders in different places apart", () => {
    const groups = groupByFolder(docsFor("/Users/nick/a/docs/x.md", "/Users/nick/b/docs/x.md"));
    expect(groups.map((g) => [g.name, g.parent])).toEqual([["docs", "~/a"], ["docs", "~/b"]]);
  });

  it("handles a file at the root", () => {
    const [g] = groupByFolder(docsFor("/x.md"));
    expect(g).toMatchObject({ dir: "/", name: "/", parent: "" });
  });

  it("is empty with no docs", () => {
    expect(groupByFolder([])).toEqual([]);
  });
});

describe("folderMarks", () => {
  it("rolls up its docs' dirty, changed and Claude state", () => {
    const [clean, edited, changed] = docsFor("/f/a.md", "/f/b.md", "/f/c.md");
    expect(folderMarks([clean])).toEqual({ dirty: false, changed: false, claude: null });
    const dirty = { ...edited, editorContent: "typed" };
    const onDisk = { ...changed, diskContent: "new", editorContent: "new" };
    const replied = { ...clean, claudeActivity: ["n1"] };
    expect(folderMarks([clean, dirty, onDisk, replied])).toEqual({ dirty: true, changed: true, claude: replied });
  });
});

describe("tildePath", () => {
  it("collapses the home folder only at a path boundary", () => {
    expect(tildePath("/Users/nick/dev")).toBe("~/dev");
    expect(tildePath("/Users/nick")).toBe("~");
    expect(tildePath("/Users")).toBe("/Users");
    expect(tildePath("/opt/x")).toBe("/opt/x");
  });
});

describe("parseSidebarPref", () => {
  it("is off (tabs) unless picked", () => {
    expect(parseSidebarPref(null)).toBe(false);
    expect(parseSidebarPref("hidden")).toBe(false);
    expect(parseSidebarPref("shown")).toBe(true);
  });
});
