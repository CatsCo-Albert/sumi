"use client";

/**
 * useUiEvents — subscribe to the SSE endpoint and dispatch patches into the store.
 *
 * Mirrors the reference events route semantics:
 *   - server sends `event: ui_patch` + `data: <UiPatch JSON>`
 *   - handshake emits `ready`, heartbeat emits `ping`
 *   - reconnect replays missed events via the durable log
 */

import { useEffect, useRef } from "react";
import { useUiStore } from "@/stores/ui-store";
import { useEditStore } from "@/stores/edit-store";
import { useIntentStore } from "@/stores/intent-store";
import { validateUiPatch } from "@/src/a2ui/validate";
import { getStoredToken } from "./use-session";
import { apiPath } from "./api-path";

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
        if (!patch) return;
        applyUiPatch(patch);

        // Intent lifecycle — feed the AI chat panel's thread list.
        if (
          patch.type === "intent_created" ||
          patch.type === "intent_claimed" ||
          patch.type === "intent_answered" ||
          patch.type === "intent_closed"
        ) {
          useIntentStore.getState().applyIntentPatch(patch);
        }

        // Hydrate the pending-edit store for diff decorations.
        if (patch.type === "pending_edit_changed") {
          const editStore = useEditStore.getState();
          if (patch.edit === null) {
            // Edit was removed (rejected / applied / cleaned up). The apply path
            // already clears it locally on accept — this catches rejections
            // and remote cleanups.
            // We can't know which edit without an id, so re-fetch the list.
            void refetchPendingEdits(patch.projectId, patch.fileId);
          } else {
            const e0 = patch.edit as {
              id?: string;
              projectId?: string;
              filePath?: string;
              fileId?: string;
              blocks?: unknown[];
              description?: string;
              status?: string;
              createdAt?: number;
              authorId?: string;
              authorName?: string;
            };
            if (e0.id && e0.projectId) {
              editStore.upsertPendingEdit({
                id: e0.id,
                projectId: e0.projectId,
                filePath: (e0.filePath ?? e0.fileId ?? patch.fileId) as string,
                blocks: (e0.blocks ?? []) as never,
                description: e0.description,
                status: "pending",
                createdAt: e0.createdAt ?? Date.now(),
                authorId: e0.authorId,
                authorName: e0.authorName,
              });
            }
          }
        }
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

// ---------------------------------------------------------------------------
// Pending-edit refetch — called when a `pending_edit_changed` patch has
// `edit: null` (deletion signal; we need to refresh the whole list).
// ---------------------------------------------------------------------------

async function refetchPendingEdits(projectId: string, fileId?: string): Promise<void> {
  const url = new URL(apiPath("/api/pending-edits"), window.location.origin);
  url.searchParams.set("projectId", projectId);
  if (fileId) url.searchParams.set("fileId", fileId);
  const token = getStoredToken();
  if (!token) return;
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => null);
  if (!res?.ok) return;
  const { edits } = await res.json();
  useEditStore.getState().setPendingEdits(edits ?? []);
}
