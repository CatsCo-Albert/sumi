/**
 * Markdown/HTML editor bound to a Yjs document.
 *
 * CodeMirror is framework-agnostic and owns its own DOM, so the Solid side only
 * creates it once and disposes it; every reactive value the editor needs (the
 * room, the seed content, the read-only flag) is read through accessors rather
 * than passed as a value, so a change does not need a rebuild.
 */

import { createEffect, onCleanup } from "solid-js";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  highlightSpecialChars,
  drawSelection,
  highlightActiveLine,
  dropCursor,
  lineNumbers,
  highlightActiveLineGutter,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  indentOnInput,
  bracketMatching,
  syntaxHighlighting,
  defaultHighlightStyle,
  HighlightStyle,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import {
  autocompletion,
  completionKeymap,
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { lintKeymap } from "@codemirror/lint";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import * as Y from "yjs";
import { yCollab } from "y-codemirror.next";
import { WebsocketProvider } from "y-websocket";

export interface CollabOptions {
  /** Yjs room — `${projectId}-${fileId}` on the server. */
  room: string;
  /** WebSocket origin, e.g. `ws://127.0.0.1:1234`. */
  wsUrl: string;
  /** Bearer token for the WS handshake; agents use `api_key` instead. */
  token: string | null;
  /** Seed used only when the room is genuinely empty. */
  initialContent: string;
  mode: "markdown" | "html";
  readOnly: boolean;
  user: { id: string; name: string; color: string; image?: string };
  onSynced?: () => void;
  onPresence?: (count: number) => void;
  onText?: (text: string) => void;
  /** Hands the live view out so the outline can jump and read the cursor. */
  onReady?: (view: EditorView) => void;
}

export interface EditorHandle {
  view: EditorView;
  ydoc: Y.Doc;
  provider: WebsocketProvider;
  destroy: () => void;
}

/**
 * Prose styling for the document itself.
 *
 * A writing surface reads as words, not as a source file: headings get real
 * type steps, links take the accent, and only inline code and code blocks go
 * monospace — which is what `tags.monospace` marks. Rendering the whole editor
 * in a mono face was the single strongest reason it looked like a code editor.
 */
const proseHighlight = HighlightStyle.define([
  { tag: tags.monospace, fontFamily: "var(--ui-font-mono)", fontSize: "0.9em" },
  { tag: tags.strong, fontWeight: "650" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  {
    tag: [tags.link, tags.url],
    color: "var(--accent)",
    textDecoration: "underline",
    textUnderlineOffset: "0.18em",
  },
  { tag: tags.heading, fontWeight: "650", letterSpacing: "-0.025em" },
  { tag: tags.heading1, fontSize: "1.55em", lineHeight: "1.25" },
  { tag: tags.heading2, fontSize: "1.28em", lineHeight: "1.35" },
  { tag: tags.heading3, fontSize: "1.1em", lineHeight: "1.45" },
  { tag: tags.heading4, fontSize: "1em" },
  { tag: tags.quote, color: "var(--text-muted)", fontStyle: "italic" },
  /* The markdown punctuation (#, **, |) is scaffolding, not content. */
  { tag: tags.processingInstruction, color: "var(--text-muted)", opacity: "0.5" },
  { tag: tags.contentSeparator, color: "var(--line-strong)" },
]);

function extensionsFor(mode: "markdown" | "html", readOnly: boolean) {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    syntaxHighlighting(proseHighlight),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...completionKeymap,
      ...lintKeymap,
      indentWithTab,
    ]),
    mode === "html" ? html() : markdown(),
    EditorView.lineWrapping,
    EditorState.readOnly.of(readOnly),
  ];
}

/** Create an editor in `host`, synced through a Yjs WebSocket room. */
export function mountEditor(host: HTMLElement, options: CollabOptions): EditorHandle {
  const ydoc = new Y.Doc();
  // "content" is the room's contract, not a choice: the ws-server seeds it from
  // the blob, `/doc`, `/replace` and pending-edit application all read and write
  // this key. A different key would compile and sync fine while quietly keeping
  // the edit in a second text the server never looks at.
  const ytext = ydoc.getText("content");

  const params: Record<string, string> = {};
  if (options.token) params.token = options.token;

  const provider = new WebsocketProvider(options.wsUrl, options.room, ydoc, { params });
  provider.awareness.setLocalStateField("user", {
    name: options.user.name,
    color: options.user.color,
    colorLight: `${options.user.color}33`,
    id: options.user.id,
    image: options.user.image,
  });

  let seeded = false;
  const onSync = (synced: boolean) => {
    if (!synced || seeded) return;
    seeded = true;
    // Server-side seeding makes this normally a no-op; it only covers a room
    // that is genuinely empty, where a concurrent insert cannot collide.
    if (ytext.length === 0 && options.initialContent) {
      ytext.insert(0, options.initialContent);
    }
    options.onSynced?.();
  };
  provider.on("sync", onSync);

  const readPresence = () => options.onPresence?.(provider.awareness.getStates().size);
  provider.awareness.on("change", readPresence);

  // The outline and the word count read from here; without it they would need a
  // second copy of the document that could drift from the one being edited.
  const readText = () => options.onText?.(ytext.toString());
  ytext.observe(readText);

  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      // Always empty: yCollab fills it from `ytext` on the first sync. Seeding
      // the editor *and* letting the server's content arrive would insert both,
      // and Yjs keeps concurrent inserts at the same position rather than
      // choosing between them — which is how a document doubles on open.
      doc: "",
      extensions: [...extensionsFor(options.mode, options.readOnly), yCollab(ytext, provider.awareness)],
    }),
  });

  return {
    view,
    ydoc,
    provider,
    destroy() {
      provider.awareness.off("change", readPresence);
      provider.off("sync", onSync);
      provider.destroy();
      view.destroy();
      ydoc.destroy();
    },
  };
}

export interface EditorProps {
  room: string;
  wsUrl: string;
  token: string | null;
  initialContent: string;
  mode?: "markdown" | "html";
  readOnly?: boolean;
  user: { id: string; name: string; color: string; image?: string };
  onSynced?: () => void;
  onPresence?: (count: number) => void;
  onText?: (text: string) => void;
  /** Hands the live view out so the outline can jump and read the cursor. */
  onReady?: (view: EditorView | null) => void;
}

/**
 * Rebuilds the editor whenever the room changes.
 *
 * Deliberately keyed on the room string: a different document needs a different
 * Y.Doc, and reusing one across rooms is exactly the duplication bug that made
 * documents double on every visit.
 */
export function Editor(props: EditorProps) {
  let host!: HTMLDivElement;
  let handle: EditorHandle | null = null;

  const teardown = () => {
    if (handle) props.onReady?.(null);
    handle?.destroy();
    handle = null;
  };

  createEffect(
    () => [props.room, props.mode ?? "markdown", props.readOnly ?? false] as const,
    ([room, mode, readOnly]) => {
      teardown();
      if (!room) return;
      handle = mountEditor(host, {
        room,
        wsUrl: props.wsUrl,
        token: props.token,
        initialContent: props.initialContent,
        mode,
        readOnly,
        user: props.user,
        onSynced: () => props.onSynced?.(),
        onPresence: (count) => props.onPresence?.(count),
        onText: (text) => props.onText?.(text),
      });
      if (handle) props.onReady?.(handle.view);
    }
  );

  onCleanup(teardown);

  return <div class="editor-host" ref={host} />;
}
