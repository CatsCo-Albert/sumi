"use client";

/**
 * Pending-edit lock decorations.
 *
 * Two lock flavors:
 *   - own locks    — pending edits *this user* proposed (blue tint, no badge)
 *   - remote locks — other actors' pending edits (grey tint, 🔒 name badge,
 *                    change-filtered: typing inside is blocked)
 *
 * RelPos is the only source of truth — if an anchor can't resolve, the lock
 * is skipped (position was deleted).
 */

import {
  EditorView,
  Decoration,
  DecorationSet,
  WidgetType,
} from "@codemirror/view";
import {
  StateField,
  StateEffect,
  RangeSetBuilder,
  Text,
  EditorState,
  Transaction,
} from "@codemirror/state";
import * as Y from "yjs";
import type { RelativePositionJSON } from "@/src/server/edit-position-tracker";
import type { EditLock } from "@/stores/edit-store";

export interface RemoteLockInfo extends EditLock {
  /** userId of the remote actor who owns this lock */
  userId: string;
}

export const setOwnLocksEffect = StateEffect.define<EditLock[]>();
export const setRemoteLocksEffect = StateEffect.define<RemoteLockInfo[]>();
export const setLockFileEffect = StateEffect.define<string>();
export const setCurrentUserIdEffect = StateEffect.define<string>();
export const setLockYjsRefsEffect = StateEffect.define<{
  ydoc: Y.Doc | null;
  ytext: Y.Text | null;
}>();

function getLineFromRelPos(
  ydoc: Y.Doc | null,
  ytext: Y.Text | null,
  relPosJSON: RelativePositionJSON | undefined
): number | null {
  if (!ydoc || !ytext || !relPosJSON) return null;
  try {
    const relPos = Y.createRelativePositionFromJSON(relPosJSON);
    const abs = Y.createAbsolutePositionFromRelativePosition(relPos, ydoc);
    if (!abs) return null;
    return ytext.toString().slice(0, abs.index).split("\n").length;
  } catch {
    return null;
  }
}

function filePathMatches(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const an = a.split("/").pop() || a;
  const bn = b.split("/").pop() || b;
  return an === bn || a.endsWith(bn) || b.endsWith(an);
}

function lineToOffset(doc: Text, line: number): number {
  if (line < 1) return 0;
  if (line > doc.lines) return doc.length;
  return doc.line(line).from;
}

class LockOwnerWidget extends WidgetType {
  constructor(readonly userName: string, readonly userColor: string) {
    super();
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-lock-badge";
    el.style.setProperty("--user-color", this.userColor);
    el.textContent = this.userName;
    el.title = `正在编辑：${this.userName}`;
    return el;
  }
  eq(o: LockOwnerWidget) {
    return o.userName === this.userName && o.userColor === this.userColor;
  }
  ignoreEvent() {
    return true;
  }
}

interface LockState {
  ownLocks: EditLock[];
  remoteLocks: RemoteLockInfo[];
  filePath: string;
  currentUserId: string;
  ydoc: Y.Doc | null;
  ytext: Y.Text | null;
  decorations: DecorationSet;
  lockedRanges: Array<{ from: number; to: number }>;
}

interface DecoEntry {
  from: number;
  to: number;
  decoration: Decoration;
}

function build(
  doc: Text,
  ownLocks: EditLock[],
  remoteLocks: RemoteLockInfo[],
  filePath: string,
  currentUserId: string,
  ydoc: Y.Doc | null,
  ytext: Y.Text | null
): { decorations: DecorationSet; lockedRanges: Array<{ from: number; to: number }> } {
  const entries: DecoEntry[] = [];
  const lockedRanges: Array<{ from: number; to: number }> = [];

  const resolve = (lock: EditLock) => {
    if (!lock.startRelPos || !lock.endRelPos || !ydoc || !ytext) return null;
    const s = getLineFromRelPos(ydoc, ytext, lock.startRelPos);
    const e = getLineFromRelPos(ydoc, ytext, lock.endRelPos);
    if (s === null || e === null) return null;
    return { s, e };
  };

  // Own pending locks — subtle blue, not blocking (we own them)
  for (const lock of ownLocks) {
    const r = resolve(lock);
    if (!r) continue;
    if (!filePathMatches(lock.fileId, filePath)) continue;
    const s = Math.min(r.s, doc.lines);
    const e = Math.min(r.e, doc.lines);
    for (let ln = s; ln <= e; ln++) {
      const pos = doc.line(ln).from;
      entries.push({
        from: pos,
        to: pos,
        decoration: Decoration.line({ class: "cm-own-lock-line" }),
      });
    }
  }

  // Remote locks — grey + owner badge + blocked for editing
  for (const lock of remoteLocks) {
    if (lock.userId === currentUserId) continue;
    if (!filePathMatches(lock.fileId, filePath)) continue;
    const r = resolve(lock);
    if (!r) continue;
    const s = Math.min(r.s, doc.lines);
    const e = Math.min(r.e, doc.lines);

    const from = lineToOffset(doc, s);
    const to = e < doc.lines ? lineToOffset(doc, e + 1) : doc.length;
    lockedRanges.push({ from, to });

    for (let ln = s; ln <= e; ln++) {
      const pos = doc.line(ln).from;
      entries.push({
        from: pos,
        to: pos,
        decoration: Decoration.line({ class: "cm-remote-lock-line" }),
      });
    }
    entries.push({
      from,
      to: from,
      decoration: Decoration.widget({
        widget: new LockOwnerWidget(lock.userName, lock.userColor),
        side: -1,
      }),
    });
  }

  entries.sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const e of entries) builder.add(e.from, e.to, e.decoration);
  return { decorations: builder.finish(), lockedRanges };
}

export const lockStateField = StateField.define<LockState>({
  create: () => ({
    ownLocks: [],
    remoteLocks: [],
    filePath: "",
    currentUserId: "",
    ydoc: null,
    ytext: null,
    decorations: Decoration.none,
    lockedRanges: [],
  }),
  update(state, tr) {
    let { ownLocks, remoteLocks, filePath, currentUserId, ydoc, ytext, decorations, lockedRanges } = state;
    let rebuild = false;
    for (const effect of tr.effects) {
      if (effect.is(setOwnLocksEffect)) {
        ownLocks = effect.value;
        rebuild = true;
      }
      if (effect.is(setRemoteLocksEffect)) {
        remoteLocks = effect.value;
        rebuild = true;
      }
      if (effect.is(setLockFileEffect)) {
        filePath = effect.value;
        rebuild = true;
      }
      if (effect.is(setCurrentUserIdEffect)) {
        currentUserId = effect.value;
        rebuild = true;
      }
      if (effect.is(setLockYjsRefsEffect)) {
        ydoc = effect.value.ydoc;
        ytext = effect.value.ytext;
        rebuild = true;
      }
    }
    if (rebuild || tr.docChanged) {
      const r = build(tr.state.doc, ownLocks, remoteLocks, filePath, currentUserId, ydoc, ytext);
      decorations = r.decorations;
      lockedRanges = r.lockedRanges;
    }
    return { ownLocks, remoteLocks, filePath, currentUserId, ydoc, ytext, decorations, lockedRanges };
  },
  provide: (f) => EditorView.decorations.from(f, (s) => s.decorations),
});

/** Reject user transactions that overlap locked regions (remote locks only). */
export const lockChangeFilter = EditorState.changeFilter.of((tr: Transaction) => {
  if (!tr.docChanged) return true;
  if (!tr.annotation(Transaction.userEvent)) return true; // yCollab bypasses

  const state = tr.startState.field(lockStateField);
  const locked = state.lockedRanges;
  if (locked.length === 0) return true;

  let blocked = false;
  tr.changes.iterChanges((fromA, toA) => {
    for (const l of locked) {
      if (!(toA < l.from || fromA >= l.to)) {
        blocked = true;
        return;
      }
    }
  });
  return !blocked;
});

export const lockTheme = EditorView.theme({
  ".cm-own-lock-line": {
    backgroundColor: "rgba(10, 132, 255, 0.05)",
    borderLeft: "2px solid rgba(10, 132, 255, 0.3)",
  },
  ".cm-remote-lock-line": {
    backgroundColor: "rgba(120, 120, 128, 0.08)",
    borderLeft: "2px solid rgba(120, 120, 128, 0.4)",
    cursor: "not-allowed",
  },
  ".cm-lock-badge": {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    padding: "1px 6px",
    marginRight: "4px",
    borderRadius: "3px",
    fontSize: "10px",
    fontWeight: "500",
    fontFamily: "-apple-system, sans-serif",
    backgroundColor: "var(--user-color, rgba(120,120,128,0.8))",
    color: "white",
    verticalAlign: "middle",
    letterSpacing: "-0.005em",
  },
});

export function getLockExtensions() {
  return [lockStateField, lockChangeFilter, lockTheme];
}

// Convenience dispatchers ------------------------------------------------

export function setOwnLocks(view: EditorView, locks: EditLock[]) {
  view.dispatch({ effects: setOwnLocksEffect.of(locks) });
}
export function setRemoteLocks(view: EditorView, locks: RemoteLockInfo[]) {
  view.dispatch({ effects: setRemoteLocksEffect.of(locks) });
}
export function setLockFile(view: EditorView, filePath: string) {
  view.dispatch({ effects: setLockFileEffect.of(filePath) });
}
export function setLockUser(view: EditorView, userId: string) {
  view.dispatch({ effects: setCurrentUserIdEffect.of(userId) });
}
export function setLockYjsRefs(view: EditorView, ydoc: Y.Doc | null, ytext: Y.Text | null) {
  view.dispatch({ effects: setLockYjsRefsEffect.of({ ydoc, ytext }) });
}
