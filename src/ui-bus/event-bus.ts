/**
 * Workspace UI event bus.
 *
 * Three fan-out tiers:
 *   1. in-memory recent ring   — last N events per user (no I/O)
 *   2. live listeners          — same-process SSE push
 *   3. durable persisted log   — JSON blobs under `sumi/ui-events/{userId}/`,
 *      replayed on client reconnect so missed patches can be re-sent.
 *
 * Durable writes are fire-and-forget; list() merges in-memory + disk with dedup.
 */

import type { UiPatch } from "../a2ui/schema";
import { getStorage } from "../storage";

export type UiEventSource = "external_agent" | "system" | "internal_agent";

export interface UiEvent {
  id: string;
  type: "ui_patch";
  source: UiEventSource;
  userId: string;
  projectId: string;
  patch: UiPatch;
  createdAt: number;
}

export interface PublishInput {
  userId: string;
  projectId: string;
  patch: UiPatch;
  source?: UiEventSource;
}

type Listener = (event: UiEvent) => void;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const listenersByUserId = new Map<string, Set<Listener>>();
const recentByUserId = new Map<string, UiEvent[]>();
const MAX_RECENT = 50;

const DURABLE_PREFIX = "sumi/ui-events";
const MAX_DURABLE_PER_USER = 120;
const DURABLE_RETENTION_MS = 10 * 60_000; // 10 minutes
const pruning = new Set<string>();

function id(): string {
  return `ui_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Recent ring
// ---------------------------------------------------------------------------

function pushRecent(userId: string, event: UiEvent): void {
  const arr = recentByUserId.get(userId) || [];
  arr.push(event);
  if (arr.length > MAX_RECENT) arr.splice(0, arr.length - MAX_RECENT);
  recentByUserId.set(userId, arr);
}

export function getRecentEvents(userId: string, limit = 20): UiEvent[] {
  const arr = recentByUserId.get(userId) || [];
  if (limit <= 0) return [];
  return arr.slice(-limit);
}

// ---------------------------------------------------------------------------
// Durable layer
// ---------------------------------------------------------------------------

const durableUserPrefix = (userId: string) => `${DURABLE_PREFIX}/${userId}/`;
const durableKey = (e: UiEvent) =>
  `${durableUserPrefix(e.userId)}${e.createdAt}_${e.id}.json`;

function parseEvent(v: unknown): UiEvent | null {
  if (!v || typeof v !== "object") return null;
  const c = v as Partial<UiEvent>;
  if (
    typeof c.id !== "string" ||
    c.type !== "ui_patch" ||
    typeof c.userId !== "string" ||
    typeof c.projectId !== "string" ||
    !c.patch ||
    typeof c.createdAt !== "number"
  ) {
    return null;
  }
  return {
    id: c.id,
    type: "ui_patch",
    source:
      c.source === "external_agent" || c.source === "internal_agent"
        ? c.source
        : "system",
    userId: c.userId,
    projectId: c.projectId,
    patch: c.patch,
    createdAt: c.createdAt,
  };
}

async function pruneDurable(userId: string): Promise<void> {
  if (pruning.has(userId)) return;
  pruning.add(userId);
  try {
    const storage = await getStorage();
    const files = await storage.list(durableUserPrefix(userId));
    if (files.length === 0) return;

    const now = Date.now();
    const sorted = [...files].sort(
      (a, b) => b.lastModified.getTime() - a.lastModified.getTime()
    );
    const stale = sorted
      .filter((f, i) => {
        const expired = now - f.lastModified.getTime() > DURABLE_RETENTION_MS;
        return expired || i >= MAX_DURABLE_PER_USER;
      })
      .map((f) => f.key);
    await Promise.all(stale.map((k) => storage.delete(k).catch(() => undefined)));
  } catch (err) {
    console.error("[ui-bus] prune durable failed:", err);
  } finally {
    pruning.delete(userId);
  }
}

async function persist(event: UiEvent): Promise<void> {
  try {
    const storage = await getStorage();
    await storage.upload(
      durableKey(event),
      JSON.stringify(event),
      "application/json"
    );
  } catch (err) {
    console.error("[ui-bus] persist event failed:", err);
    return;
  }
  void pruneDurable(event.userId);
}

async function loadDurable(
  userId: string,
  afterCreatedAt: number,
  limit: number
): Promise<UiEvent[]> {
  try {
    const storage = await getStorage();
    const files = await storage.list(durableUserPrefix(userId));
    if (files.length === 0) return [];

    const sorted = [...files].sort(
      (a, b) => b.lastModified.getTime() - a.lastModified.getTime()
    );
    const events: UiEvent[] = [];
    for (const f of sorted) {
      if (!f.key.endsWith(".json")) continue;
      if (events.length >= limit) break;
      try {
        const buf = await storage.download(f.key);
        const parsed = JSON.parse(buf.toString("utf8"));
        const ev = parseEvent(parsed);
        if (!ev || ev.userId !== userId) continue;
        if (afterCreatedAt > 0 && ev.createdAt <= afterCreatedAt) continue;
        events.push(ev);
      } catch { /* skip malformed */ }
    }
    return events.sort((a, b) => a.createdAt - b.createdAt);
  } catch (err) {
    console.error("[ui-bus] load durable failed:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function publishUiPatch(input: PublishInput): Promise<UiEvent> {
  const event: UiEvent = {
    id: id(),
    type: "ui_patch",
    source: input.source || "system",
    userId: input.userId,
    projectId: input.projectId,
    patch: input.patch,
    createdAt: Date.now(),
  };

  pushRecent(input.userId, event);

  const listeners = listenersByUserId.get(input.userId);
  if (listeners?.size) {
    listeners.forEach((l) => {
      try {
        l(event);
      } catch (err) {
        console.error("[ui-bus] listener threw:", err);
      }
    });
  }

  await persist(event);
  return event;
}

export function subscribeUiEvents(
  userId: string,
  listener: Listener
): () => void {
  const set = listenersByUserId.get(userId) || new Set<Listener>();
  set.add(listener);
  listenersByUserId.set(userId, set);
  return () => {
    const cur = listenersByUserId.get(userId);
    if (!cur) return;
    cur.delete(listener);
    if (cur.size === 0) listenersByUserId.delete(userId);
  };
}

export interface ListOptions {
  afterCreatedAt?: number;
  limit?: number;
}

export async function listUiEvents(
  userId: string,
  opts: ListOptions = {}
): Promise<UiEvent[]> {
  const after = opts.afterCreatedAt || 0;
  const limit = Math.max(1, Math.min(opts.limit || 20, 200));

  const mem = getRecentEvents(userId, limit * 2).filter(
    (e) => e.createdAt > after
  );
  const disk = await loadDurable(userId, after, limit * 2);

  const deduped = new Map<string, UiEvent>();
  [...disk, ...mem].forEach((e) => deduped.set(e.id, e));
  return [...deduped.values()]
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-limit);
}

/** For tests. */
export function resetUiEventBusForTests(): void {
  listenersByUserId.clear();
  recentByUserId.clear();
  pruning.clear();
}
