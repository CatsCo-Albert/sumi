/**
 * E2E: auth — spin up ws-server, exercise:
 *   - no credentials → 1008 unauthenticated
 *   - session cookie → connection OK
 *   - viewer member → write drops (can't fully test drop without another client)
 *   - HMAC agent token → connection OK
 *
 * Run: WS_PORT=12346 node tests/e2e-auth.mjs
 * (Assumes ws-server is listening on $WS_PORT)
 */

import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { DatabaseSync } from "node:sqlite";
import crypto from "crypto";

// Bootstrap DB
const DB_DIR = process.env.SUMI_DATA_DIR || "/tmp/sumi-e2e-db";
const { execSync } = await import("child_process");
execSync(`mkdir -p ${DB_DIR}`);
const db = new DatabaseSync(`${DB_DIR}/sumi.db`);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

// Run the migration inline — same as src/db
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
    image TEXT, password_hash TEXT, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    file_id TEXT NOT NULL, title TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE (project_id, file_id)
  );
  CREATE TABLE IF NOT EXISTS project_members (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    subject_kind TEXT NOT NULL CHECK (subject_kind IN ('user','agent')),
    subject_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('viewer','editor','owner')),
    granted_by TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, subject_kind, subject_id)
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS magic_links (
    token_hash TEXT PRIMARY KEY, email TEXT NOT NULL,
    expires_at INTEGER NOT NULL, consumed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_project_members_subject
    ON project_members(subject_kind, subject_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id);
`);

const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const id = (p) => `${p}_${crypto.randomBytes(12).toString("hex")}`;

// Seed: alice owns "shared" project; bob is editor; agent is viewer
const alice = { id: id("usr"), email: "a@x.com", name: "Alice" };
const bob = { id: id("usr"), email: "b@x.com", name: "Bob" };
const agentId = id("agt");
const projectId = id("prj");
const now = Date.now();
const sessionToken = "test-session-" + crypto.randomBytes(16).toString("hex");
const agentToken = "sumi_agent_" + crypto.randomBytes(24).toString("hex");

db.prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)").run(alice.id, alice.email, alice.name, now);
db.prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)").run(bob.id, bob.email, bob.name, now);
db.prepare("INSERT INTO projects (id, name, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(projectId, "shared", alice.id, now, now);
db.prepare("INSERT INTO project_members (project_id, subject_kind, subject_id, role, granted_by, created_at) VALUES (?, 'user', ?, 'owner', ?, ?)").run(projectId, alice.id, alice.id, now);
db.prepare("INSERT INTO project_members (project_id, subject_kind, subject_id, role, granted_by, created_at) VALUES (?, 'user', ?, 'editor', ?, ?)").run(projectId, bob.id, alice.id, now);
db.prepare("INSERT INTO project_members (project_id, subject_kind, subject_id, role, granted_by, created_at) VALUES (?, 'agent', ?, 'viewer', ?, ?)").run(projectId, agentId, alice.id, now);
db.prepare("INSERT INTO agents (id, name, owner_id, token_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(agentId, "ci-bot", alice.id, sha256(agentToken), now);
db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(sha256(sessionToken), alice.id, now + 3600_000, now);

const WS_PORT = process.env.WS_PORT || 12346;
const room = `${projectId}-notes.md`;
const url = `ws://localhost:${WS_PORT}`;

// --- Test 1: no credentials → never gets 'sync' --------------------------
await new Promise((resolve, reject) => {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(url, room, doc);
  const timer = setTimeout(() => {
    provider.destroy();
    console.log("✅ anonymous rejected (no sync)");
    resolve();
  }, 2000);
  provider.once("sync", () => {
    clearTimeout(timer);
    provider.destroy();
    reject(new Error("anonymous client got sync — auth bypassed"));
  });
});

// --- Test 2: session cookie auth --------------------------------------------
await new Promise((resolve, reject) => {
  const doc = new Y.Doc();
  // pass session via cookie — y-websocket supports `params` or custom headers via `protocols`?
  // Browser-side cookies are auto-sent; Node we need to inject via `protocols` or `headers`.
  // y-websocket 3.x supports `headers` option in newer versions.
  const provider = new WebsocketProvider(url, room, doc, {
    params: { session: sessionToken },
  });
  provider.once("sync", () => {
    console.log("✅ session auth OK");
    provider.destroy();
    resolve();
  });
  setTimeout(() => reject(new Error("session auth timed out")), 4000);
});

// --- Test 3: bearer agent token ---------------------------------------------
await new Promise((resolve, reject) => {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(url, room, doc, {
    params: { agentToken },
  });
  provider.once("sync", () => {
    console.log("✅ agent bearer auth OK");
    provider.destroy();
    resolve();
  });
  setTimeout(() => reject(new Error("agent auth timed out")), 4000);
});

// --- Test 4: unauthorized user never syncs ---------------------------------
await new Promise((resolve, reject) => {
  const doc = new Y.Doc();
  const badToken = "session-for-unknown-user-" + crypto.randomBytes(8).toString("hex");
  const provider = new WebsocketProvider(url, room, doc, {
    params: { session: badToken },
  });
  const timer = setTimeout(() => {
    provider.destroy();
    console.log("✅ unauthorized session rejected (no sync)");
    resolve();
  }, 2000);
  provider.once("sync", () => {
    clearTimeout(timer);
    provider.destroy();
    reject(new Error("unauthorized session got sync — auth bypassed"));
  });
});

console.log("✅ all auth E2E tests passed");
process.exit(0);
