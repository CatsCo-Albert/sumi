/**
 * `POST /api/artifacts/report` — the page tells Sumi what a person just did, and
 * Sumi forwards it to the dashboard so the conversation can wake.
 *
 * The page cannot call the dashboard itself: it is served from a public preview
 * origin, and the dashboard listens on loopback with no CORS headers. This route
 * is the hop that already sits on the right side of that boundary.
 *
 * A failure to forward is reported, not swallowed. "The bot will not hear you"
 * is information the person needs; a 200 with an empty body would be a lie the
 * page could not distinguish from success.
 */

import { actorFromRequest } from "@/lib/http-auth";
import {
  ArtifactBridgeClient,
  configuredArtifactId,
  configuredSessionKey,
  rememberBridgeState,
  type Interaction,
} from "@/src/artifacts/bridge";

const KINDS = new Set(["a2ui_action", "a2ui_form_submit", "a2ui_state_change"]);

function readInteractions(value: unknown): Interaction[] {
  if (!Array.isArray(value)) return [];
  const out: Interaction[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const kind = typeof record.kind === "string" ? record.kind : "";
    const componentId = typeof record.componentId === "string" ? record.componentId.trim() : "";
    // Unknown kinds are dropped rather than forwarded: the dashboard would reject
    // the whole batch, and one malformed entry must not lose the rest.
    if (!KINDS.has(kind) || !componentId) continue;
    out.push({
      kind: kind as Interaction["kind"],
      componentId,
      ...(typeof record.actionName === "string" ? { actionName: record.actionName } : {}),
      ...(record.params && typeof record.params === "object"
        ? { params: record.params as Record<string, unknown> }
        : {}),
      ...(record.formData && typeof record.formData === "object"
        ? { formData: record.formData as Record<string, unknown> }
        : {}),
      ...(record.state && typeof record.state === "object"
        ? { state: record.state as Record<string, unknown> }
        : {}),
      ...(record.previousState && typeof record.previousState === "object"
        ? { previousState: record.previousState as Record<string, unknown> }
        : {}),
      ...(typeof record.clientEventId === "string" ? { clientEventId: record.clientEventId } : {}),
    });
  }
  return out;
}

export async function POST(request: Request) {
  const actor = await actorFromRequest(request);
  if (!actor) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { interactions?: unknown };
  const interactions = readInteractions(body.interactions);
  if (interactions.length === 0) {
    return Response.json({ error: "interactions required" }, { status: 400 });
  }

  const artifactId = configuredArtifactId();
  const sessionKey = configuredSessionKey();
  if (!artifactId || !sessionKey) {
    // Nothing to forward to, and saying so is the whole value of this route.
    return Response.json(
      {
        ok: false,
        reason: "unconfigured",
        error:
          "CATSCO_ARTIFACT_APP_ID and SUMI_ARTIFACT_SESSION_KEY must be set for the page to reach the bot",
      },
      { status: 409 }
    );
  }

  const client = new ArtifactBridgeClient();
  const result = await client.emit({ artifactId, sessionKey, interactions });

  if (!result.ok) {
    rememberBridgeState({
      artifactId,
      attached: false,
      sessionKey,
      lastError: result,
      at: Date.now(),
    });
    // 403 from the dashboard means its intake gate is closed; telling the page
    // 502 would hide a configuration problem behind a transport word.
    const status = result.reason === "disabled" ? 403 : result.reason === "rejected" ? 422 : 502;
    return Response.json(
      { ok: false, reason: result.reason, code: result.code, error: result.message },
      { status }
    );
  }

  return Response.json({ ok: true, ...result.value });
}