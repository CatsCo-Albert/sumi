/**
 * TAP ghost-text completion — 给编辑器提供 Cursor 风格的续写建议。
 *
 * POST body: { projectId, fileId, prefix, suffix }
 * Response:  { suggestion: string, action: "insert" | "complete_word" | "fix" | "skip" }
 *
 * 未配置 OPENAI_API_KEY 时直接返回 skip，不报错 —— TAP 是可选增强。
 * 核心逻辑在 src/tap.ts（route 文件不允许非 HTTP 导出）。
 */

import { actorFromRequest } from "@/lib/http-auth";
import { getDb } from "@/src/db";
import { projectRoleFor } from "@/src/auth/actor";
import { requestTapSuggestion, type TapRequestBody } from "@/src/tap";

// ---------------------------------------------------------------------------
// 限流：每个 subjectId 30 req/min（内存计数器，单实例足够）
// ---------------------------------------------------------------------------

const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;
const rateCounters = new Map<string, { count: number; resetAt: number }>();

function rateLimited(subjectId: string): boolean {
  const now = Date.now();
  const entry = rateCounters.get(subjectId);
  if (!entry || now >= entry.resetAt) {
    rateCounters.set(subjectId, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT;
}

// 防止 map 无限膨胀 —— 惰性清理过期条目
function pruneRateCounters() {
  const now = Date.now();
  if (rateCounters.size < 1024) return;
  for (const [k, v] of rateCounters) {
    if (now >= v.resetAt) rateCounters.delete(k);
  }
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  // 没配 key 时连 auth 都不用走 —— 直接 skip
  if (!process.env.OPENAI_API_KEY) {
    return Response.json({ suggestion: "", action: "skip" });
  }

  const actor = await actorFromRequest(request);
  if (!actor) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }

  const body = (await request.json()) as TapRequestBody;
  if (!body.projectId || !body.fileId) {
    return Response.json(
      { error: "projectId, fileId required" },
      { status: 400 }
    );
  }

  const db = await getDb();
  const role = projectRoleFor(db, body.projectId, actor.id);
  if (!role) {
    return Response.json({ error: "project access required" }, { status: 403 });
  }

  pruneRateCounters();
  if (rateLimited(actor.id)) {
    return Response.json({ error: "rate limited" }, { status: 429 });
  }

  const result = await requestTapSuggestion(body);
  return Response.json(result);
}
