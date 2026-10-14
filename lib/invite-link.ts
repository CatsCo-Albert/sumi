/**
 * Absolute URL for a project invite link.
 *
 * Built here rather than inline in the component because the obvious inline
 * form — `${window.location.origin}/?invite=…` — silently drops the deployment
 * base path. Behind the artifact gateway the app is served at `/<app-id>/`, so
 * that URL points at the gateway root and 404s: the link the panel says it
 * copied would not work for whoever received it.
 */

import { apiPath } from "./api-path";

/** `origin` + the deployment base path + the invite query. */
export function inviteUrl(projectId: string, origin: string): string {
  return `${origin}${apiPath(`/?invite=${encodeURIComponent(projectId)}`)}`;
}
