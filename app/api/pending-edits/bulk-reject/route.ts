/**
 * Bulk-reject — drop many pending edits in one call.
 *
 * POST /api/pending-edits/bulk-reject { ids: string[] }
 *
 * Mirrors DELETE /api/pending-edits semantics, batched:
 *   - actor must have editor/owner on each edit's project (grouped internally)
 *   - only the reviewer (edit.userId) or project owner may reject
 *   - one sqlite transaction flips all eligible rows to 'rejected'
 *   - a `pending_edit_changed` patch (edit: null) is broadcast to every
 *     project member per rejected edit
 */

import { getDb } from "@/src/db";
import { projectRoleFor } from "@/src/auth/actor";
import { actorFromRequest } from "@/lib/http-auth";
import type { PendingEditRow } from "@/src/pending-edits";
import { publishUiPatch } from "@/src/ui-bus/event-bus";
import type { DatabaseSync } from "node:sqlite";

const MAX_IDS = 500;

function rowToEdit(r: {
  id: string;
  project_id: string;
  file_id: string;
  user_id: string;
  author_id: string;
  author_name: string | null;
  description: string | null;
  blocks: string;
  status: string;
  created_at: number;
  updated_at: number;
}): PendingEditRow {
  return {
    id: r.id,
    projectId: r.project_id,
    fileId: r.file_id,
    userId: r.user_id,
    authorId: r.author_id,
    authorName: r.author_name,
    description: r.description,
    blocks: JSON.parse(r.blocks),
    status: r.status as PendingEditRow["status"],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Broadcast a removal patch to every member of the edit's project.
 *
 * Awaited by the caller: the response claims the edits were rejected, so the
 * patches must be published before it is sent. Leaving this fire-and-forget let
 * a rejected edit's patch land after the response — a client could reload and
 * miss it, and in tests the late patch leaked into the next case, which is how
 * that surfaced.
 */
async function notifyEditRemoved(
  db: DatabaseSync,
  edit: PendingEditRow
): Promise<void> {
  const members = db
    .prepare("SELECT subject_id FROM project_members WHERE project_id = ?")
    .all(edit.projectId) as { subject_id: string }[];
  for (const m of members) {
    await publishUiPatch({
      userId: m.subject_id,
      projectId: edit.projectId,
      patch: {
        type: "pending_edit_changed",
        projectId: edit.projectId,
        fileId: edit.fileId,
        edit: null,
      },
      source: "system",
    });
  }
}

export async function POST(request: Request) {
  const body = (await request.json()) as { ids?: string[] };
  if (
    !Array.isArray(body.ids) ||
    body.ids.length === 0 ||
    body.ids.length > MAX_IDS ||
    body.ids.some((i) => typeof i !== "string" || !i)
  ) {
    return Response.json(
      { error: `ids required (1-${MAX_IDS} non-empty strings)` },
      { status: 400 }
    );
  }

  const actor = await actorFromRequest(request);
  if (!actor) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const db = await getDb();
  const ids = [...new Set(body.ids)];

  // Fetch all candidate rows.
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT * FROM pending_edits WHERE id IN (${placeholders})`)
    .all(...ids) as Parameters<typeof rowToEdit>[0][];
  const edits = rows.map(rowToEdit);

  // Group by project — actor needs editor+ on every project touched.
  const byProject = new Map<string, PendingEditRow[]>();
  for (const e of edits) {
    const arr = byProject.get(e.projectId) || [];
    arr.push(e);
    byProject.set(e.projectId, arr);
  }
  for (const projectId of byProject.keys()) {
    const role = projectRoleFor(db, projectId, actor.id);
    if (!role || role === "viewer") {
      return Response.json({ error: "editor role required" }, { status: 403 });
    }
  }

  // Only the reviewer (edit.userId) or the project owner can reject.
  for (const [projectId, list] of byProject) {
    const isOwner = projectRoleFor(db, projectId, actor.id) === "owner";
    for (const e of list) {
      if (!isOwner && e.userId !== actor.id) {
        return Response.json({ error: "not yours to drop" }, { status: 403 });
      }
    }
  }

  // Single transaction — only rows still actionable get flipped; anything
  // already applied/rejected is skipped so `rejected` is a real count.
  const now = Date.now();
  const rejected: PendingEditRow[] = [];
  db.exec("BEGIN");
  try {
    const stmt = db.prepare(
      `UPDATE pending_edits SET status = 'rejected', updated_at = ?
       WHERE id = ? AND status IN ('pending','applying')`
    );
    for (const e of edits) {
      if (stmt.run(now, e.id).changes > 0) rejected.push(e);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  for (const e of rejected) {
    await notifyEditRemoved(db, e);
  }

  return Response.json({ rejected: rejected.length });
}
