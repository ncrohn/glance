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
