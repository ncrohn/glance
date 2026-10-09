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
const activeTab = () => document.querySelector<HTMLElement>("#tabs .tab.active")?.dataset.id ?? null;
const savedSession = () => JSON.parse(localStorage.getItem("glance.openPaths") ?? "null");
const toastText = () => document.querySelector(".toast-text")?.textContent ?? "";

beforeEach(() => {
  resetEnv();
  localStorage.clear();
  localStorage.setItem("glance.seenVersion", "0.0.0-test");
  localStorage.setItem("glance.commentHintSeen", "1");
  (globalThis as any).requestAnimationFrame ??= (cb: any) => setTimeout(cb, 0);
  (globalThis as any).ResizeObserver ??= class { observe() {} disconnect() {} };
  (window as any).matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  (globalThis as any).CSS ??= { escape: (s: string) => s };
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
