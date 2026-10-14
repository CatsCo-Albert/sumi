/**
 * SSE endpoint — pushes UiPatch events to the client.
 *
 * Adapted from the SSE event route; the transport
 * is ReadableStream over Response so it works under Next.js App Router.
 *
 * Auth is currently open (single-user dev mode); wire getUserId() to your
 * session provider when auth lands.
 */

import { listUiEvents, subscribeUiEvents } from "@/src/ui-bus/event-bus";
import { actorFromRequest } from "@/lib/http-auth";

const HEARTBEAT_MS = 20_000;
const POLL_MS = 1_000;
const SENT_IDS_BUDGET = 200;
const REPLAY_LIMIT = 200;

function sseFrame(
  event: string,
  payload: unknown,
  id?: string
): Uint8Array {
  const idLine = id ? `id: ${id}\n` : "";
  return new TextEncoder().encode(
    `${idLine}event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
  );
}

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const actor = await actorFromRequest(request);
  if (!actor) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  const userId = actor.id;
  const url = new URL(request.url);
  const projectFilter = url.searchParams.get("projectId") || "";

  // SSE resume: on reconnect the client sends the id of the last event it
  // saw; we replay everything persisted after it instead of a blind tail.
  const lastEventId = request.headers.get("last-event-id") || "";

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let pollInFlight = false;
      let lastSeen = 0;
      const sentIds = new Set<string>();
      const sentOrder: string[] = [];

      const enqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
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

      const emit = (ev: { id: string; projectId: string; patch: unknown; createdAt: number }) => {
        if (projectFilter && ev.projectId !== projectFilter) return;
        if (!remember(ev.id)) return;
        lastSeen = Math.max(lastSeen, ev.createdAt);
        enqueue(sseFrame("ui_patch", ev.patch, ev.id));
      };

      enqueue(
        sseFrame("ready", {
          connected: true,
          projectId: projectFilter || null,
          timestamp: Date.now(),
        })
      );

      // Resolve the resume cursor: find the referenced event's createdAt so
  // strictly-newer events replay. Unknown id → fall back to the tail replay.
      const replay = listUiEvents(userId, { limit: REPLAY_LIMIT }).then(
        (events) => {
          let after = 0;
          let limit = 20;
          if (lastEventId) {
            const anchor = events.find((e) => e.id === lastEventId);
            if (anchor) {
              after = anchor.createdAt;
              limit = REPLAY_LIMIT;
            }
          }
          return listUiEvents(userId, {
            afterCreatedAt: after,
            limit,
          });
        }
      );
      void replay.then((events) => events.forEach(emit));

      const unsubscribe = subscribeUiEvents(userId, emit);

      const poll = setInterval(() => {
        if (closed || pollInFlight) return;
        pollInFlight = true;
        void listUiEvents(userId, {
          afterCreatedAt: lastSeen,
          limit: 50,
        })
          .then((events) => events.forEach(emit))
          .catch((err) => console.error("[ui/events] poll failed:", err))
          .finally(() => {
            pollInFlight = false;
          });
      }, POLL_MS);

      const heartbeat = setInterval(() => {
        enqueue(sseFrame("ping", { timestamp: Date.now() }));
      }, HEARTBEAT_MS);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearInterval(poll);
        unsubscribe();
        try {
          controller.close();
        } catch { /* already closed */ }
      };

      request.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
