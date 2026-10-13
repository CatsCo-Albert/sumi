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
} from "@/src/pending-edits";
import { publishUiPatch } from "@/src/ui-bus/event-bus";
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

/** Notify the reviewer that an edit changed. Fire-and-forget. */
function notifyReviewer(
  projectId: string,
  fileId: string,
  reviewerId: string,
  edit: ReturnType<typeof getPendingEdit>,
  source: "internal_agent" | "external_agent" | "system"
): void {
  void (async () => {
    // Only broadcast to the reviewer's ui-bus — the pending queue is per-user.
    // If the reviewer is offline, the durable log replays on reconnect.
    if (!reviewerId.startsWith("u")) return;
    await publishUiPatch({
      userId: reviewerId,
      projectId,
      patch: {
        type: "pending_edit_changed",
        projectId,
        fileId,
        edit,
      },
      source,
    });
  })();
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

  const created = addPendingEdit(db, {
    projectId,
    fileId,
    userId: reviewer,
    authorId: ctx.actor.id,
    authorName: ctx.actor.name,
    description,
    blocks: enrichedBlocks,
  });

  // Notify the reviewer — their editor will render the diff decorations.
  for (const edit of created) {
    notifyReviewer(projectId, fileId, reviewer, edit, "external_agent");
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
  notifyReviewer(existing.projectId, existing.fileId, existing.userId, null, "system");

  return Response.json({ ok: true });
}
