/**
 * Agent bridge, page-facing side.
 *
 * `POST /api/agent/result` — the page reports what a ui-sdk agent call returned.
 *
 * The request id in the body is the one the page received over SSE, so the
 * answer is matched to the HTTP call still waiting on it. An id nobody waits on
 * is answered 204: a second tab replying to the same request, or a reply that
 * lost the race with the timeout, is expected rather than an error.
 */

import { actorFromRequest } from "@/lib/http-auth";
import { settleAgentCall } from "@/src/ui-bus/agent-bridge";

export async function POST(request: Request) {
  const actor = await actorFromRequest(request);
  if (!actor) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    requestId?: string;
    ok?: boolean;
    value?: unknown;
    error?: string;
  };

  if (!body.requestId || typeof body.ok !== "boolean") {
    return Response.json(
      { error: "requestId and ok required" },
      { status: 400 }
    );
  }

  const settled = settleAgentCall(
    body.requestId,
    body.ok
      ? { ok: true, value: body.value ?? null }
      : { ok: false, error: body.error ?? "agent call failed" },
    actor.id
  );

  return new Response(null, { status: settled ? 204 : 204 });
}
