/**
 * Asset upload — images + small binary files attached to a project.
 *
 * Storage layout: sumi/{projectId}/assets/{hash}.{ext}
 * Served back via GET on the same endpoint.
 *
 * POST /api/projects/:id/assets   multipart/form-data or raw body
 *   headers: x-file-name (optional), content-type
 *   → { key, url, size, contentType }
 * GET  /api/projects/:id/assets?key=…  → binary stream
 * DELETE /api/projects/:id/assets {key}
 */

import { getDb } from "@/src/db";
import { actorForProject } from "@/lib/http-auth";
import { getStorage } from "@/src/storage";
import crypto from "crypto";

const MAX_ASSET_BYTES = 10 * 1024 * 1024; // 10 MB

const assetKey = (projectId: string, fileName: string) => {
  const ext = fileName.split(".").pop() || "bin";
  const rand = crypto.randomBytes(6).toString("hex");
  return `sumi/${projectId}/assets/${Date.now()}_${rand}.${ext}`;
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const actor = await actorForProject(request, projectId);
  if (!actor || actor.projectRole === "viewer") {
    return Response.json({ error: "editor role required" }, { status: 403 });
  }

  const fileName =
    request.headers.get("x-file-name") || `upload-${Date.now()}.bin`;
  const contentType = request.headers.get("content-type") || "application/octet-stream";

  const buf = Buffer.from(await request.arrayBuffer());
  if (buf.length === 0) {
    return Response.json({ error: "empty body" }, { status: 400 });
  }
  if (buf.length > MAX_ASSET_BYTES) {
    return Response.json({ error: "asset too large (max 10MB)" }, { status: 413 });
  }

  const key = assetKey(projectId, fileName);
  const storage = await getStorage();
  await storage.upload(key, buf, contentType);

  const url = `/api/projects/${projectId}/assets?key=${encodeURIComponent(key)}`;
  return Response.json({ key, url, size: buf.length, contentType }, { status: 201 });
}

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
  const key = url.searchParams.get("key") || "";
  if (!key || !key.startsWith(`sumi/${projectId}/`)) {
    return Response.json({ error: "invalid key" }, { status: 400 });
  }
  const storage = await getStorage();
  if (!(await storage.exists(key))) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  const buf = await storage.download(key);
  const contentType = key.endsWith(".png")
    ? "image/png"
    : key.endsWith(".jpg") || key.endsWith(".jpeg")
    ? "image/jpeg"
    : key.endsWith(".gif")
    ? "image/gif"
    : key.endsWith(".webp")
    ? "image/webp"
    : key.endsWith(".svg")
    ? "image/svg+xml"
    : "application/octet-stream";
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const actor = await actorForProject(request, projectId);
  if (!actor || actor.projectRole === "viewer") {
    return Response.json({ error: "editor role required" }, { status: 403 });
  }
  const { key } = (await request.json()) as { key?: string };
  if (!key || !key.startsWith(`sumi/${projectId}/`)) {
    return Response.json({ error: "invalid key" }, { status: 400 });
  }
  const storage = await getStorage();
  await storage.delete(key);
  return Response.json({ ok: true });
}
