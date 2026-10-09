import { EditorView, keymap } from "@codemirror/view";
import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state";
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

// Marks a change that came from outside the editor (the file changed on disk),
// so it isn't reported back through onChange as if the user typed it.
const external = Annotation.define<boolean>();

/** The single replacement turning `from` into `to`: their common prefix and
 *  suffix stay put, so a cursor outside the changed span keeps its place. */
export function minimalChange(from: string, to: string): { from: number; to: number; insert: string } | null {
  if (from === to) return null;
  const max = Math.min(from.length, to.length);
  let start = 0;
  while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) start++;
  let end = 0;
  while (end < max - start && from.charCodeAt(from.length - 1 - end) === to.charCodeAt(to.length - 1 - end)) end++;
  return { from: start, to: from.length - end, insert: to.slice(start, to.length - end) };
}

export function mountEditor(
  host: HTMLElement,
  initial: string,
  onChange: (v: string) => void,
  dark = false,
): EditorHandle {
  const darkness = new Compartment();
  let isDark = dark;
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
        darkness.of(EditorView.theme({}, { dark })),
        syntaxHighlighting(glanceHighlight),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return;
          if (u.transactions.every((tr) => tr.annotation(external))) return;
          onChange(u.state.doc.toString());
        }),
      ],
    }),
  });
  return {
    destroy: () => view.destroy(),
    setContent: (text: string) => {
      const change = minimalChange(view.state.doc.toString(), text);
      // Kept out of undo history: Cmd+Z must undo the user's own typing, not
      // revert an agent's rewrite of the file (which a save would then write).
      if (change) {
        view.dispatch({
          changes: change,
          annotations: [external.of(true), Transaction.addToHistory.of(false)],
        });
      }
    },
    setDark: (next: boolean) => {
      if (next === isDark) return;
      isDark = next;
      view.dispatch({ effects: darkness.reconfigure(EditorView.theme({}, { dark: next })) });
    },
    // Full-document select-all: CodeMirror knows the whole doc even though only
    // the visible lines are in the DOM, so this beats the webview's native
    // selectAll: (which would grab only the rendered lines).
    selectAll: () => { view.focus(); selectAll(view); },
    topLine: () => {
      const height = view.scrollDOM.getBoundingClientRect().top - view.documentTop;
      const block = view.lineBlockAtHeight(Math.max(height, 0));
      return view.state.doc.lineAt(block.from).number;
    },
    scrollToLine: (line: number) => {
      const doc = view.state.doc;
      const target = doc.line(Math.min(Math.max(Math.round(line), 1), doc.lines));
      view.dispatch({ effects: EditorView.scrollIntoView(target.from, { y: "start" }) });
    },
  };
}

export interface EditorHandle {
  destroy(): void;
  /** Replace the text (an outside change), keeping selection and undo history. */
  setContent(text: string): void;
  setDark(dark: boolean): void;
  selectAll(): void;
  /** 1-based source line at the top of the visible area. */
  topLine(): number;
  scrollToLine(line: number): void;
}
