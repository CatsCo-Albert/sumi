/**
 * Pending edits — agents propose, humans review.
 *
 * POST   /api/pending-edits            propose a pending edit
 * GET    /api/pending-edits?projectId&fileId?   list pending edits for this actor
 * DELETE /api/pending-edits { editId }  drop a pending edit (rejected)
 *
 * Broadcast: after mutating, we publish a `pending_edit_changed` UiPatch to
 * every project member so their `useEditStore` updates live.
 */

import { getDb } from "@/src/db";
import { projectRoleFor, type Actor } from "@/src/auth/actor";
import { actorFromRequest } from "@/lib/http-auth";
import {
  addPendingEdit,
  listPendingEdits,
  getPendingEdit,
  updatePendingEditStatus,
  deletePendingEdit,
  saveDocSnapshot,
} from "@/src/pending-edits";
import { publishUiPatch } from "@/src/ui-bus/event-bus";
import { getStorage } from "@/src/storage";
import crypto from "crypto";
import type { EditBlock } from "@/src/server/edit-position-tracker";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function actorAndRole(
  request: Request,
  projectId: string
): Promise<{ actor: Actor; role: string } | null> {
  const actor = await actorFromRequest(request);
  if (!actor) return null;
  const db = await getDb();
  const role = projectRoleFor(db, projectId, actor.id);
  if (!role) return null;
  return { actor, role };
}

/**
 * Notify all project members — humans AND agents.
 *
 * Awaited by the caller: the response reports the edit as created or dropped,
 * so the patches must be published before it is sent. Fire-and-forget let a
 * patch land after the response — a client could reload and miss it, and the
 * late patch leaked into the next test case, which is how that surfaced.
 */
async function notifyProjectMembers(
  db: Awaited<ReturnType<typeof getDb>>,
  projectId: string,
  fileId: string,
  edit: ReturnType<typeof getPendingEdit>,
  source: "internal_agent" | "external_agent" | "system"
): Promise<void> {
  const members = db
    .prepare("SELECT subject_id FROM project_members WHERE project_id = ?")
    .all(projectId) as { subject_id: string }[];
  for (const m of members) {
    await publishUiPatch({
      userId: m.subject_id,
      projectId,
      patch: {
        type: "pending_edit_changed",
        projectId,
        fileId,
        edit,
      },
      source,
    });
  }
}

// ---------------------------------------------------------------------------
// GET — list pending edits visible to this actor
// ---------------------------------------------------------------------------

export async function GET(request: Request) {
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId") || "";
  const fileId = url.searchParams.get("fileId") || undefined;

  if (!projectId) {
    return Response.json({ error: "projectId required" }, { status: 400 });
  }
  const ctx = await actorAndRole(request, projectId);
  if (!ctx) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const db = await getDb();
  const edits = listPendingEdits(db, {
    projectId,
    userId: ctx.actor.id,
    fileId,
  });
  return Response.json({ edits });
}

// ---------------------------------------------------------------------------
// POST — propose a pending edit (agent or user)
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  const body = (await request.json()) as {
    projectId?: string;
    fileId?: string;
    /** Optional: which member should see this edit — defaults to project owner. */
    targetUserId?: string;
    blocks?: EditBlock[];
    description?: string;
  };

  const { projectId, fileId, targetUserId, blocks, description } = body;
  if (!projectId || !fileId || !Array.isArray(blocks) || blocks.length === 0) {
    return Response.json(
      { error: "projectId, fileId, blocks required" },
      { status: 400 }
    );
  }

  const ctx = await actorAndRole(request, projectId);
  if (!ctx) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  // Only editor+ can propose — viewers are read-only.
  if (ctx.role === "viewer") {
    return Response.json({ error: "editor role required" }, { status: 403 });
  }

  const db = await getDb();

  // Resolve targetUserId: the member who should review. Default to the
  // project owner — they're the human responsible for the doc.
  const reviewer =
    targetUserId ||
    (db
      .prepare("SELECT owner_uid AS ownerUid FROM projects WHERE id = ?")
      .get(projectId) as { ownerUid: string } | undefined)?.ownerUid;
  if (!reviewer) {
    return Response.json({ error: "no reviewer found" }, { status: 400 });
  }

  // Best-effort RelPos enrichment via ws-server — keeps block anchors accurate
  // even if the doc drifts between proposal and apply.
  let enrichedBlocks: EditBlock[] = blocks;
  try {
    const wsPort = process.env.WS_PORT || "12345";
    const res = await fetch(
      `http://localhost:${wsPort}/relpos/${projectId}/${encodeURIComponent(fileId)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blocks }),
      }
    );
    if (res.ok) {
      const d = await res.json();
      if (Array.isArray(d.blocks)) enrichedBlocks = d.blocks;
    }
  } catch {
    // relpos enrichment is optional — fall back to raw line numbers
  }

  // Capture a doc snapshot so the apply path can verify anchors later.
  // Best-effort — a missing snapshot just means less rigorous drift checks.
  try {
    const storage = await getStorage();
    const key = `sumi/${projectId}/files/${fileId}`;
    if (await storage.exists(key)) {
      const buf = await storage.download(key);
      const content = buf.toString("utf8");
      const contentHash = crypto.createHash("sha256").update(buf).digest("hex");
      saveDocSnapshot(db, { projectId, fileId, content, contentHash });
    }
  } catch {
    // snapshot failure is non-fatal
  }

  const created = addPendingEdit(db, {
    projectId,
    fileId,
    userId: reviewer,
    authorId: ctx.actor.id,
    authorName: ctx.actor.name,
    description,
    blocks: enrichedBlocks,
  });

  // Broadcast to every project member — humans see decorations,
  // agents can poll or SSE-subscribe for notifications.
  for (const edit of created) {
    await notifyProjectMembers(db, projectId, fileId, edit, "external_agent");
  }

  return Response.json({ edits: created }, { status: 201 });
}

// ---------------------------------------------------------------------------
// DELETE — drop a pending edit (rejected, or cleaned up after apply)
// ---------------------------------------------------------------------------

export async function DELETE(request: Request) {
  const { editId } = (await request.json()) as { editId?: string };
  if (!editId) {
    return Response.json({ error: "editId required" }, { status: 400 });
  }

  const db = await getDb();
  const existing = getPendingEdit(db, editId);
  if (!existing) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const ctx = await actorAndRole(request, existing.projectId);
  if (!ctx) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  // Only the reviewer (the one it was proposed FOR) or project owner can drop it.
  const isReviewer = existing.userId === ctx.actor.id;
  const isOwner = ctx.role === "owner";
  if (!isReviewer && !isOwner) {
    return Response.json({ error: "not yours to drop" }, { status: 403 });
  }

  updatePendingEditStatus(db, editId, "rejected");
  notifyProjectMembers(db, existing.projectId, existing.fileId, null, "system");

  return Response.json({ ok: true });
}
