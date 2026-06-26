# Glance Agent Integration (Skill + Auto-Open Hook) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the one-click "Set up Claude Integration…" action also install a `glance` agent skill (teaching the comment-review loop) and a PostToolUse hook that auto-opens new project markdown in Glance.

**Architecture:** Both artifacts are embedded as string constants in `src-tauri/src/setup.rs` (the same approach as the existing `guidance_block()`), written to disk by two new steps appended to `setup_claude_integration()`. The hook is a `/bin/sh` script that uses `python3` to parse the Claude Code hook event on stdin and launches the app binary (absolute path, baked in at install) on qualifying files.

**Tech Stack:** Rust (`serde_json`, std fs/unix permissions), `/bin/sh` + `python3` for the hook, Claude Code skill (`SKILL.md`) and settings.json hook formats.

## Global Constraints

- Artifacts are embedded as Rust string constants and written by `setup_claude_integration()` — no runtime resource-file lookups.
- The hook references the app binary by **absolute path from `current_exe()`**, interpolated at install time — never relies on `mdview`/`glance-mcp` being on `$PATH`.
- `install_open_hook` reuses the existing **AppTranslocation guard** (refuse, returning a failed `StepResult`, when `current_exe()` contains `"AppTranslocation"`).
- Skill install path: `~/.claude/skills/glance/SKILL.md`. Hook script path: `~/.claude/skills/glance/open-md-hook.sh`.
- Hook fires `mdview` (opens the doc) iff ALL: `tool_name == "Write"`; path ends `.md`/`.markdown`; path is inside `cwd`; no path segment is `node_modules` or starts with `.`. The hook **always exits 0** and launches the binary detached (`… >/dev/null 2>&1 &`).
- Settings hook matcher is exactly `"Write"`. Registration is idempotent (no duplicate if the command string already appears under `PostToolUse`).
- Agent MCP surface stays read+resolve only: the skill references `list_annotations`, `get_annotation`, `resolve_annotation` and states there is no create tool.
- **Deviation from spec (deliberate):** the spec's separate temp-dir (`$TMPDIR`/`/tmp`/`/private/tmp`) exclusion is omitted. It is subsumed by the in-`cwd` requirement (an in-`cwd` file is only temp-rooted when `cwd` itself is, i.e. a legitimate sandbox/test project root) and would wrongly exclude such roots. The in-`cwd` + `node_modules` + dotdir filters are the scope.

---

## File Structure

- `src-tauri/src/setup.rs` — *modify*. Add `skill_doc()`, `hook_script()`, `merge_settings_hook()` (pure, embedded text + JSON merge), `install_skill()`, `install_open_hook()` (I/O), and append both to `setup_claude_integration()`. Add unit tests + one shell-behavior test.
- `README.md` — *modify*. Note the skill + hook in the Claude integration section.
- `CLAUDE.md` — *modify*. Note `setup.rs` now installs the skill + hook.

No new files; everything lands in the one module that owns the setup action.

---

## Task 1: The `glance` skill (`skill_doc` + `install_skill`)

**Files:**
- Modify: `src-tauri/src/setup.rs`

**Interfaces:**
- Consumes: existing `StepResult`, `home()`.
- Produces:
  - `pub fn skill_doc() -> String` — the full `SKILL.md` text.
  - `fn install_skill() -> StepResult` — writes `~/.claude/skills/glance/SKILL.md`.

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` block in `src-tauri/src/setup.rs`:

```rust
    #[test]
    fn skill_doc_has_trigger_and_tools() {
        let s = skill_doc();
        assert!(s.contains("name: glance"));
        assert!(s.contains("description:"));
        // teaches the mdview open convention and all three read+resolve MCP tools
        assert!(s.contains("mdview <absolute-path>"));
        assert!(s.contains("list_annotations"));
        assert!(s.contains("get_annotation"));
        assert!(s.contains("resolve_annotation"));
        // names the anchor states the agent must interpret
        assert!(s.contains("orphaned"));
        assert!(s.contains("drifted"));
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test setup::tests::skill_doc_has_trigger_and_tools`
Expected: FAIL — `cannot find function skill_doc in this scope`.

- [ ] **Step 3: Implement `skill_doc()`**

Add to `src-tauri/src/setup.rs` (after `guidance_block()`):

```rust
/// The `glance` agent skill, written to ~/.claude/skills/glance/SKILL.md.
pub fn skill_doc() -> String {
    r#"---
name: glance
description: Use when you create or update a markdown file the user should review, or when the user refers to Glance, their review comments, or annotations on a document. Opens docs in Glance and reads and acts on the user's anchored comments.
---

# Using Glance

Glance is the user's macOS markdown viewer. It shows the documents you produce and lets the user attach **anchored review comments** to specific lines. Your job: surface docs for review, then read and act on those comments.

## Surface a document for review

Open any markdown the user should review:

```
mdview <absolute-path>
```

New files you create in the project are usually opened automatically by a hook. Call `mdview` yourself for files the hook will not catch — e.g. an existing doc the user asks you to revise. Glance reuses one window and de-dupes tabs, so repeated calls are safe.

## Read the user's comments

Use the Glance MCP tools. To list open comments on a file, with line numbers resolved against its **current** contents:

```
list_annotations(path: "<absolute-path>")
```

Each comment has:
- `note` — what the user wants changed.
- `lineStart` / `lineEnd` — its current location. Trust these; they are re-anchored live, not the line the user first selected.
- `quote` — the text it is anchored to.
- `anchor` — how confidently it was located:
  - `exact` — found unambiguously. Act on it.
  - `quote-only` — text matched but its surroundings moved. Still reliable.
  - `drifted` — the quoted text is gone; this is an approximate line. Confirm with the user before editing.
  - `orphaned` — the quoted text no longer exists anywhere. Do not guess — ask the user what they meant.

Use `get_annotation(path, id)` for one comment with surrounding context.

## Act, then close the loop

1. Make the change the comment asks for, at the indicated lines.
2. Call `resolve_annotation(path: "<absolute-path>", id: "<id>")`. It flips to resolved live in Glance so the user sees it handled.
3. When done, call `list_annotations` again to confirm nothing is still open.

## Etiquette

- Your tools are read + resolve only (`list_annotations`, `get_annotation`, `resolve_annotation`). There is no tool to create annotations — that is the user's side.
- Resolve a comment only after you actually addressed it. One resolve per comment.
"#
    .to_string()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src-tauri && cargo test setup::tests::skill_doc_has_trigger_and_tools`
Expected: PASS.

- [ ] **Step 5: Implement `install_skill()`**

Add to `src-tauri/src/setup.rs` (after `write_guidance()`):

```rust
fn install_skill() -> StepResult {
    let label = "Install Glance agent skill".to_string();
    let home = match home() {
        Some(h) => h,
        None => return StepResult { ok: false, label, message: "Could not determine your home directory ($HOME).".to_string() },
    };
    let dir = home.join(".claude").join("skills").join("glance");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return StepResult { ok: false, label, message: format!("Could not create {}: {e}", dir.display()) };
    }
    let path = dir.join("SKILL.md");
    match std::fs::write(&path, skill_doc()) {
        Ok(_) => StepResult { ok: true, label, message: format!("Installed skill → {}", path.display()) },
        Err(e) => StepResult { ok: false, label, message: format!("Could not write {}: {e}", path.display()) },
    }
}
```

(`install_skill` is not yet called — Task 3 wires it in. It will warn as dead code until then; that is expected and resolved in Task 3. Do not add `#[allow(dead_code)]`.)

- [ ] **Step 6: Verify it compiles and the test suite is green**

Run: `cd src-tauri && cargo test setup::`
Expected: all `setup::` tests pass (existing 3 + `skill_doc_has_trigger_and_tools`). A `function `install_skill` is never used` warning is acceptable for now.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/setup.rs
git commit -m "feat(setup): embed glance agent skill + install_skill"
```

---

## Task 2: The auto-open hook (`hook_script` + `merge_settings_hook` + `install_open_hook`)

**Files:**
- Modify: `src-tauri/src/setup.rs`

**Interfaces:**
- Consumes: existing `StepResult`, `home()`.
- Produces:
  - `pub fn hook_script(app_bin: &str) -> String` — the `/bin/sh` hook with `app_bin` interpolated.
  - `pub fn merge_settings_hook(existing: &str, command: &str) -> String` — idempotent settings.json merge adding a `PostToolUse`/`Write` hook.
  - `fn install_open_hook() -> StepResult` — writes the script (0755) + registers it in `~/.claude/settings.json`.

- [ ] **Step 1: Write the failing tests for the pure helpers**

Add to the `#[cfg(test)] mod tests` block:

```rust
    #[test]
    fn hook_script_interpolates_binary_and_filters() {
        let s = hook_script("/Applications/Glance.app/Contents/MacOS/glance");
        assert!(s.contains("/Applications/Glance.app/Contents/MacOS/glance"));
        // key guards present in the script body
        assert!(s.contains("python3"));
        assert!(s.contains("Write"));
        assert!(s.contains("node_modules"));
        assert!(s.contains(".md"));
        assert!(s.contains("exit 0"));
    }

    #[test]
    fn merge_settings_hook_creates_entry_in_empty() {
        let out = merge_settings_hook("", "/h/open-md-hook.sh");
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        let entry = &v["hooks"]["PostToolUse"][0];
        assert_eq!(entry["matcher"], "Write");
        assert_eq!(entry["hooks"][0]["type"], "command");
        assert_eq!(entry["hooks"][0]["command"], "/h/open-md-hook.sh");
    }

    #[test]
    fn merge_settings_hook_preserves_others_and_is_idempotent() {
        let existing = r#"{"model":"opus","hooks":{"PostToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"/other.sh"}]}]}}"#;
        let once = merge_settings_hook(existing, "/h/open-md-hook.sh");
        let twice = merge_settings_hook(&once, "/h/open-md-hook.sh");
        let v: serde_json::Value = serde_json::from_str(&twice).unwrap();
        assert_eq!(v["model"], "opus");
        let arr = v["hooks"]["PostToolUse"].as_array().unwrap();
        // original Bash entry kept, our Write entry added exactly once
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["matcher"], "Bash");
        assert_eq!(arr[1]["matcher"], "Write");
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test setup::tests::hook_script_interpolates_binary_and_filters setup::tests::merge_settings_hook_creates_entry_in_empty setup::tests::merge_settings_hook_preserves_others_and_is_idempotent`
Expected: FAIL — `cannot find function hook_script` / `merge_settings_hook`.

- [ ] **Step 3: Implement `hook_script()` and `merge_settings_hook()`**

Add to `src-tauri/src/setup.rs`:

```rust
/// The PostToolUse hook script. `app_bin` (absolute path to the Glance GUI
/// binary) is interpolated via a placeholder so the embedded `python3` heredoc
/// keeps its literal braces. Opens NEW project markdown; always exits 0.
pub fn hook_script(app_bin: &str) -> String {
    const TEMPLATE: &str = r#"#!/bin/sh
# Glance auto-open hook (PostToolUse). Opens new project markdown in Glance.
# Reads the Claude Code tool event JSON from stdin and prints the file to open
# (a Write of a .md inside cwd, skipping node_modules and dotdirs); fires nothing
# otherwise. Always exits 0 so it can never block the agent.
TARGET=$(python3 - <<'PY'
import sys, json, os
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if d.get("tool_name") != "Write":
    sys.exit(0)
ti = d.get("tool_input") or {}
fp = ti.get("file_path") or ""
cwd = d.get("cwd") or ""
if not fp or not cwd:
    sys.exit(0)
cwd = os.path.abspath(cwd)
ap = fp if os.path.isabs(fp) else os.path.join(cwd, fp)
ap = os.path.abspath(ap)
if not (ap.endswith(".md") or ap.endswith(".markdown")):
    sys.exit(0)
try:
    if os.path.commonpath([ap, cwd]) != cwd:
        sys.exit(0)
except ValueError:
    sys.exit(0)
rel = os.path.relpath(ap, cwd)
parts = rel.split(os.sep)
if any(p == "node_modules" or p.startswith(".") for p in parts):
    sys.exit(0)
print(ap)
PY
)
[ -n "$TARGET" ] && "__APP_BIN__" "$TARGET" >/dev/null 2>&1 &
exit 0
"#;
    TEMPLATE.replace("__APP_BIN__", app_bin)
}

/// Add a PostToolUse/Write hook running `command` to a settings.json string,
/// preserving everything else. Idempotent: no-op if `command` already appears
/// under any PostToolUse entry. Tolerates empty/invalid input.
pub fn merge_settings_hook(existing: &str, command: &str) -> String {
    let mut root: serde_json::Value =
        serde_json::from_str(existing).unwrap_or_else(|_| serde_json::json!({}));
    if !root.is_object() {
        root = serde_json::json!({});
    }
    let obj = root.as_object_mut().unwrap();
    let hooks = obj.entry("hooks").or_insert_with(|| serde_json::json!({}));
    if !hooks.is_object() {
        *hooks = serde_json::json!({});
    }
    let hooks_obj = hooks.as_object_mut().unwrap();
    let post = hooks_obj
        .entry("PostToolUse")
        .or_insert_with(|| serde_json::json!([]));
    if !post.is_array() {
        *post = serde_json::json!([]);
    }
    let arr = post.as_array_mut().unwrap();
    let already = arr.iter().any(|entry| {
        entry
            .get("hooks")
            .and_then(|h| h.as_array())
            .is_some_and(|hs| {
                hs.iter()
                    .any(|h| h.get("command").and_then(|c| c.as_str()) == Some(command))
            })
    });
    if !already {
        arr.push(serde_json::json!({
            "matcher": "Write",
            "hooks": [ { "type": "command", "command": command } ]
        }));
    }
    serde_json::to_string_pretty(&root).unwrap()
}
```

- [ ] **Step 4: Run the pure-helper tests to verify they pass**

Run: `cd src-tauri && cargo test setup::tests::hook_script setup::tests::merge_settings_hook`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing shell-behavior test**

This runs the generated hook script against fixture stdin and checks whether it launches a stub "app binary" (which appends to a marker file). Gated on `python3` being available. Add to the `tests` module:

```rust
    use std::io::Write as _;
    use std::path::PathBuf;

    fn python3_available() -> bool {
        std::process::Command::new("python3")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    // Run the hook with the given stdin JSON; return true if the stub binary
    // fired (marker file created) within a short window.
    fn run_hook(dir: &PathBuf, stub: &PathBuf, marker: &PathBuf, stdin_json: &str) -> bool {
        let script = dir.join("open-md-hook.sh");
        std::fs::write(&script, hook_script(&stub.to_string_lossy())).unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let _ = std::fs::remove_file(marker);
        let mut child = std::process::Command::new("sh")
            .arg(&script)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(stdin_json.as_bytes()).unwrap();
        let _ = child.wait();
        // the stub is launched detached (`&`); poll briefly for the marker
        for _ in 0..40 {
            if marker.exists() {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        false
    }

    #[test]
    fn hook_fires_only_for_new_project_markdown() {
        if !python3_available() {
            eprintln!("skipping hook_fires_only_for_new_project_markdown: python3 not available");
            return;
        }
        // unique temp project dir (this dir is the agent cwd in fixtures)
        let base = std::env::temp_dir().join(format!("glance-hook-{}", std::process::id()));
        let proj = base.join("proj");
        std::fs::create_dir_all(proj.join("node_modules")).unwrap();
        std::fs::create_dir_all(proj.join(".hidden")).unwrap();
        let marker = base.join("marker");
        // stub "app binary": records that it was invoked
        let stub = base.join("stub.sh");
        std::fs::write(&stub, format!("#!/bin/sh\nprintf 'x' >> \"{}\"\n", marker.display())).unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let cwd = proj.to_string_lossy().to_string();
        let json = |tool: &str, file: String| {
            format!(r#"{{"tool_name":"{tool}","cwd":"{cwd}","tool_input":{{"file_path":"{file}"}}}}"#)
        };

        // FIRES: a Write of a new .md inside the project
        assert!(run_hook(&base, &stub, &marker, &json("Write", proj.join("notes.md").to_string_lossy().to_string())));
        // does NOT fire: Edit tool
        assert!(!run_hook(&base, &stub, &marker, &json("Edit", proj.join("notes.md").to_string_lossy().to_string())));
        // does NOT fire: non-markdown
        assert!(!run_hook(&base, &stub, &marker, &json("Write", proj.join("readme.txt").to_string_lossy().to_string())));
        // does NOT fire: under node_modules
        assert!(!run_hook(&base, &stub, &marker, &json("Write", proj.join("node_modules").join("x.md").to_string_lossy().to_string())));
        // does NOT fire: under a dotdir
        assert!(!run_hook(&base, &stub, &marker, &json("Write", proj.join(".hidden").join("x.md").to_string_lossy().to_string())));

        let _ = std::fs::remove_dir_all(&base);
    }
```

- [ ] **Step 6: Run the behavior test**

Run: `cd src-tauri && cargo test setup::tests::hook_fires_only_for_new_project_markdown -- --nocapture`
Expected: PASS (the `hook_script` from Step 3 already implements the filtering; this test exercises it end-to-end). If `python3` is unavailable it prints the skip line and passes.

- [ ] **Step 7: Implement `install_open_hook()`**

Add to `src-tauri/src/setup.rs`:

```rust
fn install_open_hook() -> StepResult {
    let label = "Install auto-open hook".to_string();
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
    let app_bin = exe.to_string_lossy().to_string();
    let home = match home() {
        Some(h) => h,
        None => return StepResult { ok: false, label, message: "Could not determine your home directory ($HOME).".to_string() },
    };
    let dir = home.join(".claude").join("skills").join("glance");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return StepResult { ok: false, label, message: format!("Could not create {}: {e}", dir.display()) };
    }
    let script_path = dir.join("open-md-hook.sh");
    if let Err(e) = std::fs::write(&script_path, hook_script(&app_bin)) {
        return StepResult { ok: false, label, message: format!("Could not write {}: {e}", script_path.display()) };
    }
    use std::os::unix::fs::PermissionsExt;
    if let Err(e) = std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755)) {
        return StepResult { ok: false, label, message: format!("Could not make {} executable: {e}", script_path.display()) };
    }
    let settings_path = home.join(".claude").join("settings.json");
    let existing = std::fs::read_to_string(&settings_path).unwrap_or_default();
    let merged = merge_settings_hook(&existing, &script_path.to_string_lossy());
    match std::fs::write(&settings_path, merged) {
        Ok(_) => StepResult { ok: true, label, message: format!("Installed auto-open hook → {}", script_path.display()) },
        Err(e) => StepResult { ok: false, label, message: format!("Could not write {}: {e}", settings_path.display()) },
    }
}
```

(Like `install_skill`, `install_open_hook` is wired in Task 3; a dead-code warning until then is expected.)

- [ ] **Step 8: Verify the suite compiles and passes**

Run: `cd src-tauri && cargo test setup::`
Expected: all `setup::` tests pass (existing 3 + Task 1 + the 3 pure + 1 behavior added here). Dead-code warnings for `install_open_hook`/`install_skill` are acceptable until Task 3.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/setup.rs
git commit -m "feat(setup): auto-open hook script + settings.json registration"
```

---

## Task 3: Wire both steps into setup + docs

**Files:**
- Modify: `src-tauri/src/setup.rs:113-120` (the `setup_claude_integration` body), `README.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: `install_skill()`, `install_open_hook()` from Tasks 1–2.
- Produces: a `setup_claude_integration()` that returns 5 `StepResult`s.

- [ ] **Step 1: Append the two steps**

In `src-tauri/src/setup.rs`, change `setup_claude_integration()` to:

```rust
pub fn setup_claude_integration() -> Vec<StepResult> {
    let cli = install_cli_tool();
    vec![
        StepResult { ok: cli.ok, label: "Install mdview CLI".to_string(), message: cli.message },
        register_mcp(),
        write_guidance(),
        install_skill(),
        install_open_hook(),
    ]
}
```

- [ ] **Step 2: Verify the full Rust suite is green with no dead-code warnings**

Run: `cd src-tauri && cargo build && cargo test`
Expected: builds with **no** `never used` warnings for `install_skill`/`install_open_hook` (now called); all tests pass (anchor 6, annotations 3, glance-mcp 5, cli 4, setup: 3 existing + skill_doc + 3 hook/merge + 1 behavior = 8).

- [ ] **Step 3: Commit the wiring**

```bash
git add src-tauri/src/setup.rs
git commit -m "feat(setup): install skill + auto-open hook in one-click setup"
```

- [ ] **Step 4: Update README.md**

In the "Claude integration" section of `README.md`, add that the one-click **Set up Claude Integration…** action now also:
- installs a `glance` agent skill at `~/.claude/skills/glance/SKILL.md` that teaches Claude the review-comment loop (read `list_annotations` → edit → `resolve_annotation`); and
- installs a PostToolUse hook (`~/.claude/skills/glance/open-md-hook.sh`, registered in `~/.claude/settings.json`) that automatically opens new project `.md` files in Glance as Claude writes them (skips `node_modules`, dotdirs, and files outside the working directory).

Keep the existing list of setup steps consistent (it now performs five actions).

- [ ] **Step 5: Update CLAUDE.md**

In the `setup.rs` architecture line of `CLAUDE.md`, extend it to note that the setup action also writes `~/.claude/skills/glance/SKILL.md` (the agent skill) and `open-md-hook.sh` plus a `PostToolUse`/`Write` entry in `~/.claude/settings.json` (auto-open hook). No new command needed (the `cargo test --bin glance-mcp` line already exists; setup tests run under `cargo test`).

- [ ] **Step 6: Commit docs**

```bash
git add README.md CLAUDE.md
git commit -m "docs: document the glance skill + auto-open hook in setup"
```

---

## Self-Review Notes

- **Spec coverage:** skill content + trigger (Task 1); hook script fire-conditions + always-exit-0 + detached launch (Task 2 `hook_script` + behavior test); settings.json idempotent registration (Task 2 `merge_settings_hook` + tests); PATH-independence via baked `current_exe()` path (Task 2 `install_open_hook`); AppTranslocation guard (Task 2); embedded-as-constants (both); wiring into the 5-step one-click action (Task 3); README + CLAUDE.md docs (Task 3).
- **Deliberate spec deviation:** the temp-dir exclusion is omitted (documented in Global Constraints) — subsumed by the in-`cwd` requirement and would break temp-rooted project roots / the behavior test. If the reviewer considers this a spec violation, it is the human's call; the rationale is in the plan.
- **Type/name consistency:** `skill_doc`, `hook_script`, `merge_settings_hook`, `install_skill`, `install_open_hook` are used identically across tasks; settings entry shape (`matcher:"Write"`, `hooks:[{type:"command",command}]`) matches between `merge_settings_hook`, its tests, and the spec.
- **No placeholders:** every step carries full code or an exact command + expected output.
- **`is_some_and`** (Task 2 `merge_settings_hook`) requires Rust ≥ 1.70 — well below the project's stable toolchain; if the toolchain were older, substitute `.map_or(false, …)`.
