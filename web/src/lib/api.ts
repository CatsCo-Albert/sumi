/**
 * HTTP client for the Sumi API.
 *
 * Every path is relative to the deployment base path, because the gateway
 * strips `/<app-id>/` before forwarding and a literal `/api/...` would then
 * resolve against the gateway root and 404.
 */

export const BASE_PATH = (import.meta.env.VITE_BASE_PATH ?? "/sumi").replace(/\/$/, "");

/** Prefix an in-app absolute path with the deployment base path. */
export function apiPath(path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${BASE_PATH}${suffix}`;
}

const TOKEN_KEY = "sumi.token";

export function readToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function writeToken(token: string | null) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // A blocked storage is not fatal: the request still carries the cookie.
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

function authHeaders(): Record<string, string> {
  const token = readToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const headers: Record<string, string> = { ...authHeaders() };
  if (body !== undefined) headers["content-type"] = "application/json";

  const res = await fetch(apiPath(path), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });

  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;

  if (!res.ok) {
    const payload = (data ?? {}) as { error?: string; detail?: string };
    throw new ApiError(res.status, payload.error ?? `http ${res.status}`, payload.detail);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  del: <T>(path: string, body?: unknown) => request<T>("DELETE", path, body),
};

// ---------------------------------------------------------------------------
// Shapes — mirrored from the route handlers, not invented here.
// ---------------------------------------------------------------------------

export interface Actor {
  kind: "user" | "agent";
  /** Sumi subject id — "u{uid}" or "a{uid}". */
  id: string;
  uid: number;
  name: string;
  username?: string;
  avatarUrl?: string;
  ownerUid?: number;
  projectRole?: "owner" | "editor" | "viewer";
}

export interface Project {
  id: string;
  name: string;
  ownerUid: string;
  description: string | null;
  tags: string[];
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  memberCount: number;
  ownerDisplayName: string | null;
}

export interface DocumentRow {
  id: string;
  projectId: string;
  fileId: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MemberRow {
  subjectId: string;
  role: string;
  displayName: string | null;
  kind: string | null;
  status: string | null;
}

export interface EditBlock {
  startLine: number;
  endLine: number;
  updated: string;
  original?: string;
}

export interface PendingEdit {
  id: string;
  projectId: string;
  filePath: string;
  blocks: EditBlock[];
  description?: string;
  status: "pending" | "applying" | "applied" | "rejected";
  createdAt: number;
  userId?: string;
  authorId?: string;
  authorName?: string;
}

export interface DocContent {
  content: string;
  exists: boolean;
  contentHash: string | null;
  source?: "room" | "blob";
  updatedAt?: string;
}

export interface VersionSummary {
  id: string;
  projectId: string;
  fileId: string;
  contentHash: string;
  authorId: string | null;
  authorName: string | null;
  label: string | null;
  source: string;
  sizeBytes: number;
  createdAt: number;
}

export const server = {
  me: () => api.get<{ actor: Actor; projects: Project[] }>("/api/auth/me"),
  projects: () => api.get<{ projects: Project[] }>("/api/projects"),
  createProject: (name: string) => api.post<{ project: Project }>("/api/projects", { name }),
  documents: (projectId: string) =>
    api.get<{ documents: DocumentRow[] }>(`/api/projects/${projectId}/documents`),
  createDocument: (projectId: string, fileId: string, title?: string) =>
    api.post<{ document: DocumentRow }>(`/api/projects/${projectId}/documents`, { fileId, title }),
  renameDocument: (projectId: string, fileId: string, next: { title?: string | null; newFileId?: string }) =>
    api.patch<{ document: DocumentRow }>(`/api/projects/${projectId}/documents`, { fileId, ...next }),
  deleteDocument: (projectId: string, fileId: string) =>
    api.del<{ ok: true }>(`/api/projects/${projectId}/documents`, { fileId }),
  content: (projectId: string, filePath: string) =>
    api.get<DocContent>(
      `/api/documents/content?projectId=${encodeURIComponent(projectId)}&filePath=${encodeURIComponent(filePath)}`
    ),
  saveContent: (
    projectId: string,
    filePath: string,
    content: string,
    baseContentHash: string | null
  ) =>
    api.put<{ ok: boolean; contentHash?: string; conflict?: boolean }>(
      "/api/documents/content",
      { projectId, filePath, content, baseContentHash }
    ),
  members: (projectId: string) =>
    api.get<{ members: MemberRow[] }>(`/api/projects/${projectId}/members`),
  addMember: (projectId: string, subjectId: string, role: "viewer" | "editor") =>
    api.post<{ ok: true }>(`/api/projects/${projectId}/members`, { subjectId, role }),
  removeMember: (projectId: string, subjectId: string) =>
    api.del<{ ok: true }>(`/api/projects/${projectId}/members`, { subjectId }),
  pendingEdits: (projectId: string, fileId?: string, scope = "reviewing") => {
    const params = new URLSearchParams({ projectId, scope });
    if (fileId) params.set("fileId", fileId);
    return api.get<{ edits: PendingEdit[] }>(`/api/pending-edits?${params}`);
  },
  rejectEdit: (editId: string) => api.del<{ ok: true }>("/api/pending-edits", { editId }),
  applyEdit: (payload: { projectId: string; filePath: string; blocks: EditBlock[]; editId?: string }) =>
    api.post<{ ok?: boolean; applied?: number; skipped?: unknown[] }>("/api/edits/apply", payload),
  versions: (projectId: string, fileId: string, limit = 50) =>
    api.get<{ versions: VersionSummary[]; total: number }>(
      `/api/projects/${projectId}/versions?fileId=${encodeURIComponent(fileId)}&limit=${limit}`
    ),
  restoreVersion: (projectId: string, versionId: string) =>
    api.post<{ ok?: boolean }>(`/api/projects/${projectId}/versions/restore`, { versionId }),
  intents: (projectId: string, limit = 100) =>
    api.get<{ intents: Array<Record<string, unknown>> }>(
      `/api/intents?projectId=${encodeURIComponent(projectId)}&limit=${limit}`
    ),
  /* The route reads `prompt`; the UI's own wording is `question`. Mapping here
     keeps the translation in one place instead of at every call site. */
  askAgent: (payload: { projectId: string; fileId?: string; question: string }) =>
    api.post<{ intent?: Record<string, unknown> }>("/api/intents", {
      projectId: payload.projectId,
      fileId: payload.fileId,
      prompt: payload.question,
    }),
  agentSetup: (projectId: string, subjectId: string) =>
    api.get<Record<string, unknown>>(
      `/api/projects/${projectId}/agent-setup?subjectId=${encodeURIComponent(subjectId)}`
    ),
  pageState: (projectId: string) =>
    api.get<Record<string, unknown>>(`/api/page-state/${projectId}`),
};
