/**
 * Internal publish endpoint — lets agents / backend emit UiPatch events
 * which are then fanned out to all connected clients via SSE.
 *
 * Auth: `x-internal-secret: $INTERNAL_API_SECRET` (timing-safe).
 */

import { publishUiPatch } from "@/src/ui-bus/event-bus";
import { validateUiPatch } from "@/src/a2ui/validate";
import crypto from "crypto";

function checkAuth(req: Request): boolean {
  const expected = process.env.INTERNAL_API_SECRET;
  if (!expected) return false;
  const provided = req.headers.get("x-internal-secret") || "";
  if (!provided) return false;
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(provided);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  if (!checkAuth(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const { userId, projectId, patch, source } = body as {
    userId?: string;
    projectId?: string;
    patch?: unknown;
    source?: "external_agent" | "system" | "internal_agent";
  };

  if (!userId || !projectId) {
    return Response.json(
      { error: "userId and projectId required" },
      { status: 400 }
    );
  }

  const validated = validateUiPatch(patch);
  if (!validated) {
    return Response.json({ error: "invalid patch" }, { status: 400 });
  }

  const event = await publishUiPatch({
    userId,
    projectId,
    patch: validated,
    source: source || "external_agent",
  });

  return Response.json({ ok: true, eventId: event.id });
}
