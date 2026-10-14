/**
 * Intents — "ask an agent" requests.
 *
 * POST   /api/intents            create intent (humans or agents can create)
 * GET    /api/intents?projectId&fileId?&status?&threadId?   list
 * PATCH  /api/intents            { id, status, answerText?, answerEditId? }
 * DELETE /api/intents            { id }
 *
 * Broadcasts:
 *   intent_created   → all project members (agents see it, can claim)
 *   intent_claimed   → all members (others know it's taken)
 *   intent_answered  → all members (author sees the answer)
 *   intent_closed    → all members
 */

import { getDb } from "@/src/db";
import { projectRoleFor, type Actor } from "@/src/auth/actor";
import { actorFromRequest } from "@/lib/http-auth";
import {
  addIntent,
  listIntents,
  getIntent,
  updateIntentStatus,
  deleteIntent,
} from "@/src/intents";
import { publishUiPatch } from "@/src/ui-bus/event-bus";

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

async function broadcastToMembers(
  projectId: string,
  fileId: string,
  patchType:
    | "intent_created"
    | "intent_claimed"
    | "intent_answered"
    | "intent_closed",
  payload: Record<string, unknown>
) {
  const db = await getDb();
  const members = db
    .prepare("SELECT subject_id FROM project_members WHERE project_id = ?")
    .all(projectId) as { subject_id: string }[];
  for (const m of members) {
    void publishUiPatch({
      userId: m.subject_id,
      projectId,
      patch: {
        type: patchType,
        projectId,
        fileId,
        ...payload,
      },
      source: "system",
    });
  }
}

// ---------------------------------------------------------------------------
// GET — list intents
// ---------------------------------------------------------------------------

export async function GET(request: Request) {
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId") || "";
  const fileId = url.searchParams.get("fileId") || undefined;
  const status = url.searchParams.get("status") || undefined;
  const threadId = url.searchParams.get("threadId") || undefined;
  const targetAgentId = url.searchParams.get("targetAgentId") || undefined;
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10), 500);

  if (!projectId) {
    return Response.json({ error: "projectId required" }, { status: 400 });
  }
  const ctx = await actorAndRole(request, projectId);
  if (!ctx) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const db = await getDb();
  const intents = listIntents(db, {
    projectId,
    fileId,
    status,
    threadId,
    targetAgentId,
    limit,
  });
  return Response.json({ intents });
}

// ---------------------------------------------------------------------------
// POST — create an intent
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  const body = (await request.json()) as {
    projectId?: string;
    fileId?: string;
    prompt?: string;
    targetAgentId?: string;
    selectionStart?: number;
    selectionEnd?: number;
    selectionText?: string;
    threadId?: string;
  };

  const { projectId, fileId, prompt, targetAgentId, selectionStart, selectionEnd, selectionText, threadId } = body;
  if (!projectId || !fileId || !prompt || !prompt.trim()) {
    return Response.json(
      { error: "projectId, fileId, prompt required" },
      { status: 400 }
    );
  }

  const ctx = await actorAndRole(request, projectId);
  if (!ctx) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  // Agents can't create intents targeting themselves (no self-assign loops).
  if (targetAgentId === ctx.actor.id) {
    return Response.json(
      { error: "can't create intent targeting yourself" },
      { status: 400 }
    );
  }

  const db = await getDb();
  const intent = addIntent(db, {
    projectId,
    fileId,
    prompt: prompt.trim(),
    authorId: ctx.actor.id,
    authorName: ctx.actor.name,
    targetAgentId,
    selectionStart,
    selectionEnd,
    selectionText,
    threadId,
  });

  await broadcastToMembers(projectId, fileId, "intent_created", {
    intent,
  });

  return Response.json({ intent }, { status: 201 });
}

// ---------------------------------------------------------------------------
// PATCH — claim / answer / close an intent
// ---------------------------------------------------------------------------

export async function PATCH(request: Request) {
  const body = (await request.json()) as {
    id?: string;
    status?: "claimed" | "answered" | "closed";
    answerText?: string;
    answerEditId?: string;
  };
  const { id, status, answerText, answerEditId } = body;
  if (!id || !status) {
    return Response.json({ error: "id, status required" }, { status: 400 });
  }

  const db = await getDb();
  const existing = getIntent(db, id);
  if (!existing) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const ctx = await actorAndRole(request, existing.projectId);
  if (!ctx) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  // Claim/answer must come from the targeted agent, or any agent if broadcast.
  if (status === "claimed" || status === "answered") {
    const isAgent = ctx.actor.id.startsWith("a");
    if (!isAgent) {
      return Response.json(
        { error: "only agents can claim/answer intents" },
        { status: 403 }
      );
    }
    if (
      existing.targetAgentId &&
      existing.targetAgentId !== ctx.actor.id &&
      status === "claimed"
    ) {
      return Response.json(
        { error: "this intent targets a different agent" },
        { status: 403 }
      );
    }
  }
  // Only the author or owner can close.
  if (status === "closed") {
    const isAuthor = existing.authorId === ctx.actor.id;
    const isOwner = ctx.role === "owner";
    if (!isAuthor && !isOwner) {
      return Response.json({ error: "not yours to close" }, { status: 403 });
    }
  }

  const updated = updateIntentStatus(db, id, status, {
    answeredBy: status === "answered" ? ctx.actor.id : undefined,
    answerText,
    answerEditId,
  });

  const patchType =
    status === "claimed"
      ? "intent_claimed"
      : status === "answered"
      ? "intent_answered"
      : "intent_closed";

  await broadcastToMembers(existing.projectId, existing.fileId, patchType, {
    intent: updated,
  });

  return Response.json({ intent: updated });
}

// ---------------------------------------------------------------------------
// DELETE — remove an intent (author or owner only)
// ---------------------------------------------------------------------------

export async function DELETE(request: Request) {
  const { id } = (await request.json()) as { id?: string };
  if (!id) {
    return Response.json({ error: "id required" }, { status: 400 });
  }

  const db = await getDb();
  const existing = getIntent(db, id);
  if (!existing) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const ctx = await actorAndRole(request, existing.projectId);
  if (!ctx) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const isAuthor = existing.authorId === ctx.actor.id;
  const isOwner = ctx.role === "owner";
  if (!isAuthor && !isOwner) {
    return Response.json({ error: "not yours to delete" }, { status: 403 });
  }

  deleteIntent(db, id);
  await broadcastToMembers(existing.projectId, existing.fileId, "intent_closed", {
    intentId: id,
  });
  return Response.json({ ok: true });
}
