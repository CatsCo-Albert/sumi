import { getDb } from "@/src/db";
import {
  grantMembership,
  revokeMembership,
  listMembers,
  getSubject,
} from "@/src/auth/identity";
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
  return Response.json({ members: listMembers(db, projectId) });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const actor = await actorForProject(request, projectId);
  if (!actor || actor.projectRole !== "owner") {
    return Response.json({ error: "owner only" }, { status: 403 });
  }
  const body = (await request.json()) as {
    subjectId?: string;
    role?: "viewer" | "editor";
  };
  if (!body.subjectId || !body.role) {
    return Response.json({ error: "subjectId and role required" }, { status: 400 });
  }
  const db = await getDb();
  if (!getSubject(db, body.subjectId)) {
    return Response.json(
      { error: "unknown subjectId — subject must have connected at least once" },
      { status: 400 }
    );
  }
  grantMembership(db, {
    projectId,
    subjectId: body.subjectId,
    role: body.role,
    grantedBy: actor.id,
  });
  return Response.json({ ok: true }, { status: 201 });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const actor = await actorForProject(request, projectId);
  if (!actor || actor.projectRole !== "owner") {
    return Response.json({ error: "owner only" }, { status: 403 });
  }
  const { subjectId } = (await request.json()) as { subjectId?: string };
  if (!subjectId) {
    return Response.json({ error: "subjectId required" }, { status: 400 });
  }
  const db = await getDb();
  const ok = revokeMembership(db, projectId, subjectId);
  if (!ok) {
    return Response.json({ error: "membership not found" }, { status: 404 });
  }
  return Response.json({ ok: true });
}
