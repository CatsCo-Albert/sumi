/**
 * Pending-edit flow: agents propose → reviewer applies/rejects.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { promises as fs } from "fs";
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
