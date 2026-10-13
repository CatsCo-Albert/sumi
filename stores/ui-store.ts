"use client";

/**
 * Workspace UI store — applies UiPatch commands pushed by the SSE endpoint.
 *
 * Pattern lifted from paperanim's workspace-ui-store: each patch sets the
 * appropriate state slice AND fires a `blockAttentionSignal` so the shell
 * can flash which pane changed.
 */

import { create } from "zustand";
import type {
  UiPatch,
  WorkspaceMainBlock,
  PanelName,
} from "@/src/a2ui/schema";

export type AttentionTarget = "editor" | "sidebar" | "ai" | "inspector" | "graph" | "preview" | "management";

export interface AttentionSignal {
  id: string;
  target: AttentionTarget;
  reason: "ui_patch" | "cross_tab_insert" | "navigation";
}

export interface PromptCommand {
  id: string;
  prompt: string;
  autoSend: boolean;
}

export interface FocusRangeCommand {
  id: string;
  documentId: string;
  startLine: number;
  endLine: number;
}

interface UiStoreState {
  currentDocumentId: string | null;
  activeMainBlock: WorkspaceMainBlock;
  panelVisibility: Record<PanelName, boolean>;
  panelWidth: Record<PanelName, number>;
  attentionSignal: AttentionSignal | null;
  promptCommand: PromptCommand | null;
  pendingPromptCommands: PromptCommand[];
  focusRangeCommand: FocusRangeCommand | null;

  setCurrentDocumentId: (id: string | null) => void;
  setActiveMainBlock: (block: WorkspaceMainBlock) => void;
  setPanelVisibility: (panel: PanelName, visible: boolean) => void;
  setPanelWidth: (panel: PanelName, widthPercent: number) => void;
  triggerAttention: (target: AttentionTarget, reason?: AttentionSignal["reason"]) => void;
  consumeAttention: () => void;
  consumePromptCommand: () => void;
  consumeFocusRange: () => void;
  applyUiPatch: (patch: UiPatch) => void;
}

const signal = (target: AttentionTarget, reason: AttentionSignal["reason"] = "ui_patch"): AttentionSignal => ({
  id: `attention-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  target,
  reason,
});

export const useUiStore = create<UiStoreState>((set, get) => ({
  currentDocumentId: null,
  activeMainBlock: "editor",
  panelVisibility: { sidebar: true, ai: false, inspector: false },
  panelWidth: { sidebar: 22, ai: 34, inspector: 26 },
  attentionSignal: null,
  promptCommand: null,
  pendingPromptCommands: [],
  focusRangeCommand: null,

  setCurrentDocumentId: (id) =>
    set((state) => ({
      currentDocumentId: id,
      activeMainBlock:
        id && state.currentDocumentId !== id
          ? state.activeMainBlock === "management" ? "editor" : state.activeMainBlock
          : !id && state.activeMainBlock !== "editor" && state.activeMainBlock !== "management"
            ? "editor"
            : state.activeMainBlock,
    })),

  setActiveMainBlock: (block) =>
    set((state) => ({
      activeMainBlock:
        !state.currentDocumentId && block !== "editor" && block !== "management"
          ? "editor"
          : block,
    })),

  setPanelVisibility: (panel, visible) =>
    set((state) => ({
      panelVisibility: { ...state.panelVisibility, [panel]: visible },
    })),

  setPanelWidth: (panel, widthPercent) =>
    set((state) => ({
      panelWidth: {
        ...state.panelWidth,
        [panel]: Math.max(10, Math.min(90, widthPercent)),
      },
    })),

  triggerAttention: (target, reason) =>
    set({ attentionSignal: signal(target, reason) }),
  consumeAttention: () => set({ attentionSignal: null }),
  consumeFocusRange: () => set({ focusRangeCommand: null }),

  consumePromptCommand: () =>
    set((state) => {
      if (state.pendingPromptCommands.length === 0) {
        return { promptCommand: null };
      }
      const [next, ...rest] = state.pendingPromptCommands;
      return { promptCommand: next, pendingPromptCommands: rest };
    }),

  applyUiPatch: (patch) => {
    const queuePrompt = (prompt: string, autoSend = false) =>
      set((state) => {
        const cmd: PromptCommand = {
          id: `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          prompt,
          autoSend,
        };
        return {
          promptCommand: state.promptCommand ?? cmd,
          pendingPromptCommands: state.promptCommand
            ? [...state.pendingPromptCommands, cmd]
            : state.pendingPromptCommands,
          panelVisibility: { ...state.panelVisibility, ai: true },
          attentionSignal: signal("ai", "cross_tab_insert"),
        };
      });

    switch (patch.type) {
      case "open_document":
        set({
          activeMainBlock: "editor",
          currentDocumentId: patch.documentId,
          attentionSignal: signal("editor", "navigation"),
        });
        return;

      case "show_management":
        set({
          activeMainBlock: "management",
          currentDocumentId: null,
        });
        return;

      case "show_ai_chat":
        set((state) => ({
          panelVisibility: { ...state.panelVisibility, ai: true },
          attentionSignal: signal("ai"),
        }));
        return;

      case "set_main_block":
        set((state) => {
          const next: WorkspaceMainBlock =
            !state.currentDocumentId &&
            (patch.block === "graph" || patch.block === "preview")
              ? "editor"
              : patch.block;
          const target: AttentionTarget =
            next === "graph" ? "graph" : next === "preview" ? "preview" : "editor";
          return { activeMainBlock: next, attentionSignal: signal(target) };
        });
        return;

      case "set_panel_visibility":
        set((state) => ({
          panelVisibility: {
            ...state.panelVisibility,
            [patch.panel]: patch.visible,
          },
          attentionSignal: signal(patch.panel),
        }));
        return;

      case "set_panel_size":
        set((state) => ({
          panelWidth: {
            ...state.panelWidth,
            [patch.panel]: Math.max(10, Math.min(90, patch.widthPercent)),
          },
          attentionSignal: signal(patch.panel),
        }));
        return;

      case "queue_prompt":
        queuePrompt(patch.prompt, patch.autoSend ?? false);
        return;

      case "focus_document_range":
        set((state) => ({
          currentDocumentId: patch.documentId,
          activeMainBlock: "editor",
          focusRangeCommand: {
            id: `focus-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            documentId: patch.documentId,
            startLine: patch.startLine,
            endLine: patch.endLine,
          },
          attentionSignal: signal("editor", "navigation"),
        }));
        return;

      case "noop":
      default:
        return;
    }
  },
}));
