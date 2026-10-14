/**
 * /api/page-state/:projectId — proxy to ws-server's admin endpoint.
 *
 * The real aggregation lives on the WS server (awareness). This route
 * forwards the request so the client doesn't need to know the WS port.
 */

import { actorForProject } from "@/lib/http-auth";

const WS_HTTP_BASE = (
  process.env.SUMI_WS_HTTP_URL ||
  (process.env.SUMI_WS_URL || "ws://localhost:12345")
    .replace("ws://", "http://")
    .replace("wss://", "https://")
).replace(/\/+$/, "");

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const actor = await actorForProject(request, projectId);
  if (!actor) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const res = await fetch(`${WS_HTTP_BASE}/page-state/${projectId}`, {
      headers: {
        ...(process.env.INTERNAL_API_SECRET
          ? { "x-internal-secret": process.env.INTERNAL_API_SECRET }
          : {}),
      },
      cache: "no-store",
    });
    if (!res.ok) {
      return Response.json(
        { error: `ws server ${res.status}` },
        { status: 502 }
      );
    }
    return Response.json(await res.json());
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502 });
  }
}
