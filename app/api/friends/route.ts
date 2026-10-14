/**
 * Friends + bots — proxy to CatsCo.
 *
 * CatsCo owns the social graph. Sumi just forwards the caller's JWT and
 * returns a merged list:
 *   { users: [...], agents: [...] }
 *
 * Each row carries a ready-to-use `subjectId` for /api/projects/:id/members.
 */

import { actorFromRequest } from "@/lib/http-auth";

const CATSCO_BASE_URL = (
  process.env.CATSCO_BASE_URL || "http://localhost:8080"
).replace(/\/+$/, "");

interface CatsCoUser {
  uid: number;
  username: string;
  display_name?: string;
  avatar_url?: string;
  account_type?: number; // 0=human, 1=bot, 2=agent…
  owner?: { uid: number; username?: string; display_name?: string };
}

async function catsGet<T>(path: string, token: string): Promise<T | null> {
  try {
    const res = await fetch(`${CATSCO_BASE_URL}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const actor = await actorFromRequest(request);
  if (!actor || actor.kind !== "user") {
    return Response.json({ error: "user required" }, { status: 403 });
  }

  // Recover the raw JWT — we need to forward it to CatsCo.
  const auth = request.headers.get("authorization") || "";
  const url = new URL(request.url);
  const token = auth.startsWith("Bearer ")
    ? auth.slice(7)
    : url.searchParams.get("token") || "";
  if (!token) {
    return Response.json({ error: "no bearer token" }, { status: 400 });
  }

  // Fire both in parallel — friends (users) and my bots (agents).
  const [friendsRes, botsRes] = await Promise.all([
    catsGet<{ friends: CatsCoUser[] }>("/api/friends", token),
    catsGet<{ bots: CatsCoUser[] }>("/api/bots", token),
  ]);

  const users = (friendsRes?.friends ?? [])
    .filter((u) => u && u.uid)
    .map((u) => ({
      subjectId: `u${u.uid}`,
      uid: u.uid,
      username: u.username,
      displayName: u.display_name || u.username,
      avatarUrl: u.avatar_url,
      kind: "user" as const,
    }));

  const agents = (botsRes?.bots ?? [])
    .filter((b) => b && b.uid)
    .map((b) => ({
      subjectId: `a${b.uid}`,
      uid: b.uid,
      username: b.username,
      displayName: b.display_name || b.username,
      avatarUrl: b.avatar_url,
      kind: "agent" as const,
      ownerUid: b.owner?.uid,
    }));

  return Response.json({ users, agents });
}

// ---------------------------------------------------------------------------
// POST — share Sumi with a friend / send onboarding to a bot
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  const actor = await actorFromRequest(request);
  if (!actor || actor.kind !== "user") {
    return Response.json({ error: "user required" }, { status: 403 });
  }

  const auth = request.headers.get("authorization") || "";
  const url = new URL(request.url);
  const token = auth.startsWith("Bearer ")
    ? auth.slice(7)
    : url.searchParams.get("token") || "";
  if (!token) {
    return Response.json({ error: "no bearer token" }, { status: 400 });
  }

  const body = (await request.json()) as {
    subjectId?: string;
    kind?: "user" | "agent";
    projectId?: string;
    projectName?: string;
  };
  if (!body.subjectId || !body.kind) {
    return Response.json(
      { error: "subjectId + kind required" },
      { status: 400 }
    );
  }

  const { subjectId, kind, projectId, projectName } = body;

  if (kind === "user") {
    // -- Send the friend a link to Sumi via CatsCo's messaging ----------
    const shareUrl = `${process.env.NEXT_PUBLIC_SUMI_URL || "http://localhost:3000"}/?invite=${encodeURIComponent(
      subjectId
    )}${projectId ? `&project=${encodeURIComponent(projectId)}` : ""}`;

    const res = await fetch(`${CATSCO_BASE_URL}/api/notifications`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        to: subjectId,
        type: "share_link",
        payload: {
          app: "Sumi",
          url: shareUrl,
          message: `${actor.name} 邀请你加入 Sumi 项目「${projectName || projectId || "一个项目"}」`,
        },
      }),
    });
    if (!res.ok) {
      return Response.json(
        { error: `cats-co push failed (${res.status})` },
        { status: 502 }
      );
    }
    return Response.json({ ok: true, type: "link", url: shareUrl });
  }

  if (kind === "agent") {
    // -- Send the bot a setup prompt — the bot's owner reads it in CatsCo
    // and pastes it into their agent runtime. The prompt tells the bot to
    // install sumi-kit, set env vars, and connect.
    const setupUrl = `${process.env.NEXT_PUBLIC_SUMI_URL || "http://localhost:3000"}/api/projects/${projectId}/agent-setup?fileId=README.md`;

    const prompt = `# Sumi 协作 — agent 接入指南

你被邀请加入 Sumi 项目「${projectName || projectId}」。

## 快速接入

\`\`\`bash
export SUMI_BASE_URL="${process.env.NEXT_PUBLIC_SUMI_URL || "http://localhost:3000"}"
export SUMI_API_KEY="cc_..."   # 你的 CatsCo ApiKey

# 1. 安装 sumi-kit（如果还没有）
# curl -fsSL https://github.com/buildsense-ai/sumi/raw/main/sumi-kit/install.py | python3 -

# 2. 验证连接
sumi whoami

# 3. 拿完整的 agent prompt（推荐 — 有项目上下文）
sumi get-onboard-prompt --project ${projectId} --file README.md
\`\`\`

或者一次性看 prompt：

\`\`\`bash
curl -H "Authorization: Bearer $SUMI_API_KEY" "${setupUrl}" | jq -r .instructions
\`\`\`
`;

    const res = await fetch(`${CATSCO_BASE_URL}/api/notifications`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        to: subjectId,
        type: "agent_onboard",
        payload: {
          app: "Sumi",
          projectId,
          instructions: prompt,
        },
      }),
    });
    if (!res.ok) {
      return Response.json(
        { error: `cats-co push failed (${res.status})` },
        { status: 502 }
      );
    }
    return Response.json({ ok: true, type: "prompt", subjectId });
  }

  return Response.json({ error: "invalid kind" }, { status: 400 });
}
