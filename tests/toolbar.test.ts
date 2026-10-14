/**
 * Toolbar format-helper tests.
 *
 * The helpers in components/editor/format-helpers.ts are pure CodeMirror
 * operations — drive them against a real EditorState / headless EditorView
 * and assert on the resulting document + selection. No React involved.
 */

import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  wrapSelectionWith,
  insertText,
  insertBlock,
  toggleLinePrefix,
  setHeadingLevel,
} from "../components/editor/format-helpers";

/** Build a minimal view stub — the helpers only touch `state` + `dispatch`,
 * so a full EditorView (which needs a real DOM) isn't required. */
function makeView(doc: string, sel?: { anchor: number; head?: number }) {
  let state = EditorState.create({
    doc,
    selection: sel ? { anchor: sel.anchor, head: sel.head } : undefined,
  });
  const view = {
    get state() {
      return state;
    },
    dispatch: (spec: Parameters<EditorView["dispatch"]>[0]) => {
      state = state.update(spec).state;
    },
  } as unknown as EditorView;
  return view;
}

describe("wrapSelectionWith", () => {
  it("wraps a non-empty selection with a symmetric pair", () => {
    const view = makeView("hello world", { anchor: 0, head: 5 });
    wrapSelectionWith("**")(view);
    expect(view.state.doc.toString()).toBe("**hello** world");
    // selection wraps just the inner text
    expect(view.state.sliceDoc(
      view.state.selection.main.from,
      view.state.selection.main.to
    )).toBe("hello");
  });

  it("inserts an empty pair at a cursor and parks the caret inside", () => {
    const view = makeView("abc", { anchor: 3 });
    wrapSelectionWith("`")(view);
    expect(view.state.doc.toString()).toBe("abc``");
    expect(view.state.selection.main.head).toBe(4);
  });

  it("supports asymmetric pairs (underline tags)", () => {
    const view = makeView("x", { anchor: 0, head: 1 });
    wrapSelectionWith("<u>", "</u>")(view);
    expect(view.state.doc.toString()).toBe("<u>x</u>");
  });
});

describe("insertText", () => {
  it("inserts at cursor and honours cursorOffset", () => {
    const view = makeView("ab", { anchor: 2 });
    insertText(view, "[t](u)", 1);
    expect(view.state.doc.toString()).toBe("ab[t](u)");
    expect(view.state.selection.main.head).toBe(3); // inside the bracket
  });
});

describe("insertBlock", () => {
  it("inserts in place on an empty line", () => {
    const view = makeView("top\n\nbottom", { anchor: 4 });
    insertBlock(view, "---");
    expect(view.state.doc.toString()).toBe("top\n---\n\nbottom");
  });

  it("drops the block on a fresh paragraph after a non-empty line", () => {
    const view = makeView("paragraph", { anchor: 3 });
    insertBlock(view, "```\ncode\n```");
    expect(view.state.doc.toString()).toBe("paragraph\n\n```\ncode\n```\n");
  });
});

describe("toggleLinePrefix", () => {
  it("prefixes the cursor line and toggles off on a second call", () => {
    const view = makeView("item", { anchor: 0 });
    toggleLinePrefix(view, "> ");
    expect(view.state.doc.toString()).toBe("> item");
    toggleLinePrefix(view, "> ");
    expect(view.state.doc.toString()).toBe("item");
  });

  it("covers every line the selection touches", () => {
    const view = makeView("a\nb\nc", { anchor: 0, head: 5 });
    toggleLinePrefix(view, "- ");
    expect(view.state.doc.toString()).toBe("- a\n- b\n- c");
  });
});

describe("setHeadingLevel", () => {
  it("promotes a plain line to h2 and back to 正文", () => {
    const view = makeView("title", { anchor: 0 });
    setHeadingLevel(view, 2);
    expect(view.state.doc.toString()).toBe("## title");
    setHeadingLevel(view, 0);
    expect(view.state.doc.toString()).toBe("title");
  });

  it("changes an existing heading level instead of stacking hashes", () => {
    const view = makeView("### deep", { anchor: 0 });
    setHeadingLevel(view, 1);
    expect(view.state.doc.toString()).toBe("# deep");
  });

  it("applies to all selected lines", () => {
    const view = makeView("one\ntwo", { anchor: 0, head: 7 });
    setHeadingLevel(view, 3);
    expect(view.state.doc.toString()).toBe("### one\n### two");
  });
});
