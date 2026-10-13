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
  return Response.json({ project });
}
