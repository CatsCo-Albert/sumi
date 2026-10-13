/**
 * SSE handler for the UI event bus.
 *
 * Framework-agnostic — works with any Node HTTP handler signature.
 * Usage (Node http):
 *   const handler = createUiEventsSseHandler({ getUserId: (req) => auth(req) });
 *   http.createServer((req, res) => {
 *     if (req.url?.startsWith("/api/ui/events")) return handler(req, res);
 *     ...
 *   });
 *
 * Behavior mirrors paperanim/app/api/workspace-ui/events/route.ts:
 *   - initial `ready` handshake frame
 *   - replay of recent events
 *   - live push via in-process subscription
 *   - 1s poll over the durable log (covers missed events)
 *   - heartbeat ping every 20s
 *   - dedupe by event id with bounded memory
 */

import type { IncomingMessage, ServerResponse } from "http";
import {
  listUiEvents,
  subscribeUiEvents,
  type UiEvent,
} from "./event-bus";

const HEARTBEAT_MS = 20_000;
const POLL_MS = 1_000;
const SENT_IDS_BUDGET = 200;
const REPLAY_LIMIT = 20;
const POLL_BATCH_LIMIT = 50;

export interface SseHandlerOptions {
  /** Resolve the current user; return null to 401. */
  getUserId: (req: IncomingMessage) => Promise<string | null> | string | null;
  /** Optional query-param name for project filter (default "projectId"). */
  projectParam?: string;
}

function sseFrame(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function createUiEventsSseHandler(opts: SseHandlerOptions) {
  const projectParam = opts.projectParam ?? "projectId";

  return async function handler(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const userId = await opts.getUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    const url = new URL(req.url || "/", "http://localhost");
    const projectFilter = url.searchParams.get(projectParam) || "";

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    let closed = false;
    let pollInFlight = false;
    let lastSeen = 0;
    const sentIds = new Set<string>();
    const sentOrder: string[] = [];

    const write = (chunk: string) => {
      if (closed) return;
      try {
        res.write(chunk);
      } catch {
        closed = true;
      }
    };

    const remember = (id: string): boolean => {
      if (sentIds.has(id)) return false;
      sentIds.add(id);
      sentOrder.push(id);
      if (sentOrder.length > SENT_IDS_BUDGET) {
        const old = sentOrder.shift();
        if (old) sentIds.delete(old);
      }
      return true;
    };

    const emit = (ev: Pick<UiEvent, "id" | "projectId" | "patch" | "createdAt">) => {
      if (projectFilter && ev.projectId !== projectFilter) return;
      if (!remember(ev.id)) return;
      lastSeen = Math.max(lastSeen, ev.createdAt);
      write(sseFrame("ui_patch", ev.patch));
    };

    // handshake
    write(
      sseFrame("ready", {
        connected: true,
        projectId: projectFilter || null,
        timestamp: Date.now(),
      })
    );

    // initial replay
    void listUiEvents(userId, { limit: REPLAY_LIMIT }).then((events) =>
      events.forEach(emit)
    );

    const unsubscribe = subscribeUiEvents(userId, emit);

    const poll = setInterval(() => {
      if (closed || pollInFlight) return;
      pollInFlight = true;
      void listUiEvents(userId, {
        afterCreatedAt: lastSeen,
        limit: POLL_BATCH_LIMIT,
      })
        .then((events) => events.forEach(emit))
        .catch((err) => console.error("[ui-bus-sse] poll failed:", err))
        .finally(() => {
          pollInFlight = false;
        });
    }, POLL_MS);

    const heartbeat = setInterval(() => {
      write(sseFrame("ping", { timestamp: Date.now() }));
    }, HEARTBEAT_MS);

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearInterval(poll);
      unsubscribe();
      try {
        res.end();
      } catch { /* already closed */ }
    };

    req.on("close", cleanup);
    res.on("close", cleanup);
  };
}
