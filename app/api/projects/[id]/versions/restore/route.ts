/**
 * Version restore —— POST { versionId }。
 *
 * 顺序（保证恢复本身可撤销）：
 *   1. 读取目标版本内容
 *   2. 取当前文档内容，先写一条 source='restore' 的保护性版本
 *      （跳过与既有版本完全相同的冗余行）
 *   3. 目标内容写入 storage + 推送 ws-server /replace（全量覆盖 →
 *      所有连上房间的客户端通过 Yjs 同步看到）
 *   4. 向项目全体成员广播 doc_restored UiPatch
 *
 * Auth: editor+。
 */

import { actorForProject } from "@/lib/http-auth";
import { getDb } from "@/src/db";
import { addVersion, getVersion, hashContent, latestVersion } from "@/src/versions";
import { currentDocContent, pushDocContent } from "@/src/doc-content";
import { publishUiPatch } from "@/src/ui-bus/event-bus";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const actor = await actorForProject(request, projectId);
  if (!actor || actor.projectRole === "viewer") {
    return Response.json({ error: "editor role required" }, { status: 403 });
  }
  const { versionId } = (await request.json()) as { versionId?: string };
  if (!versionId) {
    return Response.json({ error: "versionId required" }, { status: 400 });
  }

  const db = await getDb();
  const version = getVersion(db, versionId);
  if (!version || version.projectId !== projectId) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  const fileId = version.fileId;

  // 1) 保护性快照当前内容 —— restore 可撤销
  const current = await currentDocContent(projectId, fileId);
  if (current !== null) {
    const prev = latestVersion(db, projectId, fileId);
    if (!prev || prev.contentHash !== hashContent(current)) {
      addVersion(db, {
        projectId,
        fileId,
        content: current,
        authorId: actor.id,
        authorName: actor.name,
        source: "restore",
      });
    }
  }

  // 2) 写入 storage + 全量推送到 ws-server
  await pushDocContent(projectId, fileId, version.content);

  // 3) 广播 doc_restored —— 客户端的持久化层据此跳过自动版本 + 刷新历史列表
  const members = db
    .prepare("SELECT subject_id FROM project_members WHERE project_id = ?")
    .all(projectId) as { subject_id: string }[];
  void (async () => {
    for (const m of members) {
      await publishUiPatch({
        userId: m.subject_id,
        projectId,
        patch: {
          type: "doc_restored",
          projectId,
          fileId,
          versionId: version.id,
        },
        source: "system",
      });
    }
  })();

  return Response.json({
    ok: true,
    versionId: version.id,
    fileId,
    contentLength: version.content.length,
  });
}
