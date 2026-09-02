# Changelog

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
