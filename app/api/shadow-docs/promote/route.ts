/**
 * POST /api/shadow-docs/promote —— 把 shadow 草稿转成 pending_edit。
 *
 * 流程：
 *   1. 取基准内容：doc_snapshots 快照 → 否则 storage 当前文件 → 否则空
 *   2. shadowToBlocks(base, shadow.content) 算最小块编辑（Myers 行级 diff）
 *   3. ws-server /relpos 加锚（best-effort，同 pending-edits POST）
 *   4. addPendingEdit → 广播 pending_edit_changed + shadow_doc_promoted
 *
 * 只有 draft 状态的 shadow 能 promote；baseDocHash 仅作漂移信息记录。
 */

import { actorFromRequest } from "@/lib/http-auth";
import { getDb } from "@/src/db";
import { projectRoleFor } from "@/src/auth/actor";
import { getStorage } from "@/src/storage";
import { publishUiPatch } from "@/src/ui-bus/event-bus";
import {
  getShadowDoc,
  updateShadowDoc,
  shadowToBlocks,
  notifyShadow,
} from "@/src/shadow-docs";
import {
  addPendingEdit,
  getDocSnapshot,
  saveDocSnapshot,
} from "@/src/pending-edits";
import crypto from "crypto";
import type { EditBlock } from "@/src/server/edit-position-tracker";

const docKey = (projectId: string, fileId: string) =>
  `sumi/${projectId}/files/${fileId}`;

export async function POST(request: Request) {
  const body = (await request.json()) as { id?: string };
  if (!body.id) {
    return Response.json({ error: "id required" }, { status: 400 });
  }

  const db = await getDb();
  const shadow = getShadowDoc(db, body.id);
  if (!shadow) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const actor = await actorFromRequest(request);
  if (!actor) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  const role = projectRoleFor(db, shadow.projectId, actor.id);
  if (!role || role === "viewer") {
    return Response.json({ error: "editor role required" }, { status: 403 });
  }
  // 只有 owner 自己能 promote —— 草稿是私人的
  if (shadow.ownerId !== actor.id) {
    return Response.json({ error: "owner only" }, { status: 403 });
  }
  if (shadow.status !== "draft") {
    return Response.json(
      { error: `shadow is ${shadow.status} — cannot promote` },
      { status: 409 }
    );
  }

  // --- 基准内容 ---------------------------------------------------------
  // 优先 doc_snapshots（propose 时拍的），否则 storage 当前文件，否则空。
  let baseContent = "";
  let baseFromSnapshot = false;
  const snap = getDocSnapshot(db, shadow.projectId, shadow.fileId);
  if (snap) {
    baseContent = snap.content;
    baseFromSnapshot = true;
  } else {
    try {
      const storage = await getStorage();
      const key = docKey(shadow.projectId, shadow.fileId);
      if (await storage.exists(key)) {
        baseContent = (await storage.download(key)).toString("utf8");
      }
    } catch {
      // 读不到就按空文档 diff —— 全量新增
    }
  }

  const blocks = shadowToBlocks(baseContent, shadow.content);
  if (!blocks || blocks.length === 0) {
    return Response.json(
      { error: "shadow content identical to base — nothing to propose" },
      { status: 400 }
    );
  }

  // --- RelPos 锚定（best-effort，复用 pending-edits 的逻辑） -----------------
  let enrichedBlocks: EditBlock[] = blocks;
  try {
    const wsPort = process.env.WS_PORT || "12345";
    const res = await fetch(
      `http://localhost:${wsPort}/relpos/${shadow.projectId}/${encodeURIComponent(shadow.fileId)}`,
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
    // 锚定失败不阻塞 —— 行号兜底
  }

  // 基准来自 storage（无快照）→ 顺手存一份，供 apply 时做漂移校验
  if (!baseFromSnapshot) {
    try {
      const contentHash = crypto
        .createHash("sha256")
        .update(baseContent)
        .digest("hex");
      saveDocSnapshot(db, {
        projectId: shadow.projectId,
        fileId: shadow.fileId,
        content: baseContent,
        contentHash,
      });
    } catch {
      // non-fatal
    }
  }

  // --- reviewer：项目 owner（与 pending-edits POST 一致） --------------------
  const reviewer = (
    db
      .prepare("SELECT owner_uid AS ownerUid FROM projects WHERE id = ?")
      .get(shadow.projectId) as { ownerUid: string } | undefined
  )?.ownerUid;
  if (!reviewer) {
    return Response.json({ error: "no reviewer found" }, { status: 400 });
  }

  const description = `Promoted from shadow: ${shadow.title || shadow.id}`;
  const created = addPendingEdit(db, {
    projectId: shadow.projectId,
    fileId: shadow.fileId,
    userId: reviewer,
    authorId: shadow.ownerId,
    authorName: actor.name,
    description,
    blocks: enrichedBlocks,
  });

  // 标记 shadow 已 promote —— promoted_edit_id 记第一块（同组 edit 共享描述）
  updateShadowDoc(db, {
    id: shadow.id,
    status: "promoted",
    promotedEditId: created[0]?.id ?? null,
  });

  // --- 广播 -----------------------------------------------------------------
  // Awaited: the response reports the promotion, so the patches must be out
  // before it is sent. Fire-and-forget could land them after the response.
  const members = db
    .prepare("SELECT subject_id FROM project_members WHERE project_id = ?")
    .all(shadow.projectId) as { subject_id: string }[];
  for (const m of members) {
    for (const edit of created) {
      await publishUiPatch({
        userId: m.subject_id,
        projectId: shadow.projectId,
        patch: {
          type: "pending_edit_changed",
          projectId: shadow.projectId,
          fileId: shadow.fileId,
          edit,
        },
        source: "external_agent",
      });
    }
  }
  await notifyShadow(db, {
    type: "shadow_doc_promoted",
    projectId: shadow.projectId,
    fileId: shadow.fileId,
    shadow: getShadowDoc(db, shadow.id),
    edits: created,
  });

  return Response.json({ edits: created }, { status: 201 });
}
