"use client";

/**
 * Intent store — agent-ask threads for the current document scope.
 *
 * Mirrors edit-store: the AI chat panel hydrates `intents` via GET
 * /api/intents, then SSE `intent_*` patches keep it live. `scope` is the
 * projectId/fileId the panel is currently viewing — patches for other
 * docs are ignored.
 */

import { create } from "zustand";
import type { UiPatch } from "@/src/a2ui/schema";
import type { IntentRow } from "@/src/intents";

export interface IntentScope {
  projectId: string | null;
  fileId: string | null;
}

interface IntentStoreState {
  scope: IntentScope;
  /** Raw list — newest first (matches API ordering). */
  intents: IntentRow[];

  setScope: (scope: IntentScope) => void;
  setIntents: (rows: IntentRow[]) => void;
  upsertIntent: (row: IntentRow) => void;
  /** Route a validated intent_* SSE patch into the list, scoped. */
  applyIntentPatch: (patch: UiPatch) => void;
}

function isIntentPatch(patch: UiPatch): boolean {
  return (
    patch.type === "intent_created" ||
    patch.type === "intent_claimed" ||
    patch.type === "intent_answered" ||
    patch.type === "intent_closed"
  );
}

export const useIntentStore = create<IntentStoreState>((set, get) => ({
  scope: { projectId: null, fileId: null },
  intents: [],

  setScope: (scope) => set({ scope }),
  setIntents: (rows) => set({ intents: rows }),

  upsertIntent: (row) =>
    set((s) => {
      const idx = s.intents.findIndex((i) => i.id === row.id);
      return {
        intents:
          idx === -1
            ? [row, ...s.intents]
            : s.intents.map((i) => (i.id === row.id ? row : i)),
      };
    }),

  applyIntentPatch: (patch) => {
    if (!isIntentPatch(patch)) return;
    const p = patch as Extract<
      UiPatch,
      {
        type:
          | "intent_created"
          | "intent_claimed"
          | "intent_answered"
          | "intent_closed";
      }
    >;
    const { scope } = get();
    if (!scope.projectId || p.projectId !== scope.projectId) return;
    // null fileId scope = project-wide view (no doc open); otherwise filter.
    if (scope.fileId && p.fileId !== scope.fileId) return;

    // DELETE broadcasts only { intentId } — drop the row entirely.
    if (p.type === "intent_closed" && !p.intent && p.intentId) {
      set((s) => ({ intents: s.intents.filter((i) => i.id !== p.intentId) }));
      return;
    }

    const row = p.intent as IntentRow | undefined;
    if (!row?.id) return;
    get().upsertIntent(row);
  },
}));
