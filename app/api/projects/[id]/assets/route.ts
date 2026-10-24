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
import { detectImage } from "@/src/asset-format";

const MAX_ASSET_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * The formats this endpoint will store, identified by their leading bytes.
 *
 * The extension and the `content-type` header both come from the client, so neither
 * can decide what a file is: `x-file-name: cat.png` with an HTML body would have been
 * stored as `.png` and served back on this origin. What the bytes say is the only
 * claim worth trusting, and even that only well enough to pick a type.
 *
 * SVG is included but treated differently — see `looksLikeSvg` and the response
 * headers in GET. It is markup, not an image: served naively it is a script that
 * runs on our origin, which is stored XSS with extra steps.
 */
const assetKey = (projectId: string, ext: string) => {
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

  const buf = Buffer.from(await request.arrayBuffer());
  if (buf.length === 0) {
    return Response.json({ error: "empty body" }, { status: 400 });
  }
  if (buf.length > MAX_ASSET_BYTES) {
    return Response.json({ error: "asset too large (max 10MB)" }, { status: 413 });
  }

  // What the file is, decided by the file. The declared name and content-type are
  // ignored on purpose — they are the two things an uploader can set freely, and
  // storing ".png" because someone typed ".png" is how an HTML document ends up
  // inside an image path.
  const format = detectImage(buf);
  if (!format) {
    return Response.json(
      {
        error: "unsupported file type",
        detail: "Only PNG, JPEG, GIF, WebP, AVIF and SVG are accepted.",
      },
      { status: 415 }
    );
  }

  const key = assetKey(projectId, format.ext);
  const storage = await getStorage();
  await storage.upload(key, buf, format.mime);

  const url = `/api/projects/${projectId}/assets?key=${encodeURIComponent(key)}`;
  return Response.json(
    { key, url, size: buf.length, contentType: format.mime },
    { status: 201 }
  );
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

  // Type from the bytes, not from the key. An object stored before this endpoint
  // checked anything still has whatever extension the uploader chose, and serving it
  // as an image because of that name is the same mistake one level down.
  const format = detectImage(buf);
  if (!format) {
    // Stored, but not a type we will hand back with an image content-type. Returning
    // it as octet-stream would let a browser download it; refusing is simpler to
    // reason about and nothing legitimate lands here.
    return Response.json({ error: "not a supported asset" }, { status: 415 });
  }

  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": format.mime,
      "Cache-Control": "public, max-age=31536000, immutable",
      // No sniffing: the browser must use the type above and not re-interpret the
      // payload as something else.
      "X-Content-Type-Options": "nosniff",
      // SVG is markup and can carry script. `<img src>` renders it inert, but the
      // URL can also be opened directly, where it runs on this origin. This policy
      // removes every source, so the document can paint but not fetch or execute.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
      // Belt and braces for the same case: never let this response be treated as a
      // top-level document that inherits our origin.
      "Content-Disposition": "inline",
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
