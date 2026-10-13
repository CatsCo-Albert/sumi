/**
 * Document content persistence — read/write the canonical file on disk.
 *
 * The Yjs doc is authoritative while anyone is connected; this endpoint reads
 * (and writes) the persisted file used to seed a fresh Yjs room.
 *
 *   GET  ?projectId=…&filePath=…  → { content, updatedAt }
 *   PUT  { projectId, filePath, content }  → writes file + notifies ws-server
 */

import { actorFromRequest } from "@/lib/http-auth";
import { getDb } from "@/src/db";
import { projectRoleFor } from "@/src/auth/actor";
import { getStorage } from "@/src/storage";
import crypto from "crypto";

const WS_PORT = process.env.WS_PORT ? parseInt(process.env.WS_PORT, 10) : 12345;
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET || "";

const docKey = (projectId: string, filePath: string) =>
  `sumi/${projectId}/files/${filePath}`;

const hashContent = (buf: Buffer | string) =>
  crypto.createHash("sha256").update(buf).digest("hex");

export async function GET(request: Request) {
  const actor = await actorFromRequest(request);
  if (!actor) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId") || "";
  const filePath = url.searchParams.get("filePath") || "";
  if (!projectId || !filePath) {
    return Response.json(
      { error: "projectId and filePath required" },
      { status: 400 }
    );
  }

  const db = await getDb();
  const role = projectRoleFor(db, projectId, actor.id);
  if (!role) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const storage = await getStorage();
  const key = docKey(projectId, filePath);
  const exists = await storage.exists(key);
  if (!exists) {
    return Response.json({ content: "", exists: false, contentHash: null });
  }
  const buf = await storage.download(key);
  const info = await storage.list(docKey(projectId, filePath));
  return Response.json({
    content: buf.toString("utf8"),
    exists: true,
    contentHash: hashContent(buf),
    updatedAt: info[0]?.lastModified.toISOString(),
  });
}

export async function PUT(request: Request) {
  const actor = await actorFromRequest(request);
  if (!actor) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { projectId, filePath, content, baseContentHash, force } =
    (await request.json()) as {
      projectId?: string;
      filePath?: string;
      content?: string;
      /** sha256 of the content this write is based on — optimistic lock. */
      baseContentHash?: string;
      /** Skip the hash check entirely. */
      force?: boolean;
    };
  if (!projectId || !filePath || typeof content !== "string") {
    return Response.json(
      { error: "projectId, filePath, content required" },
      { status: 400 }
    );
  }

  const db = await getDb();
  const role = projectRoleFor(db, projectId, actor.id);
  if (role !== "owner" && role !== "editor") {
    return Response.json({ error: "editor role required" }, { status: 403 });
  }

  const storage = await getStorage();
  const key = docKey(projectId, filePath);

  // Optimistic concurrency: if the caller claims a base hash, verify it.
  // Mismatch → 409 FILE_CONFLICT (mirrors the paperanim contract — callers
  // should re-GET, decide whether to overwrite with the fresh hash, or
  // hand off to human review).
  if (baseContentHash && !force && (await storage.exists(key))) {
    const current = await storage.download(key);
    const currentHash = hashContent(current);
    if (currentHash !== baseContentHash) {
      return Response.json(
        {
          error: "content changed since your read",
          errorCode: "FILE_CONFLICT",
          currentHash,
        },
        { status: 409 }
      );
    }
  }

  await storage.upload(key, content, "text/markdown");
  const contentHash = hashContent(content);

  // Push into Yjs so connected clients see it without a refresh.
  const wsUrl = `http://localhost:${WS_PORT}/replace/${projectId}/${encodeURIComponent(filePath)}`;
  try {
    await fetch(wsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": INTERNAL_SECRET,
      },
      body: JSON.stringify({ content }),
    });
  } catch {
    // ws-server unreachable is non-fatal; next sync will reload from storage
  }

  return Response.json({ ok: true, contentHash });
}
