# Glance ↔ Claude Annotation Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Claude session read the user's anchored review comments on a markdown file via an MCP server, while the user creates those comments by selecting text in Glance — plus one-click setup of the whole integration from inside the app.

**Architecture:** Annotations persist as per-document JSON on disk (`~/.glance/annotations/<sha1(absPath)>.json`). The GUI reads/writes via Tauri IPC and watches the store for live updates. A standalone native Rust binary `glance-mcp` (bundled inside `Glance.app`) is the stdio MCP server Claude spawns; it shares the anchor-resolution logic with the GUI. v1 is read+resolve only — Claude consumes user-authored annotations.

**Tech Stack:** Tauri 2, Rust (`glance_lib` + `glance-mcp` binary, `serde`, `serde_json`, `sha1`, `notify`), TypeScript (vanilla, vitest `node` env), markdown-it, CodeMirror 6.

## Global Constraints

- **No runtime deps on the user's machine.** The MCP server is a native binary bundled in `Glance.app`; no Node/pnpm required for end users. (TS is build-time only.)
- **All install/setup paths derive from `current_exe()` at click time** — nothing hardcoded; must work wherever `Glance.app` is installed.
- **Refuse setup from a translocated copy** — reuse the existing `AppTranslocation` guard (`src-tauri/src/cli_install.rs`).
- **Anchor resolution lives once, in Rust** (`src-tauri/src/anchor.rs`, in `glance_lib`), consumed by both the GUI (IPC) and `glance-mcp` (direct). TS never re-implements resolution.
- **TS logic modules stay pure** (vitest runs in `node` env — no DOM). DOM glue is thin and manually verified; pure helpers are unit-tested.
- **Reducers return new state, never mutate** — load-bearing for the full-rerender model.
- **Store JSON field names are camelCase** (`docPath`, `lineHint`, `createdAt`, `startLine`, `endLine`) — Rust serde uses `#[serde(rename = ...)]` to match.
- **v1 MCP surface is read+resolve only**: `list_annotations`, `get_annotation`, `resolve_annotation`, resource `glance://annotations/{path}`. No `add_annotation`/highlight (v2).

---

## File Structure

**Rust (`src-tauri/`):**
- `src/anchor.rs` — *new*. Pure anchor types + `resolve_anchor`. The heart.
- `src/annotations.rs` — *new*. `AnnotationStore` serde type, store path derivation, read/write, and the annotation Tauri commands.
- `src/bin/glance-mcp.rs` — *new*. Stdio MCP server binary. Pure `build_views`/`apply_resolve` + JSON-RPC loop.
- `src/setup.rs` — *new*. Multi-step "Set up Claude Integration": mdview wrapper + MCP registration + CLAUDE.md guidance. Pure merge helpers.
- `src/cli_install.rs` — *modify*. `install_cli_tool` stays; `setup.rs` calls it.
- `src/watcher.rs` — *modify*. Add `watch_annotations` command emitting `annotations-changed`.
- `src/lib.rs` — *modify*. Declare `mod anchor/annotations/setup`; register new commands; change menu item to "Set up Claude Integration"; emit `setup-result`.
- `Cargo.toml` — *modify*. Add `sha1` dep; declare `[[bin]]` for `glance` and `glance-mcp`.

**TypeScript (`src/`):**
- `src/annotations.ts` — *new*. Types + pure reducers over `Annotation[]`.
- `src/build-anchor.ts` — *new*. Pure `buildAnchor(fullText, start, end)` → `{quote, prefix, suffix}`.
- `src/anchor-capture.ts` — *new*. Thin DOM adapter: `Selection` → `{quote, prefix, suffix, lineHint}` (manually verified).
- `src/annotation-ui.ts` — *new*. Pure `groupAnnotations`; rail/highlight/toolbar DOM builders.
- `src/document.ts` / `src/store.ts` — *modify*. Add `annotations`/`resolutions` to `Doc`; store-level setters.
- `src/renderer.ts` — *modify*. Stamp `data-sourceline` on top-level block tokens.
- `src/ipc.ts` — *modify*. Wrappers for new commands + events.
- `src/app.ts` — *modify*. Load/watch annotations, render rail + highlights, wire selection toolbar.
- `src/renderer.test.ts` — *modify*. Update assertions for the new attribute.

**Docs:**
- `README.md` / `CLAUDE.md` — *modify*. Document the integration + setup.

---

## Task 1: Rust anchor engine (`anchor.rs`)

**Files:**
- Create: `src-tauri/src/anchor.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod anchor;`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `pub struct LineHint { pub start: usize, pub end: usize }` (serde camelCase fields are already camelCase)
  - `pub struct Annotation { id, quote, prefix, suffix, line_hint (rename "lineHint"), note, status, author, created_at (rename "createdAt") }` — all `String` except `line_hint: LineHint`.
  - `pub struct Resolution { id: String, start_line: Option<usize> (rename "startLine"), end_line: Option<usize> (rename "endLine"), anchor: String }` where `anchor` ∈ `"exact" | "quote-only" | "drifted" | "orphaned"`.
  - `pub fn resolve_anchor(text: &str, a: &Annotation) -> Resolution`

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/anchor.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct LineHint {
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Annotation {
    pub id: String,
    pub quote: String,
    pub prefix: String,
    pub suffix: String,
    #[serde(rename = "lineHint")]
    pub line_hint: LineHint,
    pub note: String,
    pub status: String,
    pub author: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Resolution {
    pub id: String,
    #[serde(rename = "startLine")]
    pub start_line: Option<usize>,
    #[serde(rename = "endLine")]
    pub end_line: Option<usize>,
    pub anchor: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ann(quote: &str, prefix: &str, suffix: &str, line: usize) -> Annotation {
        Annotation {
            id: "x".into(),
            quote: quote.into(),
            prefix: prefix.into(),
            suffix: suffix.into(),
            line_hint: LineHint { start: line, end: line },
            note: "n".into(),
            status: "open".into(),
            author: "user".into(),
            created_at: "t".into(),
        }
    }

    #[test]
    fn exact_match_recomputes_lines_after_insertion_above() {
        let a = ann("needle here", "the ", " end", 2);
        let text = "inserted line\nanother inserted\nthe needle here end\n";
        let r = resolve_anchor(text, &a);
        assert_eq!(r.anchor, "exact");
        assert_eq!(r.start_line, Some(3));
        assert_eq!(r.end_line, Some(3));
    }

    #[test]
    fn context_changed_but_unique_quote_is_quote_only() {
        let a = ann("unique phrase", "OLD ", " OLD", 1);
        let text = "totally different before unique phrase different after\n";
        let r = resolve_anchor(text, &a);
        assert_eq!(r.anchor, "quote-only");
        assert_eq!(r.start_line, Some(1));
    }

    #[test]
    fn duplicate_quote_disambiguated_by_line_hint() {
        let a = ann("dup", "", "", 3);
        let text = "dup\nx\ndup\nx\ndup\n"; // lines 1,3,5
        let r = resolve_anchor(text, &a);
        assert_eq!(r.anchor, "quote-only");
        assert_eq!(r.start_line, Some(3)); // nearest to hint 3
    }

    #[test]
    fn quote_gone_line_in_range_is_drifted() {
        let a = ann("vanished", "", "", 2);
        let text = "still here\nand here\nthird line\n";
        let r = resolve_anchor(text, &a);
        assert_eq!(r.anchor, "drifted");
        assert_eq!(r.start_line, Some(2));
    }

    #[test]
    fn quote_gone_line_out_of_range_is_orphaned() {
        let a = ann("vanished", "", "", 99);
        let text = "one\ntwo\n";
        let r = resolve_anchor(text, &a);
        assert_eq!(r.anchor, "orphaned");
        assert_eq!(r.start_line, None);
    }

    #[test]
    fn multiline_quote_spans_lines() {
        let a = ann("line two\nline three", "", "", 2);
        let text = "line one\nline two\nline three\nline four\n";
        let r = resolve_anchor(text, &a);
        assert_eq!(r.anchor, "exact");
        assert_eq!(r.start_line, Some(2));
        assert_eq!(r.end_line, Some(3));
    }
}
```

Add `mod anchor;` to the top of `src-tauri/src/lib.rs` (next to the other `mod` lines).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test anchor::`
Expected: FAIL — `cannot find function resolve_anchor in this scope`.

- [ ] **Step 3: Implement `resolve_anchor`**

Add to `src-tauri/src/anchor.rs` (above the `#[cfg(test)]` block):

```rust
fn offset_to_line(text: &str, byte_offset: usize) -> usize {
    text[..byte_offset].bytes().filter(|&b| b == b'\n').count() + 1
}

fn find_all(text: &str, needle: &str) -> Vec<usize> {
    let mut out = Vec::new();
    let mut start = 0usize;
    while let Some(i) = text[start..].find(needle) {
        let abs = start + i;
        out.push(abs);
        start = abs + needle.len().max(1);
        if start > text.len() {
            break;
        }
    }
    out
}

fn located(a: &Annotation, text: &str, quote_offset: usize, kind: &str) -> Resolution {
    let start = offset_to_line(text, quote_offset);
    let newlines_in_quote = a.quote.bytes().filter(|&b| b == b'\n').count();
    Resolution {
        id: a.id.clone(),
        start_line: Some(start),
        end_line: Some(start + newlines_in_quote),
        anchor: kind.to_string(),
    }
}

fn orphan(a: &Annotation) -> Resolution {
    Resolution {
        id: a.id.clone(),
        start_line: None,
        end_line: None,
        anchor: "orphaned".to_string(),
    }
}

/// Resolve a stored annotation against the document's current text.
/// Tries: exact (prefix+quote+suffix) → unique/nearest quote → line-hint drift → orphan.
pub fn resolve_anchor(text: &str, a: &Annotation) -> Resolution {
    if a.quote.is_empty() {
        return orphan(a);
    }

    let full = format!("{}{}{}", a.prefix, a.quote, a.suffix);
    if let Some(idx) = text.find(&full) {
        return located(a, text, idx + a.prefix.len(), "exact");
    }

    let occurrences = find_all(text, &a.quote);
    match occurrences.len() {
        0 => {
            let total_lines = text.lines().count().max(1);
            if a.line_hint.start >= 1 && a.line_hint.start <= total_lines {
                Resolution {
                    id: a.id.clone(),
                    start_line: Some(a.line_hint.start),
                    end_line: Some(a.line_hint.end),
                    anchor: "drifted".to_string(),
                }
            } else {
                orphan(a)
            }
        }
        1 => located(a, text, occurrences[0], "quote-only"),
        _ => {
            let hint = a.line_hint.start as i64;
            let best = occurrences
                .iter()
                .min_by_key(|&&off| (offset_to_line(text, off) as i64 - hint).abs())
                .copied()
                .unwrap();
            located(a, text, best, "quote-only")
        }
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test anchor::`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/anchor.rs src-tauri/src/lib.rs
git commit -m "feat(anchor): pure fuzzy anchor resolution engine"
```

---

## Task 2: Rust annotation store (`annotations.rs`)

**Files:**
- Create: `src-tauri/src/annotations.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod annotations;`), `src-tauri/Cargo.toml` (add `sha1`)

**Interfaces:**
- Consumes: `crate::anchor::{Annotation, Resolution, resolve_anchor}`.
- Produces:
  - `pub struct AnnotationStore { doc_path: String (rename "docPath"), annotations: Vec<Annotation> }` (derive `Default`)
  - `pub fn sha1_hex(s: &str) -> String`
  - `pub fn store_path_for(doc_path: &str) -> Option<std::path::PathBuf>`
  - `pub fn read_store(doc_path: &str) -> AnnotationStore`
  - `pub fn write_store(store: &AnnotationStore) -> Result<(), String>`

- [ ] **Step 1: Add the `sha1` dependency**

In `src-tauri/Cargo.toml`, under `[dependencies]`, add:

```toml
sha1 = "0.10"
```

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/src/annotations.rs`:

```rust
use crate::anchor::Annotation;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::path::PathBuf;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct AnnotationStore {
    #[serde(rename = "docPath")]
    pub doc_path: String,
    #[serde(default)]
    pub annotations: Vec<Annotation>,
}

pub fn sha1_hex(s: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(s.as_bytes());
    hasher.finalize().iter().map(|b| format!("{:02x}", b)).collect()
}

fn store_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".glance").join("annotations"))
}

pub fn store_path_for(doc_path: &str) -> Option<PathBuf> {
    store_dir().map(|d| d.join(format!("{}.json", sha1_hex(doc_path))))
}

pub fn read_store(doc_path: &str) -> AnnotationStore {
    let empty = || AnnotationStore {
        doc_path: doc_path.to_string(),
        annotations: Vec::new(),
    };
    let path = match store_path_for(doc_path) {
        Some(p) => p,
        None => return empty(),
    };
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|_| empty()),
        Err(_) => empty(),
    }
}

pub fn write_store(store: &AnnotationStore) -> Result<(), String> {
    let path = store_path_for(&store.doc_path)
        .ok_or_else(|| "Could not determine $HOME for annotation store".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha1_is_deterministic_and_hex() {
        let a = sha1_hex("/Users/me/notes.md");
        let b = sha1_hex("/Users/me/notes.md");
        assert_eq!(a, b);
        assert_eq!(a.len(), 40);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn store_path_is_under_glance_annotations() {
        std::env::set_var("HOME", "/tmp/glance-test-home");
        let p = store_path_for("/x/y.md").unwrap();
        let s = p.to_string_lossy();
        assert!(s.contains("/.glance/annotations/"));
        assert!(s.ends_with(".json"));
    }

    #[test]
    fn read_missing_store_returns_empty_with_doc_path() {
        std::env::set_var("HOME", "/tmp/glance-test-home-empty");
        let store = read_store("/no/such/file.md");
        assert_eq!(store.doc_path, "/no/such/file.md");
        assert!(store.annotations.is_empty());
    }
}
```

Add `mod annotations;` to `src-tauri/src/lib.rs`.

- [ ] **Step 3: Run tests to verify they fail, then pass**

Run: `cd src-tauri && cargo test annotations::`
Expected: first run after adding the dep compiles; the 3 tests PASS. If `sha1` is not yet fetched, `cargo test` fetches it. (These tests are written to pass against the implementation included above; the "failing" stage here is the compile error before the dep/module exist.)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/annotations.rs src-tauri/src/lib.rs
git commit -m "feat(annotations): on-disk per-doc annotation store"
```

---

## Task 3: Annotation IPC commands + live watch

**Files:**
- Modify: `src-tauri/src/annotations.rs` (add commands), `src-tauri/src/watcher.rs` (add `watch_annotations`), `src-tauri/src/lib.rs` (register handlers)

**Interfaces:**
- Consumes: `read_store`, `write_store`, `store_path_for`, `resolve_anchor`, `Annotation`, `Resolution`, `AnnotationStore`.
- Produces Tauri commands:
  - `read_annotations(path: String) -> AnnotationStore`
  - `write_annotations(store: AnnotationStore) -> Result<(), String>`
  - `resolve_anchors(text: String, annotations: Vec<Annotation>) -> Vec<Resolution>`
  - `annotation_store_path(path: String) -> Option<String>`
  - `ensure_annotation_store(path: String) -> Result<String, String>` (creates an empty store file if missing; returns its path so the frontend can watch it)
  - `watch_annotations(store_path: String, doc_path: String, ...) -> Result<(), String>` — emits event `annotations-changed` with payload `doc_path` (a `String`) on Modify/Create.

- [ ] **Step 1: Add the command wrappers to `annotations.rs`**

Append to `src-tauri/src/annotations.rs` (before the `#[cfg(test)]` block):

```rust
use crate::anchor::{resolve_anchor, Resolution};

#[tauri::command]
pub fn read_annotations(path: String) -> AnnotationStore {
    read_store(&path)
}

#[tauri::command]
pub fn write_annotations(store: AnnotationStore) -> Result<(), String> {
    write_store(&store)
}

#[tauri::command]
pub fn resolve_anchors(text: String, annotations: Vec<Annotation>) -> Vec<Resolution> {
    annotations.iter().map(|a| resolve_anchor(&text, a)).collect()
}

#[tauri::command]
pub fn annotation_store_path(path: String) -> Option<String> {
    store_path_for(&path).map(|p| p.to_string_lossy().to_string())
}

/// Ensure the store file exists (so the OS file watcher can attach to it) and
/// return its absolute path.
#[tauri::command]
pub fn ensure_annotation_store(path: String) -> Result<String, String> {
    let store_path =
        store_path_for(&path).ok_or_else(|| "Could not determine $HOME".to_string())?;
    if !store_path.exists() {
        write_store(&AnnotationStore {
            doc_path: path.clone(),
            annotations: Vec::new(),
        })?;
    }
    Ok(store_path.to_string_lossy().to_string())
}
```

- [ ] **Step 2: Add `watch_annotations` to `watcher.rs`**

Append to `src-tauri/src/watcher.rs`:

```rust
#[tauri::command]
pub fn watch_annotations(
    store_path: String,
    doc_path: String,
    app: AppHandle,
    watchers: State<Watchers>,
) -> Result<(), String> {
    let mut map = watchers.0.lock().map_err(|e| e.to_string())?;
    if map.contains_key(&store_path) {
        return Ok(());
    }
    let app2 = app.clone();
    let doc = doc_path.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            if matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_)) {
                let _ = app2.emit("annotations-changed", doc.clone());
            }
        }
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(Path::new(&store_path), RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;
    map.insert(store_path, watcher);
    Ok(())
}
```

- [ ] **Step 3: Register the new commands in `lib.rs`**

In `src-tauri/src/lib.rs`, extend the `tauri::generate_handler!` macro list (currently ends with `take_launch_args,`) to also include:

```rust
            commands::read_file,
            commands::write_file,
            watcher::watch_file,
            watcher::unwatch_file,
            watcher::watch_annotations,
            annotations::read_annotations,
            annotations::write_annotations,
            annotations::resolve_anchors,
            annotations::annotation_store_path,
            annotations::ensure_annotation_store,
            take_launch_args,
```

(Keep `commands::read_file`/`write_file` exactly as they already appear; just add the new lines.)

- [ ] **Step 4: Verify it compiles**

Run: `cd src-tauri && cargo build`
Expected: builds with no errors. (No new unit tests — these are thin IPC wrappers over already-tested logic; the existing `anchor::`/`annotations::` tests still pass: `cargo test`.)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/annotations.rs src-tauri/src/watcher.rs src-tauri/src/lib.rs
git commit -m "feat(annotations): IPC commands + live store watch event"
```

---

## Task 4: `glance-mcp` binary

**Files:**
- Create: `src-tauri/src/bin/glance-mcp.rs`
- Modify: `src-tauri/Cargo.toml` (declare bins)

**Interfaces:**
- Consumes: `glance_lib::anchor::{Annotation, resolve_anchor}`, `glance_lib::annotations::{read_store, write_store, AnnotationStore}`.
- Produces (pure, testable): `fn build_views(store: &AnnotationStore, text: &str, status_filter: Option<&str>) -> Vec<AnnotationView>` and `fn apply_resolve(store: &mut AnnotationStore, id: &str) -> bool`.
- The binary speaks newline-delimited JSON-RPC 2.0 over stdio (MCP stdio transport).

- [ ] **Step 1: Declare both binaries in `Cargo.toml`**

In `src-tauri/Cargo.toml`, after the `[lib]` block, add:

```toml
[[bin]]
name = "glance"
path = "src/main.rs"

[[bin]]
name = "glance-mcp"
path = "src/bin/glance-mcp.rs"
```

(`glance` is the existing GUI app entry; declaring it explicitly keeps cargo from being ambiguous once a second bin exists.)

- [ ] **Step 2: Write the failing tests for the pure core**

Create `src-tauri/src/bin/glance-mcp.rs`:

```rust
// Glance MCP server — stdio JSON-RPC. Lets a Claude session read the user's
// anchored annotations on a markdown file. v1: read + resolve only.

use glance_lib::anchor::{resolve_anchor, Annotation};
use glance_lib::annotations::{read_store, write_store, AnnotationStore};
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{BufRead, Write};

#[derive(Serialize, PartialEq, Debug)]
struct AnnotationView {
    id: String,
    note: String,
    quote: String,
    #[serde(rename = "lineStart")]
    line_start: Option<usize>,
    #[serde(rename = "lineEnd")]
    line_end: Option<usize>,
    status: String,
    anchor: String,
}

fn view_of(a: &Annotation, text: &str) -> AnnotationView {
    let r = resolve_anchor(text, a);
    AnnotationView {
        id: a.id.clone(),
        note: a.note.clone(),
        quote: a.quote.clone(),
        line_start: r.start_line,
        line_end: r.end_line,
        status: a.status.clone(),
        anchor: r.anchor,
    }
}

/// Build the view list, optionally filtered by status (default "open").
fn build_views(store: &AnnotationStore, text: &str, status_filter: Option<&str>) -> Vec<AnnotationView> {
    let filter = status_filter.unwrap_or("open");
    store
        .annotations
        .iter()
        .filter(|a| filter == "all" || a.status == filter)
        .map(|a| view_of(a, text))
        .collect()
}

/// Mark one annotation resolved in-place. Returns true if it was found.
fn apply_resolve(store: &mut AnnotationStore, id: &str) -> bool {
    for a in store.annotations.iter_mut() {
        if a.id == id {
            a.status = "resolved".to_string();
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use glance_lib::anchor::LineHint;

    fn ann(id: &str, quote: &str, status: &str) -> Annotation {
        Annotation {
            id: id.into(),
            quote: quote.into(),
            prefix: "".into(),
            suffix: "".into(),
            line_hint: LineHint { start: 1, end: 1 },
            note: "note".into(),
            status: status.into(),
            author: "user".into(),
            created_at: "t".into(),
        }
    }

    fn store_of(anns: Vec<Annotation>) -> AnnotationStore {
        AnnotationStore { doc_path: "/d.md".into(), annotations: anns }
    }

    #[test]
    fn build_views_defaults_to_open_only_and_resolves_lines() {
        let store = store_of(vec![ann("a", "hello", "open"), ann("b", "x", "resolved")]);
        let views = build_views(&store, "hello world\n", None);
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].id, "a");
        assert_eq!(views[0].line_start, Some(1));
        assert_eq!(views[0].anchor, "quote-only");
    }

    #[test]
    fn build_views_all_includes_resolved() {
        let store = store_of(vec![ann("a", "hello", "open"), ann("b", "x", "resolved")]);
        let views = build_views(&store, "hello x\n", Some("all"));
        assert_eq!(views.len(), 2);
    }

    #[test]
    fn apply_resolve_sets_status() {
        let mut store = store_of(vec![ann("a", "hello", "open")]);
        assert!(apply_resolve(&mut store, "a"));
        assert_eq!(store.annotations[0].status, "resolved");
        assert!(!apply_resolve(&mut store, "missing"));
    }
}
```

- [ ] **Step 3: Run the tests**

Run: `cd src-tauri && cargo test --bin glance-mcp`
Expected: PASS (3 tests). (The `main` + JSON-RPC loop added next is not exercised by unit tests; it's integration-verified in Step 5.)

- [ ] **Step 4: Add the JSON-RPC stdio loop (`main`)**

Append to `src-tauri/src/bin/glance-mcp.rs`:

```rust
const PROTOCOL_VERSION: &str = "2024-11-05";

fn tool_schemas() -> Value {
    json!([
        {
            "name": "list_annotations",
            "description": "List the user's review annotations on a markdown file, with line numbers resolved against the file's current contents. Defaults to open annotations.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path to the markdown file." },
                    "status": { "type": "string", "enum": ["open", "resolved", "orphaned", "all"], "description": "Filter (default: open)." }
                },
                "required": ["path"]
            }
        },
        {
            "name": "get_annotation",
            "description": "Get one annotation by id with its current line range and quoted text.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "id": { "type": "string" }
                },
                "required": ["path", "id"]
            }
        },
        {
            "name": "resolve_annotation",
            "description": "Mark an annotation resolved after you have applied the requested change.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "id": { "type": "string" }
                },
                "required": ["path", "id"]
            }
        }
    ])
}

fn read_doc(path: &str) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

fn text_result(value: Value) -> Value {
    json!({ "content": [ { "type": "text", "text": value.to_string() } ] })
}

fn call_tool(name: &str, args: &Value) -> Result<Value, String> {
    let path = args.get("path").and_then(|v| v.as_str()).ok_or("missing 'path'")?;
    match name {
        "list_annotations" => {
            let status = args.get("status").and_then(|v| v.as_str());
            let store = read_store(path);
            let views = build_views(&store, &read_doc(path), status);
            Ok(text_result(serde_json::to_value(views).unwrap()))
        }
        "get_annotation" => {
            let id = args.get("id").and_then(|v| v.as_str()).ok_or("missing 'id'")?;
            let store = read_store(path);
            let text = read_doc(path);
            match store.annotations.iter().find(|a| a.id == id) {
                Some(a) => Ok(text_result(serde_json::to_value(view_of(a, &text)).unwrap())),
                None => Err(format!("no annotation '{id}'")),
            }
        }
        "resolve_annotation" => {
            let id = args.get("id").and_then(|v| v.as_str()).ok_or("missing 'id'")?;
            let mut store = read_store(path);
            if apply_resolve(&mut store, id) {
                write_store(&store)?;
                Ok(text_result(json!({ "ok": true, "id": id })))
            } else {
                Err(format!("no annotation '{id}'"))
            }
        }
        other => Err(format!("unknown tool '{other}'")),
    }
}

fn handle(method: &str, params: &Value) -> Option<Result<Value, (i64, String)>> {
    match method {
        "initialize" => Some(Ok(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": { "tools": {}, "resources": {} },
            "serverInfo": { "name": "glance", "version": env!("CARGO_PKG_VERSION") }
        }))),
        "tools/list" => Some(Ok(json!({ "tools": tool_schemas() }))),
        "tools/call" => {
            let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let empty = json!({});
            let args = params.get("arguments").unwrap_or(&empty);
            Some(call_tool(name, args).map_err(|e| (-32000, e)))
        }
        "resources/list" => Some(Ok(json!({ "resources": [] }))),
        "resources/templates/list" => Some(Ok(json!({
            "resourceTemplates": [ {
                "uriTemplate": "glance://annotations/{path}",
                "name": "Glance annotations",
                "description": "Open annotations for a markdown file.",
                "mimeType": "application/json"
            } ]
        }))),
        "resources/read" => {
            let uri = params.get("uri").and_then(|v| v.as_str()).unwrap_or("");
            let path = uri.strip_prefix("glance://annotations/").unwrap_or("");
            let store = read_store(path);
            let views = build_views(&store, &read_doc(path), Some("open"));
            Some(Ok(json!({
                "contents": [ {
                    "uri": uri,
                    "mimeType": "application/json",
                    "text": serde_json::to_string(&views).unwrap()
                } ]
            })))
        }
        _ => None, // notifications (e.g. notifications/initialized) and unknowns: no reply
    }
}

fn main() {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) if !l.trim().is_empty() => l,
            Ok(_) => continue,
            Err(_) => break,
        };
        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let id = msg.get("id").cloned();
        let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");
        let empty = json!({});
        let params = msg.get("params").unwrap_or(&empty);

        let response = match handle(method, params) {
            Some(Ok(result)) => id.map(|id| json!({ "jsonrpc": "2.0", "id": id, "result": result })),
            Some(Err((code, message))) => {
                id.map(|id| json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }))
            }
            None => None,
        };

        if let Some(resp) = response {
            let _ = writeln!(stdout, "{}", resp);
            let _ = stdout.flush();
        }
    }
}
```

- [ ] **Step 5: Build and smoke-test the protocol**

Run: `cd src-tauri && cargo build --bin glance-mcp`
Expected: builds clean.

Smoke-test the handshake + a tool call with a temp store:

```bash
cd src-tauri
mkdir -p /tmp/glance-test-home/.glance/annotations
printf '# Title\n\nhello world\n' > /tmp/glance-smoke.md
HASH=$(printf '/tmp/glance-smoke.md' | shasum | cut -d' ' -f1)
cat > "/tmp/glance-test-home/.glance/annotations/$HASH.json" <<JSON
{ "docPath": "/tmp/glance-smoke.md", "annotations": [
  { "id": "a1", "quote": "hello world", "prefix": "", "suffix": "", "lineHint": {"start":3,"end":3}, "note": "tighten", "status": "open", "author": "user", "createdAt": "t" } ] }
JSON
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_annotations","arguments":{"path":"/tmp/glance-smoke.md"}}}' \
  | HOME=/tmp/glance-test-home cargo run --quiet --bin glance-mcp
```

Expected: two JSON lines. The second contains `"lineStart":3` and `"note":"tighten"` inside the `content[0].text` string.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/bin/glance-mcp.rs
git commit -m "feat(mcp): glance-mcp stdio server (list/get/resolve annotations)"
```

---

## Task 5: One-click "Set up Claude Integration"

**Files:**
- Create: `src-tauri/src/setup.rs`
- Modify: `src-tauri/src/lib.rs` (menu item + emit), `src-tauri/src/cli_install.rs` (make `CliInstallResult` reusable — already `pub`)

**Interfaces:**
- Consumes: `crate::cli_install::install_cli_tool`.
- Produces:
  - `pub struct StepResult { pub ok: bool, pub label: String, pub message: String }`
  - Pure helpers: `pub fn merge_mcp_config(existing: &str, name: &str, command: &str) -> String`, `pub fn guidance_block() -> &'static str`, `pub fn append_guidance(existing: &str) -> Option<String>` (None when the marker is already present).
  - `pub fn setup_claude_integration() -> Vec<StepResult>`

- [ ] **Step 1: Write the failing tests for the pure helpers**

Create `src-tauri/src/setup.rs`:

```rust
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
pub struct StepResult {
    pub ok: bool,
    pub label: String,
    pub message: String,
}

const GUIDANCE_MARKER: &str = "<!-- glance-integration -->";

pub fn guidance_block() -> String {
    format!(
        "{marker}\n## Glance markdown review\n\n\
         When you create or update a markdown file the user should review, open it with `mdview <absolute-path>`.\n\
         To read the user's review comments on that file, use the Glance MCP tools (`list_annotations`, `get_annotation`) and call `resolve_annotation` after applying each change.\n",
        marker = GUIDANCE_MARKER
    )
}

/// Append the guidance block unless it is already present. Returns the new file
/// contents, or None if nothing needs to change.
pub fn append_guidance(existing: &str) -> Option<String> {
    if existing.contains(GUIDANCE_MARKER) {
        return None;
    }
    let sep = if existing.is_empty() || existing.ends_with('\n') { "" } else { "\n" };
    Some(format!("{existing}{sep}\n{}", guidance_block()))
}

/// Merge a `mcpServers.<name>` entry into an existing `~/.claude.json` string,
/// preserving every other key. Tolerates empty/invalid input by starting fresh.
pub fn merge_mcp_config(existing: &str, name: &str, command: &str) -> String {
    let mut root: serde_json::Value =
        serde_json::from_str(existing).unwrap_or_else(|_| serde_json::json!({}));
    if !root.is_object() {
        root = serde_json::json!({});
    }
    let obj = root.as_object_mut().unwrap();
    let servers = obj
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}));
    if !servers.is_object() {
        *servers = serde_json::json!({});
    }
    servers.as_object_mut().unwrap().insert(
        name.to_string(),
        serde_json::json!({ "command": command, "args": [] }),
    );
    serde_json::to_string_pretty(&root).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_guidance_adds_block_once() {
        let first = append_guidance("# My config\n").unwrap();
        assert!(first.contains("mdview <absolute-path>"));
        assert!(first.contains("# My config"));
        assert!(append_guidance(&first).is_none());
    }

    #[test]
    fn merge_into_empty_creates_server() {
        let out = merge_mcp_config("", "glance", "/Apps/Glance.app/Contents/MacOS/glance-mcp");
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["mcpServers"]["glance"]["command"], "/Apps/Glance.app/Contents/MacOS/glance-mcp");
    }

    #[test]
    fn merge_preserves_other_keys_and_servers() {
        let existing = r#"{"theme":"dark","mcpServers":{"other":{"command":"x"}}}"#;
        let out = merge_mcp_config(existing, "glance", "/p/glance-mcp");
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["theme"], "dark");
        assert_eq!(v["mcpServers"]["other"]["command"], "x");
        assert_eq!(v["mcpServers"]["glance"]["command"], "/p/glance-mcp");
    }
}
```

Add `mod setup;` to `src-tauri/src/lib.rs`.

- [ ] **Step 2: Run the tests**

Run: `cd src-tauri && cargo test setup::`
Expected: PASS (3 tests).

- [ ] **Step 3: Add the orchestrator `setup_claude_integration`**

Append to `src-tauri/src/setup.rs` (before `#[cfg(test)]`):

```rust
use crate::cli_install::install_cli_tool;
use std::path::PathBuf;

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn register_mcp() -> StepResult {
    let label = "Register glance-mcp with Claude".to_string();
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => return StepResult { ok: false, label, message: format!("Could not locate the Glance binary: {e}") },
    };
    if exe.to_string_lossy().contains("AppTranslocation") {
        return StepResult {
            ok: false,
            label,
            message: "Glance is running from a quarantined copy. Move Glance.app to /Applications, reopen it, then try again.".to_string(),
        };
    }
    // The MCP binary is bundled next to the GUI binary inside Glance.app.
    let mcp = match exe.parent() {
        Some(dir) => dir.join("glance-mcp"),
        None => return StepResult { ok: false, label, message: "Could not resolve the app directory.".to_string() },
    };
    let mcp_str = mcp.to_string_lossy().to_string();

    let home = match home() {
        Some(h) => h,
        None => return StepResult { ok: false, label, message: "Could not determine your home directory ($HOME).".to_string() },
    };
    let config_path = home.join(".claude.json");
    let existing = std::fs::read_to_string(&config_path).unwrap_or_default();
    let merged = merge_mcp_config(&existing, "glance", &mcp_str);
    match std::fs::write(&config_path, merged) {
        Ok(_) => StepResult { ok: true, label, message: format!("Registered glance-mcp → {mcp_str}") },
        Err(e) => StepResult { ok: false, label, message: format!("Could not write {}: {e}", config_path.display()) },
    }
}

fn write_guidance() -> StepResult {
    let label = "Add review guidance to ~/.claude/CLAUDE.md".to_string();
    let home = match home() {
        Some(h) => h,
        None => return StepResult { ok: false, label, message: "Could not determine your home directory ($HOME).".to_string() },
    };
    let dir = home.join(".claude");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return StepResult { ok: false, label, message: format!("Could not create {}: {e}", dir.display()) };
    }
    let path = dir.join("CLAUDE.md");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    match append_guidance(&existing) {
        None => StepResult { ok: true, label, message: "Guidance already present — left unchanged.".to_string() },
        Some(next) => match std::fs::write(&path, next) {
            Ok(_) => StepResult { ok: true, label, message: format!("Appended guidance to {}", path.display()) },
            Err(e) => StepResult { ok: false, label, message: format!("Could not write {}: {e}", path.display()) },
        },
    }
}

pub fn setup_claude_integration() -> Vec<StepResult> {
    let cli = install_cli_tool();
    vec![
        StepResult { ok: cli.ok, label: "Install mdview CLI".to_string(), message: cli.message },
        register_mcp(),
        write_guidance(),
    ]
}
```

- [ ] **Step 4: Wire the menu item + emit in `lib.rs`**

In `src-tauri/src/lib.rs`:

1. Change the menu item label and id. Replace the `install_cli_item` definition:

```rust
            let install_cli_item = MenuItem::with_id(
                handle,
                "setup_integration",
                "Set up Claude Integration…",
                true,
                None::<&str>,
            )?;
```

2. Replace the `on_menu_event` body to handle the new id and emit the multi-step result:

```rust
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "setup_integration" {
                let results = setup::setup_claude_integration();
                let _ = app.emit("setup-result", results);
            }
        })
```

(Leave the rest of the menu — Edit submenu, hide/quit — unchanged.)

- [ ] **Step 5: Build and re-run the Rust test suite**

Run: `cd src-tauri && cargo build && cargo test`
Expected: builds; all tests pass (`anchor::` 6, `annotations::` 3, `glance-mcp` 3, `setup::` 3, plus existing `cli::` tests).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/setup.rs src-tauri/src/lib.rs
git commit -m "feat(setup): one-click Claude integration (mdview + MCP + guidance)"
```

---

## Task 6: TS annotation types + reducers

**Files:**
- Create: `src/annotations.ts`, `src/annotations.test.ts`
- Modify: `src/document.ts` (extend `Doc`, `createDoc`), `src/store.ts` (doc-level setters)

**Interfaces:**
- Produces:
  - Types `LineHint`, `Annotation`, `AnnotationStore`, `Resolution`, `AnchorKind`, `AnnotationStatus` (field names match the Rust serde camelCase exactly).
  - Pure reducers over `Annotation[]`: `addAnnotation`, `resolveAnnotation`, `removeAnnotation`, `setAnnotations`.
  - `genId(): string`.
  - In `store.ts`: `setDocAnnotations(s, id, list)`, `setDocResolutions(s, id, map)`.
- `Doc` gains `annotations: Annotation[]` and `resolutions: Record<string, Resolution>`.

- [ ] **Step 1: Write the failing tests**

Create `src/annotations.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  addAnnotation, resolveAnnotation, removeAnnotation, setAnnotations,
  type Annotation,
} from "./annotations";

function ann(id: string, status: Annotation["status"] = "open"): Annotation {
  return {
    id, quote: "q", prefix: "", suffix: "",
    lineHint: { start: 1, end: 1 }, note: "n",
    status, author: "user", createdAt: "t",
  };
}

describe("annotation reducers", () => {
  it("addAnnotation appends without mutating", () => {
    const a = [ann("a")];
    const b = addAnnotation(a, ann("b"));
    expect(b).toHaveLength(2);
    expect(a).toHaveLength(1); // original untouched
    expect(b[1].id).toBe("b");
  });

  it("resolveAnnotation flips status to resolved", () => {
    const a = [ann("a"), ann("b")];
    const b = resolveAnnotation(a, "a");
    expect(b.find((x) => x.id === "a")!.status).toBe("resolved");
    expect(b.find((x) => x.id === "b")!.status).toBe("open");
  });

  it("removeAnnotation drops by id", () => {
    const a = [ann("a"), ann("b")];
    expect(removeAnnotation(a, "a").map((x) => x.id)).toEqual(["b"]);
  });

  it("setAnnotations replaces the list", () => {
    expect(setAnnotations([ann("a")], [ann("z")]).map((x) => x.id)).toEqual(["z"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/annotations.test.ts`
Expected: FAIL — cannot resolve `./annotations`.

- [ ] **Step 3: Implement `src/annotations.ts`**

```ts
export type AnchorKind = "exact" | "quote-only" | "drifted" | "orphaned";
export type AnnotationStatus = "open" | "resolved" | "orphaned";

export interface LineHint {
  start: number;
  end: number;
}

export interface Annotation {
  id: string;
  quote: string;
  prefix: string;
  suffix: string;
  lineHint: LineHint;
  note: string;
  status: AnnotationStatus;
  author: "user" | "claude";
  createdAt: string;
}

export interface AnnotationStore {
  docPath: string;
  annotations: Annotation[];
}

export interface Resolution {
  id: string;
  startLine: number | null;
  endLine: number | null;
  anchor: AnchorKind;
}

export function genId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function addAnnotation(list: Annotation[], a: Annotation): Annotation[] {
  return [...list, a];
}

export function resolveAnnotation(list: Annotation[], id: string): Annotation[] {
  return list.map((a) => (a.id === id ? { ...a, status: "resolved" } : a));
}

export function removeAnnotation(list: Annotation[], id: string): Annotation[] {
  return list.filter((a) => a.id !== id);
}

export function setAnnotations(_list: Annotation[], next: Annotation[]): Annotation[] {
  return next;
}
```

- [ ] **Step 4: Extend `Doc` and `createDoc` in `src/document.ts`**

Add the import and fields. Change the `Doc` interface to add (after `existsOnDisk: boolean;`):

```ts
  annotations: import("./annotations").Annotation[];
  resolutions: Record<string, import("./annotations").Resolution>;
```

And in `createDoc`, add to the returned object (after `existsOnDisk: true,`):

```ts
    annotations: [],
    resolutions: {},
```

- [ ] **Step 5: Add store-level setters in `src/store.ts`**

Add to `src/store.ts` (the `mapDoc` helper already exists):

```ts
import type { Annotation, Resolution } from "./annotations";

export function setDocAnnotations(s: State, id: string, annotations: Annotation[]): State {
  return mapDoc(s, id, (d) => ({ ...d, annotations }));
}

export function setDocResolutions(s: State, id: string, resolutions: Record<string, Resolution>): State {
  return mapDoc(s, id, (d) => ({ ...d, resolutions }));
}
```

(Place the `import type` line next to the existing `import { Doc, ... } from "./document"`.)

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm exec vitest run src/annotations.test.ts && pnpm exec tsc --noEmit`
Expected: 4 tests PASS; tsc reports no errors.

- [ ] **Step 7: Commit**

```bash
git add src/annotations.ts src/annotations.test.ts src/document.ts src/store.ts
git commit -m "feat(annotations): TS types, reducers, and Doc state slice"
```

---

## Task 7: TS anchor capture (pure + DOM adapter)

**Files:**
- Create: `src/build-anchor.ts`, `src/build-anchor.test.ts`, `src/anchor-capture.ts`

**Interfaces:**
- Produces:
  - `buildAnchor(fullText: string, start: number, end: number, ctx?: number): { quote: string; prefix: string; suffix: string }` (pure, tested).
  - `captureSelection(): { quote, prefix, suffix, lineHint } | null` (DOM adapter; manually verified).

- [ ] **Step 1: Write the failing tests for `buildAnchor`**

Create `src/build-anchor.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildAnchor } from "./build-anchor";

const text = "The quick brown fox jumps over the lazy dog";

describe("buildAnchor", () => {
  it("captures quote with surrounding context", () => {
    const start = text.indexOf("brown fox");
    const end = start + "brown fox".length;
    const a = buildAnchor(text, start, end, 4);
    expect(a.quote).toBe("brown fox");
    expect(a.prefix).toBe("ick ");
    expect(a.suffix).toBe(" jum");
  });

  it("clamps context at string boundaries", () => {
    const a = buildAnchor(text, 0, 3, 10); // "The"
    expect(a.quote).toBe("The");
    expect(a.prefix).toBe("");
    expect(a.suffix).toBe(" quick bro");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run src/build-anchor.test.ts`
Expected: FAIL — cannot resolve `./build-anchor`.

- [ ] **Step 3: Implement `src/build-anchor.ts`**

```ts
export interface CapturedAnchor {
  quote: string;
  prefix: string;
  suffix: string;
}

/**
 * Build a fuzzy anchor from a selection range over the document's source text.
 * `prefix`/`suffix` capture up to `ctx` chars around the quote so the Rust
 * resolver can re-find it after edits.
 */
export function buildAnchor(
  fullText: string,
  start: number,
  end: number,
  ctx = 32,
): CapturedAnchor {
  return {
    quote: fullText.slice(start, end),
    prefix: fullText.slice(Math.max(0, start - ctx), start),
    suffix: fullText.slice(end, Math.min(fullText.length, end + ctx)),
  };
}
```

- [ ] **Step 4: Implement the DOM adapter `src/anchor-capture.ts`**

This is the thin, manually-verified glue. It reads the current window selection inside the rendered view, finds the nearest `[data-sourceline]` block to derive a `lineHint`, and reads the doc's source text via the offsets within that block.

```ts
import { buildAnchor } from "./build-anchor";
import type { LineHint } from "./annotations";

export interface CapturedSelection {
  quote: string;
  prefix: string;
  suffix: string;
  lineHint: LineHint;
}

/**
 * Capture the current text selection inside the rendered markdown view.
 * Returns null when there is no usable selection. `sourceText` is the document's
 * editor/source content; `start`/`end` offsets are computed against it by
 * locating the selected text near the anchored block's source line.
 */
export function captureSelection(sourceText: string): CapturedSelection | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const quote = sel.toString();
  if (!quote.trim()) return null;

  // Find the nearest block element carrying a source line number.
  const node = sel.anchorNode;
  const el = node instanceof Element ? node : node?.parentElement ?? null;
  const block = el?.closest("[data-sourceline]") as HTMLElement | null;
  const blockLine = block ? parseInt(block.dataset.sourceline ?? "1", 10) : 1;

  // Locate the quote in the source, preferring an occurrence at/after the block
  // line so duplicate text resolves to the selected instance.
  const lines = sourceText.split("\n");
  const lineStartOffset = lines.slice(0, blockLine - 1).join("\n").length + (blockLine > 1 ? 1 : 0);
  let start = sourceText.indexOf(quote, lineStartOffset);
  if (start === -1) start = sourceText.indexOf(quote);
  if (start === -1) return null;
  const end = start + quote.length;

  const before = sourceText.slice(0, start);
  const startLine = before.split("\n").length;
  const endLine = startLine + (quote.split("\n").length - 1);

  const { prefix, suffix } = buildAnchor(sourceText, start, end);
  return { quote, prefix, suffix, lineHint: { start: startLine, end: endLine } };
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm exec vitest run src/build-anchor.test.ts && pnpm exec tsc --noEmit`
Expected: 2 tests PASS; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/build-anchor.ts src/build-anchor.test.ts src/anchor-capture.ts
git commit -m "feat(annotations): selection-to-anchor capture (pure + DOM adapter)"
```

---

## Task 8: Renderer stamps `data-sourceline`

**Files:**
- Modify: `src/renderer.ts`, `src/renderer.test.ts`

**Interfaces:**
- `renderMarkdown(src)` output gains `data-sourceline="<1-based line>"` on top-level block-open tokens. No signature change.

- [ ] **Step 1: Update the existing test + add a new one**

In `src/renderer.test.ts`, the "renders headings" test currently asserts `toContain("<h1>Hi</h1>")`. Change it to not assume the bare tag, and add a sourceline assertion:

```ts
  it("renders headings", () => {
    const html = renderMarkdown("# Hi");
    expect(html).toContain("Hi</h1>");
    expect(html).toContain('data-sourceline="1"');
  });

  it("stamps source line numbers on block elements", () => {
    const html = renderMarkdown("# Title\n\nsecond para on line 3");
    expect(html).toMatch(/<h1 data-sourceline="1">/);
    expect(html).toMatch(/<p data-sourceline="3">/);
  });
```

- [ ] **Step 2: Run to verify the new test fails**

Run: `pnpm exec vitest run src/renderer.test.ts`
Expected: FAIL — no `data-sourceline` in output.

- [ ] **Step 3: Add the core rule in `src/renderer.ts`**

After `md.use(taskLists);` and before `export function renderMarkdown`, add:

```ts
// Stamp 1-based source line numbers onto top-level block-open tokens so the
// annotation layer can map a rendered selection back to a source line.
md.core.ruler.push("source_lines", (state) => {
  for (const token of state.tokens) {
    if (token.level === 0 && token.map && token.type.endsWith("_open")) {
      token.attrSet("data-sourceline", String(token.map[0] + 1));
    }
  }
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/renderer.test.ts`
Expected: PASS (all renderer tests, including the two updated/added).

- [ ] **Step 5: Commit**

```bash
git add src/renderer.ts src/renderer.test.ts
git commit -m "feat(renderer): stamp data-sourceline on block elements"
```

---

## Task 9: TS IPC wrappers

**Files:**
- Modify: `src/ipc.ts`

**Interfaces:**
- Produces wrappers matching the Rust commands/events from Tasks 3 & 5:
  - `readAnnotations(path): Promise<AnnotationStore>`
  - `writeAnnotations(store): Promise<void>`
  - `resolveAnchors(text, annotations): Promise<Resolution[]>`
  - `ensureAnnotationStore(path): Promise<string>`
  - `watchAnnotations(storePath, docPath): Promise<void>`
  - `onAnnotationsChanged(cb: (docPath: string) => void): Promise<UnlistenFn>`
  - `onSetupResult(cb: (steps: SetupStep[]) => void): Promise<UnlistenFn>` where `SetupStep = { ok: boolean; label: string; message: string }`

- [ ] **Step 1: Add the wrappers**

Append to `src/ipc.ts`:

```ts
import type { Annotation, AnnotationStore, Resolution } from "./annotations";

export interface SetupStep {
  ok: boolean;
  label: string;
  message: string;
}

export function readAnnotations(path: string): Promise<AnnotationStore> {
  return invoke<AnnotationStore>("read_annotations", { path });
}

export function writeAnnotations(store: AnnotationStore): Promise<void> {
  return invoke<void>("write_annotations", { store });
}

export function resolveAnchors(text: string, annotations: Annotation[]): Promise<Resolution[]> {
  return invoke<Resolution[]>("resolve_anchors", { text, annotations });
}

export function ensureAnnotationStore(path: string): Promise<string> {
  return invoke<string>("ensure_annotation_store", { path });
}

export function watchAnnotations(storePath: string, docPath: string): Promise<void> {
  return invoke<void>("watch_annotations", { storePath, docPath });
}

export function onAnnotationsChanged(cb: (docPath: string) => void): Promise<UnlistenFn> {
  return listen<string>("annotations-changed", (e) => cb(e.payload));
}

export function onSetupResult(cb: (steps: SetupStep[]) => void): Promise<UnlistenFn> {
  return listen<SetupStep[]>("setup-result", (e) => cb(e.payload));
}
```

> Note: the existing `onCliInstallResult` wrapper can stay or be removed. It is now unused (the menu emits `setup-result`); remove it and its usage in `app.ts` in Task 10.

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: clean (the new wrappers compile; `onCliInstallResult` may still be present and is removed in Task 10).

- [ ] **Step 3: Commit**

```bash
git add src/ipc.ts
git commit -m "feat(ipc): annotation + setup IPC wrappers"
```

---

## Task 10: Annotation UI + app wiring

**Files:**
- Create: `src/annotation-ui.ts`, `src/annotation-ui.test.ts`
- Modify: `src/app.ts`, `src/styles.css`

**Interfaces:**
- Consumes: `captureSelection`, IPC wrappers, reducers, `getActive`, `setDocAnnotations`, `setDocResolutions`.
- Produces (pure, tested): `groupAnnotations(list, resolutions): { open: Annotation[]; resolved: Annotation[]; orphaned: Annotation[] }`.
- Produces (DOM, manually verified): `renderRail(host, doc, handlers)`, `applyHighlights(renderedEl, doc)`, `mountSelectionToolbar(renderedEl, onComment)`.

- [ ] **Step 1: Write the failing test for `groupAnnotations`**

Create `src/annotation-ui.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { groupAnnotations } from "./annotation-ui";
import type { Annotation, Resolution } from "./annotations";

function ann(id: string, status: Annotation["status"] = "open"): Annotation {
  return { id, quote: "q", prefix: "", suffix: "", lineHint: { start: 1, end: 1 }, note: "n", status, author: "user", createdAt: "t" };
}

describe("groupAnnotations", () => {
  it("buckets by status, treating orphaned resolution as orphaned", () => {
    const list = [ann("a", "open"), ann("b", "resolved"), ann("c", "open")];
    const resolutions: Record<string, Resolution> = {
      a: { id: "a", startLine: 2, endLine: 2, anchor: "exact" },
      c: { id: "c", startLine: null, endLine: null, anchor: "orphaned" },
    };
    const g = groupAnnotations(list, resolutions);
    expect(g.open.map((x) => x.id)).toEqual(["a"]);
    expect(g.resolved.map((x) => x.id)).toEqual(["b"]);
    expect(g.orphaned.map((x) => x.id)).toEqual(["c"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run src/annotation-ui.test.ts`
Expected: FAIL — cannot resolve `./annotation-ui`.

- [ ] **Step 3: Implement `src/annotation-ui.ts`**

```ts
import type { Annotation, Resolution } from "./annotations";

export interface Grouped {
  open: Annotation[];
  resolved: Annotation[];
  orphaned: Annotation[];
}

/** Bucket annotations for the rail. An open annotation whose current
 *  resolution is "orphaned" is shown in the orphaned group. */
export function groupAnnotations(
  list: Annotation[],
  resolutions: Record<string, Resolution>,
): Grouped {
  const g: Grouped = { open: [], resolved: [], orphaned: [] };
  for (const a of list) {
    if (a.status === "resolved") { g.resolved.push(a); continue; }
    if (resolutions[a.id]?.anchor === "orphaned" || a.status === "orphaned") {
      g.orphaned.push(a);
      continue;
    }
    g.open.push(a);
  }
  return g;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export interface RailHandlers {
  onScrollTo: (a: Annotation) => void;
  onRemove: (a: Annotation) => void;
}

/** Render the annotations rail into `host`. Pure DOM construction. */
export function renderRail(
  host: HTMLElement,
  list: Annotation[],
  resolutions: Record<string, Resolution>,
  handlers: RailHandlers,
): void {
  host.innerHTML = "";
  const g = groupAnnotations(list, resolutions);
  const total = list.length;
  if (total === 0) { host.classList.add("empty"); return; }
  host.classList.remove("empty");

  const section = (title: string, items: Annotation[], cls: string) => {
    if (!items.length) return;
    host.appendChild(el("div", "rail-head", `${title} (${items.length})`));
    for (const a of items) {
      const card = el("div", `note-card ${cls}`);
      const res = resolutions[a.id];
      const line = res?.startLine != null ? `L${res.startLine}` : "—";
      card.appendChild(el("span", "note-line", line));
      card.appendChild(el("span", "note-text", a.note));
      card.onclick = () => handlers.onScrollTo(a);
      const del = el("span", "note-del", "×");
      del.onclick = (ev) => { ev.stopPropagation(); handlers.onRemove(a); };
      card.appendChild(del);
      host.appendChild(card);
    }
  };

  section("Open", g.open, "open");
  section("Orphaned", g.orphaned, "orphaned");
  section("Resolved", g.resolved, "resolved");
}

/** Wrap the resolved line ranges in the rendered view with a highlight class. */
export function applyHighlights(
  renderedEl: HTMLElement,
  resolutions: Record<string, Resolution>,
): void {
  const lines = new Set<number>();
  for (const r of Object.values(resolutions)) {
    if (r.startLine == null || r.endLine == null) continue;
    for (let l = r.startLine; l <= r.endLine; l++) lines.add(l);
  }
  renderedEl.querySelectorAll<HTMLElement>("[data-sourceline]").forEach((node) => {
    const l = parseInt(node.dataset.sourceline ?? "0", 10);
    node.classList.toggle("annotated", lines.has(l));
  });
}

/** Show a floating "Comment" button when the user selects text in the view. */
export function mountSelectionToolbar(
  renderedEl: HTMLElement,
  onComment: () => void,
): () => void {
  const btn = el("button", "comment-fab", "Comment");
  btn.style.display = "none";
  document.body.appendChild(btn);
  btn.onmousedown = (e) => { e.preventDefault(); }; // keep selection alive
  btn.onclick = () => { btn.style.display = "none"; onComment(); };

  const onUp = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !renderedEl.contains(sel.anchorNode)) {
      btn.style.display = "none";
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    btn.style.display = "block";
    btn.style.top = `${window.scrollY + rect.top - 36}px`;
    btn.style.left = `${window.scrollX + rect.left}px`;
  };
  document.addEventListener("mouseup", onUp);
  return () => { document.removeEventListener("mouseup", onUp); btn.remove(); };
}
```

- [ ] **Step 4: Run the test + typecheck**

Run: `pnpm exec vitest run src/annotation-ui.test.ts && pnpm exec tsc --noEmit`
Expected: 1 test PASS; tsc clean.

- [ ] **Step 5: Wire annotations into `src/app.ts`**

Make these edits:

1. Extend the imports at the top:

```ts
import {
  State, emptyState, openDoc, closeDoc, setActive, getActive,
  toggleViewMode, updateEditorContent, markSaved, applyDiskChange, markRemoved,
  setDocAnnotations, setDocResolutions,
} from "./store";
import {
  readAnnotations, writeAnnotations, resolveAnchors, ensureAnnotationStore,
  watchAnnotations, onAnnotationsChanged, onSetupResult,
} from "./ipc";
import { addAnnotation, resolveAnnotation as resolveAnn, removeAnnotation, genId, type Annotation } from "./annotations";
import { captureSelection } from "./anchor-capture";
import { renderRail, applyHighlights, mountSelectionToolbar } from "./annotation-ui";
```

(Remove the now-unused `onCliInstallResult` from the `./ipc` import list and remove its usage below.)

2. Add a helper to (re)load + resolve annotations for a doc, called on open and on store-change:

```ts
async function loadAnnotations(absPath: string): Promise<void> {
  const store = await readAnnotations(absPath);
  state = setDocAnnotations(state, absPath, store.annotations);
  await refreshResolutions(absPath);
  render();
}

async function refreshResolutions(absPath: string): Promise<void> {
  const doc = state.docs.find((d) => d.absPath === absPath);
  if (!doc) return;
  const resList = await resolveAnchors(doc.editorContent, doc.annotations);
  const map: Record<string, import("./annotations").Resolution> = {};
  for (const r of resList) map[r.id] = r;
  state = setDocResolutions(state, absPath, map);
}

async function persistAnnotations(absPath: string): Promise<void> {
  const doc = state.docs.find((d) => d.absPath === absPath);
  if (!doc) return;
  await writeAnnotations({ docPath: absPath, annotations: doc.annotations });
  await refreshResolutions(absPath);
}
```

3. In `openPath`, after the existing `watchFile(absPath)` block, set up the annotation store watch + initial load:

```ts
  try {
    const storePath = await ensureAnnotationStore(absPath);
    await watchAnnotations(storePath, absPath);
  } catch (err) {
    console.warn("annotation store watch failed for", absPath, err);
  }
  await loadAnnotations(absPath);
```

4. In `renderContent`, the rendered branch currently does `view.innerHTML = renderMarkdown(doc.editorContent)`. After appending `view`, apply highlights and mount the toolbar:

```ts
  } else {
    const view = el("div", "rendered");
    view.innerHTML = renderMarkdown(doc.editorContent);
    host.appendChild(view);
    applyHighlights(view, doc.resolutions);
    if (teardownToolbar) teardownToolbar();
    teardownToolbar = mountSelectionToolbar(view, () => void startComment(doc.absPath));
  }
```

Add a module-level `let teardownToolbar: (() => void) | null = null;` near `activeEditor`.

5. Add the comment-creation flow and the rail render. Add `startComment`:

```ts
async function startComment(absPath: string): Promise<void> {
  const doc = state.docs.find((d) => d.absPath === absPath);
  if (!doc) return;
  const cap = captureSelection(doc.editorContent);
  if (!cap) return;
  const note = window.prompt(`Comment on "${cap.quote.slice(0, 40)}…"`);
  if (!note) return;
  const annotation: Annotation = {
    id: genId(), quote: cap.quote, prefix: cap.prefix, suffix: cap.suffix,
    lineHint: cap.lineHint, note, status: "open", author: "user",
    createdAt: new Date().toISOString(),
  };
  state = setDocAnnotations(state, absPath, addAnnotation(doc.annotations, annotation));
  await persistAnnotations(absPath);
  render();
}
```

> Note: `window.prompt` is the minimal v1 input. An inline popover is a later polish; prompt keeps this task focused and testable end-to-end.

6. Render the rail in `render()`. Add a `renderRailFor()` call inside `render()` after `renderContent()`:

```ts
function renderRailFor(): void {
  const host = document.getElementById("rail");
  if (!host) return;
  const doc = getActive(state);
  if (!doc) { host.innerHTML = ""; return; }
  renderRail(host, doc.annotations, doc.resolutions, {
    onScrollTo: (a) => {
      const r = doc.resolutions[a.id];
      if (r?.startLine == null) return;
      const node = document.querySelector(`[data-sourceline="${r.startLine}"]`);
      node?.scrollIntoView({ behavior: "smooth", block: "center" });
    },
    onRemove: (a) => {
      state = setDocAnnotations(state, doc.absPath, removeAnnotation(doc.annotations, a.id));
      void persistAnnotations(doc.absPath);
      render();
    },
  });
}
```

And call `renderRailFor();` at the end of `render()` (after `renderContent()`, before `saveSession()`).

7. In `start()`, replace the `onCliInstallResult(...)` line with the multi-step setup handler, and add the annotations-changed listener:

```ts
  await onSetupResult((steps) => {
    const ok = steps.every((s) => s.ok);
    const body = steps.map((s) => `${s.ok ? "✓" : "✗"} ${s.label}: ${s.message}`).join("\n");
    showNotice(body, ok);
  });
  await onAnnotationsChanged((docPath) => { void loadAnnotations(docPath); });
```

8. Add the rail container to the DOM. `index.html` currently has a bare `<main id="content"></main>` (no wrapper). Replace that line with a flex row plus the rail aside:

```html
    <div id="workspace">
      <main id="content"></main>
      <aside id="rail" class="empty"></aside>
    </div>
```

And add to `src/styles.css`:

```css
#workspace { display: flex; flex: 1; min-height: 0; }
#content { flex: 1; min-width: 0; overflow-y: auto; }
```

(The `flex: 1; min-width: 0` is the standard fix if `#content` stops scrolling once nested in the flex row.)

- [ ] **Step 6: Add minimal styles**

Append to `src/styles.css`:

```css
.comment-fab {
  position: absolute; z-index: 50;
  font: 600 12px/1 var(--font-mono, system-ui);
  padding: 6px 10px; border-radius: 6px; border: none;
  background: var(--accent); color: var(--paper, #fff); cursor: pointer;
  box-shadow: 0 2px 8px rgba(0,0,0,.25);
}
.rendered .annotated {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  border-radius: 3px;
}
#rail { width: 260px; overflow-y: auto; padding: 16px; border-left: 1px solid var(--rule, #0002); }
#rail.empty { display: none; }
.rail-head { font: 600 11px/1 var(--font-mono, system-ui); text-transform: uppercase; color: var(--faint); margin: 14px 0 6px; }
.note-card { display: flex; gap: 8px; align-items: baseline; padding: 8px; border-radius: 6px; cursor: pointer; }
.note-card:hover { background: var(--raised, #0001); }
.note-card.orphaned { opacity: .6; }
.note-card.resolved { opacity: .5; text-decoration: line-through; }
.note-line { font: 600 11px/1 var(--font-mono); color: var(--accent); }
.note-text { flex: 1; font-size: 13px; }
.note-del { color: var(--faint); }
```

(Use the existing CSS custom properties already defined in `styles.css`; the fallbacks keep it robust if a token name differs.)

- [ ] **Step 7: Full check — tests, typecheck, build**

Run: `pnpm test && pnpm exec tsc --noEmit && pnpm build`
Expected: all vitest suites pass (existing + `annotations`, `build-anchor`, `annotation-ui`, updated `renderer`); tsc clean; vite build succeeds.

- [ ] **Step 8: Manual verification (DOM glue can't be unit-tested in `node`)**

Run: `pnpm tauri dev`
Verify:
1. Open a markdown file (`mdview` or the dev launch). Select a sentence in the rendered view → "Comment" button appears → click → enter a note. The sentence gets a highlight and a card appears in the right rail showing its line number.
2. Quit and relaunch (or re-open the file): the annotation persists and re-anchors (highlight still on the right sentence).
3. Edit the file's text above the annotated line in another editor and save → the highlight stays on the correct sentence (exact re-anchor), rail line number updates.
4. From a Claude session (after Task 5 setup), `list_annotations(<path>)` returns the note with the current line; `resolve_annotation(<path>, <id>)` → within ~1s the rail card moves to "Resolved" live (store watch).

- [ ] **Step 9: Commit**

```bash
git add src/annotation-ui.ts src/annotation-ui.test.ts src/app.ts src/styles.css index.html
git commit -m "feat(annotations): selection UI, rail, highlights, live resolve wiring"
```

---

## Task 11: Documentation

**Files:**
- Modify: `README.md`, `CLAUDE.md`

**Interfaces:** none (docs).

- [ ] **Step 1: Update `README.md`**

Add a "Claude integration" section documenting:
- The menu item **Glance ▸ Set up Claude Integration…** installs `mdview`, registers the bundled `glance-mcp` server into `~/.claude.json`, and appends review guidance to `~/.claude/CLAUDE.md`.
- The review loop: select text in Glance → add a comment → in a Claude session the comment is readable via `list_annotations` with current line numbers → Claude edits and calls `resolve_annotation`.
- Note v1 is user→Claude (read+resolve); Claude-authored highlights are future work.

- [ ] **Step 2: Update `CLAUDE.md`**

Add to the architecture section:
- `src-tauri/src/anchor.rs` — pure fuzzy anchor resolution, shared by GUI and `glance-mcp`.
- `src-tauri/src/annotations.rs` — on-disk annotation store (`~/.glance/annotations/<sha1(path)>.json`) + IPC commands.
- `src-tauri/src/bin/glance-mcp.rs` — stdio MCP server bundled in `Glance.app`; read+resolve annotation tools.
- `src-tauri/src/setup.rs` — one-click integration setup behind the menu.
- Frontend: `annotations.ts` (reducers), `build-anchor.ts`/`anchor-capture.ts` (capture), `annotation-ui.ts` (rail/highlights). Annotation resolution always happens in Rust; TS only captures and renders.
- Add to Commands: `cargo test --bin glance-mcp` (MCP unit tests).

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: document Glance↔Claude annotation integration"
```

---

## Self-Review Notes

- **Spec coverage:** architecture (Tasks 1–4), data model (Task 2/6), anchoring algorithm with all four fallbacks (Task 1, tests cover exact/quote-only/drifted/orphaned/multiline), MCP tool surface incl. resource (Task 4), re-anchor-on-read (Task 4 `view_of`), UI create/rail/highlight/orphan-list (Task 10), one-click portable setup with translocation guard + idempotent merge (Task 5), distribution via second `[[bin]]` bundled in the app (Task 4), testing strategy (every Rust/TS module has unit tests; DOM glue has explicit manual steps). Auto-open (spec A) is delivered by the `mdview` install inside Task 5 + guidance text.
- **Deferred per spec:** `add_annotation`/highlight write tools (v2) — not in any task, intentionally.
- **Type consistency:** Rust `Resolution { startLine, endLine, anchor }` ↔ TS `Resolution`; store JSON `docPath`/`lineHint`/`createdAt` match across Rust serde renames and TS interfaces; MCP `AnnotationView` uses `lineStart`/`lineEnd` (view-only, distinct from `Resolution`'s `startLine`/`endLine` — intentional, documented in each).
- **Layout:** `index.html` ships a bare `<main id="content">`; Task 10 Step 5.8 wraps it in `#workspace` (flex row) with the `#rail` aside and the matching CSS — verified against the actual markup.
