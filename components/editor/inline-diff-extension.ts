"use client";

/**
 * Inline-diff decorations for pending agent edits.
 *
 * Red-deleted lines = original content; floating green widget below shows the
 * proposed replacement. Keep/Undo buttons call into edit-store.
 *
 * Inspired by a distilled architecture — same RelPos-driven line resolution, Apple-tinted
 * palette (no saturated backgrounds, hairline borders, system-ui for chrome).
 */

import {
  EditorView,
  Decoration,
  DecorationSet,
  ViewPlugin,
  WidgetType,
} from "@codemirror/view";
import { StateField, StateEffect, RangeSetBuilder, Text } from "@codemirror/state";
import * as Y from "yjs";
import { useEditStore, getEffectiveLineNumbers, type PendingEdit } from "@/stores/edit-store";
import type { RelativePositionJSON } from "@/src/server/edit-position-tracker";

export const setPendingEditsEffect = StateEffect.define<PendingEdit[]>();
export const setCurrentFileEffect = StateEffect.define<string>();
export const setYjsRefsEffect = StateEffect.define<{
  ydoc: Y.Doc | null;
  ytext: Y.Text | null;
}>();

export const currentFileField = StateField.define<string>({
  create: () => "",
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setCurrentFileEffect)) return effect.value;
    }
    return value;
  },
});

function filePathMatches(editPath: string, currentPath: string): boolean {
  if (!editPath || !currentPath) return false;
  if (editPath === currentPath) return true;
  const a = editPath.split("/").pop() || editPath;
  const b = currentPath.split("/").pop() || currentPath;
  return a === b || editPath.endsWith(b) || currentPath.endsWith(a);
}

function lineToOffset(doc: Text, line: number): number {
  if (line < 1) return 0;
  if (line > doc.lines) return doc.length;
  return doc.line(line).from;
}
function lineEndOffset(doc: Text, line: number): number {
  if (line < 1) return 0;
  if (line > doc.lines) return doc.length;
  return doc.line(line).to;
}

class UpdatedContentWidget extends WidgetType {
  constructor(
    readonly updatedText: string,
    readonly editId: string,
    readonly authorLabel?: string
  ) {
    super();
  }

  toDOM() {
    const wrapper = document.createElement("div");
    wrapper.className = "cm-diff-wrapper";

    const header = document.createElement("div");
    header.className = "cm-diff-header";

    const label = document.createElement("span");
    label.className = "cm-diff-label";
    label.textContent = this.authorLabel
      ? `${this.authorLabel} 提议`
      : "提议修改";

    const actions = document.createElement("span");
    actions.className = "cm-diff-actions";

    const undo = document.createElement("button");
    undo.className = "cm-diff-btn cm-diff-reject";
    undo.textContent = "撤销";
    undo.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      useEditStore.getState().rejectEdit(this.editId);
    };

    const keep = document.createElement("button");
    keep.className = "cm-diff-btn cm-diff-accept";
    keep.textContent = "保留";
    keep.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      useEditStore.getState().applyEdit(this.editId);
    };

    actions.appendChild(undo);
    actions.appendChild(keep);
    header.appendChild(label);
    header.appendChild(actions);

    const content = document.createElement("div");
    content.className = "cm-diff-body";
    for (const line of this.updatedText.split("\n")) {
      const row = document.createElement("div");
      row.className = "cm-diff-line";
      const marker = document.createElement("span");
      marker.className = "cm-diff-marker";
      marker.textContent = "+";
      const text = document.createElement("span");
      text.className = "cm-diff-text";
      text.textContent = line || " ";
      row.appendChild(marker);
      row.appendChild(text);
      content.appendChild(row);
    }

    wrapper.appendChild(header);
    wrapper.appendChild(content);
    return wrapper;
  }

  eq(other: UpdatedContentWidget) {
    return (
      other.updatedText === this.updatedText &&
      other.editId === this.editId &&
      other.authorLabel === this.authorLabel
    );
  }

  ignoreEvent() {
    return false;
  }
}

interface DecoEntry {
  from: number;
  to: number;
  decoration: Decoration;
}

function buildDecorations(
  doc: Text,
  edits: PendingEdit[],
  filePath: string,
  ydoc: Y.Doc | null,
  ytext: Y.Text | null
): DecorationSet {
  const entries: DecoEntry[] = [];
  for (const edit of edits) {
    if (edit.status !== "pending") continue;
    if (!filePathMatches(edit.filePath, filePath)) continue;
    for (const block of edit.blocks) {
      const { startLine: s0, endLine: e0 } = getEffectiveLineNumbers(block, ydoc, ytext);
      if (s0 < 1 || e0 < s0) continue;
      const startLine = Math.min(s0, doc.lines);
      const endLine = Math.min(e0, doc.lines);

      for (let ln = startLine; ln <= endLine; ln++) {
        if (ln < 1 || ln > doc.lines) continue;
        const pos = doc.line(ln).from;
        entries.push({
          from: pos,
          to: pos,
          decoration: Decoration.line({ class: "cm-diff-deleted-line" }),
        });
      }

      const to = lineEndOffset(doc, endLine);
      entries.push({
        from: to,
        to,
        decoration: Decoration.widget({
          widget: new UpdatedContentWidget(
            block.updated,
            edit.id,
            edit.authorName
          ),
          side: 1,
        }),
      });
    }
  }
  entries.sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const e of entries) builder.add(e.from, e.to, e.decoration);
  return builder.finish();
}

export const inlineDiffField = StateField.define<{
  edits: PendingEdit[];
  filePath: string;
  ydoc: Y.Doc | null;
  ytext: Y.Text | null;
  decorations: DecorationSet;
}>({
  create: () => ({
    edits: [],
    filePath: "",
    ydoc: null,
    ytext: null,
    decorations: Decoration.none,
  }),
  update(state, tr) {
    let { edits, filePath, ydoc, ytext, decorations } = state;
    let rebuild = false;
    for (const effect of tr.effects) {
      if (effect.is(setPendingEditsEffect)) {
        edits = effect.value;
        rebuild = true;
      }
      if (effect.is(setCurrentFileEffect)) {
        filePath = effect.value;
        rebuild = true;
      }
      if (effect.is(setYjsRefsEffect)) {
        ydoc = effect.value.ydoc;
        ytext = effect.value.ytext;
        rebuild = true;
      }
    }
    if (rebuild || tr.docChanged) {
      decorations = buildDecorations(tr.state.doc, edits, filePath, ydoc, ytext);
    }
    return { edits, filePath, ydoc, ytext, decorations };
  },
  provide: (f) => EditorView.decorations.from(f, (s) => s.decorations),
});

export const inlineDiffTheme = EditorView.theme({
  ".cm-diff-deleted-line": {
    backgroundColor: "rgba(255, 59, 48, 0.06)",
    borderLeft: "2px solid rgba(255, 59, 48, 0.35)",
  },
  ".cm-diff-wrapper": {
    display: "block",
    margin: "4px 0",
    backgroundColor: "rgba(48, 209, 88, 0.05)",
    border: "0.5px solid rgba(48, 209, 88, 0.25)",
    borderRadius: "6px",
    overflow: "hidden",
  },
  ".cm-diff-header": {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "4px 10px",
    backgroundColor: "rgba(48, 209, 88, 0.08)",
    borderBottom: "0.5px solid rgba(48, 209, 88, 0.15)",
  },
  ".cm-diff-label": {
    fontSize: "11px",
    fontWeight: "500",
    color: "hsl(140 60% 30%)",
    fontFamily: "-apple-system, sans-serif",
    letterSpacing: "-0.005em",
  },
  ".cm-diff-actions": { display: "flex", gap: "6px" },
  ".cm-diff-btn": {
    padding: "2px 10px",
    borderRadius: "4px",
    border: "0.5px solid",
    fontSize: "11px",
    fontWeight: "500",
    cursor: "pointer",
    fontFamily: "-apple-system, sans-serif",
    transition: "opacity 120ms",
  },
  ".cm-diff-reject": {
    backgroundColor: "transparent",
    borderColor: "rgba(255, 59, 48, 0.3)",
    color: "hsl(3 80% 45%)",
  },
  ".cm-diff-accept": {
    backgroundColor: "hsl(140 60% 38%)",
    borderColor: "hsl(140 60% 38%)",
    color: "white",
  },
  ".cm-diff-body": {
    maxHeight: "240px",
    overflow: "auto",
    padding: "4px 0",
  },
  ".cm-diff-line": {
    display: "flex",
    lineHeight: "1.55",
    fontFamily: "ui-monospace, SF Mono, Menlo, monospace",
    fontSize: "12px",
  },
  ".cm-diff-marker": {
    width: "18px",
    textAlign: "center",
    color: "hsl(140 60% 40%)",
    fontWeight: "600",
    flexShrink: "0",
  },
  ".cm-diff-text": {
    flex: "1",
    paddingRight: "10px",
    whiteSpace: "pre-wrap",
    color: "hsl(140 45% 25%)",
  },
});

export const inlineDiffPlugin = ViewPlugin.fromClass(
  class {
    private unsub: (() => void) | null = null;
    constructor(private view: EditorView) {
      this.unsub = useEditStore.subscribe((state) => {
        this.view.dispatch({
          effects: setPendingEditsEffect.of(state.pendingEdits),
        });
      });
      const initial = useEditStore.getState().pendingEdits;
      if (initial.length > 0) {
        this.view.dispatch({ effects: setPendingEditsEffect.of(initial) });
      }
    }
    destroy() {
      this.unsub?.();
    }
  }
);

export function getInlineDiffExtensions() {
  return [currentFileField, inlineDiffField, inlineDiffTheme, inlineDiffPlugin];
}

// Convenience dispatchers -------------------------------------------------

export function setCurrentFile(view: EditorView, filePath: string) {
  view.dispatch({ effects: setCurrentFileEffect.of(filePath) });
}
export function setYjsRefs(view: EditorView, ydoc: Y.Doc | null, ytext: Y.Text | null) {
  view.dispatch({ effects: setYjsRefsEffect.of({ ydoc, ytext }) });
}
