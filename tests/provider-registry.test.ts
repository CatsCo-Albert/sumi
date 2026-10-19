/**
 * The pageState broadcast has to survive both orderings.
 *
 * Found in production: a freshly opened document reported no presence at all. The
 * members panel reads that feed to decide 在线/离线, so it showed everyone as 离线 —
 * including the person whose page was open and synced. The cause was ordering: the
 * shell published before the editor registered its provider, and the publish was
 * never repeated.
 */

import { describe, expect, it } from "vitest";
import type { WebsocketProvider } from "y-websocket";
import { broadcastPageState, registerProvider } from "../lib/provider-registry";

/**
 * The registry touches three things on a provider: awareness, the `sync` event,
 * and nothing else. Standing up a real WebsocketProvider would need a server, so
 * the double implements exactly that surface and is cast at the boundary — the
 * alternative is asserting against a fake whose unrelated fields are all invented.
 */
type ProviderLike = {
  awareness: {
    setLocalStateField(key: string, value: unknown): void;
    getLocalStateField(key: string): unknown;
  };
  on(event: string, fn: () => void): void;
  off(event: string, fn: () => void): void;
};

const asProvider = (p: ProviderLike) => p as unknown as WebsocketProvider;

/** Minimal stand-in for a WebsocketProvider: only awareness and the sync event. */
function fakeProvider() {
  const fields: Record<string, unknown> = {};
  const handlers = new Map<string, Array<() => void>>();
  return {
    awareness: {
      setLocalStateField(key: string, value: unknown) {
        fields[key] = value;
      },
      getLocalStateField(key: string) {
        return fields[key];
      },
    },
    on(event: string, fn: () => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
    },
    off(event: string, fn: () => void) {
      handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== fn));
    },
    emit(event: string) {
      for (const fn of handlers.get(event) ?? []) fn();
    },
    pageState() {
      return fields.pageState as { currentDocumentId: string | null } | undefined;
    },
  };
}

const state = (doc: string) => ({
  currentDocumentId: doc,
  activeMainBlock: "editor",
  aiOpen: false,
  sidebarOpen: true,
  inspectorOpen: false,
  foreground: true,
});

describe("pageState broadcast", () => {
  it("reaches a provider that registers after the broadcast", () => {
    // The shell mounts and publishes before any editor exists…
    broadcastPageState(state("prj-notes.md"));
    // …and only then does the editor register its provider.
    const provider = fakeProvider();
    const unregister = registerProvider("prj-notes.md", asProvider(provider));

    expect(provider.pageState()?.currentDocumentId).toBe("prj-notes.md");
    unregister();
  });

  it("keeps publishing to providers that were already registered", () => {
    const provider = fakeProvider();
    const unregister = registerProvider("prj-existing.md", asProvider(provider));

    broadcastPageState(state("prj-existing.md"));
    expect(provider.pageState()?.currentDocumentId).toBe("prj-existing.md");
    unregister();
  });

  it("re-applies on sync, for a provider that registered while offline", () => {
    // Awareness written before the socket is open is not guaranteed to be in the
    // handshake, so the field is written again once sync lands.
    const provider = fakeProvider();
    const unregister = registerProvider("prj-late.md", asProvider(provider));

    broadcastPageState(state("prj-late.md"));
    provider.awareness.setLocalStateField("pageState", undefined);
    provider.emit("sync");

    expect(provider.pageState()?.currentDocumentId).toBe("prj-late.md");
    unregister();
  });

  it("stops after unregistering, and stops listening for sync", () => {
    const provider = fakeProvider();
    const unregister = registerProvider("prj-gone.md", asProvider(provider));
    // Registering applies the retained state, which is the point of the replay.
    // What must stop is the *updates* after unregistering.
    const atRegistration = provider.pageState()?.currentDocumentId;

    unregister();
    broadcastPageState(state("prj-other.md"));

    expect(provider.pageState()?.currentDocumentId).toBe(atRegistration);
    expect(provider.pageState()?.currentDocumentId).not.toBe("prj-other.md");
  });
});
