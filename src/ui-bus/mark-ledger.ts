/**
 * What the agent read and changed, recorded where it can be checked afterwards.
 *
 * Two things are deliberately not true of this ledger:
 *
 *   - It is not written by the agent. The page writes it, because a call that
 *     returns success while having done nothing is the failure mode worth
 *     guarding against, and an agent's own report cannot distinguish the two.
 *   - It is not presence. Presence is the Yjs room's awareness — who is
 *     connected to the document. This is history: which page, which call, what
 *     it read or changed, and when. A page can be gone and its marks stay.
 *
 * Entries are idempotent by (requestId, ref, kind): a page answers once per
 * call, but a replayed frame or a reconnect must not double-count the same read.
 */

export interface MarkEntry {
  requestId: string;
  clientId: string;
  userId: string;
  projectId: string;
  /** The document the page was showing, when it had one open. */
  filePath: string | null;
  ref: string;
  component: string;
  label?: string;
  kind: "read" | "changed";
  /** How it was reached: the tool name, or the action a step ran. */
  via?: string;
  at: number;
}

const LIMIT = 500;
const entries: MarkEntry[] = [];
const seen = new Set<string>();
const order: string[] = [];

/** First component of the idempotency key; the rest narrows it. */
function keyOf(entry: Pick<MarkEntry, "requestId" | "clientId" | "ref" | "kind">): string {
  return `${entry.requestId}|${entry.clientId}|${entry.ref}|${entry.kind}`;
}

function remember(key: string): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  order.push(key);
  while (order.length > LIMIT) {
    const oldest = order.shift();
    if (oldest) seen.delete(oldest);
  }
  return true;
}

/** Record one page's marks for one call. Returns how many were new. */
export function recordMarks(input: {
  requestId: string;
  clientId: string;
  userId: string;
  projectId: string;
  filePath: string | null;
  marks: unknown;
}): number {
  const list = Array.isArray(input.marks) ? input.marks : [];
  let added = 0;
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const mark = raw as Record<string, unknown>;
    const ref = typeof mark.ref === "string" ? mark.ref : "";
    const kind = mark.kind === "changed" ? "changed" : "read";
    if (!ref) continue;

    const entry: MarkEntry = {
      requestId: input.requestId,
      clientId: input.clientId,
      userId: input.userId,
      projectId: input.projectId,
      filePath: input.filePath,
      ref,
      component: typeof mark.component === "string" ? mark.component : "component",
      ...(typeof mark.label === "string" && mark.label ? { label: mark.label } : {}),
      kind,
      ...(typeof mark.via === "string" && mark.via ? { via: mark.via } : {}),
      at: typeof mark.at === "number" ? mark.at : Date.now(),
    };

    if (!remember(keyOf(entry))) continue;
    entries.push(entry);
    if (entries.length > LIMIT) entries.splice(0, entries.length - LIMIT);
    added += 1;
  }
  return added;
}

export interface MarkQuery {
  /**
   * Whose marks. Omitted means "everyone in the project", which is what a
   * collaborator needs: the question "did anyone read the members panel" is not
   * answerable from one person's history. Authorization is the project role,
   * checked before a query is built — not this field.
   */
  userId?: string;
  projectId?: string;
  /** Only marks for this document. */
  filePath?: string;
  limit?: number;
}

/** Newest first. */
export function listMarks(query: MarkQuery): MarkEntry[] {
  const limit = Math.min(Math.max(query.limit ?? 100, 1), LIMIT);
  const out: MarkEntry[] = [];
  for (let i = entries.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const entry = entries[i];
    if (query.userId && entry.userId !== query.userId) continue;
    if (query.projectId && entry.projectId !== query.projectId) continue;
    if (query.filePath && entry.filePath !== query.filePath) continue;
    out.push(entry);
  }
  return out;
}

/** Counts by kind, so a caller can answer "did it read anything?" cheaply. */
export function markSummary(query: MarkQuery): {
  total: number;
  read: number;
  changed: number;
  calls: number;
  documents: string[];
  members: string[];
} {
  const all = listMarks({ ...query, limit: LIMIT });
  const calls = new Set(all.map((entry) => entry.requestId));
  const documents = new Set(
    all.map((entry) => entry.filePath).filter((p): p is string => Boolean(p))
  );
  // Which members' pages wrote these marks: the difference between "the agent
  // read my page" and "the agent read someone else's".
  const members = new Set(all.map((entry) => entry.userId));
  return {
    total: all.length,
    read: all.filter((entry) => entry.kind === "read").length,
    changed: all.filter((entry) => entry.kind === "changed").length,
    calls: calls.size,
    documents: [...documents],
    members: [...members],
  };
}

/** Test hook. */
export function resetMarkLedger(): void {
  entries.length = 0;
  seen.clear();
  order.length = 0;
}