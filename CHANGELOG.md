# Changelog

## 0.8.5

Safer documents, and Glance stops losing your work.

### Documents can't run code

- A document can no longer run code inside Glance, or read and write files through it.
- Glance only opens and saves markdown and plain-text files.
- A link to anything that could run a program — a script, an app, a `.command` file, or a file disguised as one — now asks before opening it.
- Links in mermaid diagrams open in your browser instead of replacing the Glance window.

### Your work is kept

- Closing a tab or quitting with unsaved edits asks whether to save them first.
- Opening a file while Glance is closed keeps your other tabs.
- If an annotation file is damaged, Glance shows an error and leaves the file alone, instead of replacing it with an empty one.
- Saving while an agent writes the same file no longer loses your typing or the agent's change, and no longer asks about your own save.

## 0.8.4

Opening many files at once no longer starts several copies of Glance.

- When an agent opens a burst of files while Glance is closed, they all open as tabs in one window instead of each starting its own Glance.
- If another Glance launch is stuck, a new one waits up to 10 seconds and then opens anyway.

## 0.8.3

Obsidian-style links, and Glance keeps your place.

- `[[note]]`, `[[note|label]]` and `[[note#Heading]]` links work. Glance looks for the note next to the document, then at the root of your Obsidian vault, then anywhere in the vault by name.
- Switching between Read and Edit keeps the same part of the document on screen instead of jumping to the top.
- HTML comments like `<!-- note -->` are hidden in Read mode, as on GitHub and in Obsidian. Comments inside code still show.

## 0.8.2

Images show up, and links leave Glance.

- Images with relative paths, like `![](img/diagram.png)`, now load from the document's folder.
- Web links open in your default browser instead of inside the Glance window.
- Links to other markdown files open as Glance tabs. Links to other files, like a PDF, open in their default app.
- `#heading` links scroll to that heading.

## 0.8.1

Codex CLI joins Claude Code and Cursor in **Glance ▸ Set up AI Integration…**.

### Codex CLI

- Registers `glance-mcp` in `~/.codex/config.toml`, adds the review guidance to `~/.codex/AGENTS.md`, installs the `glance` skill, and wires both hooks into `~/.codex/hooks.json`.
- New markdown files Codex creates with `apply_patch` open in Glance automatically, and open comments in the project reach Codex before each of your prompts.
- Codex asks you to trust the new hooks the next time it starts. Accept the prompt or they will not run.

### Setup, for every client

- Config files that are symlinks (a dotfiles-managed `AGENTS.md` or `CLAUDE.md`) are written through, so the link stays.
- File modes are kept. A `0600` config stays `0600`.
- Re-running setup refreshes the `glance-mcp` path and keeps anything else you added to the entry.
- Remove AI Integration deletes a guidance file it created rather than leaving it empty, and leaves a skill directory you symlinked in place.

## 0.8.0

The annotation workflow, rebuilt end to end.

### Reading and commenting

- The view keeps its scroll position when you add, edit, or resolve a comment, or when the file changes on disk.
- Select with the keyboard or the mouse, then press **⌘⇧M** or click **Comment**. The button stays inside the reading pane.
- The composer keeps a draft on a stray click and asks before discarding on Esc. Key hints are shown.
- A one-time hint on first open explains how to comment.

### The rail

- Header with the open count, a collapse toggle that is remembered, and a drag handle to resize the rail.
- Cards in document order, each with its quoted text, a stable number, and a clamp for long notes.
- Hover a card for **Resolve**, **Edit**, **Reply**, and **Delete**; **Undo** after a delete; **Reopen** on a resolved comment. Resolved cards look done, not struck out, and **Clear** empties the section.
- Drifted comments are marked **moved** with a dashed marker; orphaned ones say **not found**. Both offer **⌖ Re-anchor** to a new selection.
- Click a gutter marker or highlighted text to jump to its card, and the other way round.
- The rail hides in Edit mode.

### Working with Claude

- Comments carry a permanent number that Claude sees too, so "comment 3" means the same thing on both sides.
- Claude can reply on a card, resolve with a one-line note saying what changed, and leave pointers of its own. You can reply back from the card.
- When Claude resolves or replies, the card pulses and a toast appears; on a background tab, a dot on the tab.
- A `UserPromptSubmit` hook tells Claude about open comments in the project without being asked.
- MCP: `get_annotation` returns three lines of context; new `reply_annotation` and `add_annotation` tools.

### Themes and change bars

- Highlights use a per-theme palette with a contrast test, and highlighted text keeps the theme's ink on dark themes.
- Change bars mark the block that changed, not its whole section. Table rows, list items, code blocks, and blockquote children get their own bar. A deletion shows as a tick instead of a bar on its neighbor.

### Upgrading

Existing comments are kept and numbered in creation order on first open. Run **Glance ▸ Set up AI Integration…** once so the Claude skill and hooks pick up the new tools.

## 0.7.2

- Show in Finder keeps its enabled state in sync with the active tab.
