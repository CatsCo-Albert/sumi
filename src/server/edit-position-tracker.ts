/**
 * Edit Position Tracker — Yjs RelativePosition utilities.
 *
 * RelativePosition is a stable CRDT anchor: no matter how other clients edit,
 * it always resolves to the same logical position. We store it alongside
 * initial startLine/endLine so pending edits can be re-resolved cheaply.
 */

import * as Y from "yjs";

export type RelativePositionJSON = object;

export interface EditBlock {
  /** 1-based line number, captured when the edit was authored (display only). */
  startLine: number;
  endLine: number;
  /** New content that should replace the [startLine, endLine] range. */
  updated: string;
  /** Original content, for diff display. */
  original?: string;
  /** CRDT anchors used to re-resolve current positions. */
  startRelPos?: RelativePositionJSON;
  endRelPos?: RelativePositionJSON;
}

export interface PendingEdit {
  id: string;
  filePath: string;
  projectId: string;
  blocks: EditBlock[];
  description?: string;
  status: "pending" | "applying" | "applied" | "rejected";
  createdAt: number;
}

// ---------------------------------------------------------------------------
// RelPos helpers
// ---------------------------------------------------------------------------

/** Char offset of the start of `lineNumber` (1-based) in `content`. */
function lineToCharOffset(content: string, lineNumber: number): number {
  const lines = content.split("\n");
  let offset = 0;
  for (let i = 0; i < lineNumber - 1 && i < lines.length; i++) {
    offset += lines[i].length + 1;
  }
  return Math.min(offset, content.length);
}

/** Char offset of the end of `lineNumber` (1-based, inclusive). */
function lineToEndCharOffset(content: string, lineNumber: number): number {
  const lines = content.split("\n");
  let offset = 0;
  for (let i = 0; i < lineNumber && i < lines.length; i++) {
    offset += lines[i].length;
    if (i < lines.length - 1) offset += 1;
  }
  // Point at the last char of the line, not the following newline
  return Math.max(0, Math.min(offset - 1, content.length));
}

/** Create a RelPos pointing at the start of a 1-based line. */
export function createRelPosFromLine(
  ytext: Y.Text,
  lineNumber: number
): RelativePositionJSON | null {
  try {
    const offset = lineToCharOffset(ytext.toString(), lineNumber);
    return Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(ytext, offset)
    );
  } catch (err) {
    console.error("[RelPos] createRelPosFromLine failed:", err);
    return null;
  }
}

/** Resolve a RelPos back to a 1-based line number. */
export function getLineFromRelPos(
  ydoc: Y.Doc,
  ytext: Y.Text,
  relPosJSON: RelativePositionJSON | undefined
): number | null {
  if (!relPosJSON) return null;
  try {
    const relPos = Y.createRelativePositionFromJSON(relPosJSON);
    const absPos = Y.createAbsolutePositionFromRelativePosition(relPos, ydoc);
    if (!absPos) return null;
    return ytext
      .toString()
      .slice(0, absPos.index)
      .split("\n").length;
  } catch (err) {
    console.error("[RelPos] getLineFromRelPos failed:", err);
    return null;
  }
}

/** Create start+end RelPos anchors covering [startLine, endLine]. */
export function createRelPosForEdit(
  ytext: Y.Text,
  startLine: number,
  endLine: number
): {
  startRelPos: RelativePositionJSON | null;
  endRelPos: RelativePositionJSON | null;
} {
  try {
    const content = ytext.toString();
    const startOffset = lineToCharOffset(content, startLine);
    const endOffset = lineToEndCharOffset(content, endLine);
    return {
      startRelPos: Y.relativePositionToJSON(
        Y.createRelativePositionFromTypeIndex(ytext, startOffset)
      ),
      endRelPos: Y.relativePositionToJSON(
        Y.createRelativePositionFromTypeIndex(ytext, endOffset)
      ),
    };
  } catch (err) {
    console.error("[RelPos] createRelPosForEdit failed:", err);
    return { startRelPos: null, endRelPos: null };
  }
}

/** Attach RelPos anchors to each block of an edit. */
export function addRelPosToEdit(
  edit: PendingEdit,
  ytext: Y.Text
): PendingEdit {
  return {
    ...edit,
    blocks: edit.blocks.map((block) => {
      const { startRelPos, endRelPos } = createRelPosForEdit(
        ytext,
        block.startLine,
        block.endLine
      );
      return {
        ...block,
        startRelPos: startRelPos ?? undefined,
        endRelPos: endRelPos ?? undefined,
      };
    }),
  };
}
