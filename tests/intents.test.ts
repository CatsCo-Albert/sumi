import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  addIntent,
  listIntents,
  getIntent,
  updateIntentStatus,
  deleteIntent,
} from "@/src/intents";

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, owner_uid TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE intents (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      -- Nullable since v9: a question can be about the project, not a document.
      file_id TEXT,
      selection_start INTEGER,
      selection_end INTEGER,
      selection_text TEXT,
      prompt TEXT NOT NULL,
      author_id TEXT NOT NULL,
      author_name TEXT,
      target_agent_id TEXT,
      thread_id TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      answer_text TEXT,
      answer_edit_id TEXT,
      answered_by TEXT,
      created_at INTEGER NOT NULL,
      claimed_at INTEGER,
      answered_at INTEGER
    );
  `);
  db.prepare("INSERT INTO projects (id, name, owner_uid, created_at, updated_at) VALUES ('prj_x','Demo','u_owner',0,0)").run();
  return db;
}

describe("intents", () => {
  let db: DatabaseSync;
  beforeEach(() => { db = freshDb(); });

  it("creates an open intent with generated threadId", () => {
    const i = addIntent(db, {
      projectId: "prj_x",
      fileId: "notes/intro.md",
      prompt: "make this formal",
      authorId: "u_alice",
    });
    expect(i.id).toMatch(/^int_/);
    expect(i.threadId).toMatch(/^thr_/);
    expect(i.status).toBe("open");
    expect(i.targetAgentId).toBeNull();
  });

  it("chains follow-ups via threadId", () => {
    const a = addIntent(db, {
      projectId: "prj_x", fileId: "f", prompt: "p1", authorId: "u_x",
    });
    const b = addIntent(db, {
      projectId: "prj_x", fileId: "f", prompt: "p2", authorId: "u_x",
      threadId: a.threadId,
    });
    expect(b.threadId).toBe(a.threadId);
    const inThread = listIntents(db, { threadId: a.threadId });
    expect(inThread).toHaveLength(2);
  });

  it("accepts an ask with no document", () => {
    // What the project list asks: there is no file to anchor it to, and inventing
    // an empty string would read downstream as a real filename.
    const i = addIntent(db, {
      projectId: "prj_x",
      prompt: "这个项目接下来该做什么",
      authorId: "u_alice",
    });
    expect(i.fileId).toBeNull();

    const back = getIntent(db, i.id)!;
    expect(back.fileId).toBeNull();
  });

  it("keeps document-scoped and project-scoped asks distinguishable", () => {
    const doc = addIntent(db, {
      projectId: "prj_x", fileId: "notes.md", prompt: "改标题", authorId: "u_a",
    });
    const project = addIntent(db, {
      projectId: "prj_x", prompt: "项目问题", authorId: "u_a",
    });

    // Filtering by a file must not pick up the project-scope row, or every doc's
    // ask list would silently include questions asked about the whole project.
    expect(listIntents(db, { projectId: "prj_x", fileId: "notes.md" }).map((r) => r.id))
      .toEqual([doc.id]);
    expect(listIntents(db, { projectId: "prj_x" }).map((r) => r.id).sort())
      .toEqual([doc.id, project.id].sort());
  });

  it("status lifecycle: open → claimed → answered", () => {
    const i = addIntent(db, {
      projectId: "prj_x", fileId: "f", prompt: "p", authorId: "u_x", targetAgentId: "a42",
    });
    updateIntentStatus(db, i.id, "claimed");
    expect(getIntent(db, i.id)!.status).toBe("claimed");
    expect(getIntent(db, i.id)!.claimedAt).toBeTypeOf("number");

    updateIntentStatus(db, i.id, "answered", {
      answeredBy: "a42",
      answerText: "done",
      answerEditId: "edit_1",
    });
    const done = getIntent(db, i.id)!;
    expect(done.status).toBe("answered");
    expect(done.answeredBy).toBe("a42");
    expect(done.answerEditId).toBe("edit_1");
  });

  it("listIntents filters by targetAgentId + status", () => {
    addIntent(db, { projectId: "prj_x", fileId: "f", prompt: "a", authorId: "u_x", targetAgentId: "a1" });
    addIntent(db, { projectId: "prj_x", fileId: "f", prompt: "b", authorId: "u_x", targetAgentId: "a2" });
    addIntent(db, { projectId: "prj_x", fileId: "f", prompt: "c", authorId: "u_x" });
    const forA1 = listIntents(db, { projectId: "prj_x", targetAgentId: "a1" });
    expect(forA1).toHaveLength(1);
    expect(forA1[0].prompt).toBe("a");

    const open = listIntents(db, { projectId: "prj_x", status: "open" });
    expect(open).toHaveLength(3);
  });

  it("deleteIntent removes the row", () => {
    const i = addIntent(db, { projectId: "prj_x", fileId: "f", prompt: "x", authorId: "u" });
    expect(deleteIntent(db, i.id)).toBe(true);
    expect(getIntent(db, i.id)).toBeNull();
  });
});
