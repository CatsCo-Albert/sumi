"use client";

/**
 * Collaborative markdown/html editor.
 *
 * Minimal surface:
 *   - yCollab + WebsocketProvider for CRDT sync
 *   - awareness for remote carets + "vibeWriting" AI lock signal
 *   - prefillOnConnect — seed local Yjs before joining the room
 *   - onCollaboratorsChange — surface remote presence
 *   - restoreToken — force-reset the doc to initialContent when bumped
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { EditorState, Compartment } from "@codemirror/state";
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
import { lintKeymap } from "@codemirror/lint";
import * as Y from "yjs";
import { yCollab } from "y-codemirror.next";
import { WebsocketProvider } from "y-websocket";

import {
  getUserColorById,
  generateUserColor,
  generateUserName,
  resolveWsUrl,
} from "@/lib/utils";
import { createMarkdownExtensions, createHtmlExtensions } from "./markdown-extensions";
import { getInlineDiffExtensions, setCurrentFile, setYjsRefs as setDiffYjsRefs } from "./inline-diff-extension";
import {
  getLockExtensions,
  setOwnLocks,
  setRemoteLocks,
  setLockFile,
  setLockUser,
  setLockYjsRefs,
  type RemoteLockInfo,
} from "./pending-edit-lock-extension";
import { useEditStore } from "@/stores/edit-store";

export type EditorMode = "markdown" | "html";

export interface CollaboratorInfo {
  name: string;
  color: string;
  id?: string;
  image?: string;
}

export interface CollaborativeEditorProps {
  projectId: string;
  fileId: string;
  fileName?: string;
  initialContent?: string;
  /** When bumped, force-reset the Yjs doc to `initialContent` (version restore). */
  restoreToken?: number;
  onContentChange?: (content: string) => void;
  onCollaboratorsChange?: (collaborators: CollaboratorInfo[]) => void;
  /** e.g. "ws://localhost:1234" — room name is derived internally. */
  wsUrl?: string;
  mode?: EditorMode;
  /** Prefill local Yjs with initialContent before sync — avoids a flash of empty. */
  prefillOnConnect?: boolean;
  userId?: string;
  userName?: string;
  userImage?: string;
  onEditorReady?: (view: EditorView | null) => void;
  onCursorLineChange?: (line: number) => void;
  onConnectionStatusChange?: (status: {
    isConnected: boolean;
    isSynced: boolean;
  }) => void;
}

export default function CollaborativeEditor({
  projectId,
  fileId,
  fileName,
  initialContent,
  restoreToken,
  onContentChange,
  onCollaboratorsChange,
  wsUrl,
  mode = "markdown",
  prefillOnConnect = false,
  userId,
  userName,
  userImage,
  onEditorReady,
  onCursorLineChange,
  onConnectionStatusChange,
}: CollaborativeEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const providerRef = useRef<WebsocketProvider | null>(null);
  const ydocRef = useRef<Y.Doc | null>(null);

  const [, setCollaborators] = useState<CollaboratorInfo[]>([]);
  const [, setIsSynced] = useState(false);

  // Keep latest callbacks in refs so the CM effect doesn't re-run
  const onContentChangeRef = useRef(onContentChange);
  const onCollaboratorsChangeRef = useRef(onCollaboratorsChange);
  const onCursorLineChangeRef = useRef(onCursorLineChange);
  const onConnectionStatusChangeRef = useRef(onConnectionStatusChange);
  const onEditorReadyRef = useRef(onEditorReady);
  const initialContentRef = useRef(initialContent);

  useEffect(() => {
    onContentChangeRef.current = onContentChange;
    onCollaboratorsChangeRef.current = onCollaboratorsChange;
    onCursorLineChangeRef.current = onCursorLineChange;
    onConnectionStatusChangeRef.current = onConnectionStatusChange;
    onEditorReadyRef.current = onEditorReady;
    initialContentRef.current = initialContent;
  });

  const effectiveWsUrl = wsUrl || resolveWsUrl();

  // --- Restore token: wipe and re-seed --------------------------------------
  useEffect(() => {
    if (restoreToken === undefined || restoreToken === 0) return;
    const ydoc = ydocRef.current;
    if (!ydoc) return;
    const ytext = ydoc.getText("content");
    ydoc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, initialContentRef.current || "");
    });
  }, [restoreToken]);

  // --- Main editor effect -----------------------------------------------------
  useEffect(() => {
    if (!containerRef.current) return;

    setIsSynced(false);

    const ydoc = new Y.Doc();
    ydocRef.current = ydoc;
    const ytext = ydoc.getText("content");

    // Optional prefill so the editor doesn't flash blank before WS sync arrives.
    if (prefillOnConnect && ytext.length === 0 && initialContentRef.current) {
      ydoc.transact(() => {
        if (ytext.length === 0) {
          ytext.insert(0, initialContentRef.current!);
        }
      });
    }

    const roomName = `${projectId}-${fileId}`;
    // Browser session token is stored in sessionStorage by the sign-in screen;
    // agents pass ?api_key=<cc_…> directly on the WS URL.
    const token =
      typeof window !== "undefined"
        ? sessionStorage.getItem("sumi.token")
        : null;
    const provider = new WebsocketProvider(effectiveWsUrl, roomName, ydoc, {
      params: token ? { token } : {},
    });
    providerRef.current = provider;

    const userColor = userId ? getUserColorById(userId) : generateUserColor();
    const displayName = userName || generateUserName();
    provider.awareness.setLocalStateField("user", {
      name: displayName,
      color: userColor,
      colorLight: userColor + "33",
      id: userId,
      image: userImage,
    });

    let contentInitialized = false;
    const handleSync = (synced: boolean) => {
      if (synced && !contentInitialized) {
        contentInitialized = true;
        const initialValue = initialContentRef.current;
        if (ytext.length === 0 && initialValue) {
          ytext.insert(0, initialValue);
        }
        setIsSynced(true);
        onConnectionStatusChangeRef.current?.({
          isConnected: true,
          isSynced: true,
        });
      }
    };
    provider.on("sync", handleSync);
    if (provider.synced) handleSync(true);

    provider.on("status", ({ status }: { status: string }) => {
      onConnectionStatusChangeRef.current?.({
        isConnected: status === "connected",
        isSynced: provider.synced,
      });
    });

    const updateCollaborators = () => {
      const states = provider.awareness.getStates();
      const users: CollaboratorInfo[] = [];
      states.forEach((state) => {
        if (state.user) {
          users.push({
            name: state.user.name,
            color: state.user.color,
            id: state.user.id,
            image: state.user.image,
          });
        }
      });
      setCollaborators(users);
      onCollaboratorsChangeRef.current?.(users);
    };
    provider.awareness.on("change", updateCollaborators);
    updateCollaborators();

    // --- CodeMirror ------------------------------------------------------------
    const languageCompartment = new Compartment();
    const languageExtensions =
      mode === "html" ? createHtmlExtensions() : createMarkdownExtensions();

    const state = EditorState.create({
      doc: ytext.toString(),
      extensions: [
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

        // Trigger completion on markdown-ish triggers
        EditorView.updateListener.of(() => {}),

        rectangularSelectionPlaceholder(),
        crosshairPlaceholder(),

        highlightActiveLine(),
        EditorView.lineWrapping,

        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...completionKeymap,
          ...lintKeymap,
          indentWithTab,
        ]),

        // Apple-grade markdown formatting shortcuts
        keymap.of([
          { key: "Mod-b", run: wrap("**"), preventDefault: true },
          { key: "Mod-i", run: wrap("*"), preventDefault: true },
          { key: "Mod-u", run: wrap("<u>", "</u>"), preventDefault: true },
          { key: "Mod-Shift-x", run: wrap("~~"), preventDefault: true },
          { key: "Mod-e", run: wrap("`"), preventDefault: true },
        ]),

        languageCompartment.of(languageExtensions),

        // Yjs collab — the core
        yCollab(ytext, provider.awareness),

        // Agent pending-edit decorations
        ...getInlineDiffExtensions(),
        ...getLockExtensions(),

        EditorView.updateListener.of((update) => {
          if (update.docChanged && onContentChangeRef.current) {
            onContentChangeRef.current(update.state.doc.toString());
          }
          if (update.selectionSet && onCursorLineChangeRef.current) {
            const pos = update.state.selection.main.head;
            onCursorLineChangeRef.current(
              update.state.doc.lineAt(pos).number
            );
          }
        }),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    onEditorReadyRef.current?.(view);

    // ---- Locks + pending edits wiring -----------------------------------
    const locksMap = ydoc.getMap<RemoteLockInfo>("pendingLocks");
    const effectiveUserId = userId || `anonymous_${Math.random().toString(36).slice(2, 8)}`;

    setLockUser(view, effectiveUserId);
    setLockFile(view, fileId);
    setLockYjsRefs(view, ydoc, ytext);

    setCurrentFile(view, fileId);
    setDiffYjsRefs(view, ydoc, ytext);

    useEditStore.getState().setCurrentUserInfo(
      effectiveUserId,
      displayName,
      userColor
    );
    useEditStore.getState().setYjsRefs(ydoc, ytext, fileId);

    const pushOwnLocks = () => {
      const locks = useEditStore.getState().getEditLocks(fileId, effectiveUserId);
      setOwnLocks(view, locks);
    };
    const unsubscribeEdits = useEditStore.subscribe(pushOwnLocks);
    pushOwnLocks();

    // Sync own locks into Y.Map so remote clients can decorate them
    useEditStore.getState().setSyncLocksCallback((locks) => {
      const keysToDelete: string[] = [];
      locksMap.forEach((lock, key) => {
        if (lock.userId === effectiveUserId) keysToDelete.push(key);
      });
      ydoc.transact(() => {
        keysToDelete.forEach((k) => locksMap.delete(k));
        locks.forEach((l) => locksMap.set(l.id, l));
      });
    });

    const handleLocksChange = () => {
      const remote: RemoteLockInfo[] = [];
      locksMap.forEach((lock) => {
        if (lock.userId === effectiveUserId) return;
        const a = lock.fileId || "";
        const b = fileId;
        if (a === b || a.endsWith(b) || b.endsWith(a)) remote.push(lock);
      });
      setRemoteLocks(view, remote);
    };
    locksMap.observe(handleLocksChange);
    handleLocksChange();

    return () => {
      onEditorReadyRef.current?.(null);
      unsubscribeEdits();
      locksMap.unobserve(handleLocksChange);
      useEditStore.getState().setSyncLocksCallback(null);
      view.destroy();
      provider.awareness.off("change", updateCollaborators);
      provider.destroy();
      ydoc.destroy();
      viewRef.current = null;
      providerRef.current = null;
      ydocRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, fileId, effectiveWsUrl, mode, prefillOnConnect]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-auto"
      data-testid="collaborative-editor"
    />
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wrap the current selection (or insert empty pair) with prefix/suffix. */
function wrap(pair: string, closingOverride?: string) {
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

// Small placeholders to keep imports tidy (CM requires these as extensions).
function rectangularSelectionPlaceholder() {
  return EditorView.editable.of(true);
}
function crosshairPlaceholder() {
  return [];
}
