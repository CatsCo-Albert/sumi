import { getDb } from "@/src/db";
import { getProject } from "@/src/auth/identity";
import { actorForProject } from "@/lib/http-auth";

export async function PATCH(
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
  // Owner-only mutation, same rule as DELETE.
  if (project.ownerUid !== actor.id) {
    return Response.json({ error: "owner_only" }, { status: 403 });
  }

  const body = (await request.json()) as {
    name?: string;
    description?: string | null;
    tags?: string[];
    archived?: boolean;
  };

  const sets: string[] = ["updated_at = ?"];
  const vals: unknown[] = [Date.now()];

  if (typeof body.name === "string" && body.name.trim()) {
    sets.push("name = ?");
    vals.push(body.name.trim());
  }
  if (body.description !== undefined) {
    sets.push("description = ?");
    vals.push(body.description ?? null);
  }
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags)) {
      return Response.json({ error: "tags must be an array" }, { status: 400 });
    }
    sets.push("tags = ?");
    vals.push(JSON.stringify(body.tags.filter((t) => typeof t === "string")));
  }
  if (body.archived !== undefined) {
    sets.push("archived = ?");
    vals.push(body.archived ? 1 : 0);
  }

  vals.push(projectId);
  db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(
    ...(vals as never[])
  );

  return Response.json({ project: getProject(db, projectId) });
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
  const db = await getDb();
  const project = getProject(db, projectId);
  if (!project) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  return Response.json({ project });
}

export async function DELETE(
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
  // Only owner can delete a project.
  if (project.ownerUid !== actor.id) {
    return Response.json({ error: "owner_only" }, { status: 403 });
  }
  db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
  // project_members + documents cascade via ON DELETE CASCADE.
  return Response.json({ ok: true });
}
