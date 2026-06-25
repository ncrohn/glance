# Glance — Phase 2: Rust Core

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. See [index](plan.md) for goal/architecture/global constraints — they apply to every task here.

**Phase goal:** Build the Rust side: `read_file`/`write_file` commands, a file watcher that emits `file-changed` events carrying full contents, and single-instance + CLI path resolution that emits `open-file` events for both the first launch and any forwarded invocation. Pure path logic is unit-tested with `cargo test`; command/watcher wiring is verified by build + a scripted manual check.

**Global constraints (recap):** macOS only · Tauri v2 · single instance · watcher payload carries full file contents · CLI resolves to absolute paths.

All Rust files live under `src-tauri/src/`. After adding a module file, declare it in `main.rs` with `mod <name>;`.

---

### Task 1: File read/write commands

**Files:**
- Create: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/main.rs` (register module + handlers)

**Interfaces:**
- Produces (callable from JS via `invoke`):
  - `read_file(path: String) -> Result<String, String>`
  - `write_file(path: String, contents: String) -> Result<(), String>`

- [ ] **Step 1: Implement the commands**

Create `src-tauri/src/commands.rs`:

```rust
use std::fs;

#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_file(path: String, contents: String) -> Result<(), String> {
    fs::write(&path, contents).map_err(|e| e.to_string())
}
```

- [ ] **Step 2: Register the module and handlers**

In `src-tauri/src/main.rs`, add `mod commands;` near the top, and add the handlers to the builder's `invoke_handler`:

```rust
.invoke_handler(tauri::generate_handler![
    commands::read_file,
    commands::write_file,
])
```

(If `invoke_handler` already exists from the template, extend its `generate_handler!` list rather than adding a second call.)

- [ ] **Step 3: Build — verify it compiles**

Run: `cd src-tauri && cargo build`
Expected: builds with no errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/main.rs
git commit -m "feat: read_file/write_file Tauri commands"
```

---

### Task 2: CLI path resolution (pure, cargo-tested)

**Files:**
- Create: `src-tauri/src/cli.rs`
- Modify: `src-tauri/src/main.rs` (`mod cli;`)

**Interfaces:**
- Produces:
  - `to_abs(path: &str, cwd: &std::path::Path) -> String` — absolute, lexically normalized (collapses `.`/`..`, no filesystem hit)
  - `md_paths_from_argv(argv: &[String]) -> Vec<String>` — argv minus program name and `-`flags

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/cli.rs` with the test module first (implementation stubs added next step):

```rust
use std::path::{Path, PathBuf};

pub fn to_abs(path: &str, cwd: &Path) -> String {
    let p = Path::new(path);
    let joined = if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) };
    normalize(&joined)
}

fn normalize(p: &Path) -> String {
    use std::path::Component::*;
    let mut out: Vec<std::ffi::OsString> = Vec::new();
    for comp in p.components() {
        match comp {
            CurDir => {}
            ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str().to_os_string()),
        }
    }
    let mut pb = PathBuf::new();
    for c in out {
        pb.push(c);
    }
    pb.to_string_lossy().to_string()
}

pub fn md_paths_from_argv(argv: &[String]) -> Vec<String> {
    argv.iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn absolute_path_passes_through_normalized() {
        assert_eq!(to_abs("/a/b/notes.md", Path::new("/cwd")), "/a/b/notes.md");
    }

    #[test]
    fn relative_path_joins_cwd() {
        assert_eq!(to_abs("notes.md", Path::new("/home/x")), "/home/x/notes.md");
    }

    #[test]
    fn dot_and_dotdot_collapse() {
        assert_eq!(to_abs("./a/../b/c.md", Path::new("/root")), "/root/b/c.md");
    }

    #[test]
    fn argv_drops_program_and_flags() {
        let argv = vec![
            "glance".to_string(),
            "--flag".to_string(),
            "/a.md".to_string(),
            "b.md".to_string(),
        ];
        assert_eq!(md_paths_from_argv(&argv), vec!["/a.md", "b.md"]);
    }
}
```

- [ ] **Step 2: Register the module**

In `src-tauri/src/main.rs` add `mod cli;`.

- [ ] **Step 3: Run the tests**

Run: `cd src-tauri && cargo test cli`
Expected: 4 passed (`absolute_path_passes_through_normalized`, `relative_path_joins_cwd`, `dot_and_dotdot_collapse`, `argv_drops_program_and_flags`).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/cli.rs src-tauri/src/main.rs
git commit -m "feat: CLI path resolution (to_abs + md_paths_from_argv) with tests"
```

---

### Task 3: File watcher emitting `file-changed`

**Files:**
- Create: `src-tauri/src/watcher.rs`
- Modify: `src-tauri/src/main.rs` (`mod watcher;`, register state + handlers)
- Modify: `src-tauri/Cargo.toml` (add `notify`, `serde`)

**Interfaces:**
- Consumes: none from earlier Rust tasks.
- Produces:
  - Tauri-managed state `Watchers` (map of path → watcher handle)
  - Commands: `watch_file(path: String, app, watchers) -> Result<(), String>`, `unwatch_file(path: String, watchers) -> Result<(), String>`
  - Event `"file-changed"` with payload `{ path: String, contents: String }`

- [ ] **Step 1: Add dependencies**

In `src-tauri/Cargo.toml` under `[dependencies]` add (keep existing tauri/serde lines):

```toml
notify = "6"
serde = { version = "1", features = ["derive"] }
```

- [ ] **Step 2: Implement the watcher**

Create `src-tauri/src/watcher.rs`:

```rust
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct Watchers(pub Mutex<HashMap<String, RecommendedWatcher>>);

#[derive(Clone, serde::Serialize)]
struct FileChanged {
    path: String,
    contents: String,
}

#[tauri::command]
pub fn watch_file(
    path: String,
    app: AppHandle,
    watchers: State<Watchers>,
) -> Result<(), String> {
    let mut map = watchers.0.lock().map_err(|e| e.to_string())?;
    if map.contains_key(&path) {
        return Ok(());
    }
    let app2 = app.clone();
    let path2 = path.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            if matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_)) {
                if let Ok(contents) = std::fs::read_to_string(&path2) {
                    let _ = app2.emit(
                        "file-changed",
                        FileChanged {
                            path: path2.clone(),
                            contents,
                        },
                    );
                }
            }
        }
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(Path::new(&path), RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;
    map.insert(path, watcher);
    Ok(())
}

#[tauri::command]
pub fn unwatch_file(path: String, watchers: State<Watchers>) -> Result<(), String> {
    let mut map = watchers.0.lock().map_err(|e| e.to_string())?;
    map.remove(&path); // dropping the watcher unwatches it
    Ok(())
}
```

> Note: the watcher targets the file path directly. In-place rewrites (how Claude's Write tool and most CLI writes behave) fire `Modify`. Editors that save via temp-file-rename may drop the watch — out of scope for v1; documented limitation.

- [ ] **Step 3: Register state, module, and handlers**

In `src-tauri/src/main.rs`: add `mod watcher;`, add `.manage(watcher::Watchers::default())` to the builder, and extend `generate_handler!` to include `watcher::watch_file, watcher::unwatch_file`.

- [ ] **Step 4: Build — verify it compiles**

Run: `cd src-tauri && cargo build`
Expected: builds with no errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/watcher.rs src-tauri/src/main.rs
git commit -m "feat: file watcher emitting file-changed with full contents"
```

---

### Task 4: Single-instance + open-file emission

**Files:**
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/Cargo.toml` (add `tauri-plugin-single-instance`)

**Interfaces:**
- Consumes: `cli::md_paths_from_argv`, `cli::to_abs`.
- Produces: emits `"open-file"` (payload: absolute path `String`) for each markdown path — on first launch (from `std::env::args`) and on every forwarded second invocation (single-instance callback). Focuses the main window on forwarded invocations.

- [ ] **Step 1: Add the plugin dependency**

In `src-tauri/Cargo.toml` under `[dependencies]`:

```toml
tauri-plugin-single-instance = "2"
```

- [ ] **Step 2: Wire single-instance + first-launch args**

Ensure `src-tauri/src/main.rs` looks like this (merging with handlers/state already added in prior tasks):

```rust
// Prevents an extra console window on Windows in release — harmless on macOS.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cli;
mod commands;
mod watcher;

use std::path::Path;
use tauri::{Emitter, Manager};

fn emit_open_files(app: &tauri::AppHandle, argv: &[String], cwd: &Path) {
    for raw in cli::md_paths_from_argv(argv) {
        let abs = cli::to_abs(&raw, cwd);
        let _ = app.emit("open-file", abs);
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let cwd_path = Path::new(&cwd);
            emit_open_files(app, &argv, cwd_path);
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .manage(watcher::Watchers::default())
        .invoke_handler(tauri::generate_handler![
            commands::read_file,
            commands::write_file,
            watcher::watch_file,
            watcher::unwatch_file,
        ])
        .setup(|app| {
            let argv: Vec<String> = std::env::args().collect();
            let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("/"));
            emit_open_files(&app.handle(), &argv, &cwd);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Glance");
}
```

> The frontend must register its `open-file` listener before this fires on first launch. Phase 3 handles that ordering; for now the emit is harmless if unheard.

- [ ] **Step 3: Build — verify it compiles**

Run: `cd src-tauri && cargo build`
Expected: builds with no errors.

- [ ] **Step 4: Manual single-instance check**

Run: `pnpm tauri dev` in one terminal. In a second terminal, run the dev binary again with an arg:

```bash
./src-tauri/target/debug/glance /tmp/anything.md
```

Expected: the second process exits immediately (does not open a new window); the first window gains focus. (No tab opens yet — the frontend listener arrives in Phase 3. Confirm the window focuses and no second window appears.)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/main.rs
git commit -m "feat: single-instance forwarding + open-file emission"
```

---

**Phase 2 done when:** `cargo test` passes (cli), `cargo build` is clean, and a second invocation of the binary focuses the running window instead of spawning a new one.
