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
  // Include the local status flag on each member so the UI can grey out
  // disabled agents.
  const rows = listMembers(db, projectId).map((m) => {
    const subj = getSubject(db, m.subjectId) as
      | (ReturnType<typeof getSubject> & { status?: string | null })
      | null;
    return { ...m, status: (subj as { status?: string | null })?.status ?? null };
  });
  return Response.json({ members: rows });
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

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const actor = await actorForProject(request, projectId);
  if (!actor || actor.projectRole !== "owner") {
    return Response.json({ error: "owner only" }, { status: 403 });
  }
  const { subjectId, status } = (await request.json()) as {
    subjectId?: string;
    status?: "active" | "disabled";
  };
  if (!subjectId || !status) {
    return Response.json({ error: "subjectId + status required" }, { status: 400 });
  }
  if (!subjectId.startsWith("a")) {
    return Response.json({ error: "only agents can be disabled" }, { status: 400 });
  }
  const db = await getDb();
  const res = db
    .prepare("UPDATE subjects SET status = ? WHERE subject_id = ?")
    .run(status, subjectId);
  if (res.changes === 0) {
    return Response.json({ error: "subject not found" }, { status: 404 });
  }
  return Response.json({ ok: true });
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
