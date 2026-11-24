/**
 * Workspace state.
 *
 * Signals rather than a store library: the surface is small, and Solid's own
 * primitives already give the fine-grained updates that the React build got
 * from zustand selectors.
 */

import { createSignal } from "solid-js";
import type { Actor, DocumentRow, MemberRow, PendingEdit, Project, VersionSummary } from "./api";
import { server } from "./api";

/**
 * This module owns its state, not a component: bootstrap and the loaders write
 * from async continuations that run in whatever scope happened to call them, and
 * Solid 2 refuses a write from an owned scope unless the signal says it is the
 * owner. That refusal is a real guard — it stops stale component writes — but the
 * workspace store is genuinely shared, so the option is correct here.
 */
const OWNED = { ownedWrite: true } as const;

const [actor, setActor] = createSignal<Actor | null>(null, OWNED);
const [projects, setProjects] = createSignal<Project[]>([], OWNED);
const [projectId, setProjectId] = createSignal<string | null>(null, OWNED);
const [documents, setDocuments] = createSignal<DocumentRow[]>([], OWNED);
const [fileId, setFileId] = createSignal<string | null>(null, OWNED);
const [members, setMembers] = createSignal<MemberRow[]>([], OWNED);
const [edits, setEdits] = createSignal<PendingEdit[]>([], OWNED);
const [versions, setVersions] = createSignal<VersionSummary[]>([], OWNED);
const [status, setStatus] = createSignal<"loading" | "signed-out" | "ready" | "error">("loading", OWNED);
const [error, setError] = createSignal<string | null>(null, OWNED);
const [notice, setNotice] = createSignal<string | null>(null, OWNED);

/**
 * Derived reads, as plain functions.
 *
 * `createMemo` at module scope has no owner in Solid 2 and throws; a bare getter
 * keeps the dependency tracking at the call site, where a reactive scope does
 * exist.
 */
const currentProject = () => projects().find((p) => p.id === projectId()) ?? null;
const currentDocument = () => documents().find((d) => d.fileId === fileId()) ?? null;
const canEdit = () => {
  const role = actor()?.projectRole;
  if (role === "owner" || role === "editor") return true;
  const me = actor();
  const project = currentProject();
  if (!me || !project) return false;
  // `auth/me` does not carry a role for every project; the owner comparison is
  // the fallback the server itself uses.
  return project.ownerUid === me.id;
};

function tell(message: string | null) {
  setNotice(message);
  if (message) {
    window.setTimeout(() => setNotice((current) => (current === message ? null : current)), 3600);
  }
}

/** Load the identity and the projects. Returns false when nobody is signed in. */
async function bootstrap(): Promise<boolean> {
  setStatus("loading");
  setError(null);
  try {
    const { actor: me, projects: list } = await server.me();
    setActor(me);
    setProjects(list);
    setStatus("ready");
    if (list.length > 0 && !projectId()) {
      await selectProject(list[0].id);
    }
    return true;
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    setActor(null);
    setError(message);
    setStatus(message.includes("unauthenticated") ? "signed-out" : "error");
    return false;
  }
}

async function selectProject(id: string) {
  setProjectId(id);
  setFileId(null);
  setDocuments([]);
  setEdits([]);
  setVersions([]);
  try {
    const [{ documents: docs }, { members: people }] = await Promise.all([
      server.documents(id),
      server.members(id).catch(() => ({ members: [] as MemberRow[] })),
    ]);
    setDocuments(docs);
    setMembers(people);
    if (docs.length > 0) setFileId(docs[0].fileId);
  } catch (err) {
    tell(`读取项目失败：${(err as Error).message}`);
  }
}

function selectDocument(id: string) {
  setFileId(id);
  setVersions([]);
}

async function refreshDocuments() {
  const id = projectId();
  if (!id) return;
  const { documents: docs } = await server.documents(id);
  setDocuments(docs);
}

async function createDocument(fileIdInput: string, title?: string) {
  const id = projectId();
  if (!id) return;
  const { document: created } = await server.createDocument(id, fileIdInput, title);
  await refreshDocuments();
  selectDocument(created.fileId);
  tell("已新建文档");
}

async function deleteDocument(target: string) {
  const id = projectId();
  if (!id) return;
  await server.deleteDocument(id, target);
  await refreshDocuments();
  if (fileId() === target) {
    const next = documents()[0]?.fileId ?? null;
    setFileId(next);
  }
  tell("已删除文档");
}

async function createProject(name: string) {
  const { project } = await server.createProject(name);
  setProjects((list) => [project, ...list]);
  await selectProject(project.id);
  tell("已创建项目");
}

async function loadEdits(scope = "reviewing") {
  const id = projectId();
  if (!id) return;
  try {
    const { edits: list } = await server.pendingEdits(id, fileId() ?? undefined, scope);
    setEdits(list);
  } catch {
    setEdits([]);
  }
}

async function loadVersions() {
  const id = projectId();
  const doc = fileId();
  if (!id || !doc) return;
  try {
    const { versions: list } = await server.versions(id, doc);
    setVersions(list);
  } catch {
    setVersions([]);
  }
}

async function resolveEdit(edit: PendingEdit, action: "apply" | "reject") {
  const id = projectId();
  if (!id) return;
  try {
    if (action === "apply") {
      await server.applyEdit({
        projectId: id,
        filePath: edit.filePath,
        blocks: edit.blocks,
        editId: edit.id,
      });
      tell("已应用审阅建议");
    } else {
      await server.rejectEdit(edit.id);
      tell("已驳回");
    }
    await loadEdits();
  } catch (err) {
    tell(`${action === "apply" ? "应用" : "驳回"}失败：${(err as Error).message}`);
  }
}

export const workspace = {
  actor,
  projects,
  projectId,
  currentProject,
  documents,
  currentDocument,
  fileId,
  members,
  edits,
  versions,
  status,
  error,
  notice,
  canEdit,
  bootstrap,
  selectProject,
  selectDocument,
  refreshDocuments,
  createDocument,
  deleteDocument,
  createProject,
  loadEdits,
  loadVersions,
  resolveEdit,
  tell,
  setStatus,
  setError,
};
