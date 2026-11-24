/**
 * Agent bridge, agent-facing side.
 *
 * `POST /api/agent/call` — run one ui-sdk agent call (`snapshot` / `query` /
 * `act`) against the caller's own open page, and answer with what it returned.
 *
 * The page is the only place that can do this: `@ui-sdk/core/agent` reads live
 * component instances, which exist in a browser and nowhere else. So this
 * endpoint publishes the request on the UI event bus and waits for the page to
 * post its answer to `/api/agent/result`.
 *
 * It targets the calling subject rather than "anyone in the project": a step
 * that presses a button must run in exactly one page, and the caller is the one
 * who is looking at the result.
 */

import { actorForProject } from "@/lib/http-auth";
import { callAgent, type AgentCall } from "@/src/ui-bus/agent-bridge";

const CALLS: readonly AgentCall[] = ["snapshot", "query", "act"] as const;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    projectId?: string;
    call?: string;
    input?: unknown;
    timeoutMs?: number;
  };

  const projectId = body.projectId;
  const call = body.call as AgentCall | undefined;

  if (!projectId || !call || !CALLS.includes(call)) {
    return Response.json(
      { error: `projectId and call (${CALLS.join(" | ")}) required` },
      { status: 400 }
    );
  }

  const actor = await actorForProject(request, projectId);
  if (!actor) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const value = await callAgent({
      projectId,
      userId: actor.id,
      call,
      input: body.input ?? {},
      timeoutMs: body.timeoutMs,
    });
    return Response.json({ ok: true, value });
  } catch (error) {
    // A page nobody has open is a 503, not a 500: the request was fine, the
    // workspace simply was not there to run it.
    const message = (error as Error).message ?? String(error);
    const unavailable = message.includes("no page answered");
    return Response.json(
      { error: unavailable ? "workspace_not_open" : "agent_call_failed", detail: message },
      { status: unavailable ? 503 : 502 }
    );
  }
}
