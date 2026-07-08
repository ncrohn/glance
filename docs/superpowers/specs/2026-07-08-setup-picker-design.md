# Setup picker — opt-in AI integration per client

**Date:** 2026-07-08
**Status:** Approved (design), pending implementation

## Problem

The "Set up AI Integration…" action runs *everything* for *every* detected
client, then shows a flat list of ~11 result rows (mdview + 4 capabilities ×
each client, including "Not applicable to this client." noise for Cursor's
skill/hook). It is hard to read and offers no choice — the user cannot opt in
per client. Same for "Remove AI Integration…".

## Goal

A pre-run **picker**, grouped by client, that lets the user select which
clients to set up / remove, indicates per client what is eligible, and greys
out clients we support but that aren't installed. The result modal is
restructured into per-client sections.

## Decisions (from brainstorming)

- **Per-client toggle**, not per-capability checkboxes. Checking a client
  installs all of *its* eligible capabilities; a sub-line lists what that
  includes (and what is not supported).
- **Detected clients pre-checked**; supported-but-undetected clients shown
  **disabled/greyed** with "(not detected)" — informational, not installable.
- Only render clients we actually have adapters for (Claude Code, Cursor). No
  placeholder rows for clients without adapters.
- The old `setup_all_present` / `remove_all_present` are **removed** — the
  picker replaces them.

## Architecture

### Backend (`src-tauri/src/setup.rs`)

Make capability support explicit data so enumeration and execution share one
source of truth (they must not drift):

```rust
pub enum Capability { Mcp, Guidance, Skill, Hook }
impl Capability {
    fn key(self) -> &'static str;    // "mcp" | "guidance" | "skill" | "hook"
    fn label(self) -> &'static str;  // "MCP server (glance-mcp)", "Review guidance",
                                     // "Agent skill", "Auto-open hook"
    const ALL: [Capability; 4];
}

// ClientAdapter gains:
fn supports(&self, c: Capability) -> bool;
//   ClaudeAdapter → true for all four
//   CursorAdapter → matches!(c, Capability::Mcp | Capability::Guidance)
```

`setup_adapter` / `remove_adapter` become a loop over
`Capability::ALL.iter().filter(|c| adapter.supports(*c))`, dispatching each to
the existing `mcp` / `guidance` / `skill` / `open_hook` (and `*_uninstall`)
methods via a `match`. Unsupported capabilities are **skipped**, so the
"Not applicable to this client." rows disappear from results entirely.

`StepResult` gains `group: String` — `"Shared"` for the mdview step, otherwise
the client's `display_name` — so the result list can be sectioned.

Two new Tauri commands (registered in `lib.rs` `invoke_handler`):

```rust
// Pure enumeration, no writes.
#[tauri::command] fn list_integration_targets() -> Vec<ClientInfo>;

struct ClientInfo {
    id: String,            // "claude" | "cursor"
    display_name: String,
    present: bool,         // adapter.is_present(home)
    capabilities: Vec<CapabilityInfo>,
}
struct CapabilityInfo { key: String, label: String, supported: bool }

// Installs mdview once (setup only), then setup_adapter/remove_adapter for
// each selected id. Ignores ids that are unknown or (for setup) not usable.
#[tauri::command] fn run_integration(action: String, ids: Vec<String>) -> Vec<StepResult>;
```

`list_integration_targets` iterates `all_adapters()`, emitting a `ClientInfo`
per adapter with a `CapabilityInfo` per `Capability::ALL` (`supported =
adapter.supports(c)`).

### Frontend

`lib.rs` menu handlers stop doing work — they emit an event:
- `setup_integration`  → `emit("show-integration-picker", "setup")`
- `remove_integration` → `emit("show-integration-picker", "remove")`

`app.ts` listens (`onShowIntegrationPicker`), then:
1. `invoke listIntegrationTargets()` → `ClientInfo[]`
2. `showIntegrationPicker(action, clients, onConfirm)`
3. `onConfirm(ids)` → `invoke runIntegration(action, ids)` → `showSetupResult`

`showIntegrationPicker(action, clients, onConfirm)` — new modal, styled like the
existing `showThemePicker`:
- One checkbox row per client. Detected → enabled + pre-checked. Not-detected →
  disabled, greyed, "(not detected)".
- For `remove`, only `present` clients are checkable.
- Sub-line per client: eligible capability labels joined (`MCP · guidance ·
  skill · hook`); for setup, a muted trailing note lists unsupported ones
  (`skill, hook — not supported`). For remove: "removes: …".
- Footer: primary **Install** / **Remove** (disabled until ≥1 checked) +
  **Cancel** / Escape.

`showSetupResult` is restructured to group `steps` by `step.group`, rendering a
section header per group followed by its rows (same glyph/label/detail rows as
today).

### Data flow

```
menu → emit show-integration-picker(action)
  → app.ts: listIntegrationTargets()
    → showIntegrationPicker(action, clients)
      → runIntegration(action, ids)
        → showSetupResult({ action, steps })   // grouped by client
```

All IPC wrappers live in `ipc.ts` (`listIntegrationTargets`, `runIntegration`,
`onShowIntegrationPicker`). Logic stays pure per CLAUDE.md; the DOM modal is the
only side-effectful glue.

## Testing

**Rust:**
- `supports()` per adapter (Claude all; Cursor Mcp/Guidance only).
- `list_integration_targets` shape — Cursor's skill/hook `CapabilityInfo` carry
  `supported: false`; Claude's four all `true`.
- Capability-driven `setup_adapter` still round-trips install → uninstall clean
  (existing round-trip test adapted); no "Not applicable" steps emitted.
- `StepResult.group` set correctly (mdview → "Shared", adapter steps → display
  name).

**Frontend (vitest):**
- Pure `groupSteps(steps)` helper — partitions/orders steps by group.
- Pure `capabilitySummary(client)` helper — the picker sub-line text
  (supported list + unsupported note). The DOM modal itself stays thin and
  untested, like the other modals.

## Addendum — empty-state "set up" prompt

When Glance isn't wired into any detected client yet, the empty/welcome screen
shows a subtle call-to-action card (title + one-line sub + "Set up" button) that
opens the picker. Detection: `ClientInfo` gains `configured` (glance-mcp already
registered — `ClientAdapter::is_configured`, backed by the pure `mcp_config_has`
probe that never errors). The pure `needsSetup(clients)` helper returns true when
a detected client exists but none are configured; once any detected client is
configured the prompt disappears. `app.ts` fetches targets at startup and after
any setup/remove run, re-rendering so the prompt reflects current state. Chosen
placement: empty-state only (calm, on-brand) — not a persistent banner.

## Out of scope (YAGNI)

- Per-capability checkboxes within a client.
- "Install anyway" for undetected clients.
- Adapters for clients we don't yet support (Cline, Zed, …).
