import { getDb } from "@/src/db";
import { upsertDocument, listDocuments } from "@/src/auth/identity";
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
  return Response.json({ documents: listDocuments(db, projectId) });
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
  const { fileId, title } = (await request.json()) as {
    fileId?: string;
    title?: string;
  };
  if (!fileId) {
    return Response.json({ error: "fileId required" }, { status: 400 });
  }
  const db = await getDb();
  const doc = upsertDocument(db, { projectId, fileId, title });
  return Response.json({ document: doc }, { status: 201 });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const actor = await actorForProject(request, projectId);
  if (!actor || actor.projectRole === "viewer") {
    return Response.json({ error: "editor role required" }, { status: 403 });
  }
  const { fileId, title, newFileId } = (await request.json()) as {
    fileId?: string;
    title?: string | null;
    newFileId?: string;
  };
  if (!fileId) {
    return Response.json({ error: "fileId required" }, { status: 400 });
  }
  const db = await getDb();
  // Rename fileId or update title
  if (newFileId && newFileId !== fileId) {
    const res = db
      .prepare(
        "UPDATE documents SET id = ?, file_id = ?, updated_at = ? WHERE project_id = ? AND file_id = ?"
      )
      .run(`${projectId}-${newFileId}`, newFileId, Date.now(), projectId, fileId);
    if (res.changes === 0) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    // Also move the physical file
    const { getStorage } = await import("@/src/storage");
    const storage = await getStorage();
    const oldKey = `sumi/${projectId}/files/${fileId}`;
    const newKey = `sumi/${projectId}/files/${newFileId}`;
    if (await storage.exists(oldKey)) {
      const buf = await storage.download(oldKey);
      await storage.upload(newKey, buf, "text/markdown");
      await storage.delete(oldKey);
    }
  }
  if (title !== undefined) {
    db.prepare(
      "UPDATE documents SET title = ?, updated_at = ? WHERE project_id = ? AND file_id = ?"
    ).run(title, Date.now(), projectId, newFileId ?? fileId);
  }
  const doc = db
    .prepare(
      `SELECT id, project_id AS projectId, file_id AS fileId, title,
              created_at AS createdAt, updated_at AS updatedAt
       FROM documents WHERE project_id = ? AND file_id = ?`
    )
    .get(projectId, newFileId ?? fileId);
  return Response.json({ document: doc });
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
  const { fileId } = (await request.json()) as { fileId?: string };
  if (!fileId) {
    return Response.json({ error: "fileId required" }, { status: 400 });
  }
  const db = await getDb();
  const res = db
    .prepare("DELETE FROM documents WHERE project_id = ? AND file_id = ?")
    .run(projectId, fileId);
  if (res.changes === 0) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  return Response.json({ ok: true });
}
