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
