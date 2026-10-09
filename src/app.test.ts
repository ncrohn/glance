// @vitest-environment jsdom
// Drives the real app.ts start() against a fake Tauri backend (./ipc mocked).
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Annotation } from "./annotations";

type Handler = (payload: any) => any;
const env = {
  fs: new Map<string, string>(),
  handlers: new Map<string, Handler>(),
  launch: [] as string[],
  writes: [] as Array<[string, string]>,
  writeGate: null as null | Promise<void>,
  readGates: new Map<string, Promise<void>>(),
  annotations: new Map<string, Annotation[]>(),
  storeError: null as null | string,
  calls: [] as string[],
  aliases: new Map<string, string>(),
  watched: [] as string[],
  unwatched: [] as string[],
  storeGate: null as null | Promise<void>,
};

function resetEnv(): void {
  env.aliases = new Map();
  env.watched = [];
  env.unwatched = [];
  env.storeGate = null;
  env.fs = new Map();
  env.handlers = new Map();
  env.launch = [];
  env.writes = [];
  env.writeGate = null;
  env.readGates = new Map();
  env.annotations = new Map();
  env.storeError = null;
  env.calls = [];
}

const on = (name: string) => async (cb: Handler) => { env.handlers.set(name, cb); return () => {}; };
const storeOp = async () => { if (env.storeError) throw env.storeError; };

vi.mock("./ipc", () => ({
  appVersion: async () => "0.0.0-test",
  openExternal: async () => {}, openFileExternal: async () => {},
  localFileUrl: (p: string) => p, resolveWikilink: async () => null,
  setShowInFinderEnabled: async () => {}, revealInFinder: async () => {},
  readFile: async (p: string) => {
    await env.readGates.get(p);
    if (!env.fs.has(p)) throw new Error("No such file or directory (os error 2)");
    return env.fs.get(p)!;
  },
  writeFile: async (p: string, c: string) => {
    if (env.writeGate) await env.writeGate;
    env.fs.set(p, c);
    env.writes.push([p, c]);
  },
  watchFile: async (p: string) => { env.watched.push(p); },
  unwatchFile: async (p: string) => { env.unwatched.push(p); },
  onOpenFile: on("open-file"), onFileChanged: on("file-changed"), onFileRemoved: on("file-removed"),
  onFileError: on("file-error"),
  canonicalizePath: async (p: string) => env.aliases.get(p) ?? p,
  takeLaunchArgs: async () => env.launch,
  readAnnotations: async (p: string) => {
    await storeOp();
    return { docPath: p, annotations: env.annotations.get(p) ?? [] };
  },
  addStoredAnnotation: storeOp, removeStoredAnnotation: storeOp,
  updateStoredAnnotation: storeOp, addStoredReply: storeOp,
  resolveAnchors: async () => [],
  ensureAnnotationStore: async (p: string) => { await env.storeGate; return "/store" + p; },
  watchAnnotations: async (s: string) => { env.watched.push(s); }, onAnnotationsChanged: on("annotations-changed"),
  onShowIntegrationPicker: on("x1"), listIntegrationTargets: async () => [], runIntegration: async () => [],
  onShowAbout: on("x2"), onShowWhatsNew: on("x3"), onShowTheme: on("x4"),
  onCheckForUpdates: on("x7"), fetchLatestRelease: async () => null,
  onCloseActiveTab: on("close-active-tab"), onMenuSave: on("menu-save"), onSelectAll: on("x5"),
  onShowInFinder: on("x6"), onQuitRequested: on("quit-requested"),
  quitApp: async () => { env.calls.push("quit"); },
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
  const started = app.start();
  return started.then(flush);
}

const tabs = () => Array.from(document.querySelectorAll<HTMLElement>("#tabs .tab")).map((t) => t.dataset.id!);
const activeTab = () => document.querySelector<HTMLElement>("#tabs .tab.active")?.dataset.id ?? null;
const savedSession = () => JSON.parse(localStorage.getItem("glance.openPaths") ?? "null");
const toastText = () => document.querySelector(".toast-text")?.textContent ?? "";
const modalText = () => document.getElementById("modal-root")!.textContent ?? "";
const modalCount = () => document.querySelectorAll("#modal-root .modal").length;
const isDirtyTab = (id: string) => !!document.querySelector(`#tabs .tab.dirty[data-id="${id}"]`);
const emit = async (name: string, payload?: unknown) => { void env.handlers.get(name)!(payload); await flush(); };
const diskChange = (path: string, contents: string) => emit("file-changed", { path, contents });

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

// Type into the active tab's editor (switching it to Edit first).
async function type(text: string, at: "start" | "end" = "start") {
  const v = await editorView();
  v.dispatch({ changes: { from: at === "end" ? v.state.doc.length : 0, insert: text } });
}

const editorText = async () => (await editorView()).state.doc.toString();

function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((r) => { release = r; });
  return { promise, release };
}

beforeEach(() => {
  resetEnv();
  localStorage.clear();
  localStorage.setItem("glance.seenVersion", "0.0.0-test");
  localStorage.setItem("glance.commentHintSeen", "1");
  (globalThis as any).requestAnimationFrame ??= (cb: any) => setTimeout(cb, 0);
  (globalThis as any).ResizeObserver ??= class { observe() {} disconnect() {} };
  (window as any).matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  (globalThis as any).CSS ??= { escape: (s: string) => s };
  // jsdom has no layout; CodeMirror's measure pass needs these to exist.
  (Range.prototype as any).getClientRects ??= () => [];
  (Range.prototype as any).getBoundingClientRect ??= () => new DOMRect();
});

function annotation(id: string): Annotation {
  return {
    id, number: 1, quote: "a", prefix: "", suffix: "", lineHint: { start: 1, end: 1 }, note: "n",
    status: "open", author: "user", createdAt: "t", replies: [],
  };
}

describe("session restore", () => {
  it("no launch files: restores the saved session", async () => {
    env.fs.set("/a.md", "a\n"); env.fs.set("/b.md", "b\n");
    localStorage.setItem("glance.openPaths", JSON.stringify(["/a.md", "/b.md"]));
    await boot();
    expect(tabs()).toEqual(["/a.md", "/b.md"]);
  });

  it("a cold launch with a file keeps the saved tabs and makes the launched file active", async () => {
    env.fs.set("/a.md", "a\n"); env.fs.set("/b.md", "b\n"); env.fs.set("/c.md", "c\n");
    localStorage.setItem("glance.openPaths", JSON.stringify(["/a.md", "/b.md"]));
    env.launch = ["/c.md"];
    await boot();
    expect(tabs()).toEqual(["/a.md", "/b.md", "/c.md"]);
    expect(activeTab()).toBe("/c.md");
    expect(savedSession()).toEqual(["/a.md", "/b.md", "/c.md"]);
  });

  it("a launched file already in the session is focused, not duplicated", async () => {
    env.fs.set("/a.md", "a\n"); env.fs.set("/b.md", "b\n");
    localStorage.setItem("glance.openPaths", JSON.stringify(["/a.md", "/b.md"]));
    env.launch = ["/a.md"];
    await boot();
    expect(tabs()).toEqual(["/a.md", "/b.md"]);
    expect(activeTab()).toBe("/a.md");
  });

  it("the saved session is not overwritten while the restore is still running", async () => {
    env.fs.set("/a.md", "a\n"); env.fs.set("/b.md", "b\n"); env.fs.set("/c.md", "c\n");
    localStorage.setItem("glance.openPaths", JSON.stringify(["/a.md", "/b.md"]));
    env.launch = ["/c.md"];
    let release!: () => void;
    env.readGates.set("/b.md", new Promise<void>((r) => { release = r; }));
    const booted = boot();
    await flush();
    expect(tabs()).toEqual(["/a.md"]); // mid-restore: /b.md is still loading
    expect(savedSession()).toEqual(["/a.md", "/b.md"]);
    release();
    await booted;
    expect(savedSession()).toEqual(["/a.md", "/b.md", "/c.md"]);
  });
});

describe("unsaved edits on close and quit", () => {
  async function bootWithEdit() {
    env.fs.set("/a.md", "hello\n");
    env.launch = ["/a.md"];
    await boot();
    await type("UNSAVED ");
    expect(isDirtyTab("/a.md")).toBe(true);
  }

  it("Cmd+W on a dirty tab asks first; Cancel keeps the tab and the edits", async () => {
    await bootWithEdit();
    await emit("close-active-tab");
    expect(modalText()).toContain("Save changes to a.md?");
    await emit("close-active-tab"); // a repeat doesn't stack a second prompt
    expect(modalCount()).toBe(1);
    await click("Cancel");
    expect(tabs()).toEqual(["/a.md"]);
    expect(await editorText()).toBe("UNSAVED hello\n");
    expect(env.writes).toEqual([]);
  });

  it("Save writes the edits, then closes the tab", async () => {
    await bootWithEdit();
    await emit("close-active-tab");
    await click("Save");
    expect(env.fs.get("/a.md")).toBe("UNSAVED hello\n");
    expect(tabs()).toEqual([]);
  });

  it("Don't Save closes without writing", async () => {
    await bootWithEdit();
    document.querySelector<HTMLElement>('#tabs .tab[data-id="/a.md"] .close')!.click();
    await flush();
    await click("Don't Save");
    expect(tabs()).toEqual([]);
    expect(env.writes).toEqual([]);
  });

  it("a clean tab closes with no prompt", async () => {
    env.fs.set("/a.md", "hello\n");
    env.launch = ["/a.md"];
    await boot();
    await emit("close-active-tab");
    expect(modalCount()).toBe(0);
    expect(tabs()).toEqual([]);
  });

  it("quit with nothing dirty quits straight away", async () => {
    env.fs.set("/a.md", "hello\n");
    env.launch = ["/a.md"];
    await boot();
    await emit("quit-requested");
    expect(modalCount()).toBe(0);
    expect(env.calls).toEqual(["quit"]);
  });

  it("quit with a dirty doc: Cancel stays, Don't Save quits without writing", async () => {
    await bootWithEdit();
    await emit("quit-requested");
    expect(modalText()).toContain("Save changes to a.md?");
    await click("Cancel");
    expect(env.calls).toEqual([]);
    await emit("quit-requested");
    await click("Don't Save");
    expect(env.writes).toEqual([]);
    expect(env.calls).toEqual(["quit"]);
  });

  it("quit walks every dirty doc and stops at the first Cancel", async () => {
    env.fs.set("/a.md", "a\n"); env.fs.set("/b.md", "b\n"); env.fs.set("/c.md", "c\n");
    env.launch = ["/a.md", "/b.md", "/c.md"];
    await boot();
    await selectTab("/a.md");
    await type("A ");
    await selectTab("/b.md");
    await type("B ");
    await selectTab("/c.md");
    await emit("quit-requested");
    expect(modalText()).toContain("a.md");
    expect(activeTab()).toBe("/a.md");
    await click("Save");
    expect(env.fs.get("/a.md")).toBe("A a\n");
    expect(modalText()).toContain("b.md");
    expect(activeTab()).toBe("/b.md");
    await click("Cancel");
    expect(env.calls).toEqual([]);
    expect(env.fs.get("/b.md")).toBe("b\n");
    expect(tabs()).toEqual(["/a.md", "/b.md", "/c.md"]);
  });

  it("quit doesn't go ahead when the save fails", async () => {
    await bootWithEdit();
    env.writeGate = Promise.reject(new Error("disk full"));
    env.writeGate.catch(() => {});
    await emit("quit-requested");
    await click("Save");
    expect(env.calls).toEqual([]);
    expect(modalText()).toContain("disk full");
  });
});

describe("saving while the file changes on disk", () => {
  it("typing during a save is not reverted by the save's own echo", async () => {
    env.fs.set("/a.md", "base\n");
    env.launch = ["/a.md"];
    await boot();
    await type("ONE ");
    const g = gate();
    env.writeGate = g.promise;
    await emit("menu-save");
    await type("TWO", "end");
    g.release();
    await flush();
    expect(env.fs.get("/a.md")).toBe("ONE base\n");
    expect(isDirtyTab("/a.md")).toBe(true);
    await diskChange("/a.md", "ONE base\n");
    expect(await editorText()).toBe("ONE base\nTWO");
    expect(isDirtyTab("/a.md")).toBe(true);
    expect(modalCount()).toBe(0);
  });

  it("an echo that arrives before the save returns raises no prompt", async () => {
    env.fs.set("/a.md", "base\n");
    env.launch = ["/a.md"];
    await boot();
    await type("ONE ");
    const g = gate();
    env.writeGate = g.promise;
    await emit("menu-save");
    await type("TWO", "end");
    await diskChange("/a.md", "ONE base\n");
    expect(modalCount()).toBe(0);
    g.release();
    await flush();
    expect(await editorText()).toBe("ONE base\nTWO");
    expect(modalCount()).toBe(0);
  });

  it("Save while the reload prompt is open does not overwrite the outside change", async () => {
    env.fs.set("/a.md", "base\n");
    env.launch = ["/a.md"];
    await boot();
    await type("USER ");
    env.fs.set("/a.md", "AGENT\n");
    await diskChange("/a.md", "AGENT\n");
    expect(modalText()).toContain("changed on disk");
    await emit("menu-save");
    expect(env.writes).toEqual([]);
    expect(env.fs.get("/a.md")).toBe("AGENT\n");
    expect(toastText()).toContain("Choose Keep mine or Load disk");
    await click("Load disk");
    expect(await editorText()).toBe("AGENT\n");
    expect(isDirtyTab("/a.md")).toBe(false);
  });

  it("Keep mine, then Save, writes the user's text", async () => {
    env.fs.set("/a.md", "base\n");
    env.launch = ["/a.md"];
    await boot();
    await type("USER ");
    env.fs.set("/a.md", "AGENT\n");
    await diskChange("/a.md", "AGENT\n");
    await click("Keep mine");
    expect(isDirtyTab("/a.md")).toBe(true);
    await emit("menu-save");
    expect(env.fs.get("/a.md")).toBe("USER base\n");
    expect(isDirtyTab("/a.md")).toBe(false);
  });

  it("a second change to the same doc updates the open prompt; Load disk takes the newest", async () => {
    env.fs.set("/a.md", "base\n");
    env.launch = ["/a.md"];
    await boot();
    await type("USER ");
    await diskChange("/a.md", "AGENT 1\n");
    await diskChange("/a.md", "AGENT 2\n");
    expect(modalCount()).toBe(1);
    await click("Load disk");
    expect(modalCount()).toBe(0);
    expect(await editorText()).toBe("AGENT 2\n");
  });

  it("two docs changed on disk each get their own prompt, one after the other", async () => {
    env.fs.set("/a.md", "a\n"); env.fs.set("/b.md", "b\n");
    env.launch = ["/a.md", "/b.md"];
    await boot();
    await selectTab("/a.md");
    await type("USER-A ");
    await selectTab("/b.md");
    await type("USER-B ");
    await diskChange("/a.md", "AGENT-A\n");
    await diskChange("/b.md", "AGENT-B\n");
    expect(modalCount()).toBe(1);
    expect(modalText()).toContain("a.md");
    await click("Load disk");
    expect(modalCount()).toBe(1);
    expect(modalText()).toContain("b.md");
    await click("Keep mine");
    expect(modalCount()).toBe(0);
    await selectTab("/a.md");
    expect(await editorText()).toBe("AGENT-A\n");
    await selectTab("/b.md");
    expect(await editorText()).toBe("USER-B b\n");
  });
});

describe("damaged annotation store", () => {
  it("shows the read error instead of an empty rail with no explanation", async () => {
    env.fs.set("/a.md", "a\n");
    env.launch = ["/a.md"];
    env.storeError = "The annotation store /s.json is damaged (invalid value).";
    await boot();
    expect(tabs()).toEqual(["/a.md"]);
    expect(toastText()).toContain("Couldn't load comments for a.md");
    expect(toastText()).toContain("damaged");
  });

  it("a failed comment change is rolled back and reported", async () => {
    env.fs.set("/a.md", "a\n");
    env.annotations.set("/a.md", [annotation("x")]);
    env.launch = ["/a.md"];
    await boot();
    expect(document.querySelectorAll("#rail .note-card")).toHaveLength(1);
    env.storeError = "The annotation store /s.json is damaged (invalid value).";
    document.querySelector<HTMLElement>('#rail .note-card button.note-action[title="Delete"]')!.click();
    await flush();
    expect(document.querySelectorAll("#rail .note-card")).toHaveLength(1);
    expect(toastText()).toContain("Couldn't save the comment change on a.md");
  });
});

describe("the editor survives re-renders", () => {
  const fifty = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n") + "\n";

  it("Cmd+S and a comment change keep the same editor, cursor and undo history", async () => {
    env.fs.set("/a.md", fifty);
    env.launch = ["/a.md"];
    await boot();
    const { undoDepth } = await import("@codemirror/commands");
    const v1 = await editorView();
    v1.dispatch({ changes: { from: 200, insert: "TYPED" }, selection: { anchor: 205 } });
    const depth = undoDepth(v1.state);
    await emit("menu-save");
    expect(env.fs.get("/a.md")).toContain("TYPED");
    await emit("annotations-changed", "/a.md");
    const v2 = await editorView();
    expect(v2).toBe(v1);
    expect(v2.state.selection.main.head).toBe(205);
    expect(undoDepth(v2.state)).toBe(depth);
  });

  it("an outside change to a clean doc updates the text in place and keeps the cursor", async () => {
    env.fs.set("/a.md", fifty);
    env.launch = ["/a.md"];
    await boot();
    const v1 = await editorView();
    v1.dispatch({ selection: { anchor: 300 } });
    await diskChange("/a.md", "NEW TOP\n" + fifty);
    const v2 = await editorView();
    expect(v2).toBe(v1);
    expect(v2.state.doc.toString()).toBe("NEW TOP\n" + fifty);
    expect(v2.state.selection.main.head).toBe(308);
    expect(isDirtyTab("/a.md")).toBe(false);
  });

  it("undo doesn't revert an outside change", async () => {
    env.fs.set("/a.md", fifty);
    env.launch = ["/a.md"];
    await boot();
    const { undo } = await import("@codemirror/commands");
    const v = await editorView();
    v.dispatch({ changes: { from: 0, insert: "MINE " }, userEvent: "input.type" });
    await emit("menu-save");
    await diskChange("/a.md", "AGENT\n" + env.fs.get("/a.md"));
    undo(v);
    expect(v.state.doc.toString()).toContain("AGENT\n");
    expect(v.state.doc.toString()).not.toContain("MINE ");
  });
});

describe("old-Mac CR files", () => {
  it("an edit keeps lone-CR line endings and a re-render changes nothing", async () => {
    env.fs.set("/m.md", "line1\rline2\r");
    env.launch = ["/m.md"];
    await boot();
    const v = await editorView();
    await emit("annotations-changed", "/m.md");
    expect(isDirtyTab("/m.md")).toBe(false);
    v.dispatch({ changes: { from: 0, insert: "X" } });
    await emit("menu-save");
    expect(env.fs.get("/m.md")).toBe("Xline1\rline2\r");
  });
});

describe("CRLF files", () => {
  it("an edit keeps the file's CRLF line endings on save", async () => {
    env.fs.set("/w.md", "line1\r\nline2\r\nline3\r\n");
    env.launch = ["/w.md"];
    await boot();
    await type("X");
    await emit("menu-save");
    expect(env.fs.get("/w.md")).toBe("Xline1\r\nline2\r\nline3\r\n");
  });

  it("typing then undoing leaves the tab clean", async () => {
    env.fs.set("/w.md", "line1\r\nline2\r\n");
    env.launch = ["/w.md"];
    await boot();
    const { undo } = await import("@codemirror/commands");
    await type("X");
    expect(isDirtyTab("/w.md")).toBe(true);
    undo(await editorView());
    expect(isDirtyTab("/w.md")).toBe(false);
  });
});

describe("opening files", () => {
  it("another spelling of an open file focuses its tab instead of opening a second", async () => {
    env.fs.set("/real/a.md", "a\n"); env.fs.set("/b.md", "b\n");
    env.aliases.set("/link/a.md", "/real/a.md");
    env.launch = ["/real/a.md", "/b.md"];
    await boot();
    await emit("open-file", "/link/a.md");
    expect(tabs()).toEqual(["/real/a.md", "/b.md"]);
    expect(activeTab()).toBe("/real/a.md");
  });

  it("closing a tab while it is still opening releases every watcher it set up", async () => {
    env.fs.set("/a.md", "a\n");
    await boot();
    const g = gate();
    env.storeGate = g.promise;
    await emit("open-file", "/a.md");
    await emit("close-active-tab");
    g.release();
    await flush();
    expect(tabs()).toEqual([]);
    for (const w of env.watched) expect(env.unwatched).toContain(w);
  });

  it("a recent file that no longer exists says so and leaves the list", async () => {
    localStorage.setItem("glance.recent", JSON.stringify(["/gone.md", "/kept.md"]));
    await boot();
    document.querySelector<HTMLElement>("#content .recent li")!.click();
    await flush();
    expect(modalText()).toContain("Couldn't open /gone.md");
    expect(JSON.parse(localStorage.getItem("glance.recent")!)).toEqual(["/kept.md"]);
  });

  it("a watched file that stops being readable text says so", async () => {
    env.fs.set("/a.md", "a\n");
    env.launch = ["/a.md"];
    await boot();
    await emit("file-error", { path: "/a.md", message: "not valid UTF-8" });
    expect(toastText()).toContain("a.md changed on disk but can't be read");
  });
});
