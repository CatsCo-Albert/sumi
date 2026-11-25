/**
 * Executes ui-sdk agent calls coming from outside the page.
 *
 * The caller cannot read the page — `createAgent` reads live component
 * instances. So a request arrives here, runs against the real components, and
 * the answer travels back: to the server over HTTP for the MCP bridge, or
 * straight to the caller's promise for WebMCP.
 *
 * Both entry points funnel through `executeAgentCall`, and that is the point.
 * A call that skipped the marks would be an agent editing the page invisibly:
 * the tools would work and nobody would be able to see what the agent read. The
 * record belongs to whoever ran the call, which is this page, not the agent.
 *
 * A ref answered here is same-tab only: the ids in `snapshot` belong to this
 * document, so an agent should take a snapshot, act on what it just read, and
 * not cache refs across reloads.
 */

import { createAgent, type AgentStep } from "@ui-sdk/core/agent";
import {
  beginActivity,
  clearBusy,
  endActivity,
  finishActivity,
  markBusy,
  markChanged,
  markRead,
  updateActivity,
  type AgentMark,
} from "./agent-marks";

const agent = createAgent({
  // A step the page marked for a person still runs, because the human is not
  // the one typing: the confirmation is the agent's own tool call. Anything
  // destructive is refused rather than guessed at.
  allow: (step) => {
    if (step.confirm) return true;
    return !/^(delete|remove|destroy)/i.test(step.action);
  },
});

export type AgentCallName = "snapshot" | "query" | "act";

export interface AgentCallResult {
  value: unknown;
  /** What this call read or changed, for the page's own record. */
  marks: AgentMark[];
}

function describe(call: AgentCallName): string {
  return call === "act" ? "准备操作" : call === "query" ? "查找组件" : "读取页面";
}

/**
 * Show the outcome for a moment, then clear it.
 *
 * A read finishes in milliseconds, so clearing immediately means nobody sees it
 * at all; a failed call still names what was attempted.
 */
function reportOutcome(marks: AgentMark[]): void {
  if (marks.length === 0) {
    endActivity();
    return;
  }
  const reads = marks.filter((mark) => mark.kind === "read").length;
  const changed = marks.length - reads;
  finishActivity(
    changed > 0
      ? `改了 ${changed} 处${reads > 0 ? `，读了 ${reads} 项` : ""}`
      : `读了 ${reads} 项`
  );
}

/**
 * Run one call against the live page and record what it touched.
 *
 * Throws when the call fails; the marks gathered so far are already painted, so
 * a refused step still leaves a trace of what was attempted.
 */
export async function executeAgentCall(
  call: AgentCallName,
  input: unknown
): Promise<AgentCallResult> {
  // Say what it is doing while it does it: a call that reads forty components
  // otherwise looks identical to a page where nothing is happening.
  beginActivity(call, describe(call));

  let marks: AgentMark[] = [];
  try {
    if (call === "snapshot") {
      const value = agent.snapshot();
      marks = markRead(value, "snapshot");
      return { value, marks };
    }

    if (call === "query") {
      const value = await agent.query(
        (input ?? {}) as Parameters<typeof agent.query>[0]
      );
      marks = markRead(value, "query");
      return { value, marks };
    }

    const stepsInput = (input ?? {}) as { steps?: AgentStep[] };
    const steps = Array.isArray(stepsInput.steps) ? stepsInput.steps : [];
    // Paint the targets before running them: the step completes in one tick, so
    // a highlight added afterwards would only ever be seen as the result.
    markBusy(steps);
    updateActivity(
      steps.length > 0
        ? `操作 ${steps.map((step) => step.action ?? "step").join(", ")}`
        : "操作页面"
    );
    try {
      const value = await agent.act({ steps });
      marks = markChanged(steps, value);
      return { value, marks };
    } catch (error) {
      // A refused or failed step still names what was attempted.
      marks = markChanged(steps, { steps: [] });
      throw error;
    } finally {
      clearBusy(steps);
    }
  } finally {
    reportOutcome(marks);
  }
}

interface AgentRequestBody {
  requestId: string;
  call: AgentCallName;
  input: unknown;
}

/** Run one call and report it. Never throws: a failed call must still answer. */
export async function runAgentCall(
  body: AgentRequestBody,
  post: (payload: Record<string, unknown>) => Promise<unknown>
): Promise<void> {
  try {
    const { value, marks } = await executeAgentCall(body.call, body.input);
    // Marks travel with the answer: a record the agent writes about itself
    // could not tell "read nothing" apart from "read and reported nothing".
    await post({ requestId: body.requestId, ok: true, value, marks });
  } catch (error) {
    await post({
      requestId: body.requestId,
      ok: false,
      error: (error as Error)?.message ?? String(error),
    });
  }
}

export { agent };
