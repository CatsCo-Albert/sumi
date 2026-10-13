/**
 * CatsCo identity integration.
 *
 * Two inbound credential types:
 *
 *   1. JWT (HS256, issuer "catscompany")
 *      - minted by cats-company for browser + persistent sessions
 *      - verified locally with shared OC_JWT_SECRET
 *      - claims: { userId, username, email, token_type }
 *
 *   2. ApiKey (`cc_{hex uid}_{random}` — bots/agents)
 *      - opaque random suffix — can't verify locally
 *      - calls CatsCo `POST /api/account/introspect` with a `Service` token
 *      - returns the bot's uid; we treat it as an "agent" principal
 *
 * A third internal flow exists for CLIs:
 *   - CLI connects with its own `cc_*` ApiKey and Sumi proxies
 *     introspection; clients never need to know Sumi's secret.
 */

import * as jose from "jose";
import crypto from "crypto";

// ---------------------------------------------------------------------------
// Env config
// ---------------------------------------------------------------------------

const CATSCO_BASE_URL = (
  process.env.CATSCO_BASE_URL || "http://localhost:8080"
).replace(/\/+$/, "");

const CATSCO_SERVICE_TOKEN = process.env.CATSCO_SERVICE_TOKEN || "";

const JWT_SECRET = process.env.OC_JWT_SECRET || "";

const INTROSPECT_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// JWT verification (local)
// ---------------------------------------------------------------------------

export interface CatsCoUser {
  uid: number;
  username: string;
  email?: string;
  /** "user" | "user_persistent" */
  tokenType?: string;
}

export async function verifyCatsCoJwt(
  token: string
): Promise<CatsCoUser | null> {
  if (!JWT_SECRET) return null;
  try {
    const secret = new TextEncoder().encode(JWT_SECRET);
    const { payload } = await jose.jwtVerify(token, secret, {
      issuer: "catscompany",
    });
    const tokenType = payload.token_type as string | undefined;
    if (tokenType && tokenType !== "user" && tokenType !== "user_persistent") {
      return null;
    }
    const uid = payload.userId as number | undefined;
    const username = payload.username as string | undefined;
    if (!uid || !username) return null;
    return {
      uid,
      username,
      email: payload.email as string | undefined,
      tokenType,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// ApiKey introspection (remote)
// ---------------------------------------------------------------------------

export interface CatsCoAgent {
  uid: number;
  username: string;
  displayName?: string;
  ownerUid?: number;
  ownerUsername?: string;
}

export interface IntrospectResult {
  active: boolean;
  user?: {
    uid: number;
    username: string;
    email?: string;
    display_name?: string;
    avatar_url?: string;
    account_type: number; // 0=human, 1=bot, 2=agent…
    state: number;
    owner?: { uid: number; username?: string; display_name?: string };
  };
  claims?: {
    issuer: string;
    issued_at: string | null;
    expires_at: string | null;
  };
  error?: string;
}

/**
 * Call CatsCo's introspection endpoint. The Service token is ours — clients
 * never see it. Returns null if CATSCO_SERVICE_TOKEN isn't configured.
 */
export async function introspectToken(
  token: string
): Promise<IntrospectResult | null> {
  if (!CATSCO_SERVICE_TOKEN) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INTROSPECT_TIMEOUT_MS);
  try {
    const res = await fetch(`${CATSCO_BASE_URL}/api/account/introspect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Service ${CATSCO_SERVICE_TOKEN}`,
      },
      body: JSON.stringify({ token }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as IntrospectResult;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Actor resolution — drop-in for the local-auth version
// ---------------------------------------------------------------------------

import type { Actor } from "./actor";

export type { Actor };

/**
 * Resolve an actor from a cats-co token or ApiKey.
 *
 * Order:
 *   1. JWT verify (local, fast)
 *   2. ApiKey introspect (remote, slower — cache if needed)
 */
export async function resolveCatsCoActor(token: string): Promise<Actor | null> {
  if (!token) return null;

  // Try JWT first (user sessions)
  const jwtUser = await verifyCatsCoJwt(token);
  if (jwtUser) {
    return {
      kind: "user",
      id: `u${jwtUser.uid}`,
      uid: jwtUser.uid,
      name: jwtUser.username,
      username: jwtUser.username,
    };
  }

  // ApiKey path — must be a cc_* key and introspected remotely.
  if (!token.startsWith("cc_")) return null;
  const introspect = await introspectToken(token);
  if (!introspect || !introspect.active || !introspect.user) return null;

  const u = introspect.user;
  const isBot = u.account_type !== 0; // non-human accounts act as agents
  return {
    kind: isBot ? "agent" : "user",
    id: `${isBot ? "a" : "u"}${u.uid}`,
    uid: u.uid,
    name: u.display_name || u.username,
    username: u.username,
    avatarUrl: u.avatar_url,
    ownerUid: u.owner?.uid,
  };
}

/**
 * Extract a cats-co credential from a request — either Bearer (JWT) or
 * ApiKey (cc_*). Query params mirror CatsCo's extraction: `?token=`, `?api_key=`.
 */
export function extractCatsCoCredential(
  authHeader: string | null | undefined,
  urlSearchParams?: URLSearchParams
): { kind: "jwt" | "apikey"; token: string } | null {
  const auth = (authHeader || "").trim();
  if (auth.startsWith("Bearer ")) {
    const t = auth.slice(7).trim();
    if (t) return { kind: "jwt", token: t };
  }
  if (auth.startsWith("ApiKey ")) {
    const t = auth.slice(7).trim();
    if (t) return { kind: "apikey", token: t };
  }
  const qToken = urlSearchParams?.get("token");
  if (qToken) return { kind: "jwt", token: qToken };
  const qKey = urlSearchParams?.get("api_key");
  if (qKey) return { kind: "apikey", token: qKey };
  return null;
}

// ---------------------------------------------------------------------------
// Role / membership — CatsCo projects are stored in Sumi's own sqlite for now.
// We keep a thin "membership mirror" so Sumi can gate without calling out
// to CatsCo on every request.
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic "actor key" used in project_members.subject_id.
 * Users: "u{uid}"; agents: "a{uid}".
 */
export function actorKey(kind: "user" | "agent", uid: number): string {
  return kind === "user" ? `u${uid}` : `a${uid}`;
}

export function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}
