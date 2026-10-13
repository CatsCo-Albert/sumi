/**
 * Pending-edit flow: agents propose → reviewer applies/rejects.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { promises as fs } from "fs";
import * as Y from "yjs";
import { getDb, resetDbForTests } from "../src/db";
import {
  upsertSubject,
  createProject,
  grantMembership,
} from "../src/auth/identity";
import {
  addPendingEdit,
  listPendingEdits,
  getPendingEdit,
  updatePendingEditStatus,
  deletePendingEdit,
} from "../src/pending-edits";
import {
  createRelPosForEdit,
  getLineFromRelPos,
  type EditBlock,
} from "../src/server/edit-position-tracker";

const TEST_DIR = `/tmp/sumi-pending-test-${process.pid}`;
process.env.SUMI_DATA_DIR = TEST_DIR;

beforeEach(async () => {
  resetDbForTests();
  await fs.rm(TEST_DIR, { recursive: true, force: true });
});

describe("pending edits", () => {
  it("creates one row per block", async () => {
    const db = await getDb();
    upsertSubject(db, { subjectId: "u1", kind: "user", displayName: "Alice" });
    upsertSubject(db, { subjectId: "a9", kind: "agent", displayName: "ci" });
    const project = createProject(db, { name: "x", ownerSubjectId: "u1" });

    const edits = addPendingEdit(db, {
      projectId: project.id,
      fileId: "notes.md",
      userId: "u1",
      authorId: "a9",
      authorName: "ci",
      description: "fix typos",
      blocks: [
        { startLine: 1, endLine: 2, updated: "new 1-2" },
        { startLine: 5, endLine: 7, updated: "new 5-7" },
      ],
    });

    expect(edits).toHaveLength(2);
    expect(edits[0].blocks).toHaveLength(1);
    expect(edits[1].blocks).toHaveLength(1);
    expect(edits[0].status).toBe("pending");
  });

  it("lists only pending, scoped by user + file", async () => {
    const db = await getDb();
    upsertSubject(db, { subjectId: "u1", kind: "user", displayName: "A" });
    upsertSubject(db, { subjectId: "u2", kind: "user", displayName: "B" });
    upsertSubject(db, { subjectId: "a9", kind: "agent", displayName: "bot" });
    const project = createProject(db, { name: "x", ownerSubjectId: "u1" });
    grantMembership(db, {
      projectId: project.id,
      subjectId: "u2",
      role: "editor",
      grantedBy: "u1",
    });

    // Agent proposes to u1 and u2 on different files
    addPendingEdit(db, {
      projectId: project.id,
      fileId: "a.md",
      userId: "u1",
      authorId: "a9",
      blocks: [{ startLine: 1, endLine: 1, updated: "x" }],
    });
    addPendingEdit(db, {
      projectId: project.id,
      fileId: "b.md",
      userId: "u2",
      authorId: "a9",
      blocks: [{ startLine: 1, endLine: 1, updated: "y" }],
    });

    // u1 sees only their pending edit for a.md
    const forU1 = listPendingEdits(db, {
      projectId: project.id,
      userId: "u1",
      fileId: "a.md",
    });
    expect(forU1).toHaveLength(1);
    expect(forU1[0].fileId).toBe("a.md");
    expect(forU1[0].userId).toBe("u1");

    // u2 sees only theirs
    const forU2 = listPendingEdits(db, {
      projectId: project.id,
      userId: "u2",
    });
    expect(forU2).toHaveLength(1);
    expect(forU2[0].fileId).toBe("b.md");

    // Applier-side rejects the edit → no longer pending
    updatePendingEditStatus(db, forU1[0].id, "applied");
    expect(
      listPendingEdits(db, {
        projectId: project.id,
        userId: "u1",
        fileId: "a.md",
      })
    ).toHaveLength(0);
  });

  it("deletePendingEdit removes the row", async () => {
    const db = await getDb();
    upsertSubject(db, { subjectId: "u1", kind: "user", displayName: "A" });
    const project = createProject(db, { name: "x", ownerSubjectId: "u1" });
    const [edit] = addPendingEdit(db, {
      projectId: project.id,
      fileId: "x.md",
      userId: "u1",
      authorId: "a1",
      blocks: [{ startLine: 1, endLine: 1, updated: "x" }],
    });
    expect(getPendingEdit(db, edit.id)).not.toBeNull();
    expect(deletePendingEdit(db, edit.id)).toBe(true);
    expect(getPendingEdit(db, edit.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// RelPos anchors — CRDT-stable positions survive line drift
// ---------------------------------------------------------------------------

describe("pending edits — RelativePosition", () => {
  it("stores relPos anchors on proposed blocks", async () => {
    const db = await getDb();
    upsertSubject(db, { subjectId: "u1", kind: "user", displayName: "A" });
    const project = createProject(db, { name: "x", ownerSubjectId: "u1" });

    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("content");
    ytext.insert(0, "l1\nl2\nl3\nl4\nl5\n");
    const { startRelPos, endRelPos } = createRelPosForEdit(ytext, 2, 3);
    expect(startRelPos).toBeTruthy();
    expect(endRelPos).toBeTruthy();

    const [edit] = addPendingEdit(db, {
      projectId: project.id,
      fileId: "a.md",
      userId: "u1",
      authorId: "a1",
      blocks: [
        { startLine: 2, endLine: 3, updated: "X", startRelPos: startRelPos!, endRelPos: endRelPos! },
      ],
    });

    const stored = getPendingEdit(db, edit.id)!;
    expect(stored.blocks[0].startRelPos).toEqual(startRelPos);
    expect(stored.blocks[0].endRelPos).toEqual(endRelPos);

    const listed = listPendingEdits(db, { projectId: project.id, userId: "u1" });
    expect(listed[0].blocks[0].startRelPos).toEqual(startRelPos);

    ydoc.destroy();
  });

  it("relPos resolves to shifted lines after intervening edits", async () => {
    const db = await getDb();
    upsertSubject(db, { subjectId: "u1", kind: "user", displayName: "A" });
    const project = createProject(db, { name: "x", ownerSubjectId: "u1" });

    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("content");
    ytext.insert(0, "l1\nl2\nl3\nl4\nl5\n");

    // Propose an edit anchored at lines 2-3
    const { startRelPos, endRelPos } = createRelPosForEdit(ytext, 2, 3);
    const block: EditBlock = {
      startLine: 2,
      endLine: 3,
      updated: "NEW2\nNEW3",
      startRelPos: startRelPos!,
      endRelPos: endRelPos!,
    };
    const [edit] = addPendingEdit(db, {
      projectId: project.id,
      fileId: "a.md",
      userId: "u1",
      authorId: "a1",
      blocks: [block],
    });

    // Intervening edit: another client inserts 2 lines at the top
    ytext.insert(0, "a\nb\n");

    // Apply-time resolution: stored lines (2-3) are stale; relPos → 4-5
    const stored = getPendingEdit(db, edit.id)!;
    const b = stored.blocks[0];
    const s = getLineFromRelPos(ydoc, ytext, b.startRelPos);
    const e = getLineFromRelPos(ydoc, ytext, b.endRelPos);
    expect(s).toBe(4);
    expect(e).toBe(5);
    // Sanity: the resolved range still covers the original content
    const lines = ytext.toString().split("\n");
    expect(lines.slice(s! - 1, e!)).toEqual(["l2", "l3"]);

    ydoc.destroy();
  });

  it("falls back to stored lines when a block has no relPos", async () => {
    const db = await getDb();
    upsertSubject(db, { subjectId: "u1", kind: "user", displayName: "A" });
    const project = createProject(db, { name: "x", ownerSubjectId: "u1" });

    // Legacy row — no anchors (pre-migration data path)
    const [edit] = addPendingEdit(db, {
      projectId: project.id,
      fileId: "a.md",
      userId: "u1",
      authorId: "a1",
      blocks: [{ startLine: 3, endLine: 4, updated: "Z" }],
    });

    const stored = getPendingEdit(db, edit.id)!;
    expect(stored.blocks[0].startRelPos).toBeUndefined();

    // ws-server apply path mirrors this: no anchors → use stored lines
    const b = stored.blocks[0];
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("content");
    ytext.insert(0, "l1\nl2\nl3\nl4\nl5\n");
    const s = getLineFromRelPos(ydoc, ytext, b.startRelPos);
    expect(s).toBeNull(); // → caller uses b.startLine
    expect(b.startLine).toBe(3);
    expect(b.endLine).toBe(4);

    ydoc.destroy();
  });
});
