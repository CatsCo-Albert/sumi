/**
 * Persistence — node:sqlite (built-in since Node 22).
 *
 * Single-file DB at $SUMI_DATA_DIR/sumi.db, WAL mode, foreign keys on.
 * Schemas are additive: migrations keyed by user_version pragma.
 *
 * Auth comes from CatsCo (JWT + ApiKey); this DB stores only Sumi-local
 * projections: subjects, projects, documents, memberships.
 */

import { DatabaseSync } from "node:sqlite";
import path from "path";
import { promises as fs } from "fs";

let dbInstance: DatabaseSync | null = null;

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      -- Cached display info about CatsCo principals (users/agents).
      -- subject_id format: "u{uid}" for users, "a{uid}" for agents.
      CREATE TABLE IF NOT EXISTS subjects (
        subject_id   TEXT PRIMARY KEY,
        kind         TEXT NOT NULL CHECK (kind IN ('user','agent')),
        display_name TEXT NOT NULL,
        username     TEXT,
        avatar_url   TEXT,
        owner_uid    INTEGER,                  -- for agents: their human owner
        last_seen_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        owner_uid    TEXT NOT NULL,            -- subject_id of creator
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS documents (
        id           TEXT PRIMARY KEY,         -- "{projectId}-{fileId}"
        project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        file_id      TEXT NOT NULL,
        title        TEXT,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        UNIQUE (project_id, file_id)
      );

      CREATE TABLE IF NOT EXISTS project_members (
        project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        subject_id   TEXT NOT NULL REFERENCES subjects(subject_id) ON DELETE CASCADE,
        role         TEXT NOT NULL CHECK (role IN ('viewer','editor','owner')),
        granted_by   TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        PRIMARY KEY (project_id, subject_id)
      );

      CREATE INDEX IF NOT EXISTS idx_project_members_subject
        ON project_members(subject_id);
      CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id);
    `,
  },
];

export async function getDb(): Promise<DatabaseSync> {
  if (dbInstance) return dbInstance;

  const dir = process.env.SUMI_DATA_DIR || path.join(process.cwd(), "data");
  await fs.mkdir(dir, { recursive: true });
  const dbPath = path.join(dir, "sumi.db");

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA synchronous = NORMAL;");

  const vRow = db.prepare("PRAGMA user_version").get() as { user_version: number };
  let version = vRow.user_version;
  for (const m of MIGRATIONS) {
    if (m.version <= version) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec("COMMIT");
      version = m.version;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  dbInstance = db;
  return db;
}

export function resetDbForTests(): void {
  if (dbInstance) {
    try { dbInstance.close(); } catch { /* already closed */ }
    dbInstance = null;
  }
}
