/**
 * A tiny path router.
 *
 * The workspace is one screen with a selectable project and document; the only
 * URLs worth keeping are `/` and `/<projectId>/<fileId>`. Rather than pull in
 * the v2 router's route-tree machinery for two shapes, this reads the base
 * path out of `location` and writes it back on selection, so a document stays
 * shareable and the browser's back button still works.
 */

import { createSignal } from "solid-js";
import { BASE_PATH } from "./api";

const [route, setRoute] = createSignal(read());

function stripBase(pathname: string): string {
  if (BASE_PATH && pathname.startsWith(BASE_PATH)) {
    return pathname.slice(BASE_PATH.length) || "/";
  }
  return pathname;
}

function read(): { projectId: string | null; fileId: string | null } {
  if (typeof window === "undefined") return { projectId: null, fileId: null };
  const parts = stripBase(window.location.pathname)
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);
  return { projectId: parts[0] ?? null, fileId: parts.length > 1 ? parts.slice(1).join("/") : null };
}

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => setRoute(read()));
}

/** Replace the address bar without a reload; `null`s address the base root. */
export function navigateTo(projectId: string | null, fileId: string | null) {
  const segments = [projectId, fileId].filter((s): s is string => Boolean(s));
  const path = `${BASE_PATH}/${segments.map(encodeURIComponent).join("/")}`.replace(/\/$/, "");
  window.history.pushState({}, "", path || `${BASE_PATH}/`);
  setRoute({ projectId, fileId });
}

export const currentRoute = route;
