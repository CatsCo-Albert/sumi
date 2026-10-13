/**
 * A2UI schema — declarative UI patches emitted by agents / automation.
 *
 * Sumi distills this from paperanim/lib/a2ui. Two layers:
 *   - `UiPatch`       — a small discriminated union of *structural* commands
 *                       (focus a panel, open a document, resize a pane…)
 *   - `JsonRender`    — a payload meant to be rendered as a rich UI card
 *                       (project cards, progress, reports)
 *
 * The union below is intentionally minimal for Sumi — add kinds only when
 * you need them. Don't pre-build a huge enum "just in case".
 */

// ---------------------------------------------------------------------------
// Structural patches — thin commands that target the workspace shell
// ---------------------------------------------------------------------------

export type WorkspaceMainBlock =
  | "editor"
  | "preview"
  | "graph"
  | "management";

export type PanelName = "sidebar" | "ai" | "inspector";

export type UiPatch =
  | { type: "open_document"; documentId: string }
  | { type: "show_management" }
  | { type: "show_ai_chat" }
  | { type: "set_main_block"; block: WorkspaceMainBlock }
  | {
      type: "set_panel_visibility";
      panel: PanelName;
      visible: boolean;
    }
  | {
      type: "set_panel_size";
      panel: PanelName;
      /** percentage of container, 10–90 */
      widthPercent: number;
    }
  | { type: "queue_prompt"; prompt: string; autoSend?: boolean }
  | { type: "focus_document_range"; documentId: string; startLine: number; endLine: number }
  | { type: "noop" };

// ---------------------------------------------------------------------------
// Rich render payloads — the "agent generated a card" branch
// ---------------------------------------------------------------------------

export interface RenderAction {
  type:
    | "open_document"
    | "queue_prompt"
    | "open_url"
    | "run_command";
  label: string;
  /** open_document */
  documentId?: string;
  /** queue_prompt */
  prompt?: string;
  autoSend?: boolean;
  /** open_url */
  url?: string;
  /** run_command */
  command?: string;
  variant?: "default" | "secondary" | "outline" | "destructive";
  confirmTitle?: string;
  confirmDescription?: string;
}

export interface DocumentCard {
  id: string;
  name: string;
  description?: string | null;
  updatedAt?: string;
  mainFile?: string;
  actions?: RenderAction[];
}

export type JsonRenderPayload =
  | {
      kind: "document_cards";
      title?: string;
      subtitle?: string;
      documents: DocumentCard[];
      emptyMessage?: string;
    }
  | {
      kind: "progress";
      runId: string;
      status: "queued" | "running" | "completed" | "error";
      progress: number; // 0..1
      stage?: string;
      message?: string;
    }
  | {
      kind: "report";
      runId: string;
      title: string;
      summary: string;
      bodyMarkdown: string;
      error?: string;
    }
  | {
      kind: "status";
      requestId: string;
      status: "running" | "success" | "error";
      action?: { type: "open_full_preview" };
    };

// ---------------------------------------------------------------------------
// Node schema — top-level A2UI tree. Keep it tiny.
// ---------------------------------------------------------------------------

export type WorkspaceNode =
  | { component_name: "omni_chat"; props: Record<string, never> }
  | { component_name: "editor_core"; props: { documentId: string } };
