import { actorFromRequest } from "@/lib/http-auth";

export async function GET(request: Request) {
  const actor = await actorFromRequest(request);
  if (!actor) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  return Response.json({ actor });
}
