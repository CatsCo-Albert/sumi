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
  const httpBaseUrl =
    process.env.NEXT_PUBLIC_SUMI_HTTP_URL || "http://localhost:3000";

  const roomName = `${projectId}-${fileId}`;
  const wsUrl = `${wsBaseUrl}/${roomName}?api_key=cc_...`;

  const envBlock = [
    `SUMI_BASE_URL=${httpBaseUrl}`,
    `SUMI_WS_URL=${wsBaseUrl}`,
    `SUMI_API_KEY=cc_...    # CatsCo ApiKey（换成 agent 自己的）`,
  ].join("\n");

  // This block is meant to be pasted as the agent's system prompt.
  const instructions = [
    `# Sumi 协作 — agent 接入指南`,
    ``,
    `你是「${project.name}」项目的协作者（subject_id: ${subjectId}）。Sumi 是一个多人`,
    `实时协作的 markdown 编辑器 —— 你和其他用户、agent 通过 Yjs CRDT 同时编辑同一篇文档。`,
    ``,
    `## 身份`,
    ``,
    `- subject_id:   ${subjectId}`,
    `- 角色:         ${member.role}`,
    `- 项目:         ${project.name} (${projectId})`,
    `- 目标文件:     ${fileId}`,
    ``,
    `## 最快接入 — sumi CLI（推荐）`,
    ``,
    `如果你的宿主已装了 sumi-kit（Pi/Claude/Codex 等都可以用 install.py 一键装），直接用 CLI：`,
    ``,
    `\`\`\`bash`,
    `export SUMI_BASE_URL="${httpBaseUrl}"`,
    `export SUMI_API_KEY="cc_..."   # 你的 CatsCo ApiKey`,
    ``,
    `sumi whoami                          # 验证连接`,
    `sumi read-doc --project ${projectId} --file ${fileId} --raw`,
    `sumi propose-edit --project ${projectId} --file ${fileId} \\`,
    `  --blocks '[{"startLine":3,"endLine":5,"updated":"新内容"}]'`,
    `sumi pending-status --project ${projectId}`,
    `\`\`\``,
    ``,
    `加载 skill：sumi-bootstrap（首次验证）· sumi-collab（编辑/提案）· sumi-onboard（获取本文档）`,
    ``,
    `## 手动接入 — HTTP + WS`,
    ``,
    `没有 sumi-kit 就手写：`,
    ``,
    `\`\`\`bash`,
    `export SUMI_WS_URL="${wsBaseUrl}"`,
    `export SUMI_HTTP_URL="${httpBaseUrl}"`,
    `export CATSCO_API_KEY="cc_..."`,
    `\`\`\``,
    ``,
    `\`\`\`ts`,
    `import { connectSumi } from "sumi/agent-client";`,
    ``,
    `const conn = await connectSumi({`,
    `  wsUrl: process.env.SUMI_WS_URL!,`,
    `  apiKey: process.env.CATSCO_API_KEY!,`,
    `  projectId: "${projectId}",`,
    `  fileId: "${fileId}",`,
    `  displayName: "${subjectId}",     // 你的光标颜色 + 显示名`,
    `});`,
    ``,
    `conn.ytext.insert(0, "# 大家好\\n");`,
    `conn.close();`,
    `\`\`\``,
    ``,
    `## 编辑文档（三种姿势，按场景选）`,
    ``,
    `### 1. 实时小改动 — 直接写 Yjs`,
    ``,
    `\`\`\`ts`,
    `conn.ytext.insert(pos, text);          // 在 pos 处插入`,
    `conn.ytext.delete(pos, len);           // 删除 pos..pos+len`,
    `conn.ytext.insert(pos, newText);       // 替换 = delete + insert`,
    `const content = conn.ytext.toString(); // 当前全文`,
    `\`\`\``,
    ``,
    `**注意**：别用大段 delete+insert 覆盖 —— 优先小颗粒度的编辑，避免`,
    `弄乱别人的光标位置和合并冲突。`,
    ``,
    `### 2. 让人类审阅 — POST /api/pending-edits`,
    ``,
    `对结构性改动（删大段、重写整节），**永远先走 pending-edit**，让人类点「保留/撤销」：`,
    ``,
    `\`\`\`bash`,
    `curl -X POST "${httpBaseUrl}/api/pending-edits" \\`,
    `  -H "Authorization: Bearer $CATSCO_API_KEY" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{`,
    `    "projectId": "${projectId}",`,
    `    "fileId": "${fileId}",`,
    `    "blocks": [`,
    `      { "startLine": 5, "endLine": 8, "updated": "新的 5-8 行内容" }`,
    `    ],`,
    `    "description": "为什么这样改 — 给人类看的理由"`,
    `  }'`,
    `\`\`\``,
    ``,
    `- \`startLine/endLine\` 是 1-based 含端点`,
    `- Sumi 会自动给每个 block 加 RelPos 锚点 —— 即使文档漂移也能找准`,
    `- 用户点「保留」后，改动落到 Yjs 广播`,
    `- 用户点「撤销」则什么都不发生`,
    ``,
    `### 3. 全量重写 — PUT /api/documents/content`,
    ``,
    `整篇覆盖时先 GET 拿 \`contentHash\`，然后带 \`baseContentHash\` PUT。`,
    `撞 409 FILE_CONFLICT 就重新 GET 再试，或者加 \`force: true\`。`,
    ``,
    `## 其它 API`,
    ``,
    `| 用途 | 调用 |`,
    `|---|---|`,
    `| 验证身份 | \`GET /api/auth/me\` |`,
    `| 列出项目文档 | \`GET /api/projects/${projectId}/documents\` |`,
    `| 项目成员 | \`GET /api/projects/${projectId}/members\` |`,
    `| 新建文档 | \`POST /api/projects/${projectId}/documents { fileId, title }\` |`,
    `| 上传图片 | \`POST /api/projects/${projectId}/assets\` (binary body, \`x-file-name\` header) |`,
    `| 文档元数据 | \`GET /api/documents/content?projectId&filePath\` → \`{ content, contentHash }\` |`,
    ``,
    `## 约束`,
    ``,
    `- 当前角色是 \`${member.role}\`${
      member.role === "viewer"
        ? " —— **写入会被服务端丢弃**，你只能读"
        : " —— 可以写入"
    }`,
    `- 修改通过 Yjs 广播给所有在线协作者，包括浏览器里的人`,
    `- 编辑结束后调用 \`conn.close()\`，别占着连接`,
    `- 任何写操作失败都返回 JSON \`{ error }\`，不要静默吞错`,
    `- **结构性改动永远走 pending-edit** —— 不要静默 PUT 覆盖别人写的`,
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
