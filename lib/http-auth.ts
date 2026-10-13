/**
 * Next.js Request ↔ actor resolution glue — CatsCo edition.
 *
 * Accepts the same credentials cats-company does:
 *   - Authorization: Bearer <jwt>
 *   - Authorization: ApiKey <cc_...>
 *   - ?token=<jwt> / ?api_key=<cc_...>
 *
 * Cookie-based browser sessions are not implemented yet: the sign-in screen
 * stores the token in sessionStorage and sends it as a Bearer header. Keep this
 * list in sync with `extractCredential` in src/auth/actor.ts.
 */

import { getDb } from "@/src/db";
import {
  resolveActor as resolveWsActor,
  projectRoleFor,
  type Actor,
  type EffectiveRole,
} from "@/src/auth/actor";
import type { IncomingMessage } from "http";

export type { Actor, EffectiveRole };

/** Adapt a Web Request to a minimal IncomingMessage-shaped object for actor.ts. */
function toIncomingMessage(request: Request): IncomingMessage {
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  return { headers } as unknown as IncomingMessage;
}

/** Resolve the actor from a Web Request. */
export async function actorFromRequest(
  request: Request
): Promise<Actor | null> {
  const url = new URL(request.url);

  // Synthesize an IncomingMessage so we can reuse the ws-server resolver.
  const req = toIncomingMessage(request);
  const db = await getDb();
  return resolveWsActor(db, req, url);
}

/** Resolve + check project role. */
export async function actorForProject(
  request: Request,
  projectId: string
): Promise<Actor | null> {
  const actor = await actorFromRequest(request);
  if (!actor) return null;
  const db = await getDb();
  const role = projectRoleFor(db, projectId, actor.id);
  if (!role) return null;
  return { ...actor, projectRole: role };
}
