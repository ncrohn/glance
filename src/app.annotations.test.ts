// @vitest-environment jsdom
// Comment actions in the rail, driven through the real app.ts start() against a
// fake Tauri backend (./ipc mocked) whose annotation store behaves like the Rust
// one: add assigns a number when it has none, remove returns what it removed.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Annotation } from "./annotations";

type Handler = (payload: any) => any;
const env = {
  fs: new Map<string, string>(),
  handlers: new Map<string, Handler>(),
  launch: [] as string[],
  store: new Map<string, { next: number; list: Annotation[] }>(),
};

function storeFor(p: string) {
  if (!env.store.has(p)) env.store.set(p, { next: 1, list: [] });
  return env.store.get(p)!;
}

const on = (name: string) => async (cb: Handler) => { env.handlers.set(name, cb); return () => {}; };
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

vi.mock("./ipc", () => ({
  appVersion: async () => "0.0.0-test",
  openExternal: async () => {}, openFileExternal: async () => {},
  localFileUrl: (p: string) => p, resolveWikilink: async () => null,
  setShowInFinderEnabled: async () => {}, revealInFinder: async () => {},
  readFile: async (p: string) => {
    if (!env.fs.has(p)) throw new Error("No such file or directory (os error 2)");
    return env.fs.get(p)!;
  },
  writeFile: async (p: string, c: string) => { env.fs.set(p, c); },
  watchFile: async () => {}, unwatchFile: async () => {},
  onOpenFile: on("open-file"), onFileChanged: on("file-changed"), onFileRemoved: on("file-removed"),
  takeLaunchArgs: async () => env.launch,
  readAnnotations: async (p: string) => ({ docPath: p, annotations: clone(storeFor(p).list) }),
  addStoredAnnotation: async (p: string, a: Annotation) => {
    const s = storeFor(p);
    const added = { ...clone(a), number: a.number || s.next };
    s.next = Math.max(s.next, added.number + 1);
    s.list.push(added);
  },
  removeStoredAnnotation: async (p: string, id: string) => {
    const s = storeFor(p);
    const hit = s.list.find((a) => a.id === id) ?? null;
    s.list = s.list.filter((a) => a.id !== id);
    return hit && clone(hit);
  },
  updateStoredAnnotation: async () => {}, addStoredReply: async () => {},
  resolveAnchors: async (_text: string, list: Annotation[]) =>
    list.map((a) => ({ id: a.id, startLine: 1, endLine: 1, anchor: "exact" })),
  ensureAnnotationStore: async (p: string) => "/store" + p,
  watchAnnotations: async () => {}, onAnnotationsChanged: on("annotations-changed"),
  onShowIntegrationPicker: on("x1"), listIntegrationTargets: async () => [], runIntegration: async () => [],
  onShowAbout: on("x2"), onShowWhatsNew: on("x3"), onShowTheme: on("x4"),
  onCheckForUpdates: on("x7"), fetchLatestRelease: async () => null,
  onCloseActiveTab: on("close-active-tab"), onMenuSave: on("menu-save"), onSelectAll: on("x5"),
  onShowInFinder: on("x6"), onQuitRequested: on("quit-requested"),
  // Used once the core-editor branch is in; harmless before it.
  onFileError: on("file-error"), canonicalizePath: async (p: string) => p,
  quitApp: async () => {},
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

beforeEach(() => {
  env.fs = new Map();
  env.handlers = new Map();
  env.launch = [];
  env.store = new Map();
  localStorage.clear();
  localStorage.setItem("glance.seenVersion", "0.0.0-test");
  localStorage.setItem("glance.commentHintSeen", "1");
  (globalThis as any).requestAnimationFrame ??= (cb: any) => setTimeout(cb, 0);
  (globalThis as any).ResizeObserver ??= class { observe() {} disconnect() {} };
  (window as any).matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  (Range.prototype as any).getClientRects ??= () => [];
  (Range.prototype as any).getBoundingClientRect ??= () => new DOMRect();
  Element.prototype.scrollIntoView = () => {};
});

function annotation(id: string, number = 1): Annotation {
  return {
    id, number, quote: "hello", prefix: "", suffix: "", lineHint: { start: 1, end: 1 }, note: "n",
    status: "open", author: "user", createdAt: "t", replies: [],
  };
}

async function openWith(...list: Annotation[]) {
  env.fs.set("/a.md", "hello world\n");
  const s = storeFor("/a.md");
  s.list = clone(list);
  s.next = Math.max(1, ...list.map((a) => a.number + 1));
  env.launch = ["/a.md"];
  await boot();
}

const cardFor = (id: string) =>
  Array.from(document.querySelectorAll<HTMLElement>("#rail .note-card")).find((c) => c.dataset.annotationId === id)!;

async function clickAction(id: string, title: string) {
  cardFor(id).querySelector<HTMLElement>(`button.note-action[title="${title}"]`)!.click();
  await flush();
}

async function undo() {
  document.querySelector<HTMLElement>(".toast-action")!.click();
  await flush();
}

describe("comment Undo", () => {
  it("restores replies that reached the store after the rail rendered", async () => {
    await openWith(annotation("x"));
    // Claude replies; the store has it, the app hasn't reloaded yet.
    storeFor("/a.md").list[0].replies = [{ author: "claude", text: "done", createdAt: "t2" }];
    await clickAction("x", "Delete");
    expect(storeFor("/a.md").list).toHaveLength(0);
    await undo();
    const back = storeFor("/a.md").list;
    expect(back).toHaveLength(1);
    expect(back[0].number).toBe(1);
    expect(back[0].replies).toEqual([{ author: "claude", text: "done", createdAt: "t2" }]);
    expect(cardFor("x").textContent).toContain("done");
  });

  it("keeps the number the store assigned to a comment deleted before its add was reloaded", async () => {
    // The app still holds the in-flight copy (number 0); the store numbered it 3.
    await openWith(annotation("x", 0));
    const s = storeFor("/a.md");
    s.list[0].number = 3;
    s.next = 4;
    await clickAction("x", "Delete");
    await undo();
    expect(s.list.map((a) => [a.id, a.number])).toEqual([["x", 3]]);
  });
});

describe("annotation ids in selectors", () => {
  const id = 'q"1';

  it("scrolls to and pulses the commented block for an id with a quote", async () => {
    await openWith(annotation(id));
    const block = document.querySelector<HTMLElement>('#content [data-sourceline="1"]')!;
    block.classList.remove("anno-pulse");
    cardFor(id).click();
    await flush();
    expect(block.classList.contains("anno-pulse") || !!block.querySelector(".anno-pulse")).toBe(true);
  });

  it("opens the edit composer for an id with a quote", async () => {
    await openWith(annotation(id));
    await clickAction(id, "Edit");
    expect(document.querySelector(".comment-composer")).not.toBeNull();
  });
});
