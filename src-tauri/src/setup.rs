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
- `number` — the comment's number as the user sees it in Glance. Use it when you talk to the user ("comment 3"), never the id.
- `note` — what the user wants changed.
- `lineStart` / `lineEnd` — its current location. Trust these; they are re-anchored live, not the line the user first selected.
- `quote` — the text it is anchored to.
- `anchor` — how confidently it was located:
  - `exact` — found unambiguously. Act on it.
  - `quote-only` — text matched but its surroundings moved. Still reliable.
  - `drifted` — the quoted text is gone; this is an approximate line. Confirm with the user before editing.
  - `orphaned` — the quoted text no longer exists anywhere. Do not guess — ask the user what they meant.

Use `get_annotation(path, id)` when you need to see the lines around a comment; it returns `context.before` and `context.after` (three lines each).

When a prompt is prefixed with a `Glance:` line naming open comments, call `list_annotations` on that file before doing anything else.

## Act, then close the loop

1. If the comment is `drifted`, `orphaned`, or you cannot tell what it asks for, call `reply_annotation(path: "<absolute-path>", id: "<id>", text: "<question or reason>")` with your question, or the reason you are not making the change. Do not ask in chat what you can ask on the card. A replied-to comment stays open until the user answers there; move on to the next one.
2. Otherwise make the change the comment asks for, at the indicated lines.
3. Call `resolve_annotation(path: "<absolute-path>", id: "<id>", note: "<what changed>")`. `note` is one line saying what you changed ("Cut the cap to 5 min; batch keeps 10"). It flips to resolved live in Glance, with your note on the card, so the user sees it handled without reading the diff.
4. When done, call `list_annotations` again to confirm nothing is still open.

## Point the user at something

Use `add_annotation(path: "<absolute-path>", quote: "<verbatim text>", note: "<one line>")` for a "look here" the user should see in the document: a risk you noticed, a section that needs their decision. `quote` must be copied verbatim from the file (the call fails otherwise); `note` is one line. It appears in Glance as a numbered card marked as yours, and the user resolves or deletes it like any other. Use it sparingly, and never to restate what you already said in chat.

## Etiquette

- Your tools are `list_annotations`, `get_annotation`, `resolve_annotation`, `reply_annotation`, `add_annotation`. Annotations you create show as yours.
- Resolve a comment only after you actually addressed it. One resolve per comment, always with a `note`.
- Replies belong on the card, not in chat. Keep them to a line or two.
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
/// Understands both Claude Code's `Write` (`tool_input.file_path`) and Codex's
/// `apply_patch` (`*** Add File:` lines in `tool_input.command`), so one script
/// serves every client.
pub fn hook_script(app_bin: &str) -> String {
    const TEMPLATE: &str = r#"#!/bin/sh
# Glance auto-open hook (PostToolUse). Opens new project markdown in Glance.
# Reads the tool event JSON (Claude Code or Codex) from stdin and prints the
# files to open (a Write / apply_patch Add File of a .md inside cwd, skipping
# node_modules and dotdirs); fires nothing otherwise. Always exits 0 so it can never block the agent.
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
tool = d.get("tool_name")
ti = d.get("tool_input") or {}
cwd = d.get("cwd") or ""
if not cwd:
    sys.exit(0)
cwd = os.path.abspath(cwd)
# Candidate paths. Claude Code's Write tool carries file_path; Codex's
# apply_patch carries the patch text in tool_input.command (a string, or a
# ["apply_patch", "<patch>"] list when routed through its shell tool), and
# only "*** Add File:" entries are new documents.
cands = []
if tool == "Write":
    fp = ti.get("file_path") or ""
    if fp:
        cands.append(fp)
elif tool == "apply_patch":
    cmd = ti.get("command")
    if isinstance(cmd, list):
        cmd = "\n".join(str(c) for c in cmd)
    if not isinstance(cmd, str):
        cmd = ""
    for line in cmd.splitlines():
        if line.startswith("*** Add File: "):
            cands.append(line[len("*** Add File: "):].strip())
if not cands:
    sys.exit(0)
def project_md(fp):
    ap = fp if os.path.isabs(fp) else os.path.join(cwd, fp)
    ap = os.path.abspath(ap)
    if not (ap.endswith(".md") or ap.endswith(".markdown")):
        return None
    try:
        if os.path.commonpath([ap, cwd]) != cwd:
            return None
    except ValueError:
        return None
    rel = os.path.relpath(ap, cwd)
    parts = rel.split(os.sep)
    if any(p == "node_modules" or p.startswith(".") for p in parts):
        return None
    return ap
seen = set()
for fp in cands:
    ap = project_md(fp)
    if ap and ap not in seen:
        seen.add(ap)
        print(ap)
PY
)
TARGETS=$(python3 -c "$_GLANCE_PY")
# Launch detached, one invocation with every target as an argument (Glance
# opens each as a tab). This MUST be a single backgrounded command inside `if`, not
# `[ … ] && app &`: backgrounding an AND-list runs it in a subshell that keeps
# the hook's inherited stdout/stderr open for the app's whole lifetime, so Claude
# Code (which reads the hook's stdout to EOF) hangs until the user quits Glance.
# A lone `app … & ` reparents to launchd immediately; </dev/null also severs
# stdin so the GUI never holds the caller's terminal.
if [ -n "$TARGETS" ]; then
  set -f
  IFS='
'
  set -- $TARGETS
  unset IFS
  "__APP_BIN__" "$@" >/dev/null 2>&1 </dev/null &
fi
exit 0
"#;
    TEMPLATE.replace("__APP_BIN__", app_bin)
}

/// The UserPromptSubmit hook script. Runs `glance-mcp --pending` with the hook
/// event JSON passed through on stdin; whatever it prints becomes context for
/// Claude's next turn. Guarded and `|| true` so a missing or broken binary can
/// never block the prompt.
pub fn pending_hook_script(mcp_bin: &str) -> String {
    const TEMPLATE: &str = r#"#!/bin/sh
# Glance pending-comments hook (UserPromptSubmit). Prints one context line per
# project doc that has open review comments, so Claude reads them without being
# told. stdin (the hook event JSON, with cwd) is passed straight through to
# glance-mcp. Always exits 0 so it can never block the agent.
if [ -x "__MCP_BIN__" ]; then
  "__MCP_BIN__" --pending 2>/dev/null || true
fi
exit 0
"#;
    TEMPLATE.replace("__MCP_BIN__", mcp_bin)
}

/// Add a hook entry running `command` under `hooks.<event>` in a settings.json
/// string, preserving everything else. `matcher` is written only when given
/// (`UserPromptSubmit` entries have none). Idempotent: no-op if `command`
/// already appears under any entry of that event. Tolerates empty input,
/// refuses non-object content.
pub fn merge_settings_hook_for(
    existing: &str,
    event: &str,
    matcher: Option<&str>,
    command: &str,
) -> Result<String, String> {
    merge_settings_hook_in(existing, "~/.claude/settings.json", event, matcher, command)
}

/// [`merge_settings_hook_for`] against an arbitrary hooks file (`file` is only
/// used in error messages). Codex's `~/.codex/hooks.json` shares the layout.
pub fn merge_settings_hook_in(
    existing: &str,
    file: &str,
    event: &str,
    matcher: Option<&str>,
    command: &str,
) -> Result<String, String> {
    let mut root = parse_config_object(existing, file)?;
    let obj = root.as_object_mut().unwrap();
    let hooks = obj.entry("hooks").or_insert_with(|| serde_json::json!({}));
    if !hooks.is_object() {
        *hooks = serde_json::json!({});
    }
    let hooks_obj = hooks.as_object_mut().unwrap();
    let list = hooks_obj
        .entry(event)
        .or_insert_with(|| serde_json::json!([]));
    if !list.is_array() {
        *list = serde_json::json!([]);
    }
    let arr = list.as_array_mut().unwrap();
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
        let mut entry = serde_json::json!({
            "hooks": [ { "type": "command", "command": command } ]
        });
        if let Some(m) = matcher {
            entry.as_object_mut().unwrap().insert("matcher".to_string(), serde_json::json!(m));
        }
        arr.push(entry);
    }
    serde_json::to_string_pretty(&root).map_err(|e| e.to_string())
}

/// Add a PostToolUse/Write hook running `command`. See [`merge_settings_hook_for`].
pub fn merge_settings_hook(existing: &str, command: &str) -> Result<String, String> {
    merge_settings_hook_for(existing, "PostToolUse", Some("Write"), command)
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

/// Remove any `hooks.<event>` entry that runs `command` from a settings.json
/// string, preserving everything else. Drops an entry entirely if it had only
/// that one hook. Returns `None` when nothing matched. Tolerates empty input,
/// refuses non-object content.
pub fn remove_settings_hook_for(
    existing: &str,
    event: &str,
    command: &str,
    file: &str,
) -> Result<Option<String>, String> {
    if existing.trim().is_empty() {
        return Ok(None);
    }
    let mut root = parse_config_object(existing, file)?;
    let post = root
        .as_object_mut()
        .unwrap()
        .get_mut("hooks")
        .and_then(|h| h.as_object_mut())
        .and_then(|h| h.get_mut(event))
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

/// Remove any PostToolUse entry that runs `command`. See [`remove_settings_hook_for`].
pub fn remove_settings_hook(existing: &str, command: &str, file: &str) -> Result<Option<String>, String> {
    remove_settings_hook_for(existing, "PostToolUse", command, file)
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

/// Parse a TOML config into a format-preserving document. Empty/whitespace →
/// a fresh document. Non-empty content that fails to parse is an error —
/// same clobber-guard as [`parse_config_object`].
fn parse_toml_doc(existing: &str, file: &str) -> Result<toml_edit::DocumentMut, String> {
    if existing.trim().is_empty() {
        return Ok(toml_edit::DocumentMut::new());
    }
    existing.parse::<toml_edit::DocumentMut>().map_err(|e| {
        format!("{file} is not valid TOML ({e}); refusing to overwrite it. Fix or remove the file, then retry.")
    })
}

/// Merge a `[mcp_servers.<name>]` table into a Codex `config.toml` string,
/// preserving every other key, comment and the user's formatting.
pub fn merge_mcp_toml(existing: &str, name: &str, command: &str, file: &str) -> Result<String, String> {
    let mut doc = parse_toml_doc(existing, file)?;
    let servers = doc.entry("mcp_servers").or_insert(toml_edit::table());
    if !servers.is_table_like() {
        *servers = toml_edit::table();
    }
    if let Some(t) = servers.as_table_mut() {
        // Render as `[mcp_servers.glance]` only — no bare `[mcp_servers]` header.
        t.set_implicit(true);
    }
    let mut server = toml_edit::Table::new();
    server["command"] = toml_edit::value(command);
    server["args"] = toml_edit::value(toml_edit::Array::new());
    servers
        .as_table_like_mut()
        .unwrap()
        .insert(name, toml_edit::Item::Table(server));
    Ok(doc.to_string())
}

/// Remove `[mcp_servers.<name>]` from a Codex `config.toml` string. Returns
/// `None` when the file is empty or the entry is absent. Drops the parent
/// `mcp_servers` table if that emptied it.
pub fn remove_mcp_toml(existing: &str, name: &str, file: &str) -> Result<Option<String>, String> {
    if existing.trim().is_empty() {
        return Ok(None);
    }
    let mut doc = parse_toml_doc(existing, file)?;
    let removed = doc
        .get_mut("mcp_servers")
        .and_then(|s| s.as_table_like_mut())
        .is_some_and(|t| t.remove(name).is_some());
    if !removed {
        return Ok(None);
    }
    if doc.get("mcp_servers").and_then(|s| s.as_table_like()).is_some_and(|t| t.is_empty()) {
        doc.remove("mcp_servers");
    }
    Ok(Some(doc.to_string()))
}

/// Whether `[mcp_servers.<name>]` is present in a TOML config string. Read-only
/// probe; any parse problem is "not present".
pub fn mcp_toml_has(existing: &str, name: &str) -> bool {
    existing
        .parse::<toml_edit::DocumentMut>()
        .ok()
        .and_then(|d| d.get("mcp_servers")?.as_table_like()?.get(name).map(|_| true))
        .unwrap_or(false)
}

/// Whether a hooks.json holds nothing but empty event lists (plus an optional
/// `description`) — i.e. removing our entries left a stub worth deleting.
fn hooks_file_is_empty(json: &str) -> bool {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else { return false };
    let Some(obj) = v.as_object() else { return false };
    obj.iter().all(|(k, v)| match k.as_str() {
        "description" => true,
        "hooks" => v
            .as_object()
            .is_some_and(|h| h.values().all(|l| l.as_array().is_some_and(|a| a.is_empty()))),
        _ => false,
    })
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
    /// The Glance GUI binary — what the auto-open hook launches. The
    /// pending-comments hook runs `mcp_bin --pending` instead.
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
            Capability::Hook => "Auto-open + pending-comments hooks",
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

    /// Install the hooks: auto-open-on-write (PostToolUse, launches `app_bin`)
    /// and pending-comments (UserPromptSubmit, runs `mcp_bin --pending`).
    /// Default: unsupported (Claude only, today).
    fn open_hook(&self, _home: &Path, _bins: &Binaries) -> Result<Plan, String> {
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

    /// Remove both hooks' settings entries. Default: unsupported.
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

    fn open_hook(&self, home: &Path, bins: &Binaries) -> Result<Plan, String> {
        let skill_dir = home.join(".claude").join("skills").join("glance");
        let open_path = skill_dir.join("open-md-hook.sh");
        let pending_path = skill_dir.join("pending-hook.sh");
        let settings_path = home.join(".claude").join("settings.json");
        let merged = merge_settings_hook(&read_existing(&settings_path)?, open_path.to_string_lossy().as_ref())?;
        let merged = merge_settings_hook_for(&merged, "UserPromptSubmit", None, pending_path.to_string_lossy().as_ref())?;
        Ok(Plan::Write(vec![
            FileWrite { path: open_path, contents: hook_script(&bins.app_bin), executable: true },
            FileWrite { path: pending_path, contents: pending_hook_script(&bins.mcp_bin), executable: true },
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
        // The skill dir holds SKILL.md and both hook scripts — remove it whole.
        Ok(Plan::Delete(vec![home.join(".claude").join("skills").join("glance")]))
    }

    fn open_hook_uninstall(&self, home: &Path) -> Result<Plan, String> {
        // Both hook scripts are deleted with the skill dir above; here we only
        // withdraw their references from settings.json.
        let skill_dir = home.join(".claude").join("skills").join("glance");
        let open_path = skill_dir.join("open-md-hook.sh");
        let pending_path = skill_dir.join("pending-hook.sh");
        let settings_path = home.join(".claude").join("settings.json");
        const FILE: &str = "~/.claude/settings.json";
        let existing = read_existing(&settings_path)?;
        let after_open = remove_settings_hook(&existing, open_path.to_string_lossy().as_ref(), FILE)?;
        let base = after_open.as_deref().unwrap_or(&existing);
        let after_pending = remove_settings_hook_for(base, "UserPromptSubmit", pending_path.to_string_lossy().as_ref(), FILE)?;
        match after_pending.or(after_open) {
            None => Ok(Plan::AlreadyDone("No Glance hook entries to remove.".to_string())),
            Some(next) => Ok(Plan::Write(vec![FileWrite { path: settings_path, contents: next, executable: false }])),
        }
    }
}

/// Codex CLI — MCP in `~/.codex/config.toml` (TOML, so it has its own merge
/// helpers), guidance in `~/.codex/AGENTS.md`, the skill under
/// `~/.codex/skills/glance/`, and both hooks in `~/.codex/hooks.json`, which
/// uses the same `hooks.<Event>[].hooks[]` layout as Claude's settings.json.
/// Codex reports file edits as `apply_patch`, so the auto-open matcher targets
/// that tool; the shared [`hook_script`] parses its `*** Add File:` lines.
pub struct CodexAdapter;

const CODEX_CONFIG_FILE: &str = "~/.codex/config.toml";
const CODEX_HOOKS_FILE: &str = "~/.codex/hooks.json";

impl CodexAdapter {
    fn skill_dir(home: &Path) -> PathBuf {
        home.join(".codex").join("skills").join("glance")
    }
}

impl ClientAdapter for CodexAdapter {
    fn id(&self) -> &'static str {
        "codex"
    }
    fn display_name(&self) -> &'static str {
        "Codex CLI"
    }

    fn is_present(&self, home: &Path) -> bool {
        home.join(".codex").is_dir()
    }

    fn supports(&self, _c: Capability) -> bool {
        true // Codex has MCP, a global AGENTS.md, skills and hooks.
    }

    fn is_configured(&self, home: &Path) -> bool {
        read_existing(&home.join(".codex").join("config.toml"))
            .map(|s| mcp_toml_has(&s, "glance"))
            .unwrap_or(false)
    }

    fn mcp(&self, home: &Path, mcp_bin: &str) -> Result<Plan, String> {
        let path = home.join(".codex").join("config.toml");
        let merged = merge_mcp_toml(&read_existing(&path)?, "glance", mcp_bin, CODEX_CONFIG_FILE)?;
        Ok(Plan::Write(vec![FileWrite { path, contents: merged, executable: false }]))
    }

    fn guidance(&self, home: &Path) -> Result<Plan, String> {
        let path = home.join(".codex").join("AGENTS.md");
        match append_guidance(&read_existing(&path)?) {
            None => Ok(Plan::AlreadyDone("Guidance already present — left unchanged.".to_string())),
            Some(next) => Ok(Plan::Write(vec![FileWrite { path, contents: next, executable: false }])),
        }
    }

    fn skill(&self, home: &Path) -> Result<Plan, String> {
        let path = Self::skill_dir(home).join("SKILL.md");
        Ok(Plan::Write(vec![FileWrite { path, contents: skill_doc(), executable: false }]))
    }

    fn open_hook(&self, home: &Path, bins: &Binaries) -> Result<Plan, String> {
        let skill_dir = Self::skill_dir(home);
        let open_path = skill_dir.join("open-md-hook.sh");
        let pending_path = skill_dir.join("pending-hook.sh");
        let hooks_path = home.join(".codex").join("hooks.json");
        let existing = read_existing(&hooks_path)?;
        let merged = merge_settings_hook_in(
            &existing,
            CODEX_HOOKS_FILE,
            "PostToolUse",
            Some("apply_patch|Write"),
            open_path.to_string_lossy().as_ref(),
        )?;
        let merged = merge_settings_hook_in(
            &merged,
            CODEX_HOOKS_FILE,
            "UserPromptSubmit",
            None,
            pending_path.to_string_lossy().as_ref(),
        )?;
        Ok(Plan::Write(vec![
            FileWrite { path: open_path, contents: hook_script(&bins.app_bin), executable: true },
            FileWrite { path: pending_path, contents: pending_hook_script(&bins.mcp_bin), executable: true },
            FileWrite { path: hooks_path, contents: merged, executable: false },
        ]))
    }

    fn mcp_uninstall(&self, home: &Path) -> Result<Plan, String> {
        let path = home.join(".codex").join("config.toml");
        match remove_mcp_toml(&read_existing(&path)?, "glance", CODEX_CONFIG_FILE)? {
            None => Ok(Plan::AlreadyDone("glance-mcp was not registered.".to_string())),
            Some(next) => Ok(Plan::Write(vec![FileWrite { path, contents: next, executable: false }])),
        }
    }

    fn guidance_uninstall(&self, home: &Path) -> Result<Plan, String> {
        // Setup may have created AGENTS.md itself, so delete it when stripping
        // our block leaves nothing; otherwise keep the user's content.
        let path = home.join(".codex").join("AGENTS.md");
        match strip_guidance(&read_existing(&path)?) {
            None => Ok(Plan::AlreadyDone("No guidance block to remove.".to_string())),
            Some(next) if next.trim().is_empty() => Ok(Plan::Delete(vec![path])),
            Some(next) => Ok(Plan::Write(vec![FileWrite { path, contents: next, executable: false }])),
        }
    }

    fn skill_uninstall(&self, home: &Path) -> Result<Plan, String> {
        // SKILL.md and both hook scripts live in the skill dir — remove it whole.
        Ok(Plan::Delete(vec![Self::skill_dir(home)]))
    }

    fn open_hook_uninstall(&self, home: &Path) -> Result<Plan, String> {
        let skill_dir = Self::skill_dir(home);
        let open_path = skill_dir.join("open-md-hook.sh");
        let pending_path = skill_dir.join("pending-hook.sh");
        let hooks_path = home.join(".codex").join("hooks.json");
        let existing = read_existing(&hooks_path)?;
        let after_open = remove_settings_hook(&existing, open_path.to_string_lossy().as_ref(), CODEX_HOOKS_FILE)?;
        let base = after_open.as_deref().unwrap_or(&existing);
        let after_pending =
            remove_settings_hook_for(base, "UserPromptSubmit", pending_path.to_string_lossy().as_ref(), CODEX_HOOKS_FILE)?;
        match after_pending.or(after_open) {
            None => Ok(Plan::AlreadyDone("No Glance hook entries to remove.".to_string())),
            // hooks.json is ours to create, so drop it rather than leave a stub.
            Some(next) if hooks_file_is_empty(&next) => Ok(Plan::Delete(vec![hooks_path])),
            Some(next) => Ok(Plan::Write(vec![FileWrite { path: hooks_path, contents: next, executable: false }])),
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
    vec![Box::new(ClaudeAdapter), Box::new(CodexAdapter), Box::new(CursorAdapter)]
}

fn install_plan(adapter: &dyn ClientAdapter, c: Capability, bins: &Binaries, home: &Path) -> Result<Plan, String> {
    match c {
        Capability::Mcp => adapter.mcp(home, &bins.mcp_bin),
        Capability::Guidance => adapter.guidance(home),
        Capability::Skill => adapter.skill(home),
        Capability::Hook => adapter.open_hook(home, bins),
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
        // teaches the mdview open convention and all five MCP tools
        assert!(s.contains("mdview <absolute-path>"));
        assert!(s.contains("list_annotations"));
        assert!(s.contains("get_annotation"));
        assert!(s.contains("resolve_annotation"));
        assert!(s.contains("reply_annotation"));
        assert!(s.contains("add_annotation"));
        assert!(s.contains("Point the user at something"));
        // get_annotation is the way to see surrounding lines
        assert!(s.contains("`context.before` and `context.after`"));
        // resolves carry a note; questions go on the card, not in chat
        assert!(s.contains("note: \"<what changed>\""));
        assert!(s.contains("Do not ask in chat"));
        // tells the agent to talk in the user-visible comment number
        assert!(s.contains("`number`"));
        assert!(s.contains("never the id"));
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
        let bins = Binaries { mcp_bin: "/bin/glance-mcp".to_string(), app_bin: "/bin/glance".to_string() };
        assert!(matches!(CursorAdapter.open_hook(&home, &bins).unwrap(), Plan::NotSupported));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn claude_hook_writes_both_scripts_and_settings() {
        let home = tmp_home("claude-hook");
        let bins = Binaries {
            mcp_bin: "/Applications/Glance.app/Contents/MacOS/glance-mcp".to_string(),
            app_bin: "/Applications/Glance.app/Contents/MacOS/glance".to_string(),
        };
        let writes = plan_writes(ClaudeAdapter.open_hook(&home, &bins).unwrap());
        assert_eq!(writes.len(), 3);
        let open = writes.iter().find(|w| w.path.ends_with("open-md-hook.sh")).expect("open-md-hook.sh write");
        assert!(open.executable);
        assert!(open.contents.contains("/Applications/Glance.app/Contents/MacOS/glance\""));
        let pending = writes.iter().find(|w| w.path.ends_with("pending-hook.sh")).expect("pending-hook.sh write");
        assert!(pending.executable);
        assert!(pending.contents.contains("/Applications/Glance.app/Contents/MacOS/glance-mcp\" --pending"));
        let settings = writes.iter().find(|w| w.path.ends_with("settings.json")).expect("a settings write");
        let v: serde_json::Value = serde_json::from_str(&settings.contents).unwrap();
        assert_eq!(v["hooks"]["PostToolUse"][0]["matcher"], "Write");
        assert!(v["hooks"]["PostToolUse"][0]["hooks"][0]["command"].as_str().unwrap().ends_with("open-md-hook.sh"));
        let ups = &v["hooks"]["UserPromptSubmit"][0];
        assert!(ups.get("matcher").is_none(), "UserPromptSubmit entries carry no matcher");
        assert!(ups["hooks"][0]["command"].as_str().unwrap().ends_with("pending-hook.sh"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn pending_hook_script_runs_mcp_pending_and_never_fails() {
        let s = pending_hook_script("/Applications/Glance.app/Contents/MacOS/glance-mcp");
        assert!(s.starts_with("#!/bin/sh\n"));
        assert!(s.contains("\"/Applications/Glance.app/Contents/MacOS/glance-mcp\" --pending"));
        assert!(s.contains("|| true"));
        assert!(s.trim_end().ends_with("exit 0"));
        // With a missing binary the script must still exit 0 and print nothing.
        let dir = tmp_home("pending-script");
        let script = dir.join("pending-hook.sh");
        std::fs::write(&script, pending_hook_script(&dir.join("missing-mcp").to_string_lossy())).unwrap();
        let out = std::process::Command::new("sh")
            .arg(&script)
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap();
        assert!(out.status.success());
        assert!(out.stdout.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn merge_settings_hook_for_adds_matcherless_entry_idempotently() {
        let existing = r#"{"model":"opus","hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"/other.sh"}]}]}}"#;
        let once = merge_settings_hook_for(existing, "UserPromptSubmit", None, "/h/pending-hook.sh").unwrap();
        let twice = merge_settings_hook_for(&once, "UserPromptSubmit", None, "/h/pending-hook.sh").unwrap();
        assert_eq!(once, twice, "second merge must be a no-op");
        let v: serde_json::Value = serde_json::from_str(&twice).unwrap();
        assert_eq!(v["model"], "opus");
        let arr = v["hooks"]["UserPromptSubmit"].as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["hooks"][0]["command"], "/other.sh");
        assert!(arr[1].get("matcher").is_none());
        assert_eq!(arr[1]["hooks"][0]["type"], "command");
        assert_eq!(arr[1]["hooks"][0]["command"], "/h/pending-hook.sh");
        // other events untouched / not created
        assert!(v["hooks"].get("PostToolUse").is_none());
    }

    #[test]
    fn remove_settings_hook_for_removes_only_that_event_entry() {
        let existing = r#"{"hooks":{
            "PostToolUse":[{"matcher":"Write","hooks":[{"type":"command","command":"/h/open-md-hook.sh"}]}],
            "UserPromptSubmit":[
                {"hooks":[{"type":"command","command":"/other.sh"}]},
                {"hooks":[{"type":"command","command":"/h/pending-hook.sh"}]}
            ]}}"#;
        let out = remove_settings_hook_for(existing, "UserPromptSubmit", "/h/pending-hook.sh", "cfg").unwrap().expect("a rewrite");
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        let ups = v["hooks"]["UserPromptSubmit"].as_array().unwrap();
        assert_eq!(ups.len(), 1);
        assert_eq!(ups[0]["hooks"][0]["command"], "/other.sh");
        // PostToolUse entry untouched
        assert_eq!(v["hooks"]["PostToolUse"][0]["hooks"][0]["command"], "/h/open-md-hook.sh");
        // same command under a different event → nothing to do
        assert!(remove_settings_hook_for(&out, "PostToolUse", "/h/pending-hook.sh", "cfg").unwrap().is_none());
        assert!(remove_settings_hook_for(&out, "UserPromptSubmit", "/h/pending-hook.sh", "cfg").unwrap().is_none());
    }

    #[test]
    fn claude_hook_uninstall_removes_both_entries() {
        let home = tmp_home("claude-hook-uninstall");
        let bins = Binaries { mcp_bin: "/bin/glance-mcp".to_string(), app_bin: "/bin/glance".to_string() };
        run_step("g", "hook", ClaudeAdapter.open_hook(&home, &bins));
        // a second install plans the identical settings file: no-op
        let again = plan_writes(ClaudeAdapter.open_hook(&home, &bins).unwrap());
        let settings_again = again.iter().find(|w| w.path.ends_with("settings.json")).unwrap();
        assert_eq!(settings_again.contents, std::fs::read_to_string(home.join(".claude").join("settings.json")).unwrap());
        // uninstall drops both entries in one write
        let w = plan_writes(ClaudeAdapter.open_hook_uninstall(&home).unwrap());
        assert_eq!(w.len(), 1);
        let v: serde_json::Value = serde_json::from_str(&w[0].contents).unwrap();
        assert!(v["hooks"]["PostToolUse"].as_array().unwrap().is_empty());
        assert!(v["hooks"]["UserPromptSubmit"].as_array().unwrap().is_empty());
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
        assert!(!CodexAdapter.is_present(&home));
        assert!(!CursorAdapter.is_present(&home));
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        std::fs::create_dir_all(home.join(".cursor")).unwrap();
        assert!(ClaudeAdapter.is_present(&home));
        assert!(CodexAdapter.is_present(&home));
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
        assert!(home.join(".claude").join("skills").join("glance").join("open-md-hook.sh").exists());
        assert!(home.join(".claude").join("skills").join("glance").join("pending-hook.sh").exists());
        // uninstall
        for r in remove_adapter(&ClaudeAdapter, &home) {
            assert!(r.ok, "uninstall step failed: {}", r.message);
        }
        // glance key gone, skill dir gone, settings entry gone
        let cfg: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(home.join(".claude.json")).unwrap()).unwrap();
        assert!(cfg["mcpServers"].get("glance").is_none());
        assert!(!home.join(".claude").join("skills").join("glance").exists());
        let settings: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(home.join(".claude").join("settings.json")).unwrap()).unwrap();
        assert!(settings["hooks"]["PostToolUse"].as_array().unwrap().is_empty());
        assert!(settings["hooks"]["UserPromptSubmit"].as_array().unwrap().is_empty());
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
            assert!(CodexAdapter.supports(c), "Codex should support {c:?}");
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
        let codex = targets.iter().find(|c| c.id == "codex").expect("codex listed");
        assert_eq!(codex.display_name, "Codex CLI");
        assert!(codex.capabilities.iter().all(|c| c.supported));
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

        // Codex: apply_patch carries the patch text in tool_input.command, with
        // paths relative to cwd. (Raw strings keep the `\n` as JSON escapes.)
        let patch = |body: &str| format!(r#"{{"tool_name":"apply_patch","cwd":"{cwd}","tool_input":{{"command":"{body}"}}}}"#);
        // FIRES: adds a .md
        assert!(run_hook(&base, &stub, &marker, &patch(r"*** Begin Patch\n*** Add File: notes.md\n+hi\n*** End Patch\n")));
        // FIRES: shell-routed ["apply_patch", "<patch>"] list form
        let list = format!(r#"{{"tool_name":"apply_patch","cwd":"{cwd}","tool_input":{{"command":["apply_patch","*** Begin Patch\n*** Add File: docs/plan.md\n+x\n*** End Patch\n"]}}}}"#);
        assert!(run_hook(&base, &stub, &marker, &list));
        // does NOT fire: updates an existing .md
        assert!(!run_hook(&base, &stub, &marker, &patch(r"*** Begin Patch\n*** Update File: notes.md\n@@\n-a\n+b\n*** End Patch\n")));
        // does NOT fire: adds a non-markdown file
        assert!(!run_hook(&base, &stub, &marker, &patch(r"*** Begin Patch\n*** Add File: main.rs\n+fn main() {}\n*** End Patch\n")));
        // does NOT fire: adds a .md under node_modules
        assert!(!run_hook(&base, &stub, &marker, &patch(r"*** Begin Patch\n*** Add File: node_modules/x.md\n+x\n*** End Patch\n")));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn hook_opens_every_added_markdown_in_one_launch() {
        if !python3_available() {
            eprintln!("skipping hook_opens_every_added_markdown_in_one_launch: python3 not available");
            return;
        }
        let base = std::env::temp_dir().join(format!("glance-hook-multi-{}", std::process::id()));
        let proj = base.join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        let marker = base.join("marker");
        // stub records its argv, one per line
        let stub = base.join("stub.sh");
        std::fs::write(&stub, format!("#!/bin/sh\nprintf '%s\\n' \"$@\" >> \"{}\"\n", marker.display())).unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let cwd = proj.to_string_lossy().to_string();
        let json = format!(
            r#"{{"tool_name":"apply_patch","cwd":"{cwd}","tool_input":{{"command":"*** Begin Patch\n*** Add File: a.md\n+a\n*** Add File: src/main.rs\n+x\n*** Add File: b.md\n+b\n*** End Patch\n"}}}}"#
        );
        assert!(run_hook(&base, &stub, &marker, &json));
        let got = std::fs::read_to_string(&marker).unwrap();
        let lines: Vec<&str> = got.lines().collect();
        assert_eq!(lines, vec![proj.join("a.md").to_string_lossy().to_string(), proj.join("b.md").to_string_lossy().to_string()]);
        let _ = std::fs::remove_dir_all(&base);
    }

    // --- Codex ------------------------------------------------------------

    #[test]
    fn merge_mcp_toml_creates_and_preserves() {
        let out = merge_mcp_toml("", "glance", "/p/glance-mcp", "f").unwrap();
        assert!(mcp_toml_has(&out, "glance"));
        assert!(out.contains("[mcp_servers.glance]"));
        assert!(!out.contains("[mcp_servers]\n"));
        let existing = "# my config\nmodel = \"o3\"\n\n[mcp_servers.other]\ncommand = \"x\"\nargs = [\"-v\"]\n";
        let out = merge_mcp_toml(existing, "glance", "/p/glance-mcp", "f").unwrap();
        assert!(out.starts_with("# my config\nmodel = \"o3\"\n"));
        assert!(out.contains("[mcp_servers.other]\ncommand = \"x\"\nargs = [\"-v\"]\n"));
        assert!(mcp_toml_has(&out, "other"));
        let doc: toml_edit::DocumentMut = out.parse().unwrap();
        assert_eq!(doc["mcp_servers"]["glance"]["command"].as_str(), Some("/p/glance-mcp"));
        assert!(doc["mcp_servers"]["glance"]["args"].as_array().unwrap().is_empty());
        // idempotent
        assert_eq!(merge_mcp_toml(&out, "glance", "/p/glance-mcp", "f").unwrap(), out);
    }

    #[test]
    fn merge_mcp_toml_refuses_invalid() {
        assert!(merge_mcp_toml("model = [unclosed", "glance", "/p", "f").is_err());
        assert!(merge_mcp_toml("  \n", "glance", "/p", "f").is_ok());
    }

    #[test]
    fn remove_mcp_toml_strips_entry_and_empty_parent() {
        let with = merge_mcp_toml("model = \"o3\"\n", "glance", "/p", "f").unwrap();
        let out = remove_mcp_toml(&with, "glance", "f").unwrap().unwrap();
        assert!(!mcp_toml_has(&out, "glance"));
        assert!(!out.contains("mcp_servers"));
        assert!(out.contains("model = \"o3\""));
        // other servers survive
        let two = merge_mcp_toml(&with, "other", "/o", "f").unwrap();
        let out = remove_mcp_toml(&two, "glance", "f").unwrap().unwrap();
        assert!(mcp_toml_has(&out, "other"));
        assert!(!mcp_toml_has(&out, "glance"));
        // absent / empty → None
        assert!(remove_mcp_toml("model = \"o3\"\n", "glance", "f").unwrap().is_none());
        assert!(remove_mcp_toml("", "glance", "f").unwrap().is_none());
        assert!(remove_mcp_toml("model = [bad", "glance", "f").is_err());
    }

    #[test]
    fn mcp_toml_has_tolerates_garbage() {
        assert!(!mcp_toml_has("not = [toml", "glance"));
        assert!(!mcp_toml_has("", "glance"));
        assert!(mcp_toml_has("mcp_servers = { glance = { command = \"g\" } }", "glance"));
    }

    #[test]
    fn hooks_file_is_empty_detects_stub() {
        assert!(hooks_file_is_empty(r#"{"hooks":{"PostToolUse":[],"UserPromptSubmit":[]}}"#));
        assert!(hooks_file_is_empty(r#"{"description":"x","hooks":{}}"#));
        assert!(!hooks_file_is_empty(r#"{"hooks":{"PostToolUse":[{"hooks":[]}]}}"#));
        assert!(!hooks_file_is_empty(r#"{"other":1,"hooks":{}}"#));
        assert!(!hooks_file_is_empty("garbage"));
    }

    #[test]
    fn codex_install_then_uninstall_leaves_home_clean() {
        let home = tmp_home("codex-roundtrip");
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        std::fs::write(home.join(".codex").join("config.toml"), "model = \"o3\"\n").unwrap();
        let bins = Binaries { mcp_bin: "/bin/glance-mcp".to_string(), app_bin: "/bin/glance".to_string() };
        assert!(!CodexAdapter.is_configured(&home));
        for r in setup_adapter(&CodexAdapter, &bins, &home) {
            assert!(r.ok, "install step failed: {}", r.message);
        }
        assert!(CodexAdapter.is_configured(&home));
        let cfg = std::fs::read_to_string(home.join(".codex").join("config.toml")).unwrap();
        assert!(cfg.starts_with("model = \"o3\"\n"), "{cfg}");
        assert!(cfg.contains("[mcp_servers.glance]"));
        assert!(std::fs::read_to_string(home.join(".codex").join("AGENTS.md")).unwrap().contains(GUIDANCE_MARKER));
        let skill = home.join(".codex").join("skills").join("glance");
        assert!(skill.join("SKILL.md").exists());
        assert!(skill.join("open-md-hook.sh").exists());
        assert!(skill.join("pending-hook.sh").exists());
        let read_hooks = || -> serde_json::Value {
            serde_json::from_str(&std::fs::read_to_string(home.join(".codex").join("hooks.json")).unwrap()).unwrap()
        };
        let hooks = read_hooks();
        assert_eq!(hooks["hooks"]["PostToolUse"][0]["matcher"], "apply_patch|Write");
        assert!(hooks["hooks"]["PostToolUse"][0]["hooks"][0]["command"].as_str().unwrap().ends_with("open-md-hook.sh"));
        assert!(hooks["hooks"]["UserPromptSubmit"][0].get("matcher").is_none());
        assert!(hooks["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"].as_str().unwrap().ends_with("pending-hook.sh"));
        // re-run is idempotent: still one entry per event
        for r in setup_adapter(&CodexAdapter, &bins, &home) {
            assert!(r.ok, "{}", r.message);
        }
        let hooks = read_hooks();
        assert_eq!(hooks["hooks"]["PostToolUse"].as_array().unwrap().len(), 1);
        assert_eq!(hooks["hooks"]["UserPromptSubmit"].as_array().unwrap().len(), 1);

        for r in remove_adapter(&CodexAdapter, &home) {
            assert!(r.ok, "uninstall step failed: {}", r.message);
        }
        assert_eq!(std::fs::read_to_string(home.join(".codex").join("config.toml")).unwrap(), "model = \"o3\"\n");
        assert!(!home.join(".codex").join("AGENTS.md").exists());
        assert!(!skill.exists());
        assert!(!home.join(".codex").join("hooks.json").exists());
        assert!(!CodexAdapter.is_configured(&home));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn codex_uninstall_keeps_user_hooks_and_agents_content() {
        let home = tmp_home("codex-keep");
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        std::fs::write(home.join(".codex").join("AGENTS.md"), "# Mine\n").unwrap();
        std::fs::write(
            home.join(".codex").join("hooks.json"),
            r#"{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"/me/start.sh"}]}]}}"#,
        )
        .unwrap();
        let bins = Binaries { mcp_bin: "/bin/glance-mcp".to_string(), app_bin: "/bin/glance".to_string() };
        for r in setup_adapter(&CodexAdapter, &bins, &home) {
            assert!(r.ok, "{}", r.message);
        }
        for r in remove_adapter(&CodexAdapter, &home) {
            assert!(r.ok, "{}", r.message);
        }
        assert_eq!(std::fs::read_to_string(home.join(".codex").join("AGENTS.md")).unwrap(), "# Mine\n");
        let hooks: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(home.join(".codex").join("hooks.json")).unwrap()).unwrap();
        assert_eq!(hooks["hooks"]["SessionStart"][0]["hooks"][0]["command"], "/me/start.sh");
        assert!(hooks["hooks"]["PostToolUse"].as_array().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }
}
