/**
 * Agent bridge, page-facing side.
 *
 * `POST /api/agent/result` — the page reports what a ui-sdk agent call returned.
 *
 * The request id is the one the page received over SSE, and `clientId` is the
 * page's own identity: together they say which page answered. Without the
 * second half, an aggregated read could not tell three answers apart and an
 * addressed write could not be checked against the page it was meant for.
 *
 * An id nobody waits on is answered 204 either way: a second tab replying to the
 * same request, a page the call did not address, or a reply that lost the race
 * with the timeout are all expected rather than errors.
 */

import { actorFromRequest } from "@/lib/http-auth";
import { settleAgentCall } from "@/src/ui-bus/agent-bridge";
import { touchPage } from "@/src/ui-bus/page-registry";
import { recordMarks } from "@/src/ui-bus/mark-ledger";

export async function POST(request: Request) {
  const actor = await actorFromRequest(request);
  if (!actor) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    requestId?: string;
    clientId?: string;
    projectId?: string;
    filePath?: string | null;
    ok?: boolean;
    value?: unknown;
    error?: string;
    /** What the page actually read or changed, written here rather than by the agent. */
    marks?: unknown;
  };

  if (!body.requestId || typeof body.ok !== "boolean") {
    return Response.json(
      { error: "requestId and ok required" },
      { status: 400 }
    );
  }

  const clientId = (body.clientId ?? "").trim();
  if (!clientId) {
    // A page that does not identify itself cannot be addressed, and answering
    // for it would quietly reintroduce "whichever replied first".
    return Response.json({ error: "clientId required" }, { status: 400 });
  }

  if (body.projectId) {
    touchPage(actor.id, clientId, {
      projectId: body.projectId,
      ...(body.filePath !== undefined ? { filePath: body.filePath } : {}),
    });
  }

  /**
   * The page writes the record, not the agent: a call that returns success while
   * having done nothing is the failure worth catching, and an agent's own report
   * cannot tell that apart from a real read.
   */
  if (body.projectId && Array.isArray(body.marks) && body.marks.length > 0) {
    recordMarks({
      requestId: body.requestId,
      clientId,
      userId: actor.id,
      projectId: body.projectId,
      filePath: body.filePath ?? null,
      marks: body.marks,
    });
  }

  settleAgentCall(
    body.requestId,
    clientId,
    body.ok
      ? { ok: true, value: body.value ?? null }
      : { ok: false, error: body.error ?? "agent call failed" },
    body.filePath ?? null
  );

  return new Response(null, { status: 204 });
}