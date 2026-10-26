// @vitest-environment jsdom
// Every way a document is opened, saved, watched or reloaded, driven through
// the real app.ts start() against a fake backend that enforces the rules the
// Rust side does (commands.rs OpenDocs, watcher.rs, annotations.rs is_store_of):
//   - read_file refuses a non-text extension (and a symlink to one, or a
//     dangling symlink);
//   - write_file and watch_file need a prior successful read_file of a path
//     with the same doc key, and a text extension;
//   - watch_annotations needs its doc open and the exact store path
//     ensure_annotation_store returned for that doc (under any spelling).
// A refused call throws, as the IPC promise would reject, and is recorded.
// app.ts swallows a failed watch, so the record is what catches it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Handler = (payload: any) => any;
interface Violation { cmd: string; args: string[]; rule: string }

const env = {
  files: new Map<string, string>(),
  // Directory symlinks / filesystem aliases (`/tmp` → `/private/tmp`, a case
  // variant of a folder), and file symlinks.
  dirLinks: new Map<string, string>(),
  fileLinks: new Map<string, string>(),
  canonicalizeFails: false,
  handlers: new Map<string, Handler>(),
  launch: [] as string[],
  wikilinks: new Map<string, string>(),
  open: new Set<string>(),
  stores: new Set<string>(),
  watched: [] as string[],
  writes: [] as Array<[string, string]>,
  violations: [] as Violation[],
  quit: 0,
};

const TEXT = ["md", "markdown", "mdown", "mkd", "mkdn", "mdx", "txt"];
const hasTextExt = (p: string) => {
  const m = /\.([^./]+)$/.exec(p);
  return !!m && TEXT.includes(m[1].toLowerCase());
};

function normalize(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
}

function followDirs(p: string): string {
  for (let i = 0; i < 10; i++) {
    const hit = [...env.dirLinks.keys()]
      .filter((d) => p === d || p.startsWith(d + "/"))
      .sort((a, b) => b.length - a.length)[0];
    if (!hit) return p;
    p = env.dirLinks.get(hit)! + p.slice(hit.length);
  }
  return p;
}

// Where a path really points (fs::canonicalize, when it succeeds).
function resolve(p: string): string {
  let cur = followDirs(normalize(p));
  for (let i = 0; i < 10 && env.fileLinks.has(cur); i++) cur = followDirs(normalize(env.fileLinks.get(cur)!));
  return cur;
}
const isLink = (p: string) => env.fileLinks.has(followDirs(normalize(p)));
const exists = (p: string) => env.files.has(resolve(p));

// annotations.rs doc_key: canonical when the file exists, otherwise lexical
// with the deepest existing ancestor canonicalized.
const docKey = (p: string) => (exists(p) ? resolve(p) : followDirs(normalize(p)));
// cli::canonical (canonicalize_path): canonical when it exists, else lexical only.
const cliCanonical = (p: string) => (exists(p) ? resolve(p) : normalize(p));
const storeOf = (p: string) => `/home/.glance/annotations/${docKey(p)}.json`;

function refuse(cmd: string, args: string[], rule: string): never {
  env.violations.push({ cmd, args, rule });
  throw new Error(`${cmd} refused (${rule}): ${args.join(", ")}`);
}

function ensureText(cmd: string, p: string): void {
  if (!hasTextExt(p)) refuse(cmd, [p], "not a text extension");
  if (isLink(p) && !(exists(p) && hasTextExt(resolve(p)))) refuse(cmd, [p], "symlink to a non-text or missing target");
  if (exists(p) && !hasTextExt(resolve(p))) refuse(cmd, [p], "target is not a text file");
}

function ensureOpen(cmd: string, p: string): void {
  if (!env.open.has(docKey(p))) refuse(cmd, [p], "document was never read this session");
}

const on = (name: string) => async (cb: Handler) => { env.handlers.set(name, cb); return () => {}; };

vi.mock("./ipc", () => ({
  appVersion: async () => "0.0.0-test",
  openExternal: async () => {}, openFileExternal: async () => {},
  resolveOpenTarget: async (p: string) => ({ path: p, confirm: false }),
  localFileUrl: (p: string) => p,
  resolveWikilink: async (_doc: string, note: string) => ({ path: env.wikilinks.get(note) ?? null, capped: false }),
  canonicalizePath: async (p: string) => {
    if (env.canonicalizeFails) throw new Error("canonicalize_path unavailable");
    return cliCanonical(p);
  },
  setShowInFinderEnabled: async () => {}, revealInFinder: async () => {},
  readFile: async (p: string) => {
    ensureText("read_file", p);
    if (!exists(p)) throw new Error("No such file or directory (os error 2)");
    env.open.add(docKey(p));
    return env.files.get(resolve(p))!;
  },
  writeFile: async (p: string, c: string) => {
    ensureText("write_file", p);
    ensureOpen("write_file", p);
    env.files.set(resolve(p), c);
    env.writes.push([p, c]);
  },
  watchFile: async (p: string) => {
    ensureText("watch_file", p);
    ensureOpen("watch_file", p);
    env.watched.push(p);
  },
  unwatchFile: async () => {},
  ensureAnnotationStore: async (p: string) => { const s = storeOf(p); env.stores.add(s); return s; },
  watchAnnotations: async (s: string, d: string) => {
    ensureText("watch_annotations", d);
    ensureOpen("watch_annotations", d);
    if (s !== storeOf(d)) refuse("watch_annotations", [s, d], "not the store ensure_annotation_store returns for the doc");
    env.watched.push(s);
  },
  readAnnotations: async (p: string) => ({ docPath: p, annotations: [] }),
  addStoredAnnotation: async () => {}, removeStoredAnnotation: async () => null,
  updateStoredAnnotation: async () => {}, addStoredReply: async () => {},
  resolveAnchors: async () => [],
  onOpenFile: on("open-file"), onFileChanged: on("file-changed"), onFileRemoved: on("file-removed"),
  onFileError: on("file-error"), onAnnotationsChanged: on("annotations-changed"),
  takeLaunchArgs: async () => env.launch,
  onShowIntegrationPicker: on("x1"), listIntegrationTargets: async () => [], runIntegration: async () => [],
  onShowAbout: on("x2"), onShowWhatsNew: on("x3"), onShowTheme: on("x4"),
  onCheckForUpdates: on("x7"), fetchLatestRelease: async () => null,
  onCloseActiveTab: on("close-active-tab"), onMenuSave: on("menu-save"), onSelectAll: on("x5"),
  onShowInFinder: on("x6"), onQuitRequested: on("quit-requested"),
  quitApp: async () => { env.quit++; },
  readReviewed: async () => null, writeReviewed: async () => {},
}));
vi.mock("./mermaid", () => ({ renderMermaidBlocks: async () => {} }));

const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };

async function boot() {
  vi.resetModules();
  document.body.innerHTML = `<header id="titlebar"><div id="tabs"></div><div id="titlebar-actions"></div></header>
    <div id="workspace"><main id="content"></main><div id="rail-grip"></div><aside id="rail"></aside></div>
    <div id="modal-root"></div>`;
  const app = await import("./app");
  return app.start().then(flush);
}

const tabs = () => Array.from(document.querySelectorAll<HTMLElement>("#tabs .tab")).map((t) => t.dataset.id!);
const activeTab = () => document.querySelector<HTMLElement>("#tabs .tab.active")?.dataset.id ?? null;
const modalText = () => document.getElementById("modal-root")!.textContent ?? "";
const emit = async (name: string, payload?: unknown) => { void env.handlers.get(name)!(payload); await flush(); };

async function click(label: string) {
  const btn = Array.from(document.querySelectorAll<HTMLButtonElement>("#modal-root button"))
    .find((b) => b.textContent === label);
  if (!btn) throw new Error(`no "${label}" button in: ${modalText()}`);
  btn.click();
  await flush();
}

async function selectTab(id: string) {
  document.querySelector<HTMLElement>(`#tabs .tab[data-id="${id}"]`)!.click();
  await flush();
}

async function editorView() {
  const { EditorView } = await import("@codemirror/view");
  if (!document.querySelector(".cm-editor")) {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "e", metaKey: true }));
    await flush();
  }
  return EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement)!;
}

async function type(text: string) {
  (await editorView()).dispatch({ changes: { from: 0, insert: text } });
}

async function toRead() {
  if (document.querySelector(".cm-editor")) {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "e", metaKey: true }));
    await flush();
  }
}

async function save() { await emit("menu-save"); }

// The doc is open as far as the backend is concerned, and both its file and
// its comment store are being watched.
function expectFullyOpen(absPath: string) {
  expect(env.open.has(docKey(absPath))).toBe(true);
  expect(env.watched).toContain(absPath);
  expect(env.watched).toContain(storeOf(absPath));
}

const linkNamed = (text: string) =>
  Array.from(document.querySelectorAll<HTMLElement>("#content .rendered a")).find((a) => a.textContent === text)!;

const lastWrite = () => env.writes[env.writes.length - 1];

// Each boot() imports a fresh app.ts, but document and window outlive it. An
// earlier test's app would still answer link clicks and keys with its own
// stale state, so its listeners go when the test ends.
const removeListeners: Array<() => void> = [];
for (const target of [document, window] as EventTarget[]) {
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  (target as any).addEventListener = (type: string, fn: any, opts?: any) => {
    removeListeners.push(() => remove(type, fn, opts));
    add(type, fn, opts);
  };
}
afterEach(() => { for (const off of removeListeners.splice(0)) off(); });

beforeEach(() => {
  env.files = new Map();
  env.dirLinks = new Map([["/tmp", "/private/tmp"], ["/Docs", "/docs"]]);
  env.fileLinks = new Map();
  env.canonicalizeFails = false;
  env.handlers = new Map();
  env.launch = [];
  env.wikilinks = new Map();
  env.open = new Set();
  env.stores = new Set();
  env.watched = [];
  env.writes = [];
  env.violations = [];
  env.quit = 0;
  localStorage.clear();
  localStorage.setItem("glance.seenVersion", "0.0.0-test");
  localStorage.setItem("glance.commentHintSeen", "1");
  (globalThis as any).requestAnimationFrame ??= (cb: any) => setTimeout(cb, 0);
  (globalThis as any).ResizeObserver ??= class { observe() {} disconnect() {} };
  (window as any).matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  (globalThis as any).CSS ??= { escape: (s: string) => s };
  (Range.prototype as any).getClientRects ??= () => [];
  (Range.prototype as any).getBoundingClientRect ??= () => new DOMRect();
  Element.prototype.scrollIntoView = () => {};
});

describe("the strict fake backend", () => {
  it("refuses what the Rust side refuses", async () => {
    const ipc = await import("./ipc");
    env.files.set("/docs/a.md", "a\n");
    env.files.set("/docs/key.pem", "secret");
    env.fileLinks.set("/docs/sneaky.md", "/docs/key.pem");
    await expect(ipc.writeFile("/docs/a.md", "x")).rejects.toThrow(/never read/);
    await expect(ipc.watchFile("/docs/a.md")).rejects.toThrow(/never read/);
    await expect(ipc.readFile("/docs/key.pem")).rejects.toThrow(/text extension/);
    await expect(ipc.readFile("/docs/sneaky.md")).rejects.toThrow(/symlink/);
    await ipc.readFile("/Docs/a.md");
    await expect(ipc.writeFile("/docs/a.md", "x")).resolves.toBeUndefined();
    await expect(ipc.watchAnnotations("/home/.glance/annotations/elsewhere.json", "/docs/a.md"))
      .rejects.toThrow(/not the store/);
    await expect(ipc.watchAnnotations(await ipc.ensureAnnotationStore("/Docs/./a.md"), "/docs/a.md"))
      .resolves.toBeUndefined();
    expect(env.violations.map((v) => v.cmd)).toEqual([
      "write_file", "watch_file", "read_file", "read_file", "watch_annotations",
    ]);
    env.violations = [];
  });
});

describe("every open/save/watch/reload flow stays inside the backend's rules", () => {
  afterEach(() => { expect(env.violations).toEqual([]); });

  it("launch args", async () => {
    env.files.set("/docs/a.md", "a\n");
    env.launch = ["/docs/a.md"];
    await boot();
    expect(tabs()).toEqual(["/docs/a.md"]);
    expectFullyOpen("/docs/a.md");
  });

  it("open-file from Finder or mdview, including a /tmp spelling", async () => {
    env.files.set("/docs/a.md", "a\n");
    env.files.set("/private/tmp/x.md", "x\n");
    await boot();
    await emit("open-file", "/docs/a.md");
    await emit("open-file", "/tmp/x.md");
    expect(tabs()).toEqual(["/docs/a.md", "/private/tmp/x.md"]);
    expectFullyOpen("/docs/a.md");
    expectFullyOpen("/private/tmp/x.md");
  });

  it("File > New: the backend creates the empty file, then emits open-file; edit and save", async () => {
    await boot();
    env.files.set("/private/tmp/Untitled.md", ""); // lib.rs new_file: fs::write(&p, "")
    await emit("open-file", "/tmp/Untitled.md");
    expectFullyOpen("/private/tmp/Untitled.md");
    await type("# New\n");
    await save();
    expect(lastWrite()).toEqual(["/private/tmp/Untitled.md", "# New\n"]);
  });

  it("File > Open picks a file and emits open-file", async () => {
    env.files.set("/docs/picked.markdown", "p\n");
    await boot();
    await emit("open-file", "/docs/picked.markdown");
    expectFullyOpen("/docs/picked.markdown");
  });

  it("session restore on launch, then a launch file on top", async () => {
    env.files.set("/docs/a.md", "a\n");
    env.files.set("/docs/b.md", "b\n");
    env.files.set("/docs/c.md", "c\n");
    localStorage.setItem("glance.openPaths", JSON.stringify(["/docs/a.md", "/docs/gone.md", "/docs/b.md"]));
    env.launch = ["/Docs/c.md"];
    await boot();
    expect(tabs()).toEqual(["/docs/a.md", "/docs/b.md", "/docs/c.md"]);
    for (const p of tabs()) expectFullyOpen(p);
  });

  it("recent-docs click on the empty state", async () => {
    env.files.set("/docs/r.md", "r\n");
    localStorage.setItem("glance.recent", JSON.stringify(["/docs/r.md"]));
    await boot();
    document.querySelector<HTMLElement>("#content .recent li")!.click();
    await flush();
    expect(tabs()).toEqual(["/docs/r.md"]);
    expectFullyOpen("/docs/r.md");
  });

  it("a markdown link to another .md, through a symlinked folder", async () => {
    env.dirLinks.set("/shortcut", "/docs");
    env.files.set("/docs/a.md", "[next](../shortcut/b.md) [same](./c.md)\n");
    env.files.set("/docs/b.md", "b\n");
    env.files.set("/docs/c.md", "c\n");
    env.launch = ["/docs/a.md"];
    await boot();
    linkNamed("next").click();
    await flush();
    expect(activeTab()).toBe("/docs/b.md");
    await selectTab("/docs/a.md");
    linkNamed("same").click();
    await flush();
    expect(tabs()).toEqual(["/docs/a.md", "/docs/b.md", "/docs/c.md"]);
    for (const p of tabs()) expectFullyOpen(p);
    await type("edited ");
    await save();
    expect(lastWrite()).toEqual(["/docs/c.md", "edited c\n"]);
  });

  it("a wikilink click", async () => {
    env.files.set("/vault/a.md", "see [[Other#Part]]\n");
    env.files.set("/vault/notes/Other.md", "# Part\n");
    env.fileLinks.set("/vault/other-link.md", "/vault/notes/Other.md");
    env.wikilinks.set("Other", "/vault/other-link.md");
    env.launch = ["/vault/a.md"];
    await boot();
    document.querySelector<HTMLElement>("#content .rendered a[data-wikilink]")!.click();
    await flush();
    expect(activeTab()).toBe("/vault/notes/Other.md");
    expectFullyOpen("/vault/notes/Other.md");
  });

  it("a symlink spelling: opens, watches, saves and reloads the real file", async () => {
    env.files.set("/real.md", "real\n");
    env.fileLinks.set("/link.md", "/real.md");
    env.launch = ["/link.md"];
    await boot();
    expect(tabs()).toEqual(["/real.md"]);
    expectFullyOpen("/real.md");
    await emit("open-file", "/real.md"); // the other spelling focuses the same tab
    expect(tabs()).toEqual(["/real.md"]);
    await type("x");
    await save();
    expect(env.files.get("/real.md")).toBe("xreal\n");
  });

  it("a symlink spelling when canonicalize_path fails keeps using the spelling it was given", async () => {
    env.files.set("/real.md", "real\n");
    env.fileLinks.set("/link.md", "/real.md");
    env.files.set("/private/tmp/t.md", "t\n");
    env.canonicalizeFails = true;
    env.launch = ["/link.md", "/tmp/t.md"];
    await boot();
    expect(tabs()).toEqual(["/link.md", "/tmp/t.md"]);
    expectFullyOpen("/link.md");
    expectFullyOpen("/tmp/t.md");
    await type("y");
    await save();
    expect(env.files.get("/private/tmp/t.md")).toBe("yt\n");
  });

  it("reopening a closed tab, then saving it", async () => {
    env.files.set("/docs/a.md", "a\n");
    env.launch = ["/docs/a.md"];
    await boot();
    await emit("close-active-tab");
    expect(tabs()).toEqual([]);
    document.querySelector<HTMLElement>("#content .recent li")!.click();
    await flush();
    expect(tabs()).toEqual(["/docs/a.md"]);
    await type("again ");
    await save();
    expect(lastWrite()).toEqual(["/docs/a.md", "again a\n"]);
  });

  it("closing a tab while it is still opening, then opening it again", async () => {
    env.files.set("/docs/a.md", "a\n");
    await boot();
    void env.handlers.get("open-file")!("/docs/a.md");
    void env.handlers.get("close-active-tab")!(undefined);
    await flush();
    await emit("open-file", "/docs/a.md");
    expectFullyOpen("/docs/a.md");
  });

  it("Cmd+S after edits", async () => {
    env.files.set("/docs/a.md", "a\n");
    env.launch = ["/docs/a.md"];
    await boot();
    await type("1");
    await save();
    await type("2");
    await save();
    expect(env.writes).toEqual([["/docs/a.md", "1a\n"], ["/docs/a.md", "21a\n"]]);
  });

  it("saving a doc that was deleted on disk while open recreates it", async () => {
    env.files.set("/docs/a.md", "a\n");
    env.files.set("/private/tmp/t.md", "t\n");
    env.launch = ["/docs/a.md", "/tmp/t.md"];
    await boot();
    for (const p of ["/docs/a.md", "/private/tmp/t.md"]) {
      env.files.delete(p);
      await emit("file-removed", p);
    }
    expect(document.querySelectorAll("#tabs .removed").length).toBe(2);
    await type("back ");
    await save();
    await selectTab("/docs/a.md");
    await type("back ");
    await save();
    expect(env.files.get("/private/tmp/t.md")).toBe("back t\n");
    expect(env.files.get("/docs/a.md")).toBe("back a\n");
  });

  it("auto-reload on a disk change to a clean doc, then save", async () => {
    env.files.set("/docs/a.md", "a\n");
    env.launch = ["/docs/a.md"];
    await boot();
    env.files.set("/docs/a.md", "outside\n");
    await emit("file-changed", { path: "/docs/a.md", contents: "outside\n" });
    expect(modalText()).toBe("");
    await type("mine ");
    await save();
    expect(lastWrite()).toEqual(["/docs/a.md", "mine outside\n"]);
  });

  it("the Load disk prompt, then Keep mine, each followed by a save", async () => {
    env.files.set("/docs/a.md", "a\n");
    env.launch = ["/docs/a.md"];
    await boot();
    await type("dirty ");
    await emit("file-changed", { path: "/docs/a.md", contents: "disk1\n" });
    await click("Load disk");
    await type("x");
    await emit("file-changed", { path: "/docs/a.md", contents: "disk2\n" });
    await click("Keep mine");
    await save();
    expect(lastWrite()).toEqual(["/docs/a.md", "xdisk1\n"]);
  });

  it("closing tabs: clean, and dirty with Save", async () => {
    env.files.set("/docs/a.md", "a\n");
    env.files.set("/real.md", "r\n");
    env.fileLinks.set("/link.md", "/real.md");
    env.launch = ["/docs/a.md", "/link.md"];
    await boot();
    await type("z");
    await emit("close-active-tab");
    await click("Save");
    expect(env.files.get("/real.md")).toBe("zr\n");
    await toRead();
    await emit("close-active-tab");
    expect(tabs()).toEqual([]);
  });

  it("quit with dirty docs: Save writes each, then quits", async () => {
    env.files.set("/docs/a.md", "a\n");
    env.files.set("/real.md", "r\n");
    env.fileLinks.set("/link.md", "/real.md");
    env.files.set("/private/tmp/t.md", "t\n");
    env.launch = ["/docs/a.md", "/link.md", "/tmp/t.md"];
    await boot();
    for (const id of ["/docs/a.md", "/real.md", "/private/tmp/t.md"]) {
      await selectTab(id);
      await type("q");
    }
    env.files.delete("/private/tmp/t.md");
    await emit("file-removed", "/private/tmp/t.md");
    await emit("quit-requested");
    for (let i = 0; i < 3; i++) await click("Save");
    expect(env.files.get("/docs/a.md")).toBe("qa\n");
    expect(env.files.get("/real.md")).toBe("qr\n");
    expect(env.files.get("/private/tmp/t.md")).toBe("qt\n");
    expect(env.quit).toBe(1);
  });
});
