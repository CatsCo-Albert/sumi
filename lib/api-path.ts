/**
 * API paths under a deploy-time base path.
 *
 * Next.js rewrites `/_next/...` asset URLs when `basePath` is set, but it does
 * not touch paths written by hand in `fetch` or `new EventSource`. Behind the
 * artifact gateway, which strips `/<app-id>/` before forwarding, a literal
 * `/api/auth/me` therefore resolves against the gateway root and 404s — the app
 * then concludes nobody is signed in and shows the token form even though the
 * gateway already authenticated the visitor.
 *
 * NEXT_PUBLIC_BASE_PATH is inlined into the client bundle at build time, and is
 * empty for a root-served deployment, so this is a no-op there.
 */

export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";

/** Prefix an absolute in-app path with the deployment base path. */
export function apiPath(path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${BASE_PATH}${suffix}`;
}
