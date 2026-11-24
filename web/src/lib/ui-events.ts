/**
 * SSE subscription to `api/ui/events`.
 *
 * The server emits `ready` on open, `ui_patch` per patch, and `ping` as a
 * heartbeat. A patch can open a document, select a sidebar tab, or announce a
 * pending edit — each of which the workspace reacts to directly.
 */

import { onCleanup } from "solid-js";
import { apiPath, readToken } from "./api";
import type { PendingEdit } from "./api";
import { runAgentCall, type AgentCallName } from "./agent-bridge";

/** Report what a ui-sdk agent call returned to the HTTP request waiting on it. */
async function reportAgentResult(payload: Record<string, unknown>): Promise<void> {
  const token = readToken();
  await fetch(apiPath("/api/agent/result"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
    credentials: "same-origin",
  });
}

/**
 * Requests already answered in this tab.
 *
 * Two tabs both hear the same broadcast, and the second answer arrives after
 * the first already settled the call. Acting twice is the real hazard — a
 * `press` must not happen twice — so the id is claimed before it runs.
 */
const answered = new Set<string>();

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

export function connectUiEvents(projectId: string | null, handlers: UiEventHandlers): () => void {
  const url = new URL(apiPath("/api/ui/events"), window.location.origin);
  if (projectId) url.searchParams.set("projectId", projectId);
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
        const requestId = String(patch.requestId ?? "");
        if (!requestId || answered.has(requestId)) return;
        answered.add(requestId);
        if (answered.size > 200) {
          // Bounded: the ids are only useful for the seconds a call lives.
          const oldest = answered.values().next().value;
          if (oldest) answered.delete(oldest);
        }
        void runAgentCall(
          {
            requestId,
            call: (patch.call ?? "snapshot") as AgentCallName,
            input: patch.input,
          },
          reportAgentResult
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
