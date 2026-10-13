import { getDb } from "@/src/db";
import { createProject, listProjectsForSubject } from "@/src/auth/identity";
import { actorFromRequest } from "@/lib/http-auth";

export async function GET(request: Request) {
  const actor = await actorFromRequest(request);
  if (!actor) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  const db = await getDb();
  const projects = listProjectsForSubject(db, actor.id);
  return Response.json({ projects });
}

export async function POST(request: Request) {
  const actor = await actorFromRequest(request);
  if (!actor || actor.kind !== "user") {
    return Response.json({ error: "human user required" }, { status: 403 });
  }
  const { name } = (await request.json()) as { name?: string };
  if (!name) {
    return Response.json({ error: "name required" }, { status: 400 });
  }
  const db = await getDb();
  const project = createProject(db, { name, ownerSubjectId: actor.id });
  return Response.json({ project }, { status: 201 });
}
