# Glance Agent Integration — Skill + Auto-Open Hook — Design

**Date:** 2026-06-25
**Status:** Approved design, ready for implementation planning
**Builds on:** the annotation integration (`docs/superpowers/specs/2026-06-25-glance-annotations-design.md`) and the sidecar bundling (`glance-mcp` shipped inside `Glance.app`).

## Goal

Make a Claude Code agent automatically integrate with Glance: surface the markdown it produces for review, and know how to read and act on the user's anchored review comments. Delivered as installable artifacts the existing one-click **"Set up Claude Integration…"** action writes onto the machine — no separate plugin or manual config.

## Scope

Two behaviors, two mechanisms:

- **Auto-open** new markdown with Glance — a deterministic "every time the agent creates a doc" behavior → a **PostToolUse hook**.
- **Annotation review loop** (read comments → act → resolve) — model-judgment about an unfamiliar tool → a **skill** (`SKILL.md`).

## Non-goals

- No standalone Claude Code plugin / marketplace package (app-setup install only).
- No new MCP tools — v1 agent surface stays read+resolve (`list_annotations`, `get_annotation`, `resolve_annotation`).
- No support for non-Claude-Code agent runtimes in this iteration (the skill/hook formats are Claude Code's).
- The hook does not try to perfectly detect "new vs overwrite" — it keys on the `Write` tool, which approximates new/full-rewrite (see Hook).

## Architecture

All artifacts are **embedded as string constants in the Rust binary** (the same approach as the existing `guidance_block()`), written to disk by an extended `setup_claude_integration()`. Nothing is read from app-bundle resource files at runtime, so there is no resource-path lookup to get wrong.

```
Menu: "Set up Claude Integration…"  → setup_claude_integration() -> Vec<StepResult>
  1. install mdview wrapper                          (existing)
  2. register glance-mcp in ~/.claude.json           (existing)
  3. append guidance to ~/.claude/CLAUDE.md          (existing)
  4. write skill  → ~/.claude/skills/glance/SKILL.md            (NEW: install_skill)
  5. write hook script + register in ~/.claude/settings.json    (NEW: install_open_hook)
```

Each step yields a `StepResult { ok, label, message }`; the existing notice UI already renders the multi-step result.

**PATH-independence (load-bearing):** both the hook script and the MCP registration reference the app binary by **absolute path derived from `current_exe()`** at install time, never by relying on `mdview`/`glance-mcp` being on `$PATH`. Hooks run in a minimal environment where `~/.local/bin` may be absent. The existing mdview wrapper already bakes in `current_exe()`; the hook does the same.

**AppTranslocation guard:** `install_open_hook` reuses the existing guard — refuse to install (returning a failed `StepResult`) when the app runs from a quarantined/translocated copy, since the baked-in path would be transient.

## Component 1 — The skill (`~/.claude/skills/glance/SKILL.md`)

A flexible (knowledge) skill, ~40–60 lines. The **description is the trigger** and must fire when the agent produces markdown the user reviews, or when the user refers to Glance / their comments / annotations.

Frontmatter:

```yaml
---
name: glance
description: Use when you create or update a markdown file the user should review,
  or when the user refers to Glance, their review comments, or annotations on a
  document. Opens docs in Glance and reads and acts on the user's anchored comments.
---
```

Body teaches only the **non-obvious** parts (the agent already knows how to edit files):

1. **Surface docs for review** — open markdown the user should review with `mdview <absolute-path>`. The auto-open hook usually handles freshly created files; invoke this explicitly for files the hook won't catch (e.g. an existing doc the user asks you to revise). Reusing the running Glance window is automatic (single-instance, tab-dedup).
2. **Read the user's comments** — call the MCP tool `list_annotations(path)` to get open comments with line numbers resolved against the file's **current** contents. Field meanings:
   - `note` — what the user wants.
   - `lineStart`/`lineEnd` — current location (re-anchored live; trust these over any remembered line).
   - `quote` — the text the comment is anchored to.
   - `anchor` — `exact` (confident), `quote-only` (matched by text, context moved), `drifted` (quote gone but near the old line — approximate, confirm before editing), `orphaned` (quoted text no longer exists — do not guess; ask the user).
3. **Act** — make the requested change at the indicated lines.
4. **Close the loop** — call `resolve_annotation(path, id)` after applying each comment so it flips to resolved live in Glance. Then re-`list_annotations` to confirm nothing open remains.
5. **Etiquette** — the agent's surface is read + resolve only; there is no tool to create annotations (v1). One `resolve_annotation` per applied comment. Don't resolve a comment you didn't actually address.

## Component 2 — The auto-open hook

**Script:** `~/.claude/skills/glance/open-md-hook.sh`, written by setup with the absolute app-binary path interpolated in. Claude Code pipes the tool event as JSON on stdin.

**Parsing:** use `python3` (always present on macOS) to read `tool_name`, `tool_input.file_path`, and `cwd` from stdin — avoids a `jq` dependency.

**Fire `mdview` (open the doc) iff ALL:**
- `tool_name == "Write"` (new / full-rewrite; excludes per-edit churn).
- `file_path` ends in `.md` or `.markdown`.
- `file_path` is inside `cwd` (in-project only).
- no path segment is `node_modules` or begins with `.` (skip vendored dirs and dotdirs).
- `file_path` is not under a temp dir (`$TMPDIR`, `/tmp`, `/private/tmp`).

When it fires: launch the app binary on the file **detached** (`"<abs-bin>" "<file_path>" >/dev/null 2>&1 &`), exactly like the mdview wrapper. **Always `exit 0`** — the hook must never block or fail the agent's turn. On any parse error or unmet condition, exit 0 silently.

**Registration:** setup merges into `~/.claude/settings.json`, preserving all existing keys and hooks:

```json
{ "hooks": { "PostToolUse": [
  { "matcher": "Write",
    "hooks": [ { "type": "command", "command": "<home>/.claude/skills/glance/open-md-hook.sh" } ] }
] } }
```

Matcher is `Write` only (Edit excluded → matches the "new .md" intent). **Idempotent:** if a hook entry with our exact command string already exists anywhere under `PostToolUse`, make no change.

## Component 3 — Setup wiring (`src-tauri/src/setup.rs`)

Two steps appended to `setup_claude_integration()`:

- `install_skill() -> StepResult` — `create_dir_all(~/.claude/skills/glance)`, write `SKILL.md` from the embedded `skill_doc()` constant (overwrite to keep it current). Label: "Install Glance agent skill".
- `install_open_hook() -> StepResult` — resolve `current_exe()` (with the AppTranslocation guard); write `open-md-hook.sh` from `hook_script(app_bin)` (path interpolated), `chmod 0o755`; read `~/.claude/settings.json` (empty if absent), apply `merge_settings_hook`, write back. Label: "Install auto-open hook".

**New pure helpers (no I/O — unit-tested like `merge_mcp_config`):**

- `pub fn skill_doc() -> String` — the SKILL.md text.
- `pub fn hook_script(app_bin: &str) -> String` — the hook shell script with `app_bin` interpolated.
- `pub fn merge_settings_hook(existing: &str, command: &str) -> String` — parse `existing` (or `{}` if empty/invalid), ensure `hooks.PostToolUse` is an array, append `{matcher:"Write", hooks:[{type:"command", command}]}` only if no existing entry uses `command`, return pretty JSON preserving all other content.

## Testing

- **`merge_settings_hook`** (`cargo test`, pure): into empty input creates the entry; preserves an unrelated existing `PostToolUse` entry and other top-level keys; second call with the same command is a no-op (no duplicate).
- **`hook_script` / `skill_doc`** (`cargo test`, pure): `hook_script("/abs/glance")` contains `/abs/glance`; asserts the key guards are present in the script text (`node_modules`, `.md`, `cwd`, `"Write"`); `skill_doc()` contains the frontmatter `name: glance` and the three MCP tool names.
- **Hook-script behavior** (`cargo test` shelling out, gated on `python3` available; skip with a logged message otherwise): pipe fixture stdin JSON to `open-md-hook.sh` and assert it invokes the (stub) binary for an in-`cwd` new `.md`, and stays silent for: a `node_modules` path, a non-`.md` path, a `tool_name` of `Edit`, and a temp-dir path. The test passes a harmless stub as the app binary (e.g. a script writing to a temp marker file) so "did it fire" is observable without launching the GUI.
- No new frontend code → no vitest changes.

## Docs

- README "Claude integration" section: note that setup also installs the `glance` skill and the auto-open hook, and what each does (open new project `.md` automatically; teach the comment-review loop).
- CLAUDE.md architecture: note `setup.rs` now also installs `~/.claude/skills/glance/SKILL.md` and the `open-md-hook.sh` PostToolUse hook.

## Open questions (resolved)

- **Hook parser dependency:** `python3` (preinstalled on macOS) over `jq` (not guaranteed). If `python3` is somehow absent the script exits 0 silently — auto-open simply doesn't fire; the skill's explicit `mdview` guidance still covers opening.
- **Edit vs Write:** keying on `Write` only is the chosen approximation of "new file"; revisiting to include `Edit` (live preview on revisions) is a future tweak, not v1.
- **Global vs per-project hook:** the hook is registered in user-level `~/.claude/settings.json` (fires in every project) but the in-`cwd` + dotdir/node_modules/temp filters keep it scoped to real in-project docs.
