/**
 * E2E: CatsCo auth — spin up ws-server, exercise:
 *   - no credentials → rejected (no sync)
 *   - valid CatsCo JWT → connected (user role)
 *   - ApiKey introspection via a stub CatsCo server → connected (agent)
 *   - bad token → rejected
 *
 * Requires a stub CatsCo introspect server. Run:
 *   WS_PORT=12346 CATSCO_STUB_PORT=18901 node tests/e2e-auth.mjs
 *   # plus ws-server running with OC_JWT_SECRET + CATSCO_SERVICE_TOKEN + CATSCO_BASE_URL
 */

import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { DatabaseSync } from "node:sqlite";
import crypto from "crypto";
import http from "http";
import * as jose from "jose";

// ---------------------------------------------------------------------------
// Stub CatsCo introspect server
// ---------------------------------------------------------------------------

const CATSCO_STUB_PORT = parseInt(process.env.CATSCO_STUB_PORT || "18901");
const WS_PORT = process.env.WS_PORT || 12346;
const JWT_SECRET = process.env.OC_JWT_SECRET || "test-secret";
const SERVICE_TOKEN = "cats_svc_test";

const stub = http.createServer((req, res) => {
  const auth = req.headers.authorization || "";
  if (req.method === "POST" && req.url === "/api/account/introspect" && auth === `Service ${SERVICE_TOKEN}`) {
    let body = "";
    req.on("data", (c) => (body += c.toString()));
    req.on("end", () => {
      const { token } = JSON.parse(body);
      // Accept a known-good ApiKey
      if (token === "cc_agent_test_key") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          active: true,
          user: {
            uid: 42,
            username: "ci-bot",
            display_name: "CI Bot",
            account_type: 1,
            state: 0,
            owner: { uid: 1, username: "alice" },
          },
        }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ active: false, error: "invalid_or_expired_token" }));
    });
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => stub.listen(CATSCO_STUB_PORT, r));

// ---------------------------------------------------------------------------
// Seed Sumi's sqlite: project + membership
// ---------------------------------------------------------------------------

const DB_DIR = process.env.SUMI_DATA_DIR || "/tmp/sumi-e2e-catsco";
const { execSync } = await import("child_process");
execSync(`mkdir -p ${DB_DIR}`);
const db = new DatabaseSync(`${DB_DIR}/sumi.db`);
db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
db.exec(`
  CREATE TABLE IF NOT EXISTS subjects (
    subject_id TEXT PRIMARY KEY, kind TEXT NOT NULL, display_name TEXT NOT NULL,
    username TEXT, avatar_url TEXT, owner_uid INTEGER, last_seen_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_uid TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS project_members (
    project_id TEXT NOT NULL, subject_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('viewer','editor','owner')),
    granted_by TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, subject_id)
  );
`);

const aliceUid = 1;
const agentUid = 42;
const aliceSubject = `u${aliceUid}`;
const agentSubject = `a${agentUid}`;
const projectId = "prj_e2e";
const now = Date.now();

db.prepare(`INSERT OR REPLACE INTO subjects (subject_id, kind, display_name, username, last_seen_at)
            VALUES (?, ?, ?, ?, ?)`).run(aliceSubject, "user", "Alice", "alice", now);
db.prepare(`INSERT OR REPLACE INTO subjects (subject_id, kind, display_name, username, owner_uid, last_seen_at)
            VALUES (?, ?, ?, ?, ?, ?)`).run(agentSubject, "agent", "CI Bot", "ci-bot", aliceUid, now);
db.prepare(`INSERT OR REPLACE INTO projects (id, name, owner_uid, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)`).run(projectId, "e2e", aliceSubject, now, now);
db.prepare(`INSERT OR REPLACE INTO project_members (project_id, subject_id, role, granted_by, created_at)
            VALUES (?, ?, 'owner', ?, ?)`).run(projectId, aliceSubject, aliceSubject, now);
db.prepare(`INSERT OR REPLACE INTO project_members (project_id, subject_id, role, granted_by, created_at)
            VALUES (?, ?, 'viewer', ?, ?)`).run(projectId, agentSubject, aliceSubject, now);

// Flush WAL so the ws-server's separate connection sees the seeded rows.
db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
db.close();

// Mint a CatsCo-shaped JWT for alice
const secret = new TextEncoder().encode(JWT_SECRET);
const aliceJwt = await new jose.SignJWT({
  userId: aliceUid,
  username: "alice",
  email: "a@x.com",
  token_type: "user",
})
  .setProtectedHeader({ alg: "HS256" })
  .setIssuer("catscompany")
  .setIssuedAt()
  .setExpirationTime("7d")
  .sign(secret);

const room = `${projectId}-notes.md`;
const url = `ws://localhost:${WS_PORT}`;

// --- Test 1: no credentials → rejected --------------------------------------
await new Promise((resolve, reject) => {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(url, room, doc);
  const timer = setTimeout(() => {
    provider.destroy();
    console.log("✅ anonymous rejected");
    resolve();
  }, 1500);
  provider.once("sync", () => {
    clearTimeout(timer);
    provider.destroy();
    reject(new Error("anonymous client got sync"));
  });
});

// --- Test 2: CatsCo JWT (user) ----------------------------------------------
await new Promise((resolve, reject) => {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(url, room, doc, {
    params: { token: aliceJwt },
  });
  provider.on("status", (s) => console.log("  [test2] status:", s.status));
  provider.on("sync", (synced) => {
    if (!synced) return;
    console.log("✅ JWT auth OK");
    provider.destroy();
    resolve();
  });
  provider.on("connection-close", (e) =>
    console.log("  [test2] close:", e?.code, e?.reason)
  );
  provider.on("connection-error", (e) =>
    console.log("  [test2] err:", e?.message)
  );
  setTimeout(() => reject(new Error("JWT auth timed out")), 8000);
});

// --- Test 3: CatsCo ApiKey (agent) -------------------------------------------
await new Promise((resolve, reject) => {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(url, room, doc, {
    params: { api_key: "cc_agent_test_key" },
  });
  provider.on("status", (s) => console.log("  [test3] status:", s.status));
  provider.on("sync", (synced) => {
    if (!synced) return;
    console.log("✅ ApiKey auth OK (agent)");
    provider.destroy();
    resolve();
  });
  provider.on("connection-close", (e) =>
    console.log("  [test3] close:", e?.code, e?.reason)
  );
  setTimeout(() => reject(new Error("ApiKey auth timed out")), 8000);
});

// --- Test 4: bad JWT → rejected ----------------------------------------------
await new Promise((resolve, reject) => {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(url, room, doc, {
    params: { token: "not-a-jwt" },
  });
  const timer = setTimeout(() => {
    provider.destroy();
    console.log("✅ bad JWT rejected");
    resolve();
  }, 1500);
  provider.once("sync", () => {
    clearTimeout(timer);
    provider.destroy();
    reject(new Error("bad JWT got sync"));
  });
});

console.log("✅ all CatsCo auth E2E tests passed");
stub.close();
process.exit(0);
