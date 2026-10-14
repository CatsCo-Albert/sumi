/**
 * Version history —— 文档历史版本 API。
 *
 *   GET  /api/projects/:id/versions?fileId=…           列版本（无 content）
 *   GET  /api/projects/:id/versions?fileId=…&id=ver_x  单条详情（含 content）
 *   POST /api/projects/:id/versions { fileId, label?, source?, content? }
 *        —— 手动快照 source='manual'；保存路径的自动快照 source='auto'
 *           （服务端防抖裁决，跳过时返回 { created:false, reason }）
 *
 * Auth: list/detail = project member；create = editor+。
 */

import { actorForProject } from "@/lib/http-auth";
import { getDb } from "@/src/db";
import {
  addVersion,
  getVersion,
  hashContent,
  latestVersion,
  listVersions,
  shouldAutoVersion,
  type VersionSource,
} from "@/src/versions";
import { currentDocContent } from "@/src/doc-content";

const SOURCES: VersionSource[] = ["auto", "manual", "restore"];

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const actor = await actorForProject(request, projectId);
  if (!actor) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const url = new URL(request.url);
  const fileId = url.searchParams.get("fileId") || "";
  if (!fileId) {
    return Response.json({ error: "fileId required" }, { status: 400 });
  }
  const db = await getDb();

  const versionId = url.searchParams.get("id");
  if (versionId) {
    const v = getVersion(db, versionId);
    if (!v || v.projectId !== projectId || v.fileId !== fileId) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    return Response.json({ version: v });
  }

  const sourceParam = url.searchParams.get("source");
  const source = SOURCES.includes(sourceParam as VersionSource)
    ? (sourceParam as VersionSource)
    : undefined;
  const limitParam = url.searchParams.get("limit");
  const offsetParam = url.searchParams.get("offset");
  const { versions, total } = listVersions(db, {
    projectId,
    fileId,
    source,
    limit: limitParam ? parseInt(limitParam, 10) : undefined,
    offset: offsetParam ? parseInt(offsetParam, 10) : undefined,
  });
  return Response.json({ versions, total });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const actor = await actorForProject(request, projectId);
  if (!actor || actor.projectRole === "viewer") {
    return Response.json({ error: "editor role required" }, { status: 403 });
  }
  const body = (await request.json()) as {
    fileId?: string;
    label?: string;
    source?: string;
    /** Callers that already hold the content may pass it; else we read server-side. */
    content?: string;
  };
  if (!body.fileId) {
    return Response.json({ error: "fileId required" }, { status: 400 });
  }
  const source: VersionSource =
    body.source === "auto" || body.source === "restore" ? body.source : "manual";

  const db = await getDb();
  const content =
    typeof body.content === "string"
      ? body.content
      : await currentDocContent(projectId, body.fileId);
  if (content === null) {
    return Response.json(
      { error: "document content unavailable" },
      { status: 404 }
    );
  }

  if (source === "auto") {
    const prev = latestVersion(db, projectId, body.fileId);
    const decision = shouldAutoVersion(prev, content);
    if (!decision.create) {
      return Response.json({ created: false, reason: decision.reason });
    }
  } else {
    // manual/restore：仍然跳过与最近版本完全相同的内容
    const prev = latestVersion(db, projectId, body.fileId);
    if (prev && prev.contentHash === hashContent(content)) {
      return Response.json({ created: false, reason: "unchanged" });
    }
  }

  const version = addVersion(db, {
    projectId,
    fileId: body.fileId,
    content,
    authorId: actor.id,
    authorName: actor.name,
    label: typeof body.label === "string" ? body.label.trim() || undefined : undefined,
    source,
  });
  const { content: _omit, ...summary } = version;
  return Response.json({ created: true, version: summary }, { status: 201 });
}
