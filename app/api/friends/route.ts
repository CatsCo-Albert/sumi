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
    }));

  return Response.json({ users, agents });
}
