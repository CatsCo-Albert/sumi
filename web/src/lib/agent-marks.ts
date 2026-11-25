/**
 * Marks for what the agent read and what it changed.
 *
 * Without this the agent's activity is invisible: a tool call happens and the
 * page looks the same, so nobody can tell whether it read the outline, the
 * members list or nothing at all. Two things are recorded and both are shown:
 *
 *   - a mark on the component itself, so a person can see which controls were
 *     touched and where the agent's information came from;
 *   - an entry in the log, so the history is checkable after the mark fades.
 *
 * The element mark is temporary; the log is the durable record.
 */

import { createSignal } from "solid-js";
import { elementOf } from "@ui-sdk/core/observe";

export type AgentMarkKind = "read" | "changed";

export interface AgentMark {
  ref: string;
  component: string;
  label?: string;
  kind: AgentMarkKind;
  at: number;
  /** How the agent reached it, when known, e.g. "snapshot" or "press". */
  via?: string;
}

/** How long an element keeps its outline. The log entry stays. */
const MARK_TTL_MS = 15_000;
const LOG_LIMIT = 200;

const [marks, setMarks] = createSignal<AgentMark[]>([]);

/** Newest first. */
export const agentMarks = marks;

export function clearAgentMarks(): void {
  for (const mark of marks()) {
    clearElementMark(mark.ref);
  }
  setMarks([]);
}

function clearElementMark(ref: string): void {
  try {
    const element = elementOf(ref);
    if (!element) return;
    delete element.dataset.agentMark;
    delete element.dataset.agentLabel;
  } catch {
    // The component left the page; nothing to clean up.
  }
}

function paint(mark: AgentMark): void {
  try {
    const element = elementOf(mark.ref);
    if (!element) return;
    element.dataset.agentMark = mark.kind;
    if (mark.label) element.dataset.agentLabel = mark.label;
    window.setTimeout(() => {
      // Only clear this mark: a later mark on the same element may exist.
      if (element.dataset.agentMark !== mark.kind) return;
      delete element.dataset.agentMark;
      delete element.dataset.agentLabel;
    }, MARK_TTL_MS);
  } catch {
    // A ref that no longer resolves is normal after a re-render.
  }
}

function record(incoming: AgentMark[]): void {
  if (incoming.length === 0) return;
  for (const mark of incoming) paint(mark);
  setMarks((current) => [...incoming, ...current].slice(0, LOG_LIMIT));
}

interface AgentComponentLike {
  ref?: unknown;
  component?: unknown;
  label?: unknown;
}

/** Everything a read returned is information the agent now has. */
export function markRead(value: unknown, via: string): AgentMark[] {
  if (!Array.isArray(value)) return [];
  const at = Date.now();
  const incoming: AgentMark[] = [];
  for (const item of value as AgentComponentLike[]) {
    if (typeof item?.ref !== "string") continue;
    incoming.push({
      ref: item.ref,
      component: typeof item.component === "string" ? item.component : "component",
      label: typeof item.label === "string" ? item.label : undefined,
      kind: "read",
      at,
      via,
    });
    if (incoming.length >= 60) break;
  }
  record(incoming);
  return incoming;
}

/**
 * A step names the component it acted on, so the ref is already known; the
 * result says what changed, which is what the log quotes.
 */
export function markChanged(
  steps: Array<{ ref?: unknown; action?: unknown }>,
  result: unknown
): AgentMark[] {
  const at = Date.now();
  const changes =
    result && typeof result === "object" && Array.isArray((result as { steps?: unknown[] }).steps)
      ? ((result as { steps: Array<{ ref?: unknown; action?: unknown; changes?: unknown[] }> }).steps ?? [])
      : [];

  const incoming: AgentMark[] = [];
  for (const step of changes) {
    if (typeof step?.ref !== "string") continue;
    const keys = Array.isArray(step.changes)
      ? step.changes
          .map((change) =>
            change && typeof change === "object" ? String((change as { key?: unknown }).key ?? "") : ""
          )
          .filter(Boolean)
      : [];
    incoming.push({
      ref: step.ref,
      component: "component",
      label: keys.length > 0 ? keys.join(", ") : undefined,
      kind: "changed",
      at,
      via: typeof step.action === "string" ? step.action : undefined,
    });
  }

  // A step that failed still tells the reader which control was attempted.
  if (incoming.length === 0) {
    for (const step of steps) {
      if (typeof step?.ref !== "string") continue;
      incoming.push({
        ref: step.ref,
        component: "component",
        kind: "changed",
        at,
        via: typeof step.action === "string" ? step.action : undefined,
      });
    }
  }

  const kept = incoming.slice(0, 60);
  record(kept);
  return kept;
}