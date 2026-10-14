/**
 * POST /api/invite/redeem — join a project as viewer via an invite link.
 *
 * Unlike POST /members (owner-only), this lets any authenticated user add
 * themselves to a project they have the invite link for.
 *
 * body: { projectId }
 */

import { getDb } from "@/src/db";
import { getProject, grantMembership } from "@/src/auth/identity";
import { projectRoleFor } from "@/src/auth/actor";
import { actorFromRequest } from "@/lib/http-auth";

export async function POST(request: Request) {
  const actor = await actorFromRequest(request);
  if (!actor || actor.kind !== "user") {
    return Response.json({ error: "user required" }, { status: 403 });
  }
  const body = (await request.json()) as { projectId?: string };
  if (!body.projectId) {
    return Response.json({ error: "projectId required" }, { status: 400 });
  }
  const db = await getDb();

  // Without this the insert hit the project_members FK and came back as a 500
  // "FOREIGN KEY constraint failed", which reads like a server fault for what
  // is simply an unknown or deleted project.
  if (!getProject(db, body.projectId)) {
    return Response.json({ error: "project not found" }, { status: 404 });
  }

  // Already in the project — leave the existing role alone.
  //
  // grantMembership upserts with `DO UPDATE SET role = excluded.role`, so
  // redeeming an invite used to rewrite the caller's row to "viewer": an editor
  // who opened a colleague's link silently lost edit rights. Redeeming a link
  // may add a membership, never lower one.
  if (projectRoleFor(db, body.projectId, actor.id)) {
    return Response.json({
      ok: true,
      subjectId: actor.id,
      alreadyMember: true,
    });
  }

  try {
    grantMembership(db, {
      projectId: body.projectId,
      subjectId: actor.id,
      role: "viewer",
      grantedBy: `invite:${actor.id}`,
    });
    return Response.json({ ok: true, subjectId: actor.id });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
