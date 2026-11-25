/**
 * Executes ui-sdk agent calls coming from the server.
 *
 * The server cannot read the page — `createAgent` reads live component
 * instances. So when an external agent asks for a snapshot or an action, the
 * request arrives here over SSE, runs against the real components, and the
 * answer is posted back to the API that is waiting for it.
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
  // Say what it is doing while it does it: a call that reads forty components
  // otherwise looks identical to a page where nothing is happening.
  beginActivity(
    body.call,
    body.call === "act" ? "准备操作" : body.call === "query" ? "查找组件" : "读取页面"
  );

  // Declared outside the try so the finally block can report the outcome.
  let marks: Array<{ kind: "read" | "changed" }> = [];

  try {
    let value: unknown;
    // Marks travel with the answer: the page is the only place that knows what
    // it actually read, and a record the agent writes about itself could not
    // tell "read nothing" apart from "read and reported nothing".
    if (body.call === "snapshot") {
      value = agent.snapshot();
      marks = markRead(value, "snapshot");
    } else if (body.call === "query") {
      value = await agent.query((body.input ?? {}) as Parameters<typeof agent.query>[0]);
      marks = markRead(value, "query");
    } else {
      const input = (body.input ?? {}) as { steps?: AgentStep[] };
      const steps = Array.isArray(input.steps) ? input.steps : [];
      // Paint the targets before running them: the step completes in one tick,
      // so a highlight added afterwards would only ever be seen as the result.
      markBusy(steps);
      updateActivity(
        steps.length > 0
          ? `操作 ${steps.map((step) => step.action ?? "step").join(", ")}`
          : "操作页面"
      );
      try {
        value = await agent.act({ steps });
        marks = markChanged(steps, value);
      } catch (error) {
        // A refused or failed step still names what was attempted.
        marks = markChanged(steps, { steps: [] });
        throw error;
      } finally {
        clearBusy(steps);
      }
    }
    await post({ requestId: body.requestId, ok: true, value, marks });
  } catch (error) {
    await post({
      requestId: body.requestId,
      ok: false,
      error: (error as Error)?.message ?? String(error),
    });
  } finally {
    // Report the outcome briefly: a completed read is otherwise invisible.
    if (marks.length > 0) {
      const reads = marks.filter((mark) => mark.kind === "read").length;
      const changed = marks.length - reads;
      finishActivity(
        changed > 0
          ? `改了 ${changed} 处${reads > 0 ? `，读了 ${reads} 项` : ""}`
          : `读了 ${reads} 项`
      );
    } else {
      endActivity();
    }
  }
}

export { agent };
