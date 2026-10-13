"use client";

/**
 * useUiEvents — subscribe to the SSE endpoint and dispatch patches into the store.
 *
 * Mirrors paperanim's events route semantics:
 *   - server sends `event: ui_patch` + `data: <UiPatch JSON>`
 *   - handshake emits `ready`, heartbeat emits `ping`
 *   - reconnect replays missed events via the durable log
 */

import { useEffect, useRef } from "react";
import { useUiStore } from "@/stores/ui-store";
import { validateUiPatch } from "@/src/a2ui/validate";
import { getStoredToken } from "./use-session";

export interface UseUiEventsOptions {
  /** Optional server filter; the endpoint also accepts this. */
  projectId?: string | null;
  /** Custom SSE endpoint (defaults to /api/ui/events). */
  endpoint?: string;
  /** Disable entirely (e.g. server-rendered shell). */
  enabled?: boolean;
}

export function useUiEvents({
  projectId,
  endpoint = "/api/ui/events",
  enabled = true,
}: UseUiEventsOptions = {}) {
  const applyUiPatch = useUiStore((s) => s.applyUiPatch);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;

    const url = new URL(endpoint, window.location.origin);
    if (projectId) url.searchParams.set("projectId", projectId);
    const token = getStoredToken();
    if (token) url.searchParams.set("token", token);

    const source = new EventSource(url.toString());
    sourceRef.current = source;

    source.addEventListener("ui_patch", (e) => {
      try {
        const payload = JSON.parse((e as MessageEvent).data);
        const patch = validateUiPatch(payload);
        if (patch) applyUiPatch(patch);
      } catch {
        // drop malformed frames
      }
    });

    return () => {
      source.close();
      sourceRef.current = null;
    };
  }, [endpoint, projectId, enabled, applyUiPatch]);
}
