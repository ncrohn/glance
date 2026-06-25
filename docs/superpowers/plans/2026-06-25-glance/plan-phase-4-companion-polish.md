# Glance — Phase 4: Companion Polish

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. See [index](plan.md) for goal/architecture/global constraints — they apply to every task here.

**Phase goal:** Finish the companion ergonomics: session restore (reopen last tabs), deleted-file handling, the no-args empty state with a recent-docs list, the `mdview` CLI wrapper, and an install script that builds the app and links `mdview`. After this phase the Definition of Done in the [index](plan.md) is fully met.

**Global constraints (recap):** macOS only · pnpm only · session restore via webview `localStorage` · single resident instance · CLI resolves to absolute paths.

---

### Task 1: Session persistence (pure, unit-tested)

**Files:**
- Create: `src/session.ts`
- Test: `src/session.test.ts`

**Interfaces:**
- Consumes: `State` from `store.ts`.
- Produces:
  - `openPaths(s: State): string[]` — absolute paths of all open docs, in tab order
  - `pushRecent(recent: string[], absPath: string, max?: number): string[]` — most-recent-first, deduped, capped (default 10)

These are pure so they can be tested; the `localStorage` read/write happens in `app.ts` (Task 2) using these helpers.

- [ ] **Step 1: Write the failing test**

Create `src/session.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { openPaths, pushRecent } from "./session";
import { emptyState, openDoc } from "./store";

describe("session", () => {
  it("openPaths returns open docs in tab order", () => {
    let s = openDoc(emptyState(), "/a.md", "A");
    s = openDoc(s, "/b.md", "B");
    expect(openPaths(s)).toEqual(["/a.md", "/b.md"]);
  });

  it("pushRecent puts newest first and dedupes", () => {
    let r = pushRecent([], "/a.md");
    r = pushRecent(r, "/b.md");
    r = pushRecent(r, "/a.md"); // re-open moves to front
    expect(r).toEqual(["/a.md", "/b.md"]);
  });

  it("pushRecent caps length", () => {
    let r: string[] = [];
    for (let i = 0; i < 15; i++) r = pushRecent(r, `/f${i}.md`, 10);
    expect(r).toHaveLength(10);
    expect(r[0]).toBe("/f14.md");
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `pnpm test src/session.test.ts`
Expected: FAIL — cannot find module `./session`.

- [ ] **Step 3: Implement**

Create `src/session.ts`:

```ts
import { State } from "./store";

export function openPaths(s: State): string[] {
  return s.docs.map((d) => d.absPath);
}

export function pushRecent(recent: string[], absPath: string, max = 10): string[] {
  const next = [absPath, ...recent.filter((p) => p !== absPath)];
  return next.slice(0, max);
}
```

- [ ] **Step 4: Run — verify it passes**

Run: `pnpm test src/session.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/session.ts src/session.test.ts
git commit -m "feat: session helpers (openPaths, pushRecent)"
```

---

### Task 2: Restore tabs on launch + recent-docs empty state

**Files:**
- Modify: `src/app.ts`

**Interfaces:**
- Consumes: `openPaths`, `pushRecent` (session); `readFile` (ipc).
- Produces: persistence of open paths + recent paths to `localStorage`; restore on `start()`; an empty-state list that reopens a recent doc on click.

- [ ] **Step 1: Add persistence helpers in app.ts**

Add near the top of `src/app.ts`:

```ts
import { openPaths, pushRecent } from "./session";

const LS_OPEN = "glance.openPaths";
const LS_RECENT = "glance.recent";

function loadRecent(): string[] {
  try { return JSON.parse(localStorage.getItem(LS_RECENT) || "[]"); } catch { return []; }
}
function saveSession(): void {
  localStorage.setItem(LS_OPEN, JSON.stringify(openPaths(state)));
}
```

- [ ] **Step 2: Persist on every state change**

Call `saveSession()` at the end of `render()` (so any open/close/reorder is captured), and update recent on open. In `openPath()`, after a successful read, record recent:

```ts
const recent = pushRecent(loadRecent(), absPath);
localStorage.setItem(LS_RECENT, JSON.stringify(recent));
```

- [ ] **Step 3: Restore on startup**

In `start()`, before the final `render()`, reopen previously-open paths (skip any that error, e.g. deleted):

```ts
let toRestore: string[] = [];
try { toRestore = JSON.parse(localStorage.getItem(LS_OPEN) || "[]"); } catch { /* ignore */ }
for (const p of toRestore) {
  try { await openPath(p); } catch { /* file gone; skip */ }
}
```

- [ ] **Step 4: Recent-docs empty state**

Update the no-doc branch in `renderContent()`:

```ts
if (!doc) {
  const empty = el("div", "empty");
  empty.appendChild(el("p", undefined, "No document open."));
  const recent = loadRecent();
  if (recent.length) {
    empty.appendChild(el("p", undefined, "Recent:"));
    const ul = el("ul");
    for (const p of recent) {
      const li = el("li", undefined, p);
      li.onclick = () => { void openPath(p); };
      ul.appendChild(li);
    }
    empty.appendChild(ul);
  }
  host.appendChild(empty);
  return;
}
```

- [ ] **Step 5: Manual verification**

Run `pnpm tauri dev`, open two files, quit (⌘Q), relaunch with `pnpm tauri dev`.
Expected: both tabs reopen. Close all tabs → empty state lists recent paths; clicking one reopens it.

- [ ] **Step 6: Commit**

```bash
git add src/app.ts
git commit -m "feat: session restore and recent-docs empty state"
```

---

### Task 3: Deleted-file handling

**Files:**
- Modify: `src/watcher.rs` (emit a delete signal) OR handle in frontend
- Modify: `src/app.ts`

**Interfaces:**
- Produces: when a watched file is removed, its tab is marked (visually) but its content is kept in memory; ⌘S recreates the file.

- [ ] **Step 1: Emit a removed event from the watcher**

In `src-tauri/src/watcher.rs`, extend the event handler to also signal removal. Add a second event for `EventKind::Remove`:

```rust
use notify::EventKind;
// inside the closure, after the Modify/Create branch:
if matches!(event.kind, EventKind::Remove(_)) {
    let _ = app2.emit("file-removed", path2.clone());
}
```

- [ ] **Step 2: Add an ipc listener**

In `src/ipc.ts`:

```ts
export function onFileRemoved(cb: (path: string) => void): Promise<UnlistenFn> {
  return listen<string>("file-removed", (e) => cb(e.payload));
}
```

- [ ] **Step 3: Handle removal in app.ts**

Add the `existsOnDisk` flag handling. In `store.ts` add:

```ts
export function markRemoved(s: State, absPath: string): State {
  return { ...s, docs: s.docs.map((d) => d.absPath === absPath ? { ...d, existsOnDisk: false } : d) };
}
```

In `start()` register:

```ts
import { onFileRemoved } from "./ipc";
import { markRemoved } from "./store";
await onFileRemoved((path) => { state = markRemoved(state, path); render(); });
```

Show the state in the tab — in `renderTabBar()`, when `!d.existsOnDisk`, append a marker:

```ts
if (!d.existsOnDisk) { const m = el("span", "removed", "(deleted)"); tab.appendChild(m); }
```

The existing ⌘S handler already recreates the file via `write_file` (which uses `fs::write`, creating the path); `markSaved` sets `existsOnDisk = true`, clearing the marker.

- [ ] **Step 4: Manual verification**

Open `/tmp/glance-test.md`, then `rm /tmp/glance-test.md`.
Expected: the tab shows "(deleted)". Edit + ⌘S recreates the file; marker clears; `cat /tmp/glance-test.md` shows content.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/watcher.rs src/ipc.ts src/store.ts src/app.ts
git commit -m "feat: deleted-file marker with recreate-on-save"
```

---

### Task 4: `mdview` CLI wrapper + install script

**Files:**
- Create: `bin/mdview`
- Create: `scripts/install.sh`

**Interfaces:**
- Consumes: the built `Glance.app` bundle.
- Produces: a `mdview <file...>` command that resolves each arg to an absolute path and launches/forwards to the running Glance instance.

- [ ] **Step 1: Write the CLI wrapper**

Create `bin/mdview`:

```bash
#!/usr/bin/env bash
set -euo pipefail

APP_BIN="/Applications/Glance.app/Contents/MacOS/glance"
if [[ ! -x "$APP_BIN" ]]; then
  echo "mdview: Glance.app not found at $APP_BIN. Run scripts/install.sh." >&2
  exit 1
fi

if [[ $# -eq 0 ]]; then
  exec "$APP_BIN"
fi

# Resolve every arg to an absolute path so forwarding works from any cwd.
abs_args=()
for f in "$@"; do
  if [[ -e "$f" ]]; then
    abs_args+=("$(cd "$(dirname "$f")" && pwd)/$(basename "$f")")
  else
    # Non-existent path: absolutize against cwd so the app can create-on-save.
    case "$f" in
      /*) abs_args+=("$f") ;;
      *)  abs_args+=("$PWD/$f") ;;
    esac
  fi
done

# Launching the binary while an instance runs triggers single-instance forwarding;
# the second process exits on its own.
exec "$APP_BIN" "${abs_args[@]}"
```

> The single-instance plugin forwards `argv` to the running instance and the second process exits. The wrapper does not need `open`; calling the bundle's executable directly preserves argv ordering.

- [ ] **Step 2: Write the install script**

Create `scripts/install.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Building Glance (release)…"
pnpm install
pnpm tauri build

APP_SRC="src-tauri/target/release/bundle/macos/Glance.app"
if [[ ! -d "$APP_SRC" ]]; then
  echo "Build did not produce $APP_SRC" >&2
  exit 1
fi

echo "Installing Glance.app to /Applications…"
rm -rf "/Applications/Glance.app"
cp -R "$APP_SRC" "/Applications/Glance.app"

# Link the CLI. Prefer the user's dotfiles bin if present, else /usr/local/bin.
DOTBIN="$HOME/dev/dotfiles/bin"
if [[ -d "$DOTBIN" ]]; then
  TARGET="$DOTBIN/mdview"
else
  TARGET="/usr/local/bin/mdview"
fi
chmod +x bin/mdview
ln -sf "$(pwd)/bin/mdview" "$TARGET"
echo "Linked mdview -> $TARGET"
echo "Done. Try: mdview README.md"
```

- [ ] **Step 3: Make scripts executable**

```bash
chmod +x bin/mdview scripts/install.sh
```

- [ ] **Step 4: Manual verification**

Run `bash scripts/install.sh`. Expected: build succeeds, `Glance.app` lands in `/Applications`, `mdview` is linked and on PATH (open a new shell or check the chosen target dir).

Then: `mdview /tmp/glance-test.md` → Glance launches and shows the file. From a different directory, `cd / && mdview tmp/glance-test.md` (relative) → focuses the running instance and opens the same file deduped (not a second tab, not a second window).

- [ ] **Step 5: Commit**

```bash
git add bin/mdview scripts/install.sh
git commit -m "feat: mdview CLI wrapper and install script"
```

---

### Task 5: Claude integration note + final verification

**Files:**
- Create: `README.md`

**Interfaces:** none.

- [ ] **Step 1: Write the README**

Create `README.md` documenting: what Glance is, `bash scripts/install.sh`, and a short "For Claude Code" section stating that Claude can open any markdown doc it creates with `mdview <path>` (works from any working directory; reuses the running window; auto-refreshes when a file is rewritten). Optionally suggest adding a line to the user's `~/.claude/CLAUDE.md` so Claude prefers `mdview` for surfacing markdown.

- [ ] **Step 2: Full Definition-of-Done sweep**

Verify each index DoD item against the installed app:
- `mdview file.md` from any dir → rendered tab in single window.
- Second `mdview` → focus/dedupe, no second process.
- ⌘E toggles; docs open rendered.
- External rewrite of a clean tab auto-updates; dirty tab prompts.
- ⌘S persists and clears the dot.
- Relaunch restores tabs.

Run `pnpm test` (all frontend suites) and `cd src-tauri && cargo test` (cli) — both green.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README with install and Claude integration notes"
```

---

**Phase 4 done when:** every Definition-of-Done item in the [index](plan.md) is verified on the installed app, `mdview` works from any directory, tabs restore across relaunch, and all unit tests pass.
