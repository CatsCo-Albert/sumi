/**
 * Shadow docs —— agent 的私密草稿区。
 *
 *   POST   /api/shadow-docs            创建 { projectId, fileId, content, title?, baseDocHash? }
 *   GET    /api/shadow-docs?projectId&fileId?&mine=1   列草稿（成员可见项目内全部）
 *   PATCH  /api/shadow-docs            { id, content?, title?, status? }
 *   DELETE /api/shadow-docs            { id }
 *   POST   /api/shadow-docs/promote    { id } → 转 pending_edit
 *
 * 生命周期：draft → promoted（仅 promote 端点）| discarded（owner 或项目 owner）。
 * 广播：shadow_doc_created/updated/promoted/discarded 发给项目全体成员。
 */

import { actorFromRequest } from "@/lib/http-auth";
import { getDb } from "@/src/db";
import { projectRoleFor, type Actor } from "@/src/auth/actor";
import { getStorage } from "@/src/storage";
import {
  createShadowDoc,
  getShadowDoc,
  listShadowDocs,
  updateShadowDoc,
  deleteShadowDoc,
  notifyShadow,
  type ShadowStatus,
} from "@/src/shadow-docs";
import crypto from "crypto";

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

const docKey = (projectId: string, fileId: string) =>
  `sumi/${projectId}/files/${fileId}`;

const hashContent = (buf: Buffer | string) =>
  crypto.createHash("sha256").update(buf).digest("hex");

/** 计算 baseDocHash：优先服务端从 storage 读，不信任客户端传值。 */
async function computeBaseDocHash(
  projectId: string,
  fileId: string
): Promise<string | null> {
  try {
    const storage = await getStorage();
    const key = docKey(projectId, fileId);
    if (!(await storage.exists(key))) return null;
    const buf = await storage.download(key);
    return hashContent(buf);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GET — 列草稿
// ---------------------------------------------------------------------------

export async function GET(request: Request) {
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId") || "";
  const fileId = url.searchParams.get("fileId") || undefined;
  const mine = url.searchParams.get("mine") === "1";
  const status = url.searchParams.get("status") as ShadowStatus | null;
  const all = url.searchParams.get("all") === "1"; // 含 promoted/discarded

  if (!projectId) {
    return Response.json({ error: "projectId required" }, { status: 400 });
  }
  const ctx = await actorAndRole(request, projectId);
  if (!ctx) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const db = await getDb();
  const shadows = listShadowDocs(db, {
    projectId,
    fileId,
    ownerId: mine ? ctx.actor.id : undefined,
    status: status ?? undefined,
    includeArchived: all || !!status,
  });
  return Response.json({ shadows });
}

// ---------------------------------------------------------------------------
// POST — 创建草稿（editor+）
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  const body = (await request.json()) as {
    projectId?: string;
    fileId?: string;
    content?: string;
    title?: string;
    baseDocHash?: string;
  };
  const { projectId, fileId, content, title } = body;
  if (!projectId || !fileId || typeof content !== "string") {
    return Response.json(
      { error: "projectId, fileId, content required" },
      { status: 400 }
    );
  }

  const ctx = await actorAndRole(request, projectId);
  if (!ctx) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  if (ctx.role === "viewer") {
    return Response.json({ error: "editor role required" }, { status: 403 });
  }

  const db = await getDb();
  // baseDocHash 以服务端读到的为准 —— 客户端传值只做参考，不落库
  const baseDocHash = await computeBaseDocHash(projectId, fileId);

  const shadow = createShadowDoc(db, {
    projectId,
    fileId,
    ownerId: ctx.actor.id,
    content,
    title,
    baseDocHash,
  });

  notifyShadow(db, {
    type: "shadow_doc_created",
    projectId,
    fileId,
    shadow,
  });

  return Response.json({ shadow }, { status: 201 });
}

// ---------------------------------------------------------------------------
// PATCH — 更新 content/title（仅 owner）或 status='discarded'（owner/项目owner）
// ---------------------------------------------------------------------------

export async function PATCH(request: Request) {
  const body = (await request.json()) as {
    id?: string;
    content?: string;
    title?: string;
    status?: ShadowStatus;
  };
  if (!body.id) {
    return Response.json({ error: "id required" }, { status: 400 });
  }

  const db = await getDb();
  const shadow = getShadowDoc(db, body.id);
  if (!shadow) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const ctx = await actorAndRole(request, shadow.projectId);
  if (!ctx) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const isOwner = shadow.ownerId === ctx.actor.id;
  const isProjectOwner = ctx.role === "owner";

  // content/title 只能 owner 改
  if ((body.content !== undefined || body.title !== undefined) && !isOwner) {
    return Response.json({ error: "owner only" }, { status: 403 });
  }

  // status 变更：只允许 'discarded'，且 owner 或项目 owner
  if (body.status !== undefined) {
    if (body.status !== "discarded") {
      return Response.json(
        { error: "status can only transition to 'discarded' via PATCH" },
        { status: 400 }
      );
    }
    if (!isOwner && !isProjectOwner) {
      return Response.json({ error: "not yours to discard" }, { status: 403 });
    }
    if (shadow.status !== "draft") {
      return Response.json(
        { error: `already ${shadow.status}` },
        { status: 409 }
      );
    }
  }

  if (shadow.status !== "draft") {
    return Response.json(
      { error: `shadow is ${shadow.status} — cannot edit` },
      { status: 409 }
    );
  }

  const updated = updateShadowDoc(db, {
    id: body.id,
    content: body.content,
    title: body.title,
    status: body.status,
  });

  notifyShadow(db, {
    type: body.status === "discarded" ? "shadow_doc_discarded" : "shadow_doc_updated",
    projectId: shadow.projectId,
    fileId: shadow.fileId,
    shadow: updated,
  });

  return Response.json({ shadow: updated });
}

// ---------------------------------------------------------------------------
// DELETE — owner 或项目 owner
// ---------------------------------------------------------------------------

export async function DELETE(request: Request) {
  const body = (await request.json()) as { id?: string };
  if (!body.id) {
    return Response.json({ error: "id required" }, { status: 400 });
  }

  const db = await getDb();
  const shadow = getShadowDoc(db, body.id);
  if (!shadow) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const ctx = await actorAndRole(request, shadow.projectId);
  if (!ctx) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const isOwner = shadow.ownerId === ctx.actor.id;
  const isProjectOwner = ctx.role === "owner";
  if (!isOwner && !isProjectOwner) {
    return Response.json({ error: "not yours to delete" }, { status: 403 });
  }

  deleteShadowDoc(db, body.id);
  notifyShadow(db, {
    type: "shadow_doc_discarded",
    projectId: shadow.projectId,
    fileId: shadow.fileId,
    shadowId: shadow.id,
  });

  return Response.json({ ok: true });
}
