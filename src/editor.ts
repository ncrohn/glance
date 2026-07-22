import { EditorView, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, selectAll } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

// Chrome theme — colors reference the page-level CSS custom properties, so the
// editor tracks whichever theme is active (see theme.ts) automatically. The
// `dark` flag passed to mountEditor only sets CodeMirror's own light/dark
// default, so it must be re-derived from the active theme's appearance.
const glanceTheme = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "var(--ink)", height: "100%" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    fontSize: "14px",
    lineHeight: "1.7",
    padding: "32px 0 120px",
  },
  ".cm-content": { maxWidth: "60rem", margin: "0 auto", padding: "0 40px", caretColor: "var(--accent)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--selection)",
  },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--faint)", border: "none" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--raised) 45%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--muted)" },
});

// Markdown token styling for source mode.
const glanceHighlight = HighlightStyle.define([
  { tag: t.heading, color: "var(--accent)", fontWeight: "700" },
  { tag: t.strong, color: "var(--ink)", fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.link, color: "var(--accent)" },
  { tag: t.url, color: "var(--muted)" },
  { tag: [t.monospace], color: "var(--accent)" },
  { tag: t.quote, color: "var(--muted)", fontStyle: "italic" },
  { tag: [t.list, t.contentSeparator], color: "var(--accent)" },
  { tag: t.comment, color: "var(--faint)" },
]);

export function mountEditor(
  host: HTMLElement,
  initial: string,
  onChange: (v: string) => void,
  dark = false,
): { destroy(): void; selectAll(): void } {
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: initial,
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown(),
        EditorView.lineWrapping,
        glanceTheme,
        EditorView.theme({}, { dark }),
        syntaxHighlighting(glanceHighlight),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChange(u.state.doc.toString());
        }),
      ],
    }),
  });
  return {
    destroy: () => view.destroy(),
    // Full-document select-all: CodeMirror knows the whole doc even though only
    // the visible lines are in the DOM, so this beats the webview's native
    // selectAll: (which would grab only the rendered lines).
    selectAll: () => { view.focus(); selectAll(view); },
  };
}
