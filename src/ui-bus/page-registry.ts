/**
 * Which pages are open right now, per person and per project.
 *
 * The agent bridge used to know only a user id, so two tabs of the same person
 * were indistinguishable: a broadcast was answered by whichever page replied
 * first, and nothing in the answer said which one it was. This registry gives
 * every open page an id, so a call can address one page and the answer can say
 * which page it came from.
 *
 * It keeps two indexes because there are two legitimate questions:
 *
 *   - "what does this person have open" — a caller acting as themselves;
 *   - "what is open in this project" — a collaborator, who is usually not the
 *     person sitting in front of the page. Collaboration means working on the
 *     same documents, so a member of the project can address another member's
 *     page. Authorization lives at the caller (are you in this project), not
 *     here; this index only answers what exists.
 *
 * A page is on these lists because it holds an SSE stream open. The stream's
 * abort is the reliable signal; the TTL sweep only catches the case where an
 * abort is missed (a killed process, a dropped network) so a ghost page cannot
 * keep answering nothing forever.
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
const byProject = new Map<string, Map<string, OpenPage>>();

function bucket(userId: string): Map<string, OpenPage> {
  let pages = byUser.get(userId);
  if (!pages) {
    pages = new Map();
    byUser.set(userId, pages);
  }
  return pages;
}

function projectBucket(projectId: string): Map<string, OpenPage> {
  let pages = byProject.get(projectId);
  if (!pages) {
    pages = new Map();
    byProject.set(projectId, pages);
  }
  return pages;
}

/** Put this page in its project's index, if it has chosen one. */
function indexProject(entry: OpenPage): void {
  if (!entry.projectId) return;
  projectBucket(entry.projectId).set(entry.clientId, entry);
}

/**
 * Take this page out of one project's index.
 *
 * The entry is compared by identity: a page re-registers with a fresh object, so
 * a stale removal must not delete the newer one that took its place.
 */
function unindexProject(entry: OpenPage, projectId: string | null): void {
  if (!projectId) return;
  const pages = byProject.get(projectId);
  if (!pages) return;
  if (pages.get(entry.clientId) !== entry) return;
  pages.delete(entry.clientId);
  if (pages.size === 0) byProject.delete(projectId);
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
  // The project index holds the previous object for this clientId; replace it
  // rather than adding a second entry under the same id.
  if (previous) unindexProject(previous, previous.projectId);
  indexProject(entry);

  return () => {
    const pages = byUser.get(input.userId);
    if (pages) {
      if (pages.get(input.clientId) === entry) {
        pages.delete(input.clientId);
        if (pages.size === 0) byUser.delete(input.userId);
      }
    }
    unindexProject(entry, entry.projectId);
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
  const entry = pages.get(clientId);
  if (!entry) {
    const created: OpenPage = {
      clientId,
      userId,
      projectId: fields.projectId ?? null,
      filePath: fields.filePath ?? null,
      openedAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    pages.set(clientId, created);
    indexProject(created);
    return;
  }
  entry.lastSeenAt = Date.now();
  if (fields.projectId !== undefined && fields.projectId !== entry.projectId) {
    // The page switched projects: it must stop answering as part of the old one.
    unindexProject(entry, entry.projectId);
    entry.projectId = fields.projectId;
    indexProject(entry);
  }
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
      unindexProject(entry, entry.projectId);
      continue;
    }
    // A page that has not chosen a project yet can still answer, so it is kept
    // when the caller did not name one.
    if (projectId && entry.projectId && entry.projectId !== projectId) continue;
    out.push(entry);
  }
  return out.sort((a, b) => a.openedAt - b.openedAt);
}

/**
 * Every page open in one project, whoever is sitting in front of it.
 *
 * This is what makes collaboration possible: the caller is in the project, the
 * pages belong to its members, and the documents are shared. A page that has not
 * chosen a project is not part of any project's work, so it is not listed here.
 */
export function listProjectPages(projectId: string): OpenPage[] {
  const pages = byProject.get(projectId);
  if (!pages) return [];
  const out: OpenPage[] = [];
  for (const entry of pages.values()) {
    if (!live(entry)) {
      pages.delete(entry.clientId);
      // Drop the stale entry from its owner's list too, so the two indexes
      // cannot disagree about whether a page exists.
      const owner = byUser.get(entry.userId);
      if (owner?.get(entry.clientId) === entry) owner.delete(entry.clientId);
      if (owner && owner.size === 0) byUser.delete(entry.userId);
      continue;
    }
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
  byProject.clear();
}
