/**
 * Intents — "ask an agent" requests anchored to a doc region.
 *
 * Lifecycle:
 *   open    — created, broadcasting to target agent (or all agents if none specified)
 *   claimed — an agent acknowledged it's working on it (PATCH status=claimed)
 *   answered — agent submitted an answer (text and/or pending_edit_id)
 *   closed  — human marked resolved (or intent became stale)
 *
 * Threading: a threadId groups back-and-forth. Each answer can spin up a
 * follow-up intent with the same threadId.
 */

import crypto from "crypto";
import type { DatabaseSync } from "node:sqlite";

export interface IntentRow {
  id: string;
  projectId: string;
  fileId: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  selectionText: string | null;
  prompt: string;
  authorId: string;
  authorName: string | null;
  targetAgentId: string | null;
  threadId: string;
  status: "open" | "claimed" | "answered" | "closed";
  answerText: string | null;
  answerEditId: string | null;
  answeredBy: string | null;
  createdAt: number;
  claimedAt: number | null;
  answeredAt: number | null;
}

const id = () => `int_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
const threadId = () => `thr_${crypto.randomBytes(8).toString("hex")}`;

function rowToIntent(r: any): IntentRow {
  return {
    id: r.id,
    projectId: r.project_id,
    fileId: r.file_id,
    selectionStart: r.selection_start ?? null,
    selectionEnd: r.selection_end ?? null,
    selectionText: r.selection_text ?? null,
    prompt: r.prompt,
    authorId: r.author_id,
    authorName: r.author_name ?? null,
    targetAgentId: r.target_agent_id ?? null,
    threadId: r.thread_id,
    status: r.status,
    answerText: r.answer_text ?? null,
    answerEditId: r.answer_edit_id ?? null,
    answeredBy: r.answered_by ?? null,
    createdAt: r.created_at,
    claimedAt: r.claimed_at ?? null,
    answeredAt: r.answered_at ?? null,
  };
}

export function addIntent(
  db: DatabaseSync,
  input: {
    projectId: string;
    fileId: string;
    prompt: string;
    authorId: string;
    authorName?: string;
    targetAgentId?: string;
    selectionStart?: number;
    selectionEnd?: number;
    selectionText?: string;
    threadId?: string;
  }
): IntentRow {
  const intentId = id();
  const tid = input.threadId || threadId();
  const now = Date.now();
  db.prepare(
    `INSERT INTO intents (
      id, project_id, file_id, selection_start, selection_end, selection_text,
      prompt, author_id, author_name, target_agent_id, thread_id,
      status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`
  ).run(
    intentId,
    input.projectId,
    input.fileId,
    input.selectionStart ?? null,
    input.selectionEnd ?? null,
    input.selectionText ?? null,
    input.prompt,
    input.authorId,
    input.authorName ?? null,
    input.targetAgentId ?? null,
    tid,
    now
  );
  return getIntent(db, intentId)!;
}

export function getIntent(db: DatabaseSync, id: string): IntentRow | null {
  const r = db
    .prepare("SELECT * FROM intents WHERE id = ?")
    .get(id);
  return r ? rowToIntent(r) : null;
}

export function listIntents(
  db: DatabaseSync,
  opts: {
    projectId?: string;
    fileId?: string;
    status?: string;
    targetAgentId?: string;
    threadId?: string;
    limit?: number;
  }
): IntentRow[] {
  const conds: string[] = [];
  const args: any[] = [];
  if (opts.projectId) { conds.push("project_id = ?"); args.push(opts.projectId); }
  if (opts.fileId) { conds.push("file_id = ?"); args.push(opts.fileId); }
  if (opts.status) { conds.push("status = ?"); args.push(opts.status); }
  if (opts.targetAgentId) { conds.push("target_agent_id = ?"); args.push(opts.targetAgentId); }
  if (opts.threadId) { conds.push("thread_id = ?"); args.push(opts.threadId); }
  const sql =
    `SELECT * FROM intents ${conds.length ? "WHERE " + conds.join(" AND ") : ""} ` +
    `ORDER BY created_at DESC LIMIT ?`;
  args.push(opts.limit ?? 100);
  const rows = db.prepare(sql).all(...args);
  return rows.map(rowToIntent);
}

export function updateIntentStatus(
  db: DatabaseSync,
  id: string,
  status: IntentRow["status"],
  opts: { answeredBy?: string; answerText?: string; answerEditId?: string } = {}
): IntentRow | null {
  const now = Date.now();
  const fields: string[] = ["status = ?"];
  const args: any[] = [status];
  if (status === "claimed") {
    fields.push("claimed_at = ?");
    args.push(now);
  }
  if (status === "answered") {
    fields.push("answered_at = ?");
    args.push(now);
    if (opts.answeredBy) { fields.push("answered_by = ?"); args.push(opts.answeredBy); }
    if (opts.answerText !== undefined) { fields.push("answer_text = ?"); args.push(opts.answerText); }
    if (opts.answerEditId) { fields.push("answer_edit_id = ?"); args.push(opts.answerEditId); }
  }
  args.push(id);
  db.prepare(`UPDATE intents SET ${fields.join(", ")} WHERE id = ?`).run(...args);
  return getIntent(db, id);
}

export function deleteIntent(db: DatabaseSync, id: string): boolean {
  const r = db.prepare("DELETE FROM intents WHERE id = ?").run(id);
  return r.changes > 0;
}
