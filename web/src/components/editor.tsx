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
} from "@codemirror/language";
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
}

export interface EditorHandle {
  view: EditorView;
  ydoc: Y.Doc;
  provider: WebsocketProvider;
  destroy: () => void;
}

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
      doc: ytext.length === 0 ? options.initialContent : "",
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
    }
  );

  onCleanup(teardown);

  return <div class="editor-host" ref={host} />;
}
