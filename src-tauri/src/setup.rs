use crate::cli_install::install_cli_tool;
use serde::Serialize;
use std::path::PathBuf;

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

/// The PostToolUse hook script. `app_bin` (absolute path to the Glance GUI
/// binary) is interpolated via a placeholder so the embedded `python3` heredoc
/// keeps its literal braces. Opens NEW project markdown; always exits 0.
pub fn hook_script(app_bin: &str) -> String {
    const TEMPLATE: &str = r#"#!/bin/sh
# Glance auto-open hook (PostToolUse). Opens new project markdown in Glance.
# Reads the Claude Code tool event JSON from stdin and prints the file to open
# (a Write of a .md inside cwd, skipping node_modules and dotdirs); fires nothing
# otherwise. Always exits 0 so it can never block the agent.
#
# The Python code is captured into a variable first so that python3's stdin
# remains the outer process's stdin (the JSON event). Using `python3 - <<HEREDOC`
# would replace python3's stdin with the heredoc, losing the JSON.
_GLANCE_PY=$(cat <<'PY'
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
TARGET=$(python3 -c "$_GLANCE_PY")
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

pub fn setup_claude_integration() -> Vec<StepResult> {
    let cli = install_cli_tool();
    vec![
        StepResult { ok: cli.ok, label: "Install mdview CLI".to_string(), message: cli.message },
        register_mcp(),
        write_guidance(),
    ]
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
}
