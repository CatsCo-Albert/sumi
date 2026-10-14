/**
 * Shared CodeMirror editing helpers — used by both the keymap inside
 * collaborative-editor.tsx and the toolbar buttons in editor-toolbar.tsx.
 *
 * Everything here is a pure CM operation: dispatch a transaction on the
 * view, return whether it ran. No React, no DOM.
 */

import type { EditorView } from "@codemirror/view";

/**
 * Wrap the current selection with `prefix`/`suffix` (defaults to a matching
 * pair like `**`). With an empty selection, inserts the empty pair and puts
 * the cursor between them.
 *
 * Returns a CM command — `run(view)` — so it can be dropped into a keymap
 * or invoked directly from a button.
 */
export function wrapSelectionWith(pair: string, closingOverride?: string) {
  const closing = closingOverride ?? pair;
  return (view: EditorView): boolean => {
    const { state } = view;
    const sel = state.selection.main;
    if (sel.empty) {
      const pos = sel.from;
      view.dispatch({
        changes: { from: pos, insert: pair + closing },
        selection: { anchor: pos + pair.length },
      });
    } else {
      const text = state.sliceDoc(sel.from, sel.to);
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: pair + text + closing },
        selection: {
          anchor: sel.from + pair.length,
          head: sel.from + pair.length + text.length,
        },
      });
    }
    return true;
  };
}

/**
 * Insert `text` at the head of the main selection. `cursorOffset` places
 * the cursor inside the inserted text (e.g. between `[` and `](url)`).
 */
export function insertText(
  view: EditorView,
  text: string,
  cursorOffset?: number
): boolean {
  const sel = view.state.selection.main;
  const pos = sel.to;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: text },
    selection: { anchor: pos + (cursorOffset ?? text.length) },
  });
  return true;
}

/**
 * Insert a block-level markdown construct. If the cursor sits mid-line the
 * block goes on a fresh paragraph below the current line; on an empty line
 * it's inserted in place. Cursor lands at the end of the inserted block.
 */
export function insertBlock(view: EditorView, text: string): boolean {
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  const insertPos = line.to;
  const insertContent = (line.text.trim() === "" ? "" : "\n\n") + text + "\n";
  view.dispatch({
    changes: { from: insertPos, insert: insertContent },
    selection: { anchor: insertPos + insertContent.length - 1 },
  });
  return true;
}

/**
 * Apply a line-prefix to every line the selection touches (headings, lists,
 * blockquote). If the selection is a cursor, only that line is rewritten.
 * If the line already starts with the prefix it is removed (toggle).
 */
export function toggleLinePrefix(view: EditorView, prefix: string): boolean {
  const { state } = view;
  const sel = state.selection.main;
  const startLine = state.doc.lineAt(sel.from);
  const endLine = state.doc.lineAt(sel.to);
  const changes: { from: number; to?: number; insert?: string }[] = [];

  for (let n = startLine.number; n <= endLine.number; n++) {
    const line = state.doc.line(n);
    if (line.text.startsWith(prefix)) {
      changes.push({ from: line.from, to: line.from + prefix.length });
    } else {
      changes.push({ from: line.from, insert: prefix });
    }
  }
  view.dispatch({ changes });
  return true;
}

/**
 * Set the heading level of the lines under the selection. `level === 0`
 * strips any leading `# ` markers back to 正文.
 */
export function setHeadingLevel(view: EditorView, level: number): boolean {
  const { state } = view;
  const sel = state.selection.main;
  const startLine = state.doc.lineAt(sel.from);
  const endLine = state.doc.lineAt(sel.to);
  const changes: { from: number; to: number; insert: string }[] = [];

  for (let n = startLine.number; n <= endLine.number; n++) {
    const line = state.doc.line(n);
    const stripped = line.text.replace(/^#{1,6}\s+/, "");
    const prefix = level > 0 ? "#".repeat(level) + " " : "";
    changes.push({
      from: line.from,
      to: line.to,
      insert: prefix + stripped,
    });
  }
  view.dispatch({ changes });
  return true;
}
