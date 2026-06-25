# Glance — Phase 1: Frontend Logic Core

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. See [index](plan.md) for goal/architecture/global constraints — they apply to every task here.

**Phase goal:** Scaffold the Tauri v2 project and build the pure, framework-free, fully unit-tested logic modules: the document model + dirty tracking, the tab store (open/close/focus/dedupe), the markdown renderer, and the reload decision. No UI and no Rust logic in this phase (the `src-tauri` scaffold exists but stays as generated).

**Global constraints (recap):** macOS only · pnpm only · Tauri v2 · vanilla TS · GFM · default rendered · no autosave · highlight.js.

---

### Task 1: Scaffold Tauri v2 project with vitest

**Files:**
- Create: whole Tauri scaffold at repo root (`package.json`, `vite.config.ts`, `index.html`, `tsconfig.json`, `src/`, `src-tauri/`)
- Create: `vitest.config.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a runnable dev app (`pnpm tauri dev`) and a working test runner (`pnpm test`). Later tasks add modules under `src/` and import them in tests under `src/*.test.ts`.

- [ ] **Step 1: Scaffold the app**

Run from repo root (`~/dev/glance`):

```bash
pnpm create tauri-app@latest . --template vanilla-ts --manager pnpm --yes
pnpm install
```

This generates `src/` (frontend), `src-tauri/` (Rust, Tauri v2), `index.html`, `vite.config.ts`, `tsconfig.json`, and adds `tauri` scripts to `package.json`. If the directory-not-empty prompt blocks `--yes`, scaffold into a temp dir and move files in, preserving the existing `docs/` and `.git`.

- [ ] **Step 2: Set the product name and identifier**

Edit `src-tauri/tauri.conf.json`: set `"productName": "Glance"`, `"identifier": "fun.sibi.glance"`, and under `app.windows[0]` set `"title": "Glance"`, `"width": 1000`, `"height": 720`.

- [ ] **Step 3: Add vitest + test deps**

```bash
pnpm add -D vitest
pnpm add markdown-it markdown-it-task-lists highlight.js
pnpm add -D @types/markdown-it
```

- [ ] **Step 4: Add the test config and script**

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

Add to `package.json` `scripts`: `"test": "vitest run"`, `"test:watch": "vitest"`.

- [ ] **Step 5: Add a smoke test**

Create `src/smoke.test.ts`:

```ts
import { describe, it, expect } from "vitest";

describe("smoke", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 6: Run the smoke test — verify it passes**

Run: `pnpm test`
Expected: 1 passed.

- [ ] **Step 7: Verify the app builds + launches**

Run: `pnpm tauri dev`
Expected: a blank "Glance" window opens (the default Tauri template page). Close it. (If Rust toolchain is missing, install via `rustup` first.)

- [ ] **Step 8: Delete the smoke test and commit**

```bash
rm src/smoke.test.ts
git add -A
git commit -m "chore: scaffold Glance Tauri v2 app with vitest"
```

---

### Task 2: Document model + dirty tracking

**Files:**
- Create: `src/document.ts`
- Test: `src/document.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ViewMode = "rendered" | "source"`
  - `interface Doc { id: string; absPath: string; fileName: string; diskContent: string; editorContent: string; viewMode: ViewMode; existsOnDisk: boolean }`
  - `createDoc(absPath: string, diskContent: string): Doc`
  - `isDirty(doc: Doc): boolean`
  - `basename(path: string): string`

- [ ] **Step 1: Write the failing test**

Create `src/document.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createDoc, isDirty, basename } from "./document";

describe("document", () => {
  it("createDoc starts clean, rendered, and exists", () => {
    const d = createDoc("/a/b/notes.md", "# Hi");
    expect(d.id).toBe("/a/b/notes.md");
    expect(d.absPath).toBe("/a/b/notes.md");
    expect(d.fileName).toBe("notes.md");
    expect(d.diskContent).toBe("# Hi");
    expect(d.editorContent).toBe("# Hi");
    expect(d.viewMode).toBe("rendered");
    expect(d.existsOnDisk).toBe(true);
    expect(isDirty(d)).toBe(false);
  });

  it("isDirty true once editorContent diverges", () => {
    const d = { ...createDoc("/x.md", "a"), editorContent: "b" };
    expect(isDirty(d)).toBe(true);
  });

  it("basename handles nested and bare paths", () => {
    expect(basename("/a/b/c.md")).toBe("c.md");
    expect(basename("c.md")).toBe("c.md");
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `pnpm test src/document.test.ts`
Expected: FAIL — cannot find module `./document`.

- [ ] **Step 3: Implement**

Create `src/document.ts`:

```ts
export type ViewMode = "rendered" | "source";

export interface Doc {
  id: string;
  absPath: string;
  fileName: string;
  diskContent: string;
  editorContent: string;
  viewMode: ViewMode;
  existsOnDisk: boolean;
}

export function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

export function createDoc(absPath: string, diskContent: string): Doc {
  return {
    id: absPath,
    absPath,
    fileName: basename(absPath),
    diskContent,
    editorContent: diskContent,
    viewMode: "rendered",
    existsOnDisk: true,
  };
}

export function isDirty(doc: Doc): boolean {
  return doc.editorContent !== doc.diskContent;
}
```

- [ ] **Step 4: Run — verify it passes**

Run: `pnpm test src/document.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/document.ts src/document.test.ts
git commit -m "feat: document model with dirty tracking"
```

---

### Task 3: Tab store (open/close/focus/dedupe + edits)

**Files:**
- Create: `src/store.ts`
- Test: `src/store.test.ts`

**Interfaces:**
- Consumes: `Doc`, `createDoc`, `ViewMode` from `./document`.
- Produces (all pure, return a new `State`):
  - `interface State { docs: Doc[]; activeId: string | null }`
  - `emptyState(): State`
  - `openDoc(s: State, absPath: string, diskContent: string): State` — dedupe by absPath, focus if present
  - `closeDoc(s: State, id: string): State`
  - `setActive(s: State, id: string): State`
  - `updateEditorContent(s: State, id: string, content: string): State`
  - `toggleViewMode(s: State, id: string): State`
  - `markSaved(s: State, id: string): State` — set `diskContent = editorContent`
  - `applyDiskChange(s: State, id: string, diskContent: string): State` — set both `diskContent` and `editorContent` (used for clean auto-reload and "Load disk")
  - `getActive(s: State): Doc | null`

- [ ] **Step 1: Write the failing test**

Create `src/store.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  emptyState, openDoc, closeDoc, setActive, updateEditorContent,
  toggleViewMode, markSaved, applyDiskChange, getActive,
} from "./store";
import { isDirty } from "./document";

describe("store", () => {
  it("opens a doc and makes it active", () => {
    const s = openDoc(emptyState(), "/a.md", "A");
    expect(s.docs).toHaveLength(1);
    expect(s.activeId).toBe("/a.md");
  });

  it("dedupes by absPath and just focuses", () => {
    let s = openDoc(emptyState(), "/a.md", "A");
    s = openDoc(s, "/b.md", "B");
    s = openDoc(s, "/a.md", "A-newer"); // already open
    expect(s.docs).toHaveLength(2);
    expect(s.activeId).toBe("/a.md");
    expect(getActive(s)!.diskContent).toBe("A"); // not replaced
  });

  it("closing the active doc activates a neighbor", () => {
    let s = openDoc(emptyState(), "/a.md", "A");
    s = openDoc(s, "/b.md", "B");
    s = closeDoc(s, "/b.md");
    expect(s.docs).toHaveLength(1);
    expect(s.activeId).toBe("/a.md");
  });

  it("closing the last doc clears active", () => {
    let s = openDoc(emptyState(), "/a.md", "A");
    s = closeDoc(s, "/a.md");
    expect(s.docs).toHaveLength(0);
    expect(s.activeId).toBeNull();
  });

  it("edits mark dirty; markSaved clears it", () => {
    let s = openDoc(emptyState(), "/a.md", "A");
    s = updateEditorContent(s, "/a.md", "A!");
    expect(isDirty(getActive(s)!)).toBe(true);
    s = markSaved(s, "/a.md");
    expect(isDirty(getActive(s)!)).toBe(false);
    expect(getActive(s)!.diskContent).toBe("A!");
  });

  it("toggleViewMode flips rendered/source", () => {
    let s = openDoc(emptyState(), "/a.md", "A");
    expect(getActive(s)!.viewMode).toBe("rendered");
    s = toggleViewMode(s, "/a.md");
    expect(getActive(s)!.viewMode).toBe("source");
    s = toggleViewMode(s, "/a.md");
    expect(getActive(s)!.viewMode).toBe("rendered");
  });

  it("applyDiskChange replaces both disk and editor content", () => {
    let s = openDoc(emptyState(), "/a.md", "A");
    s = applyDiskChange(s, "/a.md", "A-from-disk");
    const d = getActive(s)!;
    expect(d.diskContent).toBe("A-from-disk");
    expect(d.editorContent).toBe("A-from-disk");
    expect(isDirty(d)).toBe(false);
  });

  it("setActive switches the active tab", () => {
    let s = openDoc(emptyState(), "/a.md", "A");
    s = openDoc(s, "/b.md", "B");
    s = setActive(s, "/a.md");
    expect(s.activeId).toBe("/a.md");
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `pnpm test src/store.test.ts`
Expected: FAIL — cannot find module `./store`.

- [ ] **Step 3: Implement**

Create `src/store.ts`:

```ts
import { Doc, ViewMode, createDoc } from "./document";

export interface State {
  docs: Doc[];
  activeId: string | null;
}

export function emptyState(): State {
  return { docs: [], activeId: null };
}

export function getActive(s: State): Doc | null {
  return s.docs.find((d) => d.id === s.activeId) ?? null;
}

function mapDoc(s: State, id: string, fn: (d: Doc) => Doc): State {
  return { ...s, docs: s.docs.map((d) => (d.id === id ? fn(d) : d)) };
}

export function openDoc(s: State, absPath: string, diskContent: string): State {
  const existing = s.docs.find((d) => d.absPath === absPath);
  if (existing) return { ...s, activeId: existing.id };
  const doc = createDoc(absPath, diskContent);
  return { docs: [...s.docs, doc], activeId: doc.id };
}

export function closeDoc(s: State, id: string): State {
  const idx = s.docs.findIndex((d) => d.id === id);
  if (idx === -1) return s;
  const docs = s.docs.filter((d) => d.id !== id);
  let activeId = s.activeId;
  if (activeId === id) {
    activeId = docs.length ? docs[Math.min(idx, docs.length - 1)].id : null;
  }
  return { docs, activeId };
}

export function setActive(s: State, id: string): State {
  return s.docs.some((d) => d.id === id) ? { ...s, activeId: id } : s;
}

export function updateEditorContent(s: State, id: string, content: string): State {
  return mapDoc(s, id, (d) => ({ ...d, editorContent: content }));
}

export function toggleViewMode(s: State, id: string): State {
  const next: Record<ViewMode, ViewMode> = { rendered: "source", source: "rendered" };
  return mapDoc(s, id, (d) => ({ ...d, viewMode: next[d.viewMode] }));
}

export function markSaved(s: State, id: string): State {
  return mapDoc(s, id, (d) => ({ ...d, diskContent: d.editorContent, existsOnDisk: true }));
}

export function applyDiskChange(s: State, id: string, diskContent: string): State {
  return mapDoc(s, id, (d) => ({
    ...d,
    diskContent,
    editorContent: diskContent,
    existsOnDisk: true,
  }));
}
```

- [ ] **Step 4: Run — verify it passes**

Run: `pnpm test src/store.test.ts`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts src/store.test.ts
git commit -m "feat: tab store with dedupe, edit, and reload state transitions"
```

---

### Task 4: Markdown renderer (GFM + syntax highlight)

**Files:**
- Create: `src/renderer.ts`
- Test: `src/renderer.test.ts`

**Interfaces:**
- Consumes: `markdown-it`, `markdown-it-task-lists`, `highlight.js`.
- Produces: `renderMarkdown(src: string): string` — returns an HTML string.

- [ ] **Step 1: Write the failing test**

Create `src/renderer.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderMarkdown } from "./renderer";

describe("renderMarkdown", () => {
  it("renders headings", () => {
    expect(renderMarkdown("# Hi")).toContain("<h1>Hi</h1>");
  });

  it("renders GFM tables", () => {
    const html = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain("<table>");
    expect(html).toContain("<td>1</td>");
  });

  it("renders task lists as checkboxes", () => {
    const html = renderMarkdown("- [x] done\n- [ ] todo");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("checked");
  });

  it("renders strikethrough", () => {
    expect(renderMarkdown("~~gone~~")).toContain("<s>gone</s>");
  });

  it("highlights fenced code with a language class", () => {
    const html = renderMarkdown("```js\nconst x = 1;\n```");
    expect(html).toContain("hljs");
    expect(html).toContain("language-js");
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `pnpm test src/renderer.test.ts`
Expected: FAIL — cannot find module `./renderer`.

- [ ] **Step 3: Implement**

Create `src/renderer.ts`:

```ts
import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import hljs from "highlight.js";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
  highlight(code, lang): string {
    const language = lang && hljs.getLanguage(lang) ? lang : "";
    const cls = `hljs language-${lang || "plaintext"}`;
    if (language) {
      try {
        const out = hljs.highlight(code, { language }).value;
        return `<pre><code class="${cls}">${out}</code></pre>`;
      } catch {
        /* fall through to escaped */
      }
    }
    const escaped = md.utils.escapeHtml(code);
    return `<pre><code class="${cls}">${escaped}</code></pre>`;
  },
});

md.use(taskLists);

export function renderMarkdown(src: string): string {
  return md.render(src);
}
```

- [ ] **Step 4: Run — verify it passes**

Run: `pnpm test src/renderer.test.ts`
Expected: 5 passed. (markdown-it renders `~~x~~` as `<s>`; tables and the `highlight` hook's `language-js` class satisfy the assertions.)

- [ ] **Step 5: Commit**

```bash
git add src/renderer.ts src/renderer.test.ts
git commit -m "feat: GFM markdown renderer with syntax highlighting"
```

---

### Task 5: Reload decision

**Files:**
- Create: `src/reload.ts`
- Test: `src/reload.test.ts`

**Interfaces:**
- Consumes: `Doc`, `isDirty` from `./document`.
- Produces:
  - `type ReloadAction = "auto-reload" | "prompt"`
  - `decideReload(doc: Doc): ReloadAction` — `"prompt"` if dirty, else `"auto-reload"`

- [ ] **Step 1: Write the failing test**

Create `src/reload.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { decideReload } from "./reload";
import { createDoc } from "./document";

describe("decideReload", () => {
  it("auto-reloads a clean doc", () => {
    expect(decideReload(createDoc("/a.md", "A"))).toBe("auto-reload");
  });

  it("prompts when the doc is dirty", () => {
    const dirty = { ...createDoc("/a.md", "A"), editorContent: "A-edited" };
    expect(decideReload(dirty)).toBe("prompt");
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `pnpm test src/reload.test.ts`
Expected: FAIL — cannot find module `./reload`.

- [ ] **Step 3: Implement**

Create `src/reload.ts`:

```ts
import { Doc, isDirty } from "./document";

export type ReloadAction = "auto-reload" | "prompt";

export function decideReload(doc: Doc): ReloadAction {
  return isDirty(doc) ? "prompt" : "auto-reload";
}
```

- [ ] **Step 4: Run — verify it passes**

Run: `pnpm test src/reload.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Run the whole suite and commit**

```bash
pnpm test
git add src/reload.ts src/reload.test.ts
git commit -m "feat: reload decision (clean auto-reload vs dirty prompt)"
```

Expected: all Phase 1 suites pass (document, store, renderer, reload).

---

**Phase 1 done when:** `pnpm test` is green across document/store/renderer/reload, and `pnpm tauri dev` opens a blank Glance window. No UI behavior yet — that is Phase 3.
