/**
 * Agent bridge — lets an external agent drive the page through ui-sdk.
 *
 * `@ui-sdk/core/agent` runs in the browser: it reads every live ui-sdk
 * component and calls their own api. An agent talking to Sumi over HTTP is not
 * in the browser, so the call has to travel: publish a request on the UI event
 * bus (the open page hears it over SSE), let the page run it with its own agent
 * instance, and hold the HTTP response open until the answer comes back.
 *
 * This replaces the A2UI spec channel. A spec asked the model to describe UI in
 * JSON that a renderer turned into components; the components were therefore
 * illustrations the agent could not touch afterwards. Here the components are
 * the real ones, already on the page, and the agent operates them.
 *
 * Requests are addressed to one user, not to everyone in the project: a step
 * like `press` must run once, in one page. When that person has several tabs
 * open, each tab may run it — the page also de-duplicates by request id, so the
 * practical case (one tab) is exact.
 */

import { publishUiPatch } from "./event-bus";

export type AgentCall = "snapshot" | "query" | "act";

export interface AgentRequest {
  projectId: string;
  /** Subject id of the page that should answer, e.g. "u42". */
  userId: string;
  call: AgentCall;
  input: unknown;
  /** `act` waits longer than a read. */
  timeoutMs?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  userId: string;
}

const pending = new Map<string, Pending>();

/** Reads answer fast; a multi-step `act` may wait on the page's own confirms. */
const DEFAULT_TIMEOUT: Record<AgentCall, number> = {
  snapshot: 8_000,
  query: 8_000,
  act: 45_000,
};

function requestId(): string {
  return `ar_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Ask an open page to run one ui-sdk agent call.
 *
 * Rejects rather than returning an empty result when nothing answers: an agent
 * that reads "no components" from a page nobody has open would conclude the UI
 * was empty and act on that conclusion.
 */
export async function callAgent(request: AgentRequest): Promise<unknown> {
  const id = requestId();
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT[request.call];

  const answer = new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(
        new Error(
          `no page answered within ${timeoutMs}ms — is the workspace open for ${request.userId}?`
        )
      );
    }, timeoutMs);
    // The timer must not hold the process open on its own.
    timer.unref?.();
    pending.set(id, { resolve, reject, timer, userId: request.userId });
  });

  try {
    await publishUiPatch({
      userId: request.userId,
      projectId: request.projectId,
      source: "external_agent",
      patch: {
        type: "agent_call",
        requestId: id,
        call: request.call,
        input: request.input,
      },
    });
  } catch (error) {
    const entry = pending.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(id);
    }
    throw error;
  }

  return answer;
}

/**
 * Hand a page's answer back to whoever is waiting.
 *
 * Returns false for an id nobody waits on — a duplicate answer from a second
 * tab, or one that arrived after the timeout. Both are normal, so this is not
 * an error.
 */
export function settleAgentCall(
  id: string,
  result: { ok: true; value: unknown } | { ok: false; error: string },
  fromUserId: string
): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  if (entry.userId !== fromUserId) return false;

  clearTimeout(entry.timer);
  pending.delete(id);
  if (result.ok) entry.resolve(result.value);
  else entry.reject(new Error(result.error));
  return true;
}

/** Test hook: how many calls are in flight. */
export function pendingAgentCalls(): number {
  return pending.size;
}

export function resetAgentBridgeForTests(): void {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  pending.clear();
}
