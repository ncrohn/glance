# Glance — Phase 3: UI + IPC Wiring

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. See [index](plan.md) for goal/architecture/global constraints — they apply to every task here.

**Phase goal:** Assemble the running app: an IPC layer over Tauri commands/events, a DOM tab bar + content pane driven by the Phase 1 store, the CodeMirror source editor with the ⌘E rendered↔source toggle, ⌘S save with a per-tab dirty dot, the `open-file`/`file-changed` event wiring with the conflict prompt, plus a native menu and macOS light/dark theming.

This phase is mostly DOM/integration, so tasks end with **explicit manual verification** (exact actions + expected result) rather than unit tests. The pure logic they depend on is already tested in Phase 1.

**Global constraints (recap):** default rendered · ⌘E toggle (no split) · ⌘S explicit save · clean→auto-reload, dirty→prompt · dedupe by absPath · follow macOS light/dark.

---

### Task 1: IPC layer

**Files:**
- Create: `src/ipc.ts`
- Modify: `package.json` (add `@tauri-apps/api` if not present from scaffold)

**Interfaces:**
- Consumes: Tauri commands `read_file`, `write_file`, `watch_file`, `unwatch_file`; events `open-file`, `file-changed` (from Phase 2).
- Produces:
  - `readFile(path: string): Promise<string>`
  - `writeFile(path: string, contents: string): Promise<void>`
  - `watchFile(path: string): Promise<void>`
  - `unwatchFile(path: string): Promise<void>`
  - `onOpenFile(cb: (absPath: string) => void): Promise<UnlistenFn>`
  - `onFileChanged(cb: (e: { path: string; contents: string }) => void): Promise<UnlistenFn>`

- [ ] **Step 1: Ensure the API package is installed**

```bash
pnpm add @tauri-apps/api
```

- [ ] **Step 2: Implement the IPC wrappers**

Create `src/ipc.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export function readFile(path: string): Promise<string> {
  return invoke<string>("read_file", { path });
}

export function writeFile(path: string, contents: string): Promise<void> {
  return invoke<void>("write_file", { path, contents });
}

export function watchFile(path: string): Promise<void> {
  return invoke<void>("watch_file", { path });
}

export function unwatchFile(path: string): Promise<void> {
  return invoke<void>("unwatch_file", { path });
}

export function onOpenFile(cb: (absPath: string) => void): Promise<UnlistenFn> {
  return listen<string>("open-file", (e) => cb(e.payload));
}

export function onFileChanged(
  cb: (e: { path: string; contents: string }) => void,
): Promise<UnlistenFn> {
  return listen<{ path: string; contents: string }>("file-changed", (e) => cb(e.payload));
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/ipc.ts package.json pnpm-lock.yaml
git commit -m "feat: IPC layer over Tauri commands and events"
```

---

### Task 2: App shell, tab bar, and rendered view

**Files:**
- Modify: `index.html`
- Create: `src/styles.css`
- Create: `src/app.ts` (the app controller — holds the single mutable `State`, renders DOM)
- Modify: `src/main.ts` (bootstrap → call into `src/app.ts`)

**Interfaces:**
- Consumes: Phase 1 `store.ts`, `document.ts`, `renderer.ts`; Phase 3 `ipc.ts`.
- Produces: a global `App` controller object in `src/app.ts`:
  - `start(): Promise<void>` — sets up listeners and first render
  - internal `render()` — rebuilds tab bar + content pane from `state`
  - `openPath(absPath: string): Promise<void>` — read file, `openDoc`, `watchFile`, render

- [ ] **Step 1: Set up the HTML shell**

Replace `index.html` body with:

```html
<body>
  <div id="tabbar"></div>
  <div id="content"></div>
  <div id="modal-root"></div>
  <script type="module" src="/src/main.ts"></script>
</body>
```

- [ ] **Step 2: Add styles**

Create `src/styles.css`:

```css
:root {
  color-scheme: light dark;
  --bg: #ffffff; --fg: #1d1d1f; --muted: #6b6b70;
  --tabbar-bg: #f2f2f4; --tab-active: #ffffff; --border: #d9d9de; --accent: #0a84ff;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1e1e1e; --fg: #e6e6e6; --muted: #9a9aa0;
    --tabbar-bg: #2a2a2a; --tab-active: #1e1e1e; --border: #3a3a3a; --accent: #0a84ff;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100vh; overflow: hidden; }
body { display: flex; flex-direction: column; background: var(--bg); color: var(--fg);
  font: 14px/1.5 -apple-system, system-ui, sans-serif; }
#tabbar { display: flex; gap: 2px; background: var(--tabbar-bg); border-bottom: 1px solid var(--border);
  padding: 6px 6px 0; overflow-x: auto; min-height: 36px; }
.tab { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border: 1px solid var(--border);
  border-bottom: none; border-radius: 8px 8px 0 0; background: transparent; cursor: default; white-space: nowrap; }
.tab.active { background: var(--tab-active); }
.tab .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); visibility: hidden; }
.tab.dirty .dot { visibility: visible; }
.tab .close { color: var(--muted); cursor: pointer; padding: 0 2px; }
#content { flex: 1; overflow: auto; }
.rendered { padding: 28px 40px; max-width: 820px; margin: 0 auto; }
.rendered table { border-collapse: collapse; }
.rendered th, .rendered td { border: 1px solid var(--border); padding: 4px 10px; }
.rendered pre { background: var(--tabbar-bg); padding: 12px; border-radius: 8px; overflow-x: auto; }
.cm-host { height: 100%; }
.empty { padding: 40px; color: var(--muted); }
.empty li { cursor: pointer; color: var(--accent); list-style: none; }
.modal { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,0.3); }
.modal .box { background: var(--bg); border: 1px solid var(--border); border-radius: 12px; padding: 20px; max-width: 420px; }
.modal button { margin: 12px 8px 0 0; padding: 6px 14px; }
```

- [ ] **Step 3: Implement the app controller (tab bar + rendered view only)**

Create `src/app.ts`:

```ts
import "./styles.css";
import "highlight.js/styles/github.css";
import {
  State, emptyState, openDoc, closeDoc, setActive, getActive,
} from "./store";
import { isDirty } from "./document";
import { renderMarkdown } from "./renderer";
import { readFile, watchFile, unwatchFile, onOpenFile, onFileChanged } from "./ipc";

let state: State = emptyState();

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function renderTabBar(): void {
  const bar = document.getElementById("tabbar")!;
  bar.innerHTML = "";
  for (const d of state.docs) {
    const tab = el("div", "tab");
    if (d.id === state.activeId) tab.classList.add("active");
    if (isDirty(d)) tab.classList.add("dirty");
    tab.appendChild(el("span", "dot"));
    const label = el("span", "label", d.fileName);
    label.onclick = () => { state = setActive(state, d.id); render(); };
    tab.appendChild(label);
    const close = el("span", "close", "×");
    close.onclick = (ev) => { ev.stopPropagation(); closeTab(d.id); };
    tab.appendChild(close);
    bar.appendChild(tab);
  }
}

function renderContent(): void {
  const host = document.getElementById("content")!;
  host.innerHTML = "";
  const doc = getActive(state);
  if (!doc) {
    host.appendChild(el("div", "empty", "No document open."));
    return;
  }
  // Phase 3 Task 3 replaces this branch with the source editor when viewMode === "source".
  const view = el("div", "rendered");
  view.innerHTML = renderMarkdown(doc.editorContent);
  host.appendChild(view);
}

export function render(): void {
  renderTabBar();
  renderContent();
}

function closeTab(id: string): void {
  const doc = state.docs.find((d) => d.id === id);
  if (doc) void unwatchFile(doc.absPath);
  state = closeDoc(state, id);
  render();
}

export async function openPath(absPath: string): Promise<void> {
  const already = state.docs.find((d) => d.absPath === absPath);
  if (already) { state = setActive(state, absPath); render(); return; }
  const contents = await readFile(absPath);
  state = openDoc(state, absPath, contents);
  await watchFile(absPath);
  render();
}

export async function start(): Promise<void> {
  await onOpenFile((absPath) => { void openPath(absPath); });
  await onFileChanged((e) => { /* Task 4 wires reload logic here */ void e; });
  render();
}
```

- [ ] **Step 4: Bootstrap from main.ts**

Replace `src/main.ts` with:

```ts
import { start } from "./app";
start();
```

- [ ] **Step 5: Manual verification**

Create a test doc: `printf '# Hello\n\n- [x] a\n- [ ] b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n' > /tmp/glance-test.md`

Run `pnpm tauri dev`, then from another terminal run `./src-tauri/target/debug/glance /tmp/glance-test.md`.

Expected:
- A tab labeled `glance-test.md` appears and is active.
- The content pane shows a rendered H1, a checked + unchecked checkbox, and a bordered table.
- Running the same command again does **not** add a second tab (dedupe).
- Opening a second file adds a second tab; clicking a tab label switches content; clicking `×` closes it.

- [ ] **Step 6: Commit**

```bash
git add index.html src/styles.css src/app.ts src/main.ts
git commit -m "feat: app shell, tab bar, and rendered markdown view"
```

---

### Task 3: CodeMirror source editor + ⌘E toggle

**Files:**
- Create: `src/editor.ts`
- Modify: `src/app.ts` (render source view; bind ⌘E)
- Modify: `package.json` (CodeMirror deps)

**Interfaces:**
- Consumes: `toggleViewMode`, `updateEditorContent` from `store.ts`.
- Produces: `mountEditor(host: HTMLElement, initial: string, onChange: (v: string) => void): { destroy(): void }`

- [ ] **Step 1: Add CodeMirror**

```bash
pnpm add codemirror @codemirror/lang-markdown @codemirror/view @codemirror/state
```

- [ ] **Step 2: Implement the editor wrapper**

Create `src/editor.ts`:

```ts
import { EditorView, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";

export function mountEditor(
  host: HTMLElement,
  initial: string,
  onChange: (v: string) => void,
): { destroy(): void } {
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: initial,
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown(),
        EditorView.lineWrapping,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChange(u.state.doc.toString());
        }),
      ],
    }),
  });
  return { destroy: () => view.destroy() };
}
```

> `@codemirror/commands` ships transitively with the `codemirror` meta-package; if the import fails, run `pnpm add @codemirror/commands`.

- [ ] **Step 3: Render the source view and bind ⌘E in app.ts**

In `src/app.ts`: import `toggleViewMode, updateEditorContent` from `./store` and `mountEditor` from `./editor`. Track a live editor handle so it can be destroyed on re-render:

```ts
import { mountEditor } from "./editor";
import { toggleViewMode, updateEditorContent } from "./store";

let activeEditor: { destroy(): void } | null = null;
```

Replace `renderContent()` with:

```ts
function renderContent(): void {
  const host = document.getElementById("content")!;
  if (activeEditor) { activeEditor.destroy(); activeEditor = null; }
  host.innerHTML = "";
  const doc = getActive(state);
  if (!doc) { host.appendChild(el("div", "empty", "No document open.")); return; }

  if (doc.viewMode === "source") {
    const cmHost = el("div", "cm-host");
    host.appendChild(cmHost);
    activeEditor = mountEditor(cmHost, doc.editorContent, (v) => {
      state = updateEditorContent(state, doc.id, v);
      renderTabBar(); // refresh dirty dot without tearing down the editor
    });
  } else {
    const view = el("div", "rendered");
    view.innerHTML = renderMarkdown(doc.editorContent);
    host.appendChild(view);
  }
}
```

Add a global keydown handler at the end of `start()` (before `render()`):

```ts
window.addEventListener("keydown", (e) => {
  if (e.metaKey && (e.key === "e" || e.key === "E")) {
    e.preventDefault();
    const doc = getActive(state);
    if (doc) { state = toggleViewMode(state, doc.id); render(); }
  }
});
```

- [ ] **Step 4: Manual verification**

Run `pnpm tauri dev`, open `/tmp/glance-test.md`.
Expected:
- Opens in rendered mode.
- ⌘E switches to a CodeMirror source editor showing the raw markdown; ⌘E again returns to rendered, reflecting any edits.
- Typing in source mode makes the tab's dirty dot appear.

- [ ] **Step 5: Commit**

```bash
git add src/editor.ts src/app.ts package.json pnpm-lock.yaml
git commit -m "feat: CodeMirror source editor with Cmd-E rendered/source toggle"
```

---

### Task 4: ⌘S save + smart reload + conflict prompt

**Files:**
- Modify: `src/app.ts`
- Create: `src/modal.ts` (Keep mine / Load disk prompt)

**Interfaces:**
- Consumes: `writeFile` (ipc); `markSaved`, `applyDiskChange` (store); `decideReload` (reload).
- Produces: `confirmReload(fileName: string): Promise<"mine" | "disk">` in `src/modal.ts`

- [ ] **Step 1: Implement the modal**

Create `src/modal.ts`:

```ts
export function confirmReload(fileName: string): Promise<"mine" | "disk"> {
  return new Promise((resolve) => {
    const root = document.getElementById("modal-root")!;
    root.innerHTML = "";
    const overlay = document.createElement("div");
    overlay.className = "modal";
    const box = document.createElement("div");
    box.className = "box";
    box.innerHTML = `<p><strong>${fileName}</strong> changed on disk while you have unsaved edits.</p>`;
    const keep = document.createElement("button");
    keep.textContent = "Keep mine";
    const load = document.createElement("button");
    load.textContent = "Load disk";
    const done = (r: "mine" | "disk") => { root.innerHTML = ""; resolve(r); };
    keep.onclick = () => done("mine");
    load.onclick = () => done("disk");
    box.appendChild(keep); box.appendChild(load);
    overlay.appendChild(box); root.appendChild(overlay);
  });
}
```

- [ ] **Step 2: Wire ⌘S in app.ts**

Add to the keydown handler:

```ts
if (e.metaKey && (e.key === "s" || e.key === "S")) {
  e.preventDefault();
  const doc = getActive(state);
  if (doc) {
    void writeFile(doc.absPath, doc.editorContent).then(() => {
      state = markSaved(state, doc.id);
      render();
    });
  }
}
```

Add imports: `import { writeFile } from "./ipc";` (extend existing ipc import), `import { markSaved, applyDiskChange } from "./store";`, `import { decideReload } from "./reload";`, `import { confirmReload } from "./modal";`.

- [ ] **Step 3: Wire the file-changed handler**

Replace the `onFileChanged` registration in `start()`:

```ts
await onFileChanged(async (e) => {
  const doc = state.docs.find((d) => d.absPath === e.path);
  if (!doc) return;
  if (doc.editorContent === e.contents) return; // our own save echo — no-op
  if (decideReload(doc) === "auto-reload") {
    state = applyDiskChange(state, doc.id, e.contents);
    render();
  } else {
    const choice = await confirmReload(doc.fileName);
    if (choice === "disk") {
      state = applyDiskChange(state, doc.id, e.contents);
      render();
    }
    // "mine" → keep editor content; user's edits stay dirty
  }
});
```

- [ ] **Step 4: Manual verification**

Run `pnpm tauri dev`, open `/tmp/glance-test.md`.

Clean auto-reload:
- With the tab clean, from a terminal run `printf '# Changed by Claude\n' > /tmp/glance-test.md`.
- Expected: the rendered view updates automatically to "Changed by Claude", no prompt.

Dirty conflict:
- ⌘E to source, type an edit (dirty dot shows). From terminal, `printf '# External edit\n' > /tmp/glance-test.md`.
- Expected: a modal appears. "Keep mine" leaves your edit (still dirty); "Load disk" replaces content with "External edit" (clean).

Save:
- Edit in source, ⌘S. Expected: dirty dot clears; `cat /tmp/glance-test.md` shows your content.

- [ ] **Step 5: Commit**

```bash
git add src/app.ts src/modal.ts
git commit -m "feat: Cmd-S save, smart auto-reload, and dirty conflict prompt"
```

---

### Task 5: Native menu

**Files:**
- Modify: `src-tauri/src/main.rs`

**Interfaces:**
- Consumes: nothing new.
- Produces: a native macOS menu with standard app/edit items plus File ▸ Close Tab (⌘W) and View ▸ Toggle Source (⌘E), Save (⌘S). Menu items that map to existing keyboard handlers can rely on the webview handler; the menu primarily restores the standard macOS menu bar (which a custom Tauri window otherwise lacks).

- [ ] **Step 1: Build the menu in setup**

In `src-tauri/src/main.rs`, inside `.setup(...)` (before emitting open files), construct the default menu so standard shortcuts (copy/paste/quit/minimize) work:

```rust
use tauri::menu::{Menu, MenuItem, Submenu, PredefinedMenuItem};

let app_handle = app.handle();
let app_menu = Submenu::with_items(
    app_handle,
    "Glance",
    true,
    &[
        &PredefinedMenuItem::hide(app_handle, None)?,
        &PredefinedMenuItem::quit(app_handle, None)?,
    ],
)?;
let edit_menu = Submenu::with_items(
    app_handle,
    "Edit",
    true,
    &[
        &PredefinedMenuItem::undo(app_handle, None)?,
        &PredefinedMenuItem::redo(app_handle, None)?,
        &PredefinedMenuItem::separator(app_handle)?,
        &PredefinedMenuItem::cut(app_handle, None)?,
        &PredefinedMenuItem::copy(app_handle, None)?,
        &PredefinedMenuItem::paste(app_handle, None)?,
        &PredefinedMenuItem::select_all(app_handle, None)?,
    ],
)?;
let menu = Menu::with_items(app_handle, &[&app_menu, &edit_menu])?;
app.set_menu(menu)?;
```

> ⌘E/⌘S/⌘W are handled in the webview keydown handler (Tasks 3–4 and Phase 4); the native menu here exists for standard editing shortcuts and Quit. Keep it minimal — do not duplicate app shortcuts as menu accelerators (that can double-fire).

- [ ] **Step 2: Build — verify it compiles**

Run: `cd src-tauri && cargo build`
Expected: builds clean. (If a `menu` API signature differs in the installed Tauri 2.x minor, consult the Tauri v2 menu docs and adjust item constructors — the structure stays the same.)

- [ ] **Step 3: Manual verification**

Run `pnpm tauri dev`. Expected: a macOS menu bar shows "Glance" and "Edit"; copy/paste work in the source editor; ⌘Q quits.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/main.rs
git commit -m "feat: native macOS menu with standard edit shortcuts"
```

---

**Phase 3 done when:** the app opens files into deduped tabs, renders GFM, ⌘E toggles to a CodeMirror editor, ⌘S saves and clears the dirty dot, external changes auto-reload clean tabs and prompt on dirty ones, and a native menu provides copy/paste/quit.
