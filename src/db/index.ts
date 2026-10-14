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
  {
    version: 2,
    sql: `
      -- Pending edits proposed by agents/users awaiting human review.
      -- One row per pending edit; content is a JSON blob (blocks + relpos).
      -- Keyed by (project_id, file_id) so multiple edits can queue per file,
      -- and by user_id so different users see their own pending sets.
      CREATE TABLE IF NOT EXISTS pending_edits (
        id           TEXT PRIMARY KEY,         -- "edit_<ts>_<rand>"
        project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        file_id      TEXT NOT NULL,
        user_id      TEXT NOT NULL,            -- subject this edit was proposed FOR
        author_id    TEXT NOT NULL,            -- subject that proposed it (usually agent)
        author_name  TEXT,
        description  TEXT,
        blocks       TEXT NOT NULL,            -- JSON array of EditBlock
        status       TEXT NOT NULL CHECK (status IN ('pending','applying','applied','rejected'))
                     DEFAULT 'pending',
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pending_edits_scope
        ON pending_edits(project_id, file_id, user_id, status);
    `,
  },
  {
    version: 3,
    sql: `
      -- Snapshot of the canonical document at propose-time.
      -- Used by the apply path to verify RelPos still resolves correctly
      -- (3-way merge baseline). One row per (projectId, fileId) — latest wins.
      CREATE TABLE IF NOT EXISTS doc_snapshots (
        project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        file_id      TEXT NOT NULL,
        content      TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        PRIMARY KEY (project_id, file_id)
      );
    `,
  },
  {
    version: 4,
    sql: `
      -- Agent lifecycle state: "active" (can auth), "disabled" (rejected).
      -- NULL/missing → active. Only meaningful for a* subjects.
      ALTER TABLE subjects ADD COLUMN status TEXT CHECK (status IN ('active','disabled'));
    `,
  },
  {
    version: 5,
    sql: `
      -- Richer project metadata for the table view.
      -- tags: JSON array of strings (kept simple; parse on read).
      ALTER TABLE projects ADD COLUMN description TEXT;
      ALTER TABLE projects ADD COLUMN tags TEXT;
      ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 6,
    sql: `
      -- Intents — agent-task requests anchored to a doc region.
      -- A human (or another agent) creates an intent targeting an agent
      -- subject (target_agent_id). The agent sees it via SSE broadcast
      -- (intent_created), answers via POST /api/intents/:id/answer, and
      -- its reply is stored + broadcast (intent_answered). Optionally
      -- the agent attaches a pending_edit_id when its response is an edit.
      CREATE TABLE IF NOT EXISTS intents (
        id               TEXT PRIMARY KEY,          -- "int_<ts>_<rand>"
        project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        file_id          TEXT NOT NULL,
        selection_start  INTEGER,                   -- 1-based inclusive line
        selection_end    INTEGER,
        selection_text   TEXT,                      -- snapshot of the selected text
        prompt           TEXT NOT NULL,
        author_id        TEXT NOT NULL,             -- who asked
        author_name      TEXT,
        target_agent_id  TEXT,                      -- "a*" subject, NULL = broadcast to all agents
        thread_id        TEXT,                      -- multi-turn conversation id
        status           TEXT NOT NULL CHECK (status IN ('open','claimed','answered','closed'))
                         DEFAULT 'open',
        answer_text      TEXT,
        answer_edit_id   TEXT,                      -- pending_edit.id if answered via an edit
        answered_by      TEXT,
        created_at       INTEGER NOT NULL,
        claimed_at       INTEGER,
        answered_at      INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_intents_scope
        ON intents(project_id, file_id, status);
      CREATE INDEX IF NOT EXISTS idx_intents_thread
        ON intents(thread_id);
      CREATE INDEX IF NOT EXISTS idx_intents_target
        ON intents(target_agent_id, status);
    `,
  },
  {
    version: 7,
    sql: `
      -- Shadow docs —— agent 的私密草稿区。
      -- 不渲染进编辑器、不进 Yjs；agent 迭代满意后 promote 成 pending_edit
      -- 走人工审核。owner 是创建它的 subject（通常 a*）。
      CREATE TABLE IF NOT EXISTS shadow_docs (
        id               TEXT PRIMARY KEY,          -- "shadow_<ts>_<rand>"
        project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        file_id          TEXT NOT NULL,
        owner_id         TEXT NOT NULL,             -- 创建它的 subject
        title            TEXT,                      -- 短标签，如 "formal rewrite v1"
        content          TEXT NOT NULL,             -- 草稿 markdown
        base_doc_hash    TEXT,                      -- 创建时文档 hash（漂移检测）
        status           TEXT NOT NULL CHECK (status IN ('draft','promoted','discarded'))
                         DEFAULT 'draft',
        promoted_edit_id TEXT,                      -- promote 后 → pending_edit.id
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_shadow_scope
        ON shadow_docs(project_id, file_id, owner_id, status);
    `,
  },
  {
    version: 8,
    sql: `
      -- Version history —— 用户可见的历史版本列表。
      -- 与 doc_snapshots 区分：snapshot 是操作性的漂移检测基线（单 latest），
      -- doc_versions 是用户可浏览/恢复的快照历史。
      CREATE TABLE IF NOT EXISTS doc_versions (
        id           TEXT PRIMARY KEY,         -- "ver_<ts>_<rand>"
        project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        file_id      TEXT NOT NULL,
        content      TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        author_id    TEXT NOT NULL,
        author_name  TEXT,
        label        TEXT,                     -- 可选人工标签 "v1.0"
        source       TEXT NOT NULL CHECK (source IN ('auto','manual','restore'))
                     DEFAULT 'auto',
        size_bytes   INTEGER NOT NULL,
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_doc_versions
        ON doc_versions(project_id, file_id, created_at DESC);
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
