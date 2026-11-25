/**
 * Which pages are open right now, per person.
 *
 * The agent bridge used to know only a user id, so two tabs of the same person
 * were indistinguishable: a broadcast was answered by whichever page replied
 * first, and nothing in the answer said which one it was. This registry gives
 * every open page an id, so a call can address one page and the answer can say
 * which page it came from.
 *
 * A page is on this list because it holds an SSE stream open. The stream's abort
 * is the reliable signal; the TTL sweep only catches the case where an abort is
 * missed (a killed process, a dropped network) so a ghost page cannot keep
 * answering nothing forever.
 */

export interface OpenPage {
  clientId: string;
  /** Subject id of the person signed in on that page. */
  userId: string;
  projectId: string | null;
  /** The document that page has open, when it has one. */
  filePath: string | null;
  openedAt: number;
  lastSeenAt: number;
}

/** No event for this long and the page is presumed gone. */
const TTL_MS = 90_000;

const byUser = new Map<string, Map<string, OpenPage>>();

function bucket(userId: string): Map<string, OpenPage> {
  let pages = byUser.get(userId);
  if (!pages) {
    pages = new Map();
    byUser.set(userId, pages);
  }
  return pages;
}

/** Mark a page as open. Returns the function that marks it closed. */
export function registerPage(input: {
  userId: string;
  clientId: string;
  projectId?: string | null;
  filePath?: string | null;
}): () => void {
  const now = Date.now();
  const previous = bucket(input.userId).get(input.clientId);
  const entry: OpenPage = {
    clientId: input.clientId,
    userId: input.userId,
    projectId: input.projectId ?? previous?.projectId ?? null,
    filePath: input.filePath ?? previous?.filePath ?? null,
    openedAt: previous?.openedAt ?? now,
    lastSeenAt: now,
  };
  bucket(input.userId).set(input.clientId, entry);

  return () => {
    const pages = byUser.get(input.userId);
    if (!pages) return;
    if (pages.get(input.clientId) !== entry) return;
    pages.delete(input.clientId);
    if (pages.size === 0) byUser.delete(input.userId);
  };
}

/**
 * Refresh the timestamp, and optionally the document that page is showing.
 *
 * Creates the entry when it is missing. A page announces its document as soon
 * as it renders, which can be before its SSE stream has registered it; treating
 * "unknown page" as "nothing to update" silently dropped that first announce and
 * left every page nameless until something else touched it.
 */
export function touchPage(
  userId: string,
  clientId: string,
  fields: { projectId?: string | null; filePath?: string | null } = {}
): void {
  const pages = bucket(userId);
  let entry = pages.get(clientId);
  if (!entry) {
    entry = {
      clientId,
      userId,
      projectId: fields.projectId ?? null,
      filePath: fields.filePath ?? null,
      openedAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    pages.set(clientId, entry);
    return;
  }
  entry.lastSeenAt = Date.now();
  if (fields.projectId !== undefined) entry.projectId = fields.projectId;
  if (fields.filePath !== undefined) entry.filePath = fields.filePath;
}

function live(entry: OpenPage): boolean {
  return Date.now() - entry.lastSeenAt < TTL_MS;
}

/** The pages this person has open, newest first, optionally limited to a project. */
export function listPages(userId: string, projectId?: string): OpenPage[] {
  const pages = byUser.get(userId);
  if (!pages) return [];
  const out: OpenPage[] = [];
  for (const entry of pages.values()) {
    if (!live(entry)) {
      pages.delete(entry.clientId);
      continue;
    }
    // A page that has not chosen a project yet can still answer, so it is kept
    // when the caller did not name one.
    if (projectId && entry.projectId && entry.projectId !== projectId) continue;
    out.push(entry);
  }
  return out.sort((a, b) => a.openedAt - b.openedAt);
}

export function hasPage(userId: string, clientId: string): boolean {
  const entry = byUser.get(userId)?.get(clientId);
  return Boolean(entry && live(entry));
}

/** Test hook. */
export function resetPageRegistry(): void {
  byUser.clear();
}