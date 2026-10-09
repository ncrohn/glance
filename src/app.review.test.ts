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
};

function resetEnv(): void {
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
  watchFile: async () => {}, unwatchFile: async () => {},
  onOpenFile: on("open-file"), onFileChanged: on("file-changed"), onFileRemoved: on("file-removed"),
  takeLaunchArgs: async () => env.launch,
  readAnnotations: async (p: string) => {
    await storeOp();
    return { docPath: p, annotations: env.annotations.get(p) ?? [] };
  },
  addStoredAnnotation: storeOp, removeStoredAnnotation: storeOp,
  updateStoredAnnotation: storeOp, addStoredReply: storeOp,
  resolveAnchors: async () => [],
  ensureAnnotationStore: async (p: string) => "/store" + p,
  watchAnnotations: async () => {}, onAnnotationsChanged: on("annotations-changed"),
  onShowIntegrationPicker: on("x1"), listIntegrationTargets: async () => [], runIntegration: async () => [],
  onShowAbout: on("x2"), onShowWhatsNew: on("x3"), onShowTheme: on("x4"),
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
const modalText = () => document.getElementById("modal-root")!.textContent ?? "";
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

const DONT_SAVE = "Don" + String.fromCharCode(39) + "t Save";

async function bootWithEdit() {
  env.fs.set("/a.md", "hello\n");
  env.launch = ["/a.md"];
  await boot();
  await type("UNSAVED ");
}

describe("prompts that outlive their tab", () => {
  it("a quit prompt for a doc another prompt already closed doesn't block the quit", async () => {
    await bootWithEdit();
    await emit("close-active-tab");
    await emit("quit-requested");
    await click(DONT_SAVE);
    expect(tabs()).toEqual([]);
    await click("Save");
    expect(env.writes).toEqual([]);
    expect(env.calls).toEqual(["quit"]);
  });

  it("a reload prompt for a closed tab doesn't carry over when the file is reopened", async () => {
    await bootWithEdit();
    await emit("close-active-tab");
    await diskChange("/a.md", "v2\n");
    await click(DONT_SAVE);
    env.fs.set("/a.md", "v2\n");
    await emit("open-file", "/a.md");
    env.fs.set("/a.md", "v3\n");
    await diskChange("/a.md", "v3\n");
    expect(await editorText()).toBe("v3\n");
    await click("Keep mine"); // answers the stale prompt, which must change nothing
    expect(isDirtyTab("/a.md")).toBe(false);
    await emit("menu-save");
    expect(env.writes.map(([, c]) => c)).not.toContain("v2\n");
    expect(env.fs.get("/a.md")).toBe("v3\n");
  });
});

describe("saving a deleted doc", () => {
  it("doesn't prompt about its own write", async () => {
    await bootWithEdit();
    await emit("file-removed", "/a.md");
    const g = gate();
    env.writeGate = g.promise;
    await emit("menu-save");
    await diskChange("/a.md", "UNSAVED hello\n");
    g.release();
    await flush();
    expect(modalText()).not.toContain("changed on disk");
    expect(env.writes).toEqual([["/a.md", "UNSAVED hello\n"]]);
  });
});
