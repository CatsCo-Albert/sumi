/**
 * Gateway viewer identity — the platform-native way to identify a visitor.
 *
 * Deployed behind the CatsCo artifact gateway, the browser carries no Bearer
 * token. The gateway exchanges a one-time launch code for a viewer cookie, and
 * an application learns who is visiting by forwarding that cookie to the
 * gateway's own viewer endpoint. Trust comes from the gateway answering, not
 * from anything verified locally — so this path needs neither the shared JWT
 * secret nor the account-introspection service token.
 *
 * Opt-in via CATSCO_ARTIFACT_APP_ID, which leaves the self-hosted token paths
 * in ./catsco.ts as the default for a bare deployment.
 */

const REQUEST_TIMEOUT_MS = 5_000;

export interface GatewayViewer {
  /** Stable per-application pseudonym for this visitor. */
  id: string;
  uid: number;
  username?: string;
  kind?: string;
}

function gatewayUrl(): string {
  return (process.env.CATSCO_GATEWAY_URL || "https://artifact.catsco.cc").replace(
    /\/+$/,
    ""
  );
}

export function artifactAppId(): string {
  return process.env.CATSCO_ARTIFACT_APP_ID || "";
}

export function gatewayViewerEnabled(): boolean {
  return Boolean(artifactAppId());
}

type HeaderBag = Record<string, string | string[] | undefined>;

function headerValue(headers: HeaderBag, name: string): string {
  const raw = headers[name];
  if (!raw) return "";
  return Array.isArray(raw) ? raw.join("; ") : raw;
}

/**
 * Ask the gateway who this request belongs to.
 *
 * Returns null for an anonymous visitor, for an unreachable gateway and for any
 * unusable answer. Callers must treat null as "not authenticated" rather than
 * as an error — the gateway being down must degrade to a guest, never to an
 * accidental administrator.
 */
export async function resolveGatewayViewer(
  headers: HeaderBag
): Promise<GatewayViewer | null> {
  const appId = artifactAppId();
  if (!appId) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${gatewayUrl()}/_gateway/me?app=${encodeURIComponent(appId)}`,
      {
        headers: {
          cookie: headerValue(headers, "cookie"),
          authorization: headerValue(headers, "authorization"),
        },
        signal: controller.signal,
      }
    );
    if (!res.ok) return null;

    const body = (await res.json()) as {
      authenticated?: boolean;
      viewer?: { id?: string; uid?: number; username?: string; kind?: string };
    };
    if (!body.authenticated || !body.viewer) return null;

    const uid = Number(body.viewer.uid);
    if (!Number.isFinite(uid) || uid <= 0) return null;

    return {
      id: String(body.viewer.id || `u${uid}`),
      uid,
      username: body.viewer.username,
      kind: body.viewer.kind,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
