/**
 * SSE subscription to `api/ui/events`.
 *
 * The server emits `ready` on open, `ui_patch` per patch, and `ping` as a
 * heartbeat. A patch can open a document, select a sidebar tab, or announce a
 * pending edit — each of which the workspace reacts to directly.
 *
 * Every tab also carries a `clientId`. It is what lets a call address this page
 * in particular, and what lets the answer say which page produced it, so two
 * tabs of the same person are no longer interchangeable.
 */

import { onCleanup } from "solid-js";
import { apiPath, readToken } from "./api";
import type { PendingEdit } from "./api";
import { runAgentCall, type AgentCallName } from "./agent-bridge";

const CLIENT_KEY = "sumi.client";

/**
 * This tab's id.
 *
 * `sessionStorage` is the right scope: it survives a reload of this tab, and it
 * is not shared with the tab next to it, which is exactly the granularity an
 * agent needs to keep two open workspaces apart.
 */
function clientId(): string {
  try {
    const existing = sessionStorage.getItem(CLIENT_KEY);
    if (existing) return existing;
    const created =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `c_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem(CLIENT_KEY, created);
    return created;
  } catch {
    return `c_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

export const thisClientId = clientId();

/** Report what a ui-sdk agent call returned to the request waiting on it. */
async function reportAgentResult(payload: Record<string, unknown>): Promise<void> {
  const token = readToken();
  await fetch(apiPath("/api/agent/result"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ ...payload, clientId: thisClientId }),
    credentials: "same-origin",
  });
}

/**
 * Requests already answered in this tab.
 *
 * Kept even though a call can now be addressed: an aggregated read is
 * deliberately delivered to every page, and the same id must not be run twice
 * within one page if a frame is replayed on reconnect.
 */
const answered = new Set<string>();

/**
 * Tell the server which document this tab is showing.
 *
 * The SSE stream registers the page once, with whatever was known at connect
 * time — which for a tab that landed on the project list is no document at all.
 * This keeps the entry's document current so a page can be named by what it
 * shows. It is routing metadata: presence is still the Yjs room's awareness, and
 * a page that never announces is still addressable by its id.
 */
export async function announcePage(
  projectId: string | null,
  filePath: string | null
): Promise<void> {
  const token = readToken();
  await fetch(apiPath("/api/ui/page"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ clientId: thisClientId, projectId, filePath }),
    credentials: "same-origin",
  }).catch(() => {
    // A missed announcement only costs a label; the page stays addressable.
  });
}

export interface UiPatch {
  type: string;
  [key: string]: unknown;
}

export interface UiEventHandlers {
  onPatch?: (patch: UiPatch) => void;
  onPendingEdit?: (edit: PendingEdit | null) => void;
  onReady?: (info: { connected: boolean; projectId: string | null }) => void;
  onStatus?: (state: "open" | "closed") => void;
}

export interface UiEventOptions {
  /**
   * The document this tab is showing, as a getter.
   *
   * A getter, not a value: the stream opens before the first document is
   * selected, so a snapshot taken at connect time is `null` for exactly the tabs
   * that need labelling most.
   */
  getFilePath?: () => string | null;
}

export function connectUiEvents(
  projectId: string | null,
  handlers: UiEventHandlers,
  options: UiEventOptions = {}
): () => void {
  const url = new URL(apiPath("/api/ui/events"), window.location.origin);
  if (projectId) url.searchParams.set("projectId", projectId);
  // The registry keys a page by these two, so it can be named later.
  url.searchParams.set("clientId", thisClientId);
  const initialFilePath = options.getFilePath?.() ?? null;
  if (initialFilePath) url.searchParams.set("filePath", initialFilePath);
  const token = readToken();
  if (token) url.searchParams.set("token", token);

  const source = new EventSource(url.toString());

  source.addEventListener("ready", (event) => {
    handlers.onStatus?.("open");
    try {
      handlers.onReady?.(JSON.parse((event as MessageEvent).data));
    } catch {
      handlers.onReady?.({ connected: true, projectId });
    }
  });

  source.addEventListener("ui_patch", (event) => {
    try {
      const patch = JSON.parse((event as MessageEvent).data) as UiPatch;
      handlers.onPatch?.(patch);
      if (patch.type === "pending_edit_changed") {
        handlers.onPendingEdit?.((patch.edit ?? null) as PendingEdit | null);
      }
      if (patch.type === "agent_call") {
        const target = typeof patch.targetClientId === "string" ? patch.targetClientId : "";
        // Addressed to another page: not ours to run.
        if (target && target !== thisClientId) return;
        const requestId = String(patch.requestId ?? "");
        if (!requestId || answered.has(requestId)) return;
        answered.add(requestId);
        if (answered.size > 200) {
          const oldest = answered.values().next().value;
          if (oldest) answered.delete(oldest);
        }
        void runAgentCall(
          {
            requestId,
            call: (patch.call ?? "snapshot") as AgentCallName,
            input: patch.input,
          },
          (payload) =>
            reportAgentResult({
              ...payload,
              projectId: projectId ?? undefined,
              filePath: options.getFilePath?.() ?? null,
            })
        );
      }
    } catch {
      // A malformed frame is the server's bug, not a reason to tear the stream down.
    }
  });

  source.addEventListener("ping", () => {
    handlers.onStatus?.("open");
  });

  source.addEventListener("error", () => {
    // EventSource reconnects on its own; report the dip so the shell can show it.
    handlers.onStatus?.("closed");
  });

  onCleanup(() => source.close());
  return () => source.close();
}