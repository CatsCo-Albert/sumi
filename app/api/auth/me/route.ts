import { actorFromRequest } from "@/lib/http-auth";
import { getDb } from "@/src/db";
import { listProjectsForSubject } from "@/src/auth/identity";

export async function GET(request: Request) {
  const actor = await actorFromRequest(request);
  if (!actor) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  const db = await getDb();
  const projects = listProjectsForSubject(db, actor.id);
  return Response.json({ actor, projects });
}
