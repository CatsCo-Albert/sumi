/**
 * Pending-edit flow: agents propose → reviewer applies/rejects.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { promises as fs } from "fs";
import * as Y from "yjs";
import * as jose from "jose";
import { getDb, resetDbForTests } from "../src/db";
import {
  upsertSubject,
  createProject,
  grantMembership,
} from "../src/auth/identity";
import { subscribeUiEvents, resetUiEventBusForTests, type UiEvent } from "../src/ui-bus/event-bus";
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
process.env.OC_JWT_SECRET = "test-secret-pending";

// catsco.ts captures OC_JWT_SECRET at module-eval time — import the route
// lazily so the secret above is visible.
const { POST: bulkReject } = await import(
  "../app/api/pending-edits/bulk-reject/route"
);

let testCounter = 0;

beforeEach(async () => {
  // 独立目录避免与 fire-and-forget 的 ui-events 持久化写竞争（ENOTEMPTY）
  resetDbForTests();
  resetUiEventBusForTests();
  process.env.SUMI_DATA_DIR = `${TEST_DIR}-${testCounter++}`;
  await fs.rm(process.env.SUMI_DATA_DIR, { recursive: true, force: true });
});

/** Mint a CatsCo-shaped user JWT for the given numeric uid. */
async function userJwt(uid: number, username = `user${uid}`): Promise<string> {
  return new jose.SignJWT({
    userId: uid,
    username,
    token_type: "user",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("catscompany")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(process.env.OC_JWT_SECRET));
}

function bulkReq(ids: string[], token: string): Request {
  return new Request("http://localhost/api/pending-edits/bulk-reject", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ ids }),
  });
}

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
// POST /api/pending-edits/bulk-reject — one transaction, per-project auth
// ---------------------------------------------------------------------------

describe("POST /api/pending-edits/bulk-reject", () => {
  async function seed() {
    const db = await getDb();
    upsertSubject(db, { subjectId: "u1", kind: "user", displayName: "Alice" });
    upsertSubject(db, { subjectId: "u2", kind: "user", displayName: "Bob" });
    upsertSubject(db, { subjectId: "a9", kind: "agent", displayName: "ci" });
    const project = createProject(db, { name: "x", ownerSubjectId: "u1" });
    grantMembership(db, {
      projectId: project.id,
      subjectId: "u2",
      role: "editor",
      grantedBy: "u1",
    });
    return { db, project };
  }

  it("rejects multiple edits in one call and returns the real count", async () => {
    const { db, project } = await seed();
    const e1 = addPendingEdit(db, {
      projectId: project.id, fileId: "a.md", userId: "u1", authorId: "a9",
      blocks: [{ startLine: 1, endLine: 1, updated: "x" }],
    });
    const e2 = addPendingEdit(db, {
      projectId: project.id, fileId: "b.md", userId: "u1", authorId: "a9",
      blocks: [{ startLine: 1, endLine: 1, updated: "y" }],
    });
    // Pre-rejected row — must be skipped by the count.
    updatePendingEditStatus(db, e2[0].id, "rejected");

    const res = await bulkReject(
      bulkReq([e1[0].id, e2[0].id, "edit_missing"], await userJwt(1))
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rejected: 1 });
    expect(getPendingEdit(db, e1[0].id)!.status).toBe("rejected");
  });

  it("rejects when the actor is neither reviewer nor owner", async () => {
    const { db, project } = await seed();
    const [edit] = addPendingEdit(db, {
      projectId: project.id, fileId: "a.md", userId: "u1", authorId: "a9",
      blocks: [{ startLine: 1, endLine: 1, updated: "x" }],
    });

    // u2 is an editor but not the reviewer (u1) or the owner → 403.
    const res = await bulkReject(bulkReq([edit.id], await userJwt(2)));
    expect(res.status).toBe(403);
    expect(getPendingEdit(db, edit.id)!.status).toBe("pending");

    // Owner CAN reject someone else's review queue.
    const ok = await bulkReject(bulkReq([edit.id], await userJwt(1)));
    expect(ok.status).toBe(200);
    expect(getPendingEdit(db, edit.id)!.status).toBe("rejected");
  });

  it("broadcasts pending_edit_changed (edit:null) to every member", async () => {
    const { db, project } = await seed();
    const [edit] = addPendingEdit(db, {
      projectId: project.id, fileId: "a.md", userId: "u2", authorId: "a9",
      blocks: [{ startLine: 1, endLine: 1, updated: "x" }],
    });

    const events: UiEvent[] = [];
    const unsubs = ["u1", "u2"].map((u) =>
      subscribeUiEvents(u, (e) => events.push(e))
    );

    // u2 is the reviewer — they can reject their own queue.
    const res = await bulkReject(bulkReq([edit.id], await userJwt(2)));
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(events).toHaveLength(2));

    for (const u of ["u1", "u2"]) {
      const ev = events.find((e) => e.userId === u)!;
      expect(ev.projectId).toBe(project.id);
      expect(ev.patch).toMatchObject({
        type: "pending_edit_changed",
        fileId: "a.md",
        edit: null,
      });
    }
    unsubs.forEach((u) => u());
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
