/**
 * Registry of active Yjs WebsocketProviders — keyed by `${projectId}-${fileId}`.
 *
 * The workspace-shell publishes pageState (currentDocumentId / activeMainBlock /
 * panelVisibility) onto awareness of the currently-active provider so other
 * clients (humans + agents) can see where you are.
 */

import type { WebsocketProvider } from "y-websocket";

const providers = new Map<string, WebsocketProvider>();

export function registerProvider(roomName: string, provider: WebsocketProvider): () => void {
  providers.set(roomName, provider);
  return () => {
    if (providers.get(roomName) === provider) providers.delete(roomName);
  };
}

export function getProvider(roomName: string): WebsocketProvider | undefined {
  return providers.get(roomName);
}

export function listProviders(): Array<{ roomName: string; provider: WebsocketProvider }> {
  return Array.from(providers.entries()).map(([roomName, provider]) => ({ roomName, provider }));
}

/** Broadcast pageState to all active providers. */
export function broadcastPageState(pageState: {
  /** Doc the user has open (null = file tree / management). */
  currentDocumentId: string | null;
  /** Which main block is focused. */
  activeMainBlock: string;
  /** AI panel visibility. */
  aiOpen: boolean;
  /** Sidebar visibility. */
  sidebarOpen: boolean;
  /** Inspector visibility. */
  inspectorOpen: boolean;
  /** User's effective role on the project (editor|viewer|owner). */
  role?: string;
  /** Pending-edit IDs currently visible as inline diff decorations. */
  activePendingEdits?: string[];
  /** Line range the user last selected (for contextual intents). */
  selection?: { startLine: number; endLine: number };
  /** Cursor position (line). */
  cursorLine?: number;
  /** Whether this client is in the foreground (document not hidden). */
  foreground?: boolean;
}) {
  providers.forEach((provider) => {
    try {
      provider.awareness.setLocalStateField("pageState", {
        ...pageState,
        updatedAt: Date.now(),
      });
    } catch {
      // provider might be mid-destroy
    }
  });
}
