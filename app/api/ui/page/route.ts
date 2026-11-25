/**
 * `POST /api/ui/page` — a page says which document it is showing.
 *
 * The SSE connection already registers the page, but only with what is known at
 * connect time: a tab that lands on the project list has no document yet, and
 * the one it opens later is not in the URL the stream was opened with. Without
 * this the registry can address a page but cannot say what it is showing, which
 * is the difference between "page 3f2a" and "the page showing 产品概述.md".
 *
 * This is routing metadata, not presence: presence stays the Yjs room's
 * awareness, and a page that never reports here is still reachable by id.
 */

import { actorFromRequest } from "@/lib/http-auth";
import { touchPage } from "@/src/ui-bus/page-registry";

export async function POST(request: Request) {
  const actor = await actorFromRequest(request);
  if (!actor) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    clientId?: string;
    projectId?: string | null;
    filePath?: string | null;
  };

  const clientId = (body.clientId ?? "").trim();
  if (!clientId) {
    return Response.json({ error: "clientId required" }, { status: 400 });
  }

  touchPage(actor.id, clientId, {
    projectId: body.projectId ?? null,
    filePath: body.filePath ?? null,
  });

  return new Response(null, { status: 204 });
}