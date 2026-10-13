/**
 * Agent onboarding — return a copy-pasteable setup guide for the user to
 * give their agent (either a system prompt, a CLI command, or env vars).
 *
 * In Sumi, agents are just subjects (`a{uid}`) with a project_membership.
 * Their credential is a CatsCo ApiKey (`cc_*`) which the user (or their
 * agent host) already possesses — we never see it.
 *
 * The guide tells the agent:
 *   - what WS URL to connect to
 *   - which projectId/fileId to use
 *   - how to authenticate (api_key query param)
 *   - a minimal connectSumi() snippet
 *
 * GET /api/projects/:id/agent-setup?subjectId=a42[&fileId=...]
 */

import { getDb } from "@/src/db";
import { getProject } from "@/src/auth/identity";
import { actorForProject } from "@/lib/http-auth";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const actor = await actorForProject(request, projectId);
  if (!actor) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const db = await getDb();
  const project = getProject(db, projectId);
  if (!project) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const url = new URL(request.url);
  const subjectId = url.searchParams.get("subjectId");
  if (!subjectId || !subjectId.startsWith("a")) {
    return Response.json(
      { error: "subjectId must be an agent subject (a*)" },
      { status: 400 }
    );
  }

  // Member must exist
  const member = db
    .prepare(
      "SELECT role FROM project_members WHERE project_id = ? AND subject_id = ?"
    )
    .get(projectId, subjectId) as { role: string } | undefined;
  if (!member) {
    return Response.json(
      { error: "agent is not a member of this project" },
      { status: 404 }
    );
  }

  const fileId =
    url.searchParams.get("fileId") || "notes/intro.md";

  // Best-guess WS URL — clients should override via env.
  const wsBaseUrl =
    process.env.NEXT_PUBLIC_SUMI_WS_URL ||
    `ws://localhost:${process.env.WS_PORT || 12345}`;

  const roomName = `${projectId}-${fileId}`;
  const wsUrl = `${wsBaseUrl}/${roomName}?api_key=cc_...`;

  const envBlock = [
    `SUMI_WS_URL=${wsBaseUrl}`,
    `SUMI_PROJECT_ID=${projectId}`,
    `SUMI_FILE_ID=${fileId}`,
    `CATSCO_API_KEY=cc_...    # the agent's ApiKey (you already have this)`,
  ].join("\n");

  const instructions = [
    `你是「${project.name}」项目的协作者（${subjectId}）。`,
    ``,
    `通过 WebSocket 实时同步 markdown 文档：`,
    ``,
    `  WS URL:     ${wsBaseUrl}`,
    `  Room:       ${roomName}`,
    `  Project:    ${projectId}`,
    `  File:       ${fileId}`,
    `  Role:       ${member.role}`,
    ``,
    `用你的 CatsCo ApiKey（cc_*）鉴权——无需其它 token：`,
    ``,
    `  import { connectSumi } from "sumi/agent-client";`,
    ``,
    `  const conn = await connectSumi({`,
    `    wsUrl: "${wsBaseUrl}",`,
    `    apiKey: process.env.CATSCO_API_KEY,`,
    `    projectId: "${projectId}",`,
    `    fileId: "${fileId}",`,
    `    displayName: "${subjectId}",  // 让其他人看到你的光标`,
    `  });`,
    ``,
    `编辑文档 —— Y.Text 是共享的 CRDT：`,
    ``,
    `  // 插入`,
    `  conn.ytext.insert(0, "# 标题\\n\\n");`,
    `  // 追加`,
    `  conn.ytext.insert(conn.ytext.length, "末尾追加\\n");`,
    `  // 局部替换（pos, deleteLen, newText）`,
    `  conn.ytext.delete(10, 5);`,
    `  conn.ytext.insert(10, "替换");`,
    `  // 读取当前内容`,
    `  const content = conn.ytext.toString();`,
    ``,
    `注意：`,
    `- 当前角色是「${member.role}」${
      member.role === "viewer" ? "，写入会被服务端丢弃" : "，可以写入"
    }`,
    `- 修改会通过 Yjs 广播给所有在线协作者（含浏览器用户）`,
    `- 请优先做小颗粒度的 insert/delete，而不是整段覆盖 —— 这样光标位置`,
    `  对其他人更友好，且 merge 冲突少`,
    `- 修改完成后调用 conn.close() 释放连接`,
    `- 需要写新文件？POST /api/projects/${projectId}/documents { fileId, title }`,
    `- 直接改文件不走 Yjs？PUT /api/documents/content —— 带 baseContentHash 做乐观锁，`,
    `  409 FILE_CONFLICT 时先重新 GET 再决定覆盖`,
    `- 提议修改让人类审阅？POST /api/pending-edits {`,
    `    projectId: "${projectId}",`,
    `    fileId: "${fileId}",`,
    `    blocks: [{ startLine, endLine, updated }],   // 行号 1-based`,
    `    description: "这段改动意图…"`,
    `  }`,
    `  —— 修改会以「待审核」状态出现在用户编辑器里，让他们点「保留/撤销」`,
  ].join("\n");

  return Response.json({
    projectId,
    projectName: project.name,
    subjectId,
    role: member.role,
    fileId,
    roomName,
    wsBaseUrl,
    wsUrl,
    envBlock,
    instructions,
  });
}
