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
  currentDocumentId: string | null;
  activeMainBlock: string;
  panelVisibility: Record<string, boolean>;
  panelWidth: Record<string, number>;
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
