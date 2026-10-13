/**
 * Apply a pending edit — push the new content through the ws-server so every
 * connected client converges via Yjs.
 *
 * POST body: { projectId, filePath, blocks: EditBlock[], editId? }
 */

import { actorFromRequest } from "@/lib/http-auth";
import { getDb } from "@/src/db";
import { projectRoleFor } from "@/src/auth/actor";
import crypto from "crypto";

const WS_PORT = process.env.WS_PORT ? parseInt(process.env.WS_PORT, 10) : 1234;
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET || "";

export async function POST(request: Request) {
  const actor = await actorFromRequest(request);
  if (!actor) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }

  const { projectId, filePath, blocks } = (await request.json()) as {
    projectId?: string;
    filePath?: string;
    blocks?: Array<{ startLine: number; endLine: number; updated: string }>;
  };

  if (!projectId || !filePath || !Array.isArray(blocks)) {
    return Response.json(
      { error: "projectId, filePath, blocks required" },
      { status: 400 }
    );
  }

  const db = await getDb();
  const role = projectRoleFor(db, projectId, actor.id);
  if (role !== "owner" && role !== "editor") {
    return Response.json({ error: "editor role required" }, { status: 403 });
  }

  // Push to ws-server — it owns in-memory Yjs docs + broadcasts updates.
  const fileId = encodeURIComponent(filePath);
  const wsUrl = `http://localhost:${WS_PORT}/doc/${projectId}/${fileId}`;

  try {
    const res = await fetch(wsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // internal-secret bypasses client auth for backend-mediated writes
        "x-internal-secret": INTERNAL_SECRET,
      },
      body: JSON.stringify({ blocks }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return Response.json(
        { error: data.error || "ws-server apply failed" },
        { status: res.status }
      );
    }
    return Response.json({ ok: true, roomName: `${projectId}-${filePath}` });
  } catch (err) {
    return Response.json(
      { error: `ws-server unreachable: ${String(err)}` },
      { status: 502 }
    );
  }
}
