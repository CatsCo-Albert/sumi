/**
 * Actor resolution — CatsCo edition.
 *
 * Inbound credentials (mirrors cats-company's extractor order):
 *   - Authorization: Bearer <jwt>          — human user JWT
 *   - Authorization: ApiKey <cc_...>       — bot/agent API key
 *   - ?token=<jwt>                         — same as Bearer, for WS clients
 *   - ?api_key=<cc_...>                    — same as ApiKey, for WS clients
 *
 * JWT is verified locally with shared OC_JWT_SECRET.
 * ApiKey is verified via CatsCo's `POST /api/account/introspect`
 * (called with our `Service` token).
 *
 * Result carries projectRole — looked up in Sumi's project_members table.
 */

import crypto from "crypto";
import type { IncomingMessage } from "http";
import type { DatabaseSync } from "node:sqlite";
import {
  verifyCatsCoJwt,
  introspectToken,
  actorKey,
} from "./catsco";
import { upsertSubject } from "./identity";

export type ActorKind = "user" | "agent";
export type EffectiveRole = "owner" | "editor" | "viewer" | null;

export interface Actor {
  kind: ActorKind;
  /** Sumi subject id — "u{uid}" or "a{uid}" */
  id: string;
  /** Raw CatsCo uid */
  uid: number;
  name: string;
  username?: string;
  avatarUrl?: string;
  /** For agents: the uid of the human who owns them */
  ownerUid?: number;
  projectRole?: EffectiveRole;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

interface Extracted {
  kind: "jwt" | "apikey";
  token: string;
}

export function extractCredential(
  req: IncomingMessage,
  url: URL
): Extracted | null {
  const auth = (req.headers.authorization as string | undefined) || "";
  if (auth.startsWith("Bearer ")) {
    const t = auth.slice(7).trim();
    if (t) return { kind: "jwt", token: t };
  }
  if (auth.startsWith("ApiKey ")) {
    const t = auth.slice(7).trim();
    if (t) return { kind: "apikey", token: t };
  }
  const qToken = url.searchParams.get("token");
  if (qToken) return { kind: "jwt", token: qToken };
  const qKey = url.searchParams.get("api_key");
  if (qKey) return { kind: "apikey", token: qKey };
  return null;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export async function resolveActor(
  db: DatabaseSync,
  req: IncomingMessage,
  url: URL
): Promise<Actor | null> {
  const cred = extractCredential(req, url);
  if (!cred) return null;

  // --- JWT path (users) -----------------------------------------------------
  if (cred.kind === "jwt") {
    const u = await verifyCatsCoJwt(cred.token);
    if (!u) return null;
    const subjectId = actorKey("user", u.uid);
    // Cache display info
    upsertSubjectSafe(db, {
      subjectId,
      kind: "user",
      displayName: u.username,
      username: u.username,
    });
    return {
      kind: "user",
      id: subjectId,
      uid: u.uid,
      name: u.username,
      username: u.username,
    };
  }

  // --- ApiKey path (agents/bots) -------------------------------------------
  const introspect = await introspectToken(cred.token);
  if (!introspect?.active || !introspect.user) return null;
  const u = introspect.user;
  const isAgent = u.account_type !== 0; // non-human accounts act as agents
  const subjectId = actorKey(isAgent ? "agent" : "user", u.uid);

  // Check local disable flag — project owners can quarantine an agent without
  // touching CatsCo. Disabled agents are rejected here.
  if (isAgent) {
    const row = db
      .prepare("SELECT status FROM subjects WHERE subject_id = ?")
      .get(subjectId) as { status: string | null } | undefined;
    if (row?.status === "disabled") return null;
  }

  upsertSubjectSafe(db, {
    subjectId,
    kind: isAgent ? "agent" : "user",
    displayName: u.display_name || u.username,
    username: u.username,
    avatarUrl: u.avatar_url,
    ownerUid: u.owner?.uid,
  });
  return {
    kind: isAgent ? "agent" : "user",
    id: subjectId,
    uid: u.uid,
    name: u.display_name || u.username,
    username: u.username,
    avatarUrl: u.avatar_url,
    ownerUid: u.owner?.uid,
  };
}

/** Best-effort subject upsert — never fails the auth path. */
function upsertSubjectSafe(
  db: DatabaseSync,
  input: Parameters<typeof upsertSubject>[1]
): void {
  try {
    upsertSubject(db, input);
  } catch {
    // non-fatal — subject cache is optional
  }
}

// ---------------------------------------------------------------------------
// Role check
// ---------------------------------------------------------------------------

export function projectRoleFor(
  db: DatabaseSync,
  projectId: string,
  subjectId: string
): EffectiveRole {
  const row = db
    .prepare("SELECT owner_uid AS ownerUid FROM projects WHERE id = ?")
    .get(projectId) as { ownerUid: string } | undefined;
  if (!row) return null;
  if (row.ownerUid === subjectId) return "owner";

  const member = db
    .prepare(
      "SELECT role FROM project_members WHERE project_id = ? AND subject_id = ?"
    )
    .get(projectId, subjectId) as { role: "viewer" | "editor" | "owner" } | undefined;
  return member?.role ?? null;
}
