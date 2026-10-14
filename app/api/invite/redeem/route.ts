/**
 * POST /api/invite/redeem — join a project as viewer via an invite link.
 *
 * Unlike POST /members (owner-only), this lets any authenticated user
 * add themselves to a project they have the invite link for.
 *
 * body: { projectId }
 */

import { getDb } from "@/src/db";
import { grantMembership } from "@/src/auth/identity";
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
