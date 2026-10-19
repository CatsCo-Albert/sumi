/**
 * Registry of active Yjs WebsocketProviders — keyed by `${projectId}-${fileId}`.
 *
 * The workspace-shell publishes pageState (currentDocumentId / activeMainBlock /
 * panelVisibility) onto awareness of the currently-active provider so other
 * clients (humans + agents) can see where you are.
 *
 * Two orderings both happen, and both have to work:
 *
 *   - the shell broadcasts, then a provider registers (the effect ran before the
 *     editor mounted);
 *   - a provider registers, then the shell broadcasts.
 *
 * The first one used to be silent. A broadcast iterated the providers that existed
 * at that instant, so a provider arriving afterwards never received the state — and
 * because the shell's effect depends on UI values that opening a document does not
 * change, nothing ever re-published it. A freshly opened page therefore reported no
 * presence, and the members panel, which reads that feed to decide 在线/离线, called
 * everyone 离线 including the person looking at it.
 *
 * Keeping the last state and replaying it — to providers registered later, and again
 * when a provider finishes its first sync — is what makes the order stop mattering.
 * The re-apply on sync is needed as well because awareness written before the socket
 * is open is not guaranteed to be in the handshake.
 */

import type { WebsocketProvider } from "y-websocket";

const providers = new Map<string, WebsocketProvider>();

/** Everything the shell publishes. Replayed to providers that arrive later. */
export interface PageState {
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
}

let lastPageState: PageState | null = null;

function applyPageState(provider: WebsocketProvider, state: PageState | null): void {
  if (!state) return;
  try {
    provider.awareness.setLocalStateField("pageState", {
      ...state,
      updatedAt: Date.now(),
    });
  } catch {
    // provider might be mid-destroy
  }
}

export function registerProvider(roomName: string, provider: WebsocketProvider): () => void {
  providers.set(roomName, provider);

  const reapply = () => applyPageState(provider, lastPageState);
  // Immediately, for a provider that is already connected; and again on the first
  // sync, for one that is not yet.
  reapply();
  try {
    provider.on("sync", reapply);
  } catch {
    // A provider without the event surface still keeps the immediate apply.
  }

  return () => {
    try {
      provider.off("sync", reapply);
    } catch {
      /* ignore */
    }
    if (providers.get(roomName) === provider) providers.delete(roomName);
  };
}

export function getProvider(roomName: string): WebsocketProvider | undefined {
  return providers.get(roomName);
}

export function listProviders(): Array<{ roomName: string; provider: WebsocketProvider }> {
  return Array.from(providers.entries()).map(([roomName, provider]) => ({ roomName, provider }));
}

/** Broadcast pageState to all active providers, and keep it for those arriving later. */
export function broadcastPageState(pageState: PageState): void {
  lastPageState = pageState;
  providers.forEach((provider) => applyPageState(provider, pageState));
}
