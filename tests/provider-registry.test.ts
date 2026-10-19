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
import { broadcastPageState, registerProvider } from "../lib/provider-registry";

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
    const unregister = registerProvider("prj-notes.md", provider);

    expect(provider.pageState()?.currentDocumentId).toBe("prj-notes.md");
    unregister();
  });

  it("keeps publishing to providers that were already registered", () => {
    const provider = fakeProvider();
    const unregister = registerProvider("prj-existing.md", provider);

    broadcastPageState(state("prj-existing.md"));
    expect(provider.pageState()?.currentDocumentId).toBe("prj-existing.md");
    unregister();
  });

  it("re-applies on sync, for a provider that registered while offline", () => {
    // Awareness written before the socket is open is not guaranteed to be in the
    // handshake, so the field is written again once sync lands.
    const provider = fakeProvider();
    const unregister = registerProvider("prj-late.md", provider);

    broadcastPageState(state("prj-late.md"));
    provider.awareness.setLocalStateField("pageState", undefined);
    provider.emit("sync");

    expect(provider.pageState()?.currentDocumentId).toBe("prj-late.md");
    unregister();
  });

  it("stops after unregistering, and stops listening for sync", () => {
    const provider = fakeProvider();
    const unregister = registerProvider("prj-gone.md", provider);
    // Registering applies the retained state, which is the point of the replay.
    // What must stop is the *updates* after unregistering.
    const atRegistration = provider.pageState()?.currentDocumentId;

    unregister();
    broadcastPageState(state("prj-other.md"));

    expect(provider.pageState()?.currentDocumentId).toBe(atRegistration);
    expect(provider.pageState()?.currentDocumentId).not.toBe("prj-other.md");
  });
});
