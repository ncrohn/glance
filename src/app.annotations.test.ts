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
  // While set, resolveAnchors waits until released, so a test can make one
  // resolve finish after a later one.
  holdResolves: false,
  held: [] as (() => void)[],
};

// Like the Rust resolver for an exact match: the 1-based line the quote starts on.
function lineOf(text: string, quote: string): number | null {
  const at = text.indexOf(quote);
  return at === -1 ? null : text.slice(0, at).split("\n").length;
}

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
  resolveAnchors: async (text: string, list: Annotation[]) => {
    if (env.holdResolves) await new Promise<void>((r) => env.held.push(r));
    return list.map((a) => {
      const line = lineOf(text, a.quote);
      return { id: a.id, startLine: line, endLine: line, anchor: line == null ? "orphaned" : "exact" };
    });
  },
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
  env.holdResolves = false;
  env.held = [];
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

describe("comment positions follow the document text", () => {
  const lineLabel = (id: string) => cardFor(id).querySelector(".note-line")?.textContent;
  const highlightLine = () =>
    document.querySelector("#content mark.anno-highlight")?.closest("[data-sourceline]")?.getAttribute("data-sourceline");
  const emit = async (name: string, payload: unknown) => { void env.handlers.get(name)!(payload); await flush(); };
  const diskChange = (contents: string) => emit("file-changed", { path: "/a.md", contents });
  const toggleMode = async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "e", metaKey: true }));
    await flush();
  };
  async function typeAtStart(text: string) {
    const { EditorView } = await import("@codemirror/view");
    if (!document.querySelector(".cm-editor")) await toggleMode();
    const v = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement)!;
    v.dispatch({ changes: { from: 0, insert: text } });
  }

  it("moves the rail line and highlight when an outside edit adds lines above the quote", async () => {
    await openWith(annotation("x"));
    expect(lineLabel("x")).toBe("L1");
    expect(highlightLine()).toBe("1");
    await diskChange("one\n\ntwo\n\nhello world\n");
    expect(lineLabel("x")).toBe("L5");
    expect(highlightLine()).toBe("5");
  });

  it("keeps the newer position when a resolve for the old text finishes last", async () => {
    await openWith(annotation("x"));
    // A store write lands first and its resolve runs against the old text.
    env.holdResolves = true;
    await emit("annotations-changed", "/a.md");
    env.holdResolves = false;
    await diskChange("one\n\ntwo\n\nhello world\n");
    expect(lineLabel("x")).toBe("L5");
    for (const release of env.held.splice(0)) release();
    await flush();
    expect(lineLabel("x")).toBe("L5");
    expect(highlightLine()).toBe("5");
  });

  it("re-resolves text typed in Edit on the way back to Read", async () => {
    await openWith(annotation("x"));
    await typeAtStart("new\n\nlines\n\n");
    await toggleMode();
    expect(document.querySelector(".cm-editor")).toBeNull();
    expect(lineLabel("x")).toBe("L5");
    expect(highlightLine()).toBe("5");
  });

  it("re-resolves after Load disk replaces unsaved edits", async () => {
    await openWith(annotation("x"));
    await typeAtStart("draft\n\n");
    await toggleMode();
    expect(lineLabel("x")).toBe("L3");
    await diskChange("one\n\ntwo\n\nthree\n\nhello world\n");
    const load = Array.from(document.querySelectorAll<HTMLButtonElement>("#modal-root button"))
      .find((b) => b.textContent === "Load disk")!;
    load.click();
    await flush();
    expect(lineLabel("x")).toBe("L7");
    expect(highlightLine()).toBe("7");
  });

  it("a keystroke while positions catch up doesn't undo an outside edit", async () => {
    const { EditorView } = await import("@codemirror/view");
    await openWith(annotation("x"));
    await toggleMode();
    env.holdResolves = true;
    const agent = "AGENT REWRITE\n\nhello world\n";
    env.fs.set("/a.md", agent);
    await diskChange(agent);
    const v = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement)!;
    expect(v.state.doc.toString()).toBe(agent);
    v.dispatch({ changes: { from: v.state.doc.length, insert: "k" } });
    env.holdResolves = false;
    for (const release of env.held.splice(0)) release();
    await flush();
    await emit("menu-save", undefined);
    expect(env.fs.get("/a.md")).toBe(agent + "k");
  });
});
