/**
 * Agent bridge — lets an external agent drive a page through ui-sdk.
 *
 * `@ui-sdk/core/agent` runs in the browser: it reads every live ui-sdk
 * component and calls their own api. An agent talking to Sumi over MCP is not
 * in the browser, so the call has to travel: publish a request on the UI event
 * bus (the open page hears it over SSE), let the page run it with its own agent
 * instance, and hold the request open until the answer comes back.
 *
 * Targeting is per project, not per caller. Collaboration means the agent works
 * on the same documents as the people in the project, so the pages worth
 * addressing are the project's pages — not only the caller's own. Being allowed
 * to address them is decided at the entry point (is the caller a member of this
 * project); this file only routes.
 *
 * Addressing has two modes, because reads and writes fail differently:
 *
 *   - A read (snapshot, query) with no `clientId` broadcasts to every page open
 *     in the project and returns all the answers, each tagged with the page and
 *     the member it belongs to. That is what lets an agent see what a person is
 *     looking at.
 *   - A write (act) must name one page. Pressing a button in three tabs is
 *     three presses, and pressing in someone's page without saying whose is
 *     worse than refusing: an act without a `clientId` is refused when more than
 *     one page is open rather than resolved by whichever answered first.
 */

import { publishUiPatch } from "./event-bus";
import { listProjectPages } from "./page-registry";

export type AgentCall = "snapshot" | "query" | "act";

export interface AgentRequest {
  projectId: string;
  /** Subject id of the caller, recorded for attribution only. */
  userId: string;
  /**
   * One page to target. Omitted for a read means "all of them"; omitted for a
   * write means "the only one, or an error".
   */
  clientId?: string;
  call: AgentCall;
  input: unknown;
  timeoutMs?: number;
}

/** One page's answer, kept with the page it came from. */
export interface PageAnswer {
  clientId: string;
  /** The member signed in on that page. */
  userId: string;
  filePath: string | null;
  value: unknown;
}

export interface AggregateResult {
  pages: PageAnswer[];
  /** Pages that were open when the call went out but did not answer in time. */
  silent: string[];
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  settleTimer: NodeJS.Timeout | null;
  userId: string;
  /** Set when the call names one page; unset for an aggregated read. */
  targetClientId: string | null;
  answers: Map<string, PageAnswer>;
  /** Pages expected to answer, so an aggregated read can finish early. */
  expected: Set<string>;
  /** Who owns each expected page, so an answer can be attributed. */
  owners: Map<string, string>;
  finished: boolean;
}

const pending = new Map<string, Pending>();

/** Reads answer fast; a multi-step `act` may wait on the page's own confirms. */
const DEFAULT_TIMEOUT: Record<AgentCall, number> = {
  snapshot: 8_000,
  query: 8_000,
  act: 45_000,
};

/**
 * How long an aggregated read waits for the remaining pages once one has
 * answered. Long enough for a second tab on the same machine, short enough that
 * a page which never answers does not stall the whole read.
 */
const AGGREGATE_SETTLE_MS = 400;

function requestId(): string {
  return `ar_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function finish(id: string, entry: Pending): void {
  entry.finished = true;
  clearTimeout(entry.timer);
  if (entry.settleTimer) clearTimeout(entry.settleTimer);
  pending.delete(id);
}

function aggregate(entry: Pending): AggregateResult {
  const pages = [...entry.answers.values()];
  const silent = [...entry.expected].filter((clientId) => !entry.answers.has(clientId));
  return { pages, silent };
}

/**
 * Ask open page(s) in one project to run one ui-sdk agent call.
 *
 * Rejects rather than returning an empty result when nothing answers: an agent
 * that reads "no components" from a page nobody has open would conclude the UI
 * was empty and act on that conclusion.
 */
export async function callAgent(request: AgentRequest): Promise<unknown> {
  const open = listProjectPages(request.projectId);
  const clientId = request.clientId?.trim() || null;

  if (clientId && !open.some((page) => page.clientId === clientId)) {
    throw new Error(
      `page_not_open: ${clientId} is not among the pages open in ${request.projectId} (${
        open.map((p) => p.clientId).join(", ") || "none"
      })`
    );
  }

  // Nothing open: say so now. Waiting out the timeout only to report the same
  // thing makes a caller sit through eight seconds to learn there was no page.
  if (open.length === 0) {
    throw new Error(`no page answered — is the workspace open in ${request.projectId}?`);
  }

  // A write needs one page. Guessing would press the same button in every tab,
  // and would pick a person's page on the agent's behalf.
  if (!clientId && request.call === "act") {
    if (open.length > 1) {
      throw new Error(
        `ambiguous_page: ${open.length} pages are open, name one with clientId (${open
          .map((p) => `${p.clientId}${p.userId ? ` on ${p.userId}` : ""}`)
          .join(", ")})`
      );
    }
  }

  const id = requestId();
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT[request.call];
  const targets = clientId
    ? open.filter((page) => page.clientId === clientId)
    : open;
  const expected = new Set(targets.map((page) => page.clientId));
  const owners = new Map(targets.map((page) => [page.clientId, page.userId]));

  const answer = new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      const entry = pending.get(id);
      if (!entry || entry.finished) return;
      // A read that got some answers is still useful; report what came back.
      if (!clientId && entry.answers.size > 0) {
        finish(id, entry);
        resolve(aggregate(entry));
        return;
      }
      finish(id, entry);
      reject(
        new Error(
          `no page answered within ${timeoutMs}ms — is the workspace open in ${request.projectId}?`
        )
      );
    }, timeoutMs);
    timer.unref?.();

    pending.set(id, {
      resolve,
      reject,
      timer,
      settleTimer: null,
      userId: request.userId,
      targetClientId: clientId,
      answers: new Map(),
      expected,
      owners,
      finished: false,
    });
  });

  try {
    // One publish per target page, addressed to the member who owns it. The
    // event bus fans out per user, so a page only hears a request aimed at it.
    for (const page of targets) {
      await publishUiPatch({
        userId: page.userId,
        projectId: request.projectId,
        source: "external_agent",
        patch: {
          type: "agent_call",
          requestId: id,
          call: request.call,
          input: request.input,
          targetClientId: page.clientId,
        },
      });
    }
  } catch (error) {
    const entry = pending.get(id);
    if (entry) finish(id, entry);
    throw error;
  }

  return answer;
}

/**
 * Hand one page's answer back to whoever is waiting.
 *
 * Returns false when nobody waits on the id, when the answer came from a page
 * the call did not address, or when that page already answered. All three are
 * normal — a duplicate frame, a second tab, an answer after the timeout — so
 * this is not an error.
 */
export function settleAgentCall(
  id: string,
  fromClientId: string,
  result: { ok: true; value: unknown } | { ok: false; error: string },
  filePath: string | null = null
): boolean {
  const entry = pending.get(id);
  if (!entry || entry.finished) return false;
  // Only a page this call asked may answer. Without this a page that joined
  // afterwards, or one addressed by a different caller, could settle the call.
  if (!entry.expected.has(fromClientId)) return false;
  if (entry.targetClientId && entry.targetClientId !== fromClientId) return false;
  if (entry.answers.has(fromClientId)) return false;

  const owner = entry.owners.get(fromClientId) ?? entry.userId;

  // A single addressed page, or a failed read: settle immediately.
  if (entry.targetClientId || entry.answers.size === 0) {
    if (entry.targetClientId) {
      finish(id, entry);
      if (result.ok) entry.resolve(result.value);
      else entry.reject(new Error(result.error));
      return true;
    }
    // First answer to an aggregated read: record it, then wait briefly for the
    // rest so the caller gets every page rather than the fastest one.
    if (!result.ok) {
      finish(id, entry);
      entry.reject(new Error(result.error));
      return true;
    }
    entry.answers.set(fromClientId, {
      clientId: fromClientId,
      userId: owner,
      filePath,
      value: result.value,
    });
    if (entry.answers.size >= entry.expected.size) {
      finish(id, entry);
      entry.resolve(aggregate(entry));
      return true;
    }
    entry.settleTimer = setTimeout(() => {
      const current = pending.get(id);
      if (!current || current.finished) return;
      finish(id, current);
      current.resolve(aggregate(current));
    }, AGGREGATE_SETTLE_MS);
    entry.settleTimer.unref?.();
    return true;
  }

  if (!result.ok) {
    // One page failing should not discard the pages that answered.
    entry.expected.delete(fromClientId);
    if (entry.answers.size >= entry.expected.size) {
      finish(id, entry);
      entry.resolve(aggregate(entry));
    }
    return false;
  }

  entry.answers.set(fromClientId, {
    clientId: fromClientId,
    userId: owner,
    filePath,
    value: result.value,
  });
  if (entry.answers.size >= entry.expected.size) {
    finish(id, entry);
    entry.resolve(aggregate(entry));
  }
  return true;
}

/** Test hook: how many calls are in flight. */
export function pendingAgentCalls(): number {
  return pending.size;
}

export function resetAgentBridgeForTests(): void {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    if (entry.settleTimer) clearTimeout(entry.settleTimer);
  }
  pending.clear();
}
