/**
 * Sumi-local identity projections.
 *
 * Auth itself lives in CatsCo — this module only stores what Sumi needs
 * to gate access: subjects (cached user/agent metadata), projects,
 * documents, and project_members role grants.
 */

import crypto from "crypto";
import type { DatabaseSync } from "node:sqlite";

const id = (prefix: string) =>
  `${prefix}_${crypto.randomBytes(12).toString("hex")}`;

// ---------------------------------------------------------------------------
// Subjects — cached CatsCo principals
// ---------------------------------------------------------------------------

export interface SubjectRow {
  subjectId: string;
  kind: "user" | "agent";
  displayName: string;
  username: string | null;
  avatarUrl: string | null;
  ownerUid: number | null;
  lastSeenAt: number;
}

/** Insert or refresh a subject record. Called whenever we resolve an actor. */
export function upsertSubject(
  db: DatabaseSync,
  input: {
    subjectId: string;
    kind: "user" | "agent";
    displayName: string;
    username?: string;
    avatarUrl?: string;
    ownerUid?: number;
  }
): SubjectRow {
  const now = Date.now();
  db.prepare(
    `INSERT INTO subjects (subject_id, kind, display_name, username, avatar_url, owner_uid, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (subject_id) DO UPDATE SET
       kind = excluded.kind,
       display_name = excluded.display_name,
       username = excluded.username,
       avatar_url = excluded.avatar_url,
       owner_uid = excluded.owner_uid,
       last_seen_at = excluded.last_seen_at`
  ).run(
    input.subjectId,
    input.kind,
    input.displayName,
    input.username ?? null,
    input.avatarUrl ?? null,
    input.ownerUid ?? null,
    now
  );
  return {
    subjectId: input.subjectId,
    kind: input.kind,
    displayName: input.displayName,
    username: input.username ?? null,
    avatarUrl: input.avatarUrl ?? null,
    ownerUid: input.ownerUid ?? null,
    lastSeenAt: now,
  };
}

export function getSubject(db: DatabaseSync, subjectId: string): SubjectRow | null {
  const row = db
    .prepare(
      `SELECT subject_id AS subjectId, kind, display_name AS displayName,
              username, avatar_url AS avatarUrl, owner_uid AS ownerUid,
              last_seen_at AS lastSeenAt
       FROM subjects WHERE subject_id = ?`
    )
    .get(subjectId) as SubjectRow | undefined;
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export interface ProjectRow {
  id: string;
  name: string;
  ownerUid: string;
  createdAt: number;
  updatedAt: number;
}

export function createProject(
  db: DatabaseSync,
  input: { name: string; ownerSubjectId: string }
): ProjectRow {
  const projectId = id("prj");
  const now = Date.now();
  db.prepare(
    "INSERT INTO projects (id, name, owner_uid, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
  ).run(projectId, input.name, input.ownerSubjectId, now, now);
  db.prepare(
    `INSERT INTO project_members (project_id, subject_id, role, granted_by, created_at)
     VALUES (?, ?, 'owner', ?, ?)`
  ).run(projectId, input.ownerSubjectId, input.ownerSubjectId, now);
  return {
    id: projectId,
    name: input.name,
    ownerUid: input.ownerSubjectId,
    createdAt: now,
    updatedAt: now,
  };
}

export function getProject(db: DatabaseSync, projectId: string): ProjectRow | null {
  const row = db
    .prepare(
      `SELECT id, name, owner_uid AS ownerUid, created_at AS createdAt, updated_at AS updatedAt
       FROM projects WHERE id = ?`
    )
    .get(projectId) as ProjectRow | undefined;
  return row ?? null;
}

/** All projects visible to a subject: owned OR member. */
export function listProjectsForSubject(
  db: DatabaseSync,
  subjectId: string
): ProjectRow[] {
  return db
    .prepare(
      `SELECT p.id, p.name, p.owner_uid AS ownerUid, p.created_at AS createdAt, p.updated_at AS updatedAt
       FROM projects p
       LEFT JOIN project_members m
         ON m.project_id = p.id AND m.subject_id = ?
       WHERE p.owner_uid = ? OR m.role IS NOT NULL
       ORDER BY p.updated_at DESC`
    )
    .all(subjectId, subjectId) as unknown as ProjectRow[];
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

export function grantMembership(
  db: DatabaseSync,
  input: {
    projectId: string;
    subjectId: string;
    role: "viewer" | "editor";
    grantedBy: string;
  }
): void {
  db.prepare(
    `INSERT INTO project_members (project_id, subject_id, role, granted_by, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (project_id, subject_id) DO UPDATE SET role = excluded.role`
  ).run(
    input.projectId,
    input.subjectId,
    input.role,
    input.grantedBy,
    Date.now()
  );
}

export function revokeMembership(
  db: DatabaseSync,
  projectId: string,
  subjectId: string
): boolean {
  const res = db
    .prepare("DELETE FROM project_members WHERE project_id = ? AND subject_id = ?")
    .run(projectId, subjectId);
  return res.changes > 0;
}

export function listMembers(
  db: DatabaseSync,
  projectId: string
): Array<{
  subjectId: string;
  role: string;
  displayName: string | null;
  kind: string | null;
}> {
  return db
    .prepare(
      `SELECT m.subject_id AS subjectId, m.role, s.display_name AS displayName, s.kind
       FROM project_members m
       LEFT JOIN subjects s ON s.subject_id = m.subject_id
       WHERE m.project_id = ?`
    )
    .all(projectId) as Array<{
    subjectId: string;
    role: string;
    displayName: string | null;
    kind: string | null;
  }>;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export interface DocumentRow {
  id: string;
  projectId: string;
  fileId: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
}

export function upsertDocument(
  db: DatabaseSync,
  input: { projectId: string; fileId: string; title?: string }
): DocumentRow {
  const docId = `${input.projectId}-${input.fileId}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO documents (id, project_id, file_id, title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (project_id, file_id) DO UPDATE SET
       title = COALESCE(excluded.title, documents.title),
       updated_at = excluded.updated_at`
  ).run(docId, input.projectId, input.fileId, input.title ?? null, now, now);
  return getDocumentById(db, docId)!;
}

export function getDocumentById(db: DatabaseSync, docId: string): DocumentRow | null {
  const row = db
    .prepare(
      `SELECT id, project_id AS projectId, file_id AS fileId, title,
              created_at AS createdAt, updated_at AS updatedAt
       FROM documents WHERE id = ?`
    )
    .get(docId) as DocumentRow | undefined;
  return row ?? null;
}

export function listDocuments(db: DatabaseSync, projectId: string): DocumentRow[] {
  return db
    .prepare(
      `SELECT id, project_id AS projectId, file_id AS fileId, title,
              created_at AS createdAt, updated_at AS updatedAt
       FROM documents WHERE project_id = ? ORDER BY updated_at DESC`
    )
    .all(projectId) as unknown as DocumentRow[];
}
