use crate::cli_install::install_cli_tool;
use serde::Serialize;
use std::path::{Path, PathBuf};

/// Read a config file we are about to rewrite. A missing file is fine (empty
/// string → treated as a fresh config). Any *other* read error (e.g. a
/// permissions failure) is returned as an error so callers refuse to overwrite:
/// defaulting to "" here would let a merge silently replace an unread file with
/// a minimal one, destroying the user's real config.
fn read_existing(path: &Path) -> Result<String, String> {
    match std::fs::read_to_string(path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("Could not read {}: {e}", path.display())),
    }
}

/// Write `contents` to `path` atomically (temp file in the same dir + rename),
/// so a crash / disk-full / force-quit mid-write can't leave the user's global
/// config truncated or corrupt.
fn atomic_write(path: &Path, contents: &str) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, contents)?;
    std::fs::rename(&tmp, path)
}

#[derive(Clone, Debug, Serialize)]
pub struct StepResult {
    pub ok: bool,
    pub label: String,
    pub message: String,
    /// Which section the result modal files this row under: `"Shared"` for the
    /// mdview CLI, otherwise the client's display name.
    pub group: String,
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
/// preserving every other key. An empty input starts fresh, but non-empty input
/// that isn't a JSON object is an error rather than being silently discarded —
/// this file holds the user's entire Claude Code state (auth, projects), so
/// clobbering it on a transient parse failure would be catastrophic.
pub fn merge_mcp_config(existing: &str, name: &str, command: &str) -> Result<String, String> {
    let mut root = parse_config_object(existing, "~/.claude.json")?;
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
    serde_json::to_string_pretty(&root).map_err(|e| e.to_string())
}

/// Parse a config string into a JSON object. Empty/whitespace → a fresh `{}`.
/// Non-empty content that fails to parse, or parses to a non-object, is an error
/// — callers must not overwrite the file in that case.
fn parse_config_object(existing: &str, name: &str) -> Result<serde_json::Value, String> {
    if existing.trim().is_empty() {
        return Ok(serde_json::json!({}));
    }
    let root: serde_json::Value = serde_json::from_str(existing).map_err(|e| {
        format!("{name} is not valid JSON ({e}); refusing to overwrite it. Fix or remove the file, then retry.")
    })?;
    if !root.is_object() {
        return Err(format!("{name} is not a JSON object; refusing to overwrite it."));
    }
    Ok(root)
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
# Launch detached. This MUST be a single backgrounded command inside `if`, not
# `[ … ] && app &`: backgrounding an AND-list runs it in a subshell that keeps
# the hook's inherited stdout/stderr open for the app's whole lifetime, so Claude
# Code (which reads the hook's stdout to EOF) hangs until the user quits Glance.
# A lone `app … & ` reparents to launchd immediately; </dev/null also severs
# stdin so the GUI never holds the caller's terminal.
if [ -n "$TARGET" ]; then
  "__APP_BIN__" "$TARGET" >/dev/null 2>&1 </dev/null &
fi
exit 0
"#;
    TEMPLATE.replace("__APP_BIN__", app_bin)
}

/// Add a PostToolUse/Write hook running `command` to a settings.json string,
/// preserving everything else. Idempotent: no-op if `command` already appears
/// under any PostToolUse entry. Tolerates empty/invalid input.
pub fn merge_settings_hook(existing: &str, command: &str) -> Result<String, String> {
    let mut root = parse_config_object(existing, "~/.claude/settings.json")?;
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
    serde_json::to_string_pretty(&root).map_err(|e| e.to_string())
}

/// Remove the `mcpServers.<name>` entry from a config string, preserving every
/// other key. Returns `None` when the file is empty or the entry is absent
/// (nothing to do), so callers can report "not registered" instead of a
/// needless rewrite. Refuses to touch content that isn't a JSON object — same
/// clobber-guard as [`merge_mcp_config`].
pub fn remove_mcp_config(existing: &str, name: &str, file: &str) -> Result<Option<String>, String> {
    if existing.trim().is_empty() {
        return Ok(None);
    }
    let mut root = parse_config_object(existing, file)?;
    let removed = root
        .as_object_mut()
        .unwrap()
        .get_mut("mcpServers")
        .and_then(|s| s.as_object_mut())
        .is_some_and(|m| m.remove(name).is_some());
    if !removed {
        return Ok(None);
    }
    Ok(Some(serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?))
}

/// Remove any PostToolUse entry that runs `command` from a settings.json string,
/// preserving everything else. Drops an entry entirely if it had only that one
/// hook. Returns `None` when nothing matched. Tolerates empty input, refuses
/// non-object content.
pub fn remove_settings_hook(existing: &str, command: &str, file: &str) -> Result<Option<String>, String> {
    if existing.trim().is_empty() {
        return Ok(None);
    }
    let mut root = parse_config_object(existing, file)?;
    let post = root
        .as_object_mut()
        .unwrap()
        .get_mut("hooks")
        .and_then(|h| h.as_object_mut())
        .and_then(|h| h.get_mut("PostToolUse"))
        .and_then(|p| p.as_array_mut());
    let Some(arr) = post else { return Ok(None) };
    let before = arr.len();
    // For each entry, drop the matching inner hook; then drop entries left empty.
    for entry in arr.iter_mut() {
        if let Some(hs) = entry.get_mut("hooks").and_then(|h| h.as_array_mut()) {
            hs.retain(|h| h.get("command").and_then(|c| c.as_str()) != Some(command));
        }
    }
    arr.retain(|entry| {
        entry
            .get("hooks")
            .and_then(|h| h.as_array())
            .map(|hs| !hs.is_empty())
            .unwrap_or(true)
    });
    if arr.len() == before {
        return Ok(None);
    }
    Ok(Some(serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?))
}

/// Strip the guidance block (and the blank line before it) from a shared doc
/// like `~/.claude/CLAUDE.md`, leaving the user's own content intact. Returns
/// `None` when the block isn't present. Matches the exact block [`append_guidance`]
/// wrote — an older, differently-worded block would not be recognized, so an
/// install/uninstall pair must be on the same Glance version.
pub fn strip_guidance(existing: &str) -> Option<String> {
    let block = guidance_block();
    let idx = existing.find(&block)?;
    let mut out = String::with_capacity(existing.len());
    out.push_str(&existing[..idx]);
    out.push_str(&existing[idx + block.len()..]);
    let trimmed = out.trim_end();
    Some(if trimmed.is_empty() { String::new() } else { format!("{trimmed}\n") })
}

/// Whether `mcpServers.<name>` is present in a config string. Read-only probe
/// for "is Glance already wired in" — any parse/shape problem is treated as
/// "not present" (false), never an error, since this only drives a UI hint.
pub fn mcp_config_has(existing: &str, name: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(existing)
        .ok()
        .and_then(|v| v.get("mcpServers")?.get(name).map(|_| true))
        .unwrap_or(false)
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Absolute paths to the two binaries the adapters register. Both live inside
/// `Glance.app`: `app_bin` is the running GUI, `mcp_bin` is `glance-mcp` bundled
/// next to it. Resolved once and shared by every adapter (all clients point at
/// the same binaries — only *where* they record the paths differs).
pub struct Binaries {
    /// glance-mcp — the stdio MCP server clients spawn.
    pub mcp_bin: String,
    /// The Glance GUI binary — what the auto-open hook launches.
    pub app_bin: String,
}

/// Locate the bundled binaries, refusing if we are running from a quarantined
/// (App Translocation) copy — paths there are ephemeral and would break the
/// moment the user moves the app.
fn resolve_binaries() -> Result<Binaries, String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("Could not locate the Glance binary: {e}"))?;
    if exe.to_string_lossy().contains("AppTranslocation") {
        return Err("Glance is running from a quarantined copy. Move Glance.app to /Applications, reopen it, then try again.".to_string());
    }
    // glance-mcp is bundled next to the GUI binary inside Glance.app.
    let mcp = exe
        .parent()
        .ok_or_else(|| "Could not resolve the app directory.".to_string())?
        .join("glance-mcp");
    Ok(Binaries {
        mcp_bin: mcp.to_string_lossy().to_string(),
        app_bin: exe.to_string_lossy().to_string(),
    })
}

/// One file the driver will write atomically. `contents` is already merged
/// against whatever was on disk — the adapter's job is to compute it, the
/// driver's job is to commit it.
pub struct FileWrite {
    pub path: PathBuf,
    pub contents: String,
    /// chmod 0o755 after writing (hook scripts).
    pub executable: bool,
}

/// Outcome of computing one capability for one client.
pub enum Plan {
    /// Perform these writes.
    Write(Vec<FileWrite>),
    /// Delete these paths (a file or a whole directory). Missing paths are fine.
    /// Used by uninstall.
    Delete(Vec<PathBuf>),
    /// Already satisfied; message for the UI. No change.
    AlreadyDone(String),
    /// This client has no such capability — skipped, not a failure.
    NotSupported,
}

/// The four things an adapter can install for a client. `Capability::ALL` is
/// the canonical order; both enumeration (the picker) and execution iterate it,
/// so the set can never drift between "what we show" and "what we run".
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Capability {
    Mcp,
    Guidance,
    Skill,
    Hook,
}

impl Capability {
    pub const ALL: [Capability; 4] = [Capability::Mcp, Capability::Guidance, Capability::Skill, Capability::Hook];

    pub fn key(self) -> &'static str {
        match self {
            Capability::Mcp => "mcp",
            Capability::Guidance => "guidance",
            Capability::Skill => "skill",
            Capability::Hook => "hook",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Capability::Mcp => "MCP server (glance-mcp)",
            Capability::Guidance => "Review guidance",
            Capability::Skill => "Agent skill",
            Capability::Hook => "Auto-open hook",
        }
    }
}

/// One capability's eligibility for a client, for the picker UI.
#[derive(Clone, Debug, Serialize)]
pub struct CapabilityInfo {
    pub key: String,
    pub label: String,
    pub supported: bool,
}

/// A client the picker can offer, with its detection state and per-capability
/// eligibility. Produced by [`list_integration_targets`]; no side effects.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    pub id: String,
    pub display_name: String,
    pub present: bool,
    /// Whether glance-mcp is already registered with this client — drives the
    /// "set up AI integration" empty-state prompt.
    pub configured: bool,
    pub capabilities: Vec<CapabilityInfo>,
}

/// One AI coding client Glance can integrate with (Claude Code, Cursor, …).
///
/// Methods may *read* existing config to compute a merge, but never write — the
/// driver ([`run_step`]) owns all writes so the "refuse to clobber" and atomic
/// guarantees live in one audited place. Capabilities a client lacks return
/// [`Plan::NotSupported`] (the default impls) so adding a new client is just
/// `mcp` + `is_present`.
pub trait ClientAdapter {
    /// Stable id, e.g. "claude", "cursor".
    fn id(&self) -> &'static str;
    /// Human name for the setup UI, e.g. "Claude Code".
    fn display_name(&self) -> &'static str;

    /// Whether this client looks installed — drives which adapters the setup UI
    /// offers. Usually: its config dir/file exists.
    fn is_present(&self, home: &Path) -> bool;

    /// Which capabilities this client supports. The single source of truth for
    /// both the picker (eligibility) and the run loop (what to execute) — an
    /// unsupported capability is never shown as installable nor run.
    fn supports(&self, c: Capability) -> bool;

    /// Whether glance-mcp is already registered with this client. Read-only;
    /// drives the empty-state "set up AI integration" prompt.
    fn is_configured(&self, home: &Path) -> bool;

    /// Register glance-mcp. The only required capability — it is the core loop.
    fn mcp(&self, home: &Path, mcp_bin: &str) -> Result<Plan, String>;

    /// Teach the agent the review convention. Default: unsupported.
    fn guidance(&self, _home: &Path) -> Result<Plan, String> {
        Ok(Plan::NotSupported)
    }

    /// Install the agent skill. Default: unsupported (Claude-only today).
    fn skill(&self, _home: &Path) -> Result<Plan, String> {
        Ok(Plan::NotSupported)
    }

    /// Install the auto-open-on-write hook. Default: unsupported (Claude
    /// PostToolUse only, today).
    fn open_hook(&self, _home: &Path, _app_bin: &str) -> Result<Plan, String> {
        Ok(Plan::NotSupported)
    }

    // --- uninstall: reverse of the four capabilities above. Each defaults to
    // NotSupported so a client only reverses what it actually installed. The
    // shared `mdview` CLI is intentionally left in place — it is not a
    // per-client connector.

    /// De-register glance-mcp. Default: unsupported.
    fn mcp_uninstall(&self, _home: &Path) -> Result<Plan, String> {
        Ok(Plan::NotSupported)
    }

    /// Remove the review guidance. Default: unsupported.
    fn guidance_uninstall(&self, _home: &Path) -> Result<Plan, String> {
        Ok(Plan::NotSupported)
    }

    /// Remove the agent skill (and any files bundled with it). Default: unsupported.
    fn skill_uninstall(&self, _home: &Path) -> Result<Plan, String> {
        Ok(Plan::NotSupported)
    }

    /// Remove the auto-open hook's settings entry. Default: unsupported.
    fn open_hook_uninstall(&self, _home: &Path) -> Result<Plan, String> {
        Ok(Plan::NotSupported)
    }
}

/// Claude Code — the original integration, now expressed as an adapter. Wraps
/// the pure merge helpers above unchanged.
pub struct ClaudeAdapter;

impl ClientAdapter for ClaudeAdapter {
    fn id(&self) -> &'static str {
        "claude"
    }
    fn display_name(&self) -> &'static str {
        "Claude Code"
    }

    fn is_present(&self, home: &Path) -> bool {
        home.join(".claude.json").exists() || home.join(".claude").is_dir()
    }

    fn supports(&self, _c: Capability) -> bool {
        true // Claude Code supports all four capabilities.
    }

    fn is_configured(&self, home: &Path) -> bool {
        read_existing(&home.join(".claude.json"))
            .map(|s| mcp_config_has(&s, "glance"))
            .unwrap_or(false)
    }

    fn mcp(&self, home: &Path, mcp_bin: &str) -> Result<Plan, String> {
        let path = home.join(".claude.json");
        let merged = merge_mcp_config(&read_existing(&path)?, "glance", mcp_bin)?;
        Ok(Plan::Write(vec![FileWrite { path, contents: merged, executable: false }]))
    }

    fn guidance(&self, home: &Path) -> Result<Plan, String> {
        let path = home.join(".claude").join("CLAUDE.md");
        match append_guidance(&read_existing(&path)?) {
            None => Ok(Plan::AlreadyDone("Guidance already present — left unchanged.".to_string())),
            Some(next) => Ok(Plan::Write(vec![FileWrite { path, contents: next, executable: false }])),
        }
    }

    fn skill(&self, home: &Path) -> Result<Plan, String> {
        let path = home.join(".claude").join("skills").join("glance").join("SKILL.md");
        Ok(Plan::Write(vec![FileWrite { path, contents: skill_doc(), executable: false }]))
    }

    fn open_hook(&self, home: &Path, app_bin: &str) -> Result<Plan, String> {
        let script_path = home.join(".claude").join("skills").join("glance").join("open-md-hook.sh");
        let settings_path = home.join(".claude").join("settings.json");
        let merged = merge_settings_hook(&read_existing(&settings_path)?, script_path.to_string_lossy().as_ref())?;
        Ok(Plan::Write(vec![
            FileWrite { path: script_path, contents: hook_script(app_bin), executable: true },
            FileWrite { path: settings_path, contents: merged, executable: false },
        ]))
    }

    fn mcp_uninstall(&self, home: &Path) -> Result<Plan, String> {
        let path = home.join(".claude.json");
        match remove_mcp_config(&read_existing(&path)?, "glance", "~/.claude.json")? {
            None => Ok(Plan::AlreadyDone("glance-mcp was not registered.".to_string())),
            Some(next) => Ok(Plan::Write(vec![FileWrite { path, contents: next, executable: false }])),
        }
    }

    fn guidance_uninstall(&self, home: &Path) -> Result<Plan, String> {
        let path = home.join(".claude").join("CLAUDE.md");
        match strip_guidance(&read_existing(&path)?) {
            None => Ok(Plan::AlreadyDone("No guidance block to remove.".to_string())),
            Some(next) => Ok(Plan::Write(vec![FileWrite { path, contents: next, executable: false }])),
        }
    }

    fn skill_uninstall(&self, home: &Path) -> Result<Plan, String> {
        // The skill dir holds both SKILL.md and open-md-hook.sh — remove it whole.
        Ok(Plan::Delete(vec![home.join(".claude").join("skills").join("glance")]))
    }

    fn open_hook_uninstall(&self, home: &Path) -> Result<Plan, String> {
        // The hook script is deleted with the skill dir above; here we only
        // withdraw its reference from settings.json.
        let script_path = home.join(".claude").join("skills").join("glance").join("open-md-hook.sh");
        let settings_path = home.join(".claude").join("settings.json");
        match remove_settings_hook(&read_existing(&settings_path)?, script_path.to_string_lossy().as_ref(), "~/.claude/settings.json")? {
            None => Ok(Plan::AlreadyDone("No auto-open hook entry to remove.".to_string())),
            Some(next) => Ok(Plan::Write(vec![FileWrite { path: settings_path, contents: next, executable: false }])),
        }
    }
}

/// Cursor — MCP over `~/.cursor/mcp.json` (same `mcpServers` shape as Claude, so
/// [`merge_mcp_config`] is reused) plus a project-rules doc. No skill/hook
/// concepts, so those fall through to the [`ClientAdapter`] defaults.
pub struct CursorAdapter;

impl ClientAdapter for CursorAdapter {
    fn id(&self) -> &'static str {
        "cursor"
    }
    fn display_name(&self) -> &'static str {
        "Cursor"
    }

    fn is_present(&self, home: &Path) -> bool {
        home.join(".cursor").is_dir()
    }

    fn supports(&self, c: Capability) -> bool {
        // Cursor has MCP + project rules, but no agent-skill or hook concept.
        matches!(c, Capability::Mcp | Capability::Guidance)
    }

    fn is_configured(&self, home: &Path) -> bool {
        read_existing(&home.join(".cursor").join("mcp.json"))
            .map(|s| mcp_config_has(&s, "glance"))
            .unwrap_or(false)
    }

    fn mcp(&self, home: &Path, mcp_bin: &str) -> Result<Plan, String> {
        let path = home.join(".cursor").join("mcp.json");
        let merged = merge_mcp_config(&read_existing(&path)?, "glance", mcp_bin)?;
        Ok(Plan::Write(vec![FileWrite { path, contents: merged, executable: false }]))
    }

    fn guidance(&self, home: &Path) -> Result<Plan, String> {
        // Cursor reads per-topic rule files from ~/.cursor/rules/.
        let path = home.join(".cursor").join("rules").join("glance.md");
        match append_guidance(&read_existing(&path)?) {
            None => Ok(Plan::AlreadyDone("Guidance already present — left unchanged.".to_string())),
            Some(next) => Ok(Plan::Write(vec![FileWrite { path, contents: next, executable: false }])),
        }
    }

    fn mcp_uninstall(&self, home: &Path) -> Result<Plan, String> {
        let path = home.join(".cursor").join("mcp.json");
        match remove_mcp_config(&read_existing(&path)?, "glance", "~/.cursor/mcp.json")? {
            None => Ok(Plan::AlreadyDone("glance-mcp was not registered.".to_string())),
            Some(next) => Ok(Plan::Write(vec![FileWrite { path, contents: next, executable: false }])),
        }
    }

    fn guidance_uninstall(&self, home: &Path) -> Result<Plan, String> {
        // `guidance()` uses append_guidance (a merge), because ~/.cursor/rules/
        // files are user-editable and glance.md may accumulate their own content.
        // So reverse it with the same strip helper, not a blunt whole-file delete
        // — only remove the file if stripping our block empties it.
        let path = home.join(".cursor").join("rules").join("glance.md");
        match strip_guidance(&read_existing(&path)?) {
            None => Ok(Plan::AlreadyDone("No guidance block to remove.".to_string())),
            Some(next) if next.trim().is_empty() => Ok(Plan::Delete(vec![path])),
            Some(next) => Ok(Plan::Write(vec![FileWrite { path, contents: next, executable: false }])),
        }
    }
}

/// Commit one capability's [`Plan`], turning it into a [`StepResult`]. The only
/// place in setup that mutates disk — creates parent dirs, writes atomically,
/// applies the executable bit. Bails on the first write error.
fn run_step(group: &str, label: &str, plan: Result<Plan, String>) -> StepResult {
    let label = label.to_string();
    let group = group.to_string();
    let fail = |group: &str, label: &str, message: String| StepResult {
        ok: false,
        label: label.to_string(),
        message,
        group: group.to_string(),
    };
    let writes = match plan {
        Err(e) => return fail(&group, &label, e),
        Ok(Plan::NotSupported) => {
            return StepResult { ok: true, label, message: "Not applicable to this client.".to_string(), group }
        }
        Ok(Plan::AlreadyDone(m)) => return StepResult { ok: true, label, message: m, group },
        Ok(Plan::Delete(paths)) => {
            for p in &paths {
                let res = if p.is_dir() {
                    std::fs::remove_dir_all(p)
                } else {
                    std::fs::remove_file(p)
                };
                match res {
                    Ok(_) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return fail(&group, &label, format!("Could not remove {}: {e}", p.display())),
                }
            }
            let names = paths.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", ");
            return StepResult { ok: true, label, message: format!("Removed {names}"), group };
        }
        Ok(Plan::Write(w)) => w,
    };
    for w in &writes {
        if let Some(dir) = w.path.parent() {
            if let Err(e) = std::fs::create_dir_all(dir) {
                return fail(&group, &label, format!("Could not create {}: {e}", dir.display()));
            }
        }
        if let Err(e) = atomic_write(&w.path, &w.contents) {
            return fail(&group, &label, format!("Could not write {}: {e}", w.path.display()));
        }
        if w.executable {
            use std::os::unix::fs::PermissionsExt;
            if let Err(e) = std::fs::set_permissions(&w.path, std::fs::Permissions::from_mode(0o755)) {
                return fail(&group, &label, format!("Could not make {} executable: {e}", w.path.display()));
            }
        }
    }
    let paths = writes.iter().map(|w| w.path.display().to_string()).collect::<Vec<_>>().join(", ");
    StepResult { ok: true, label, message: format!("Wrote {paths}"), group }
}

/// Every client Glance knows how to integrate with.
fn all_adapters() -> Vec<Box<dyn ClientAdapter>> {
    vec![Box::new(ClaudeAdapter), Box::new(CursorAdapter)]
}

fn install_plan(adapter: &dyn ClientAdapter, c: Capability, bins: &Binaries, home: &Path) -> Result<Plan, String> {
    match c {
        Capability::Mcp => adapter.mcp(home, &bins.mcp_bin),
        Capability::Guidance => adapter.guidance(home),
        Capability::Skill => adapter.skill(home),
        Capability::Hook => adapter.open_hook(home, &bins.app_bin),
    }
}

fn uninstall_plan(adapter: &dyn ClientAdapter, c: Capability, home: &Path) -> Result<Plan, String> {
    match c {
        Capability::Mcp => adapter.mcp_uninstall(home),
        Capability::Guidance => adapter.guidance_uninstall(home),
        Capability::Skill => adapter.skill_uninstall(home),
        Capability::Hook => adapter.open_hook_uninstall(home),
    }
}

/// Install every *supported* capability of one adapter, committing each.
/// Unsupported capabilities are skipped, so results carry no "Not applicable"
/// noise. Rows are grouped under the client's display name.
pub fn setup_adapter(adapter: &dyn ClientAdapter, bins: &Binaries, home: &Path) -> Vec<StepResult> {
    let name = adapter.display_name();
    Capability::ALL
        .into_iter()
        .filter(|&c| adapter.supports(c))
        .map(|c| run_step(name, c.label(), install_plan(adapter, c, bins, home)))
        .collect()
}

/// Reverse every supported capability of one adapter.
pub fn remove_adapter(adapter: &dyn ClientAdapter, home: &Path) -> Vec<StepResult> {
    let name = adapter.display_name();
    Capability::ALL
        .into_iter()
        .filter(|&c| adapter.supports(c))
        .map(|c| run_step(name, c.label(), uninstall_plan(adapter, c, home)))
        .collect()
}

/// Enumerate every client the picker can offer, with detection state and
/// per-capability eligibility. Pure — no writes, safe to call on every open.
#[tauri::command]
pub fn list_integration_targets() -> Vec<ClientInfo> {
    let home = home();
    all_adapters()
        .iter()
        .map(|a| {
            let present = home.as_ref().map(|h| a.is_present(h)).unwrap_or(false);
            let configured = home.as_ref().map(|h| a.is_configured(h)).unwrap_or(false);
            let capabilities = Capability::ALL
                .into_iter()
                .map(|c| CapabilityInfo { key: c.key().to_string(), label: c.label().to_string(), supported: a.supports(c) })
                .collect();
            ClientInfo { id: a.id().to_string(), display_name: a.display_name().to_string(), present, configured, capabilities }
        })
        .collect()
}

/// Execute a picker selection. `action` is `"setup"` or `"remove"`; `ids` are
/// the chosen client ids. Setup installs the shared `mdview` CLI once (filed
/// under "Shared"), then each selected client; remove reverses each selected
/// client (leaving `mdview` in place). Unknown ids are ignored.
#[tauri::command]
pub fn run_integration(action: String, ids: Vec<String>) -> Vec<StepResult> {
    let adapters = all_adapters();
    let selected = |id: &str| adapters.iter().find(|a| a.id() == id);

    if action == "remove" {
        let home = match home() {
            Some(h) => h,
            None => return vec![StepResult { ok: false, label: "Locate home directory".to_string(), message: "Could not determine your home directory ($HOME).".to_string(), group: "Shared".to_string() }],
        };
        return ids
            .iter()
            .filter_map(|id| selected(id))
            .flat_map(|a| remove_adapter(a.as_ref(), &home))
            .collect();
    }

    // setup
    let cli = install_cli_tool();
    let mut results = vec![StepResult { ok: cli.ok, label: "Install mdview CLI".to_string(), message: cli.message, group: "Shared".to_string() }];
    let home = match home() {
        Some(h) => h,
        None => {
            results.push(StepResult { ok: false, label: "Locate home directory".to_string(), message: "Could not determine your home directory ($HOME).".to_string(), group: "Shared".to_string() });
            return results;
        }
    };
    let bins = match resolve_binaries() {
        Ok(b) => b,
        Err(e) => {
            results.push(StepResult { ok: false, label: "Locate Glance binaries".to_string(), message: e, group: "Shared".to_string() });
            return results;
        }
    };
    for id in &ids {
        if let Some(a) = selected(id) {
            results.extend(setup_adapter(a.as_ref(), &bins, &home));
        }
    }
    results
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
        let out = merge_mcp_config("", "glance", "/Apps/Glance.app/Contents/MacOS/glance-mcp").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["mcpServers"]["glance"]["command"], "/Apps/Glance.app/Contents/MacOS/glance-mcp");
    }

    #[test]
    fn merge_preserves_other_keys_and_servers() {
        let existing = r#"{"theme":"dark","mcpServers":{"other":{"command":"x"}}}"#;
        let out = merge_mcp_config(existing, "glance", "/p/glance-mcp").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["theme"], "dark");
        assert_eq!(v["mcpServers"]["other"]["command"], "x");
        assert_eq!(v["mcpServers"]["glance"]["command"], "/p/glance-mcp");
    }

    #[test]
    fn merge_refuses_to_clobber_invalid_json() {
        // A corrupt or mid-write ~/.claude.json must NOT be silently replaced.
        assert!(merge_mcp_config("{not valid json", "glance", "/p/glance-mcp").is_err());
        assert!(merge_mcp_config("[1,2,3]", "glance", "/p/glance-mcp").is_err()); // valid JSON, wrong shape
        assert!(merge_settings_hook("garbage{", "/h/open-md-hook.sh").is_err());
        // whitespace-only is treated as a fresh (empty) config, not an error
        assert!(merge_mcp_config("   \n", "glance", "/p/glance-mcp").is_ok());
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
        let out = merge_settings_hook("", "/h/open-md-hook.sh").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        let entry = &v["hooks"]["PostToolUse"][0];
        assert_eq!(entry["matcher"], "Write");
        assert_eq!(entry["hooks"][0]["type"], "command");
        assert_eq!(entry["hooks"][0]["command"], "/h/open-md-hook.sh");
    }

    #[test]
    fn merge_settings_hook_preserves_others_and_is_idempotent() {
        let existing = r#"{"model":"opus","hooks":{"PostToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"/other.sh"}]}]}}"#;
        let once = merge_settings_hook(existing, "/h/open-md-hook.sh").unwrap();
        let twice = merge_settings_hook(&once, "/h/open-md-hook.sh").unwrap();
        let v: serde_json::Value = serde_json::from_str(&twice).unwrap();
        assert_eq!(v["model"], "opus");
        let arr = v["hooks"]["PostToolUse"].as_array().unwrap();
        // original Bash entry kept, our Write entry added exactly once
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["matcher"], "Bash");
        assert_eq!(arr[1]["matcher"], "Write");
    }

    // --- adapter layer ---------------------------------------------------

    fn plan_kind(plan: &Plan) -> &'static str {
        match plan {
            Plan::Write(_) => "Write",
            Plan::Delete(_) => "Delete",
            Plan::AlreadyDone(_) => "AlreadyDone",
            Plan::NotSupported => "NotSupported",
        }
    }

    fn plan_writes(plan: Plan) -> Vec<FileWrite> {
        match plan {
            Plan::Write(w) => w,
            other => panic!("expected Plan::Write, got {}", plan_kind(&other)),
        }
    }

    fn plan_deletes(plan: Plan) -> Vec<PathBuf> {
        match plan {
            Plan::Delete(d) => d,
            other => panic!("expected Plan::Delete, got {}", plan_kind(&other)),
        }
    }

    // A throwaway home dir under the OS temp dir, unique per test name.
    fn tmp_home(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("glance-adapter-{}-{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn claude_adapter_mcp_targets_claude_json_and_merges() {
        let home = tmp_home("claude-mcp");
        let writes = plan_writes(ClaudeAdapter.mcp(&home, "/Apps/Glance.app/Contents/MacOS/glance-mcp").unwrap());
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].path, home.join(".claude.json"));
        let v: serde_json::Value = serde_json::from_str(&writes[0].contents).unwrap();
        assert_eq!(v["mcpServers"]["glance"]["command"], "/Apps/Glance.app/Contents/MacOS/glance-mcp");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn cursor_adapter_mcp_targets_cursor_json_reusing_shape() {
        let home = tmp_home("cursor-mcp");
        let writes = plan_writes(CursorAdapter.mcp(&home, "/p/glance-mcp").unwrap());
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].path, home.join(".cursor").join("mcp.json"));
        let v: serde_json::Value = serde_json::from_str(&writes[0].contents).unwrap();
        // same mcpServers shape as Claude — merge_mcp_config is shared
        assert_eq!(v["mcpServers"]["glance"]["command"], "/p/glance-mcp");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn cursor_has_no_skill_or_hook() {
        let home = tmp_home("cursor-caps");
        assert!(matches!(CursorAdapter.skill(&home).unwrap(), Plan::NotSupported));
        assert!(matches!(CursorAdapter.open_hook(&home, "/bin/glance").unwrap(), Plan::NotSupported));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn claude_hook_writes_executable_script_and_settings() {
        let home = tmp_home("claude-hook");
        let writes = plan_writes(ClaudeAdapter.open_hook(&home, "/Applications/Glance.app/Contents/MacOS/glance").unwrap());
        assert_eq!(writes.len(), 2);
        let script = writes.iter().find(|w| w.executable).expect("an executable script write");
        assert!(script.path.ends_with("open-md-hook.sh"));
        assert!(script.contents.contains("/Applications/Glance.app/Contents/MacOS/glance"));
        let settings = writes.iter().find(|w| w.path.ends_with("settings.json")).expect("a settings write");
        let v: serde_json::Value = serde_json::from_str(&settings.contents).unwrap();
        assert_eq!(v["hooks"]["PostToolUse"][0]["matcher"], "Write");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn guidance_is_idempotent_once_committed() {
        let home = tmp_home("claude-guidance");
        // first run plans a write; commit it, then a second call reports AlreadyDone
        let writes = plan_writes(ClaudeAdapter.guidance(&home).unwrap());
        run_step("g", "guidance", Ok(Plan::Write(writes)));
        assert!(matches!(ClaudeAdapter.guidance(&home).unwrap(), Plan::AlreadyDone(_)));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn is_present_detects_config_dirs() {
        let home = tmp_home("present");
        // nothing yet
        assert!(!ClaudeAdapter.is_present(&home));
        assert!(!CursorAdapter.is_present(&home));
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::create_dir_all(home.join(".cursor")).unwrap();
        assert!(ClaudeAdapter.is_present(&home));
        assert!(CursorAdapter.is_present(&home));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn run_step_commits_writes_and_creates_parent_dirs() {
        let home = tmp_home("run-step");
        let target = home.join("nested").join("deep").join("file.txt");
        let res = run_step("g", "write", Ok(Plan::Write(vec![FileWrite {
            path: target.clone(),
            contents: "hello".to_string(),
            executable: false,
        }])));
        assert!(res.ok);
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "hello");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn run_step_reports_not_supported_and_already_done() {
        assert!(run_step("g", "x", Ok(Plan::NotSupported)).ok);
        let done = run_step("g", "x", Ok(Plan::AlreadyDone("kept".to_string())));
        assert!(done.ok);
        assert_eq!(done.message, "kept");
        assert_eq!(done.group, "g");
        assert!(!run_step("g", "x", Err("boom".to_string())).ok);
    }

    // --- uninstall --------------------------------------------------------

    #[test]
    fn remove_mcp_config_drops_only_our_key() {
        let existing = r#"{"theme":"dark","mcpServers":{"other":{"command":"x"},"glance":{"command":"g"}}}"#;
        let out = remove_mcp_config(existing, "glance", "cfg").unwrap().expect("a rewrite");
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["theme"], "dark");
        assert_eq!(v["mcpServers"]["other"]["command"], "x");
        assert!(v["mcpServers"].get("glance").is_none());
        // absent → None (nothing to do), and the clobber-guard still holds
        assert!(remove_mcp_config(r#"{"mcpServers":{}}"#, "glance", "cfg").unwrap().is_none());
        assert!(remove_mcp_config("", "glance", "cfg").unwrap().is_none());
        assert!(remove_mcp_config("[1,2,3]", "glance", "cfg").is_err());
    }

    #[test]
    fn remove_settings_hook_drops_entry_and_keeps_others() {
        let existing = r#"{"model":"opus","hooks":{"PostToolUse":[
            {"matcher":"Bash","hooks":[{"type":"command","command":"/other.sh"}]},
            {"matcher":"Write","hooks":[{"type":"command","command":"/h/open-md-hook.sh"}]}
        ]}}"#;
        let out = remove_settings_hook(existing, "/h/open-md-hook.sh", "cfg").unwrap().expect("a rewrite");
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["model"], "opus");
        let arr = v["hooks"]["PostToolUse"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["matcher"], "Bash");
        // absent command → None
        assert!(remove_settings_hook(&out, "/h/open-md-hook.sh", "cfg").unwrap().is_none());
    }

    #[test]
    fn strip_guidance_round_trips_with_append() {
        let base = "# My config\n";
        let with = append_guidance(base).unwrap();
        assert!(with.contains("mdview <absolute-path>"));
        let without = strip_guidance(&with).expect("removable");
        assert!(!without.contains("mdview <absolute-path>"));
        assert!(without.contains("# My config"));
        // idempotent: nothing to strip the second time
        assert!(strip_guidance(&without).is_none());
    }

    #[test]
    fn claude_uninstall_reverses_each_capability() {
        let home = tmp_home("claude-uninstall");
        // MCP: rewrite dropping glance
        std::fs::write(home.join(".claude.json"), r#"{"mcpServers":{"glance":{"command":"g"},"keep":{"command":"k"}}}"#).unwrap();
        let w = plan_writes(ClaudeAdapter.mcp_uninstall(&home).unwrap());
        let v: serde_json::Value = serde_json::from_str(&w[0].contents).unwrap();
        assert!(v["mcpServers"].get("glance").is_none());
        assert_eq!(v["mcpServers"]["keep"]["command"], "k");
        // Skill: deletes the whole skills/glance dir
        let del = plan_deletes(ClaudeAdapter.skill_uninstall(&home).unwrap());
        assert_eq!(del, vec![home.join(".claude").join("skills").join("glance")]);
        // Nothing installed → AlreadyDone, not an error
        assert!(matches!(ClaudeAdapter.mcp_uninstall(&tmp_home("empty1")).unwrap(), Plan::AlreadyDone(_)));
        assert!(matches!(ClaudeAdapter.open_hook_uninstall(&tmp_home("empty2")).unwrap(), Plan::AlreadyDone(_)));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn cursor_guidance_uninstall_preserves_user_content_deletes_when_empty() {
        let home = tmp_home("cursor-uninstall");
        assert!(matches!(CursorAdapter.skill_uninstall(&home).unwrap(), Plan::NotSupported));
        let rules = home.join(".cursor").join("rules");
        std::fs::create_dir_all(&rules).unwrap();
        let path = rules.join("glance.md");

        // File that is ONLY our block → deleting it is right.
        std::fs::write(&path, append_guidance("").unwrap()).unwrap();
        let del = plan_deletes(CursorAdapter.guidance_uninstall(&home).unwrap());
        assert_eq!(del, vec![path.clone()]);

        // File with the user's own rules too → strip our block, KEEP theirs.
        std::fs::write(&path, append_guidance("# my project rules\n").unwrap()).unwrap();
        let w = plan_writes(CursorAdapter.guidance_uninstall(&home).unwrap());
        assert!(w[0].contents.contains("# my project rules"));
        assert!(!w[0].contents.contains("mdview <absolute-path>"));

        // No file → nothing to do.
        std::fs::remove_file(&path).unwrap();
        assert!(matches!(CursorAdapter.guidance_uninstall(&home).unwrap(), Plan::AlreadyDone(_)));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn install_then_uninstall_leaves_config_clean() {
        let home = tmp_home("roundtrip");
        // install MCP + guidance + skill + hook, committing each
        let bins = Binaries { mcp_bin: "/bin/glance-mcp".to_string(), app_bin: "/bin/glance".to_string() };
        for r in setup_adapter(&ClaudeAdapter, &bins, &home) {
            assert!(r.ok, "install step failed: {}", r.message);
        }
        assert!(home.join(".claude.json").exists());
        assert!(home.join(".claude").join("skills").join("glance").join("SKILL.md").exists());
        // uninstall
        for r in remove_adapter(&ClaudeAdapter, &home) {
            assert!(r.ok, "uninstall step failed: {}", r.message);
        }
        // glance key gone, skill dir gone, settings entry gone
        let cfg: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(home.join(".claude.json")).unwrap()).unwrap();
        assert!(cfg["mcpServers"].get("glance").is_none());
        assert!(!home.join(".claude").join("skills").join("glance").exists());
        let settings: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(home.join(".claude").join("settings.json")).unwrap()).unwrap();
        let arr = settings["hooks"]["PostToolUse"].as_array().unwrap();
        assert!(arr.is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn run_step_delete_removes_file_and_dir_and_tolerates_missing() {
        let home = tmp_home("delete");
        let file = home.join("f.txt");
        let dir = home.join("d");
        std::fs::write(&file, "x").unwrap();
        std::fs::create_dir_all(dir.join("inner")).unwrap();
        let res = run_step("g", "del", Ok(Plan::Delete(vec![file.clone(), dir.clone(), home.join("missing")])));
        assert!(res.ok, "{}", res.message);
        assert!(!file.exists());
        assert!(!dir.exists());
        let _ = std::fs::remove_dir_all(&home);
    }

    // --- capabilities + enumeration ---------------------------------------

    #[test]
    fn supports_reflects_each_client() {
        for c in Capability::ALL {
            assert!(ClaudeAdapter.supports(c), "Claude should support {c:?}");
        }
        assert!(CursorAdapter.supports(Capability::Mcp));
        assert!(CursorAdapter.supports(Capability::Guidance));
        assert!(!CursorAdapter.supports(Capability::Skill));
        assert!(!CursorAdapter.supports(Capability::Hook));
    }

    #[test]
    fn list_integration_targets_marks_eligibility() {
        let targets = list_integration_targets();
        let cursor = targets.iter().find(|c| c.id == "cursor").expect("cursor listed");
        assert_eq!(cursor.display_name, "Cursor");
        assert_eq!(cursor.capabilities.len(), 4);
        let sup = |key: &str| cursor.capabilities.iter().find(|c| c.key == key).unwrap().supported;
        assert!(sup("mcp"));
        assert!(sup("guidance"));
        assert!(!sup("skill"));
        assert!(!sup("hook"));
        let claude = targets.iter().find(|c| c.id == "claude").expect("claude listed");
        assert!(claude.capabilities.iter().all(|c| c.supported));
    }

    #[test]
    fn mcp_config_has_detects_registration() {
        assert!(mcp_config_has(r#"{"mcpServers":{"glance":{"command":"g"}}}"#, "glance"));
        assert!(!mcp_config_has(r#"{"mcpServers":{"other":{"command":"x"}}}"#, "glance"));
        assert!(!mcp_config_has("", "glance"));
        assert!(!mcp_config_has("{garbage", "glance")); // never errors → false
    }

    #[test]
    fn is_configured_reflects_registration_and_targets_carry_it() {
        let home = tmp_home("configured");
        assert!(!ClaudeAdapter.is_configured(&home)); // nothing yet
        // register via the adapter's own install plan, then commit
        let bins = Binaries { mcp_bin: "/bin/glance-mcp".to_string(), app_bin: "/bin/glance".to_string() };
        run_step("g", "mcp", ClaudeAdapter.mcp(&home, &bins.mcp_bin));
        assert!(ClaudeAdapter.is_configured(&home));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn setup_adapter_skips_unsupported_and_groups_by_client() {
        let home = tmp_home("cursor-setup-steps");
        let bins = Binaries { mcp_bin: "/bin/glance-mcp".to_string(), app_bin: "/bin/glance".to_string() };
        let steps = setup_adapter(&CursorAdapter, &bins, &home);
        // Cursor supports only mcp + guidance → exactly 2 steps, no "Not applicable" noise.
        assert_eq!(steps.len(), 2);
        assert!(steps.iter().all(|s| s.group == "Cursor"));
        assert!(steps.iter().all(|s| s.ok));
        assert!(steps.iter().all(|s| s.message != "Not applicable to this client."));
        let _ = std::fs::remove_dir_all(&home);
    }

    use std::io::Write as _;

    fn python3_available() -> bool {
        std::process::Command::new("python3")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    // Run the hook with the given stdin JSON; return true if the stub binary
    // fired (marker file created) within a short window.
    fn run_hook(dir: &Path, stub: &Path, marker: &Path, stdin_json: &str) -> bool {
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

    // Regression: the hook must release the caller's stdout pipe and return
    // *immediately*, even though the app it launches keeps running. Claude Code
    // runs the hook with its stdout on a pipe and reads to EOF before letting the
    // agent continue; if the hook keeps that pipe open for the app's lifetime,
    // the agent hangs until the user quits Glance. (The earlier `A && B &` form
    // did exactly that — the backgrounded AND-list ran in a subshell that held
    // the inherited pipe until the app exited.)
    #[test]
    fn hook_releases_stdout_pipe_before_app_exits() {
        if !python3_available() {
            eprintln!("skipping hook_releases_stdout_pipe_before_app_exits: python3 not available");
            return;
        }
        use std::io::Read;
        use std::sync::mpsc;
        let base = std::env::temp_dir().join(format!("glance-hook-block-{}", std::process::id()));
        let proj = base.join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        // A stub "app" that stays alive well past our assert window. If the hook
        // holds our stdout pipe for the app's lifetime, read_to_end below won't
        // see EOF until this sleep ends.
        let stub = base.join("stub.sh");
        std::fs::write(&stub, "#!/bin/sh\nsleep 10\n").unwrap();
        let script = base.join("open-md-hook.sh");
        std::fs::write(&script, hook_script(&stub.to_string_lossy())).unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let cwd = proj.to_string_lossy().to_string();
        let md = proj.join("notes.md").to_string_lossy().to_string();
        let json = format!(r#"{{"tool_name":"Write","cwd":"{cwd}","tool_input":{{"file_path":"{md}"}}}}"#);

        let mut child = std::process::Command::new("sh")
            .arg(&script)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped()) // a real pipe, like Claude Code's hook runner
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(json.as_bytes()).unwrap();
        let mut out = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = out.read_to_end(&mut buf); // returns only when every writer of the pipe is gone
            let _ = tx.send(());
        });
        // Generous 3s margin (app sleeps 10s) so this can't flake under load.
        let released = rx.recv_timeout(std::time::Duration::from_secs(3)).is_ok();
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&base);
        assert!(
            released,
            "hook held the stdout pipe until the launched app exited — it must detach the app and return immediately"
        );
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
