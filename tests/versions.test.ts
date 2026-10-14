/**
 * Version history —— 文档版本快照/恢复。
 *
 * 覆盖：
 *   - create + list + source 过滤
 *   - auto 防抖：同内容跳过；小改动在间隔内跳过；大改动无视间隔
 *   - restore：当前内容 → restore 安全版本 → 旧内容推回
 *   - 保留 cap：51 条 auto → 最旧被清；manual 豁免
 *   - auth：viewer 不能 create/restore
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { promises as fs } from "fs";
import crypto from "crypto";
import * as jose from "jose";
import { getDb, resetDbForTests } from "../src/db";
import { resetStorageForTests, getStorage } from "../src/storage";
import {
  upsertSubject,
  createProject,
  grantMembership,
} from "../src/auth/identity";
import {
  addVersion,
  listVersions,
  latestVersion,
  getVersion,
  shouldAutoVersion,
  AUTO_RETENTION,
} from "../src/versions";
import { subscribeUiEvents, resetUiEventBusForTests } from "../src/ui-bus/event-bus";

vi.hoisted(() => {
  process.env.SUMI_DATA_DIR = `/tmp/sumi-versions-test-${process.pid}`;
  process.env.OC_JWT_SECRET = "test-secret-versions";
});
const TEST_DIR = process.env.SUMI_DATA_DIR!;

const { GET, POST } = await import("../app/api/projects/[id]/versions/route");
const { POST: RESTORE } = await import(
  "../app/api/projects/[id]/versions/restore/route"
);

let testCounter = 0;

beforeEach(async () => {
  resetDbForTests();
  resetStorageForTests();
  resetUiEventBusForTests();
  process.env.SUMI_DATA_DIR = `${TEST_DIR}-${testCounter++}`;
  await fs.rm(process.env.SUMI_DATA_DIR, { recursive: true, force: true });
});

async function mintJwt(uid: number, username: string): Promise<string> {
  return new jose.SignJWT({ userId: uid, username })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("catscompany")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode("test-secret-versions"));
}

function req(method: string, path: string, token: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function setup() {
  const db = await getDb();
  upsertSubject(db, { subjectId: "u1", kind: "user", displayName: "Owner" });
  upsertSubject(db, { subjectId: "u2", kind: "user", displayName: "Editor" });
  upsertSubject(db, { subjectId: "u3", kind: "user", displayName: "Viewer" });
  upsertSubject(db, { subjectId: "u9", kind: "user", displayName: "Outsider" });
  const project = createProject(db, { name: "p", ownerSubjectId: "u1" });
  grantMembership(db, { projectId: project.id, subjectId: "u2", role: "editor", grantedBy: "u1" });
  grantMembership(db, { projectId: project.id, subjectId: "u3", role: "viewer", grantedBy: "u1" });
  const [ownerTok, editorTok, viewerTok, outsiderTok] = await Promise.all([
    mintJwt(1, "owner"),
    mintJwt(2, "editor"),
    mintJwt(3, "viewer"),
    mintJwt(9, "outsider"),
  ]);
  return { db, project, ownerTok, editorTok, viewerTok, outsiderTok };
}

describe("doc versions", () => {
  it("creates manual versions + lists them newest-first (no content in list)", async () => {
    const { project, ownerTok } = await setup();
    const res1 = await POST(
      req("POST", `/api/projects/${project.id}/versions`, ownerTok, {
        fileId: "doc.md",
        content: "# v1",
        label: "v1.0",
      }),
      params(project.id)
    );
    expect(res1.status).toBe(201);
    const d1 = await res1.json();
    expect(d1.created).toBe(true);
    expect(d1.version.source).toBe("manual");
    expect(d1.version.label).toBe("v1.0");
    expect(d1.version.content).toBeUndefined();

    // Small delay so created_at ordering is stable
    await new Promise((r) => setTimeout(r, 5));
    await POST(
      req("POST", `/api/projects/${project.id}/versions`, ownerTok, {
        fileId: "doc.md",
        content: "# v2",
      }),
      params(project.id)
    );

    const list = await GET(
      req("GET", `/api/projects/${project.id}/versions?fileId=doc.md`, ownerTok),
      params(project.id)
    );
    const ld = await list.json();
    expect(ld.total).toBe(2);
    expect(ld.versions).toHaveLength(2);
    expect(ld.versions[0].label).toBeNull(); // newest first
    expect(ld.versions[1].label).toBe("v1.0");
    expect(ld.versions[0].content).toBeUndefined();

    // detail fetch returns content
    const det = await GET(
      req(
        "GET",
        `/api/projects/${project.id}/versions?fileId=doc.md&id=${ld.versions[1].id}`,
        ownerTok
      ),
      params(project.id)
    );
    const dd = await det.json();
    expect(dd.version.content).toBe("# v1");
  });

  it("filters list by source", async () => {
    const { db, project } = await setup();
    addVersion(db, {
      projectId: project.id, fileId: "a.md", content: "x1",
      authorId: "u1", source: "auto",
    });
    addVersion(db, {
      projectId: project.id, fileId: "a.md", content: "x2",
      authorId: "u1", source: "manual",
    });
    const { versions, total } = listVersions(db, {
      projectId: project.id, fileId: "a.md", source: "manual",
    });
    expect(total).toBe(1);
    expect(versions[0].source).toBe("manual");
  });

  it("auto-version debounce: same content skipped, small change within 5min skipped, big change created", async () => {
    const { project, editorTok } = await setup();
    const base = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");

    // First auto-version lands (no history)
    let res = await POST(
      req("POST", `/api/projects/${project.id}/versions`, editorTok, {
        fileId: "f.md", source: "auto", content: base,
      }),
      params(project.id)
    );
    let d = await res.json();
    expect(d.created).toBe(true);

    // Same content → skipped
    res = await POST(
      req("POST", `/api/projects/${project.id}/versions`, editorTok, {
        fileId: "f.md", source: "auto", content: base,
      }),
      params(project.id)
    );
    d = await res.json();
    expect(d.created).toBe(false);
    expect(d.reason).toBe("unchanged");

    // Small change within the interval → debounced
    res = await POST(
      req("POST", `/api/projects/${project.id}/versions`, editorTok, {
        fileId: "f.md", source: "auto", content: base + "\nsmall tweak",
      }),
      params(project.id)
    );
    d = await res.json();
    expect(d.created).toBe(false);
    expect(d.reason).toBe("debounced");

    // Big change (>500 chars diff) → created despite the interval
    const big = base + "\n" + "new ".repeat(200);
    res = await POST(
      req("POST", `/api/projects/${project.id}/versions`, editorTok, {
        fileId: "f.md", source: "auto", content: big,
      }),
      params(project.id)
    );
    d = await res.json();
    expect(d.created).toBe(true);
  });

  it("manual snapshots skip unchanged content too", async () => {
    const { project, ownerTok } = await setup();
    await POST(
      req("POST", `/api/projects/${project.id}/versions`, ownerTok, {
        fileId: "m.md", source: "manual", content: "same",
      }),
      params(project.id)
    );
    const res = await POST(
      req("POST", `/api/projects/${project.id}/versions`, ownerTok, {
        fileId: "m.md", source: "manual", content: "same",
      }),
      params(project.id)
    );
    const d = await res.json();
    expect(d.created).toBe(false);
    expect(d.reason).toBe("unchanged");
  });

  it("restore: current content → safety version → target applied + broadcast", async () => {
    const { db, project, ownerTok } = await setup();

    // Seed "current" content on disk (ws-server offline → storage fallback)
    const storage = await getStorage();
    await storage.upload(
      `sumi/${project.id}/files/r.md`, "CURRENT CONTENT", "text/markdown"
    );

    // A historical version to restore
    const v = addVersion(db, {
      projectId: project.id, fileId: "r.md", content: "OLD CONTENT",
      authorId: "u1", source: "manual",
    });

    // Subscribe to broadcast
    const events: unknown[] = [];
    subscribeUiEvents("u1", (e) => events.push(e.patch));

    const res = await RESTORE(
      req("POST", `/api/projects/${project.id}/versions/restore`, ownerTok, {
        versionId: v.id,
      }),
      params(project.id)
    );
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.ok).toBe(true);

    // Safety version of "CURRENT CONTENT" recorded with source='restore'
    const { versions } = listVersions(db, { projectId: project.id, fileId: "r.md" });
    const safety = versions.find((x) => x.source === "restore");
    expect(safety).toBeDefined();
    const safetyFull = getVersion(db, safety!.id);
    expect(safetyFull?.content).toBe("CURRENT CONTENT");

    // Old content pushed to storage
    const nowOnDisk = (
      await storage.download(`sumi/${project.id}/files/r.md`)
    ).toString("utf8");
    expect(nowOnDisk).toBe("OLD CONTENT");

    // doc_restored broadcast went out
    await new Promise((r) => setTimeout(r, 20));
    expect(
      (events as Array<{ type: string }>).some((p) => p.type === "doc_restored")
    ).toBe(true);
  });

  it("restore is a no-op safety write when content already matches", async () => {
    const { db, project, ownerTok } = await setup();
    const storage = await getStorage();
    await storage.upload(
      `sumi/${project.id}/files/r2.md`, "SAME", "text/markdown"
    );
    const v = addVersion(db, {
      projectId: project.id, fileId: "r2.md", content: "SAME",
      authorId: "u1", source: "manual",
    });
    const res = await RESTORE(
      req("POST", `/api/projects/${project.id}/versions/restore`, ownerTok, {
        versionId: v.id,
      }),
      params(project.id)
    );
    expect(res.status).toBe(200);
    const { total } = listVersions(db, { projectId: project.id, fileId: "r2.md" });
    // Only the manual version — safety row skipped because content identical
    expect(total).toBe(1);
  });

  it("retention: auto cap 50 drops oldest; manual exempt", async () => {
    const { db, project } = await setup();
    for (let i = 0; i < AUTO_RETENTION + 5; i++) {
      addVersion(db, {
        projectId: project.id, fileId: "cap.md", content: `v${i}`,
        authorId: "u1", source: "auto",
      });
    }
    const autoRows = db
      .prepare(
        `SELECT COUNT(*) AS n FROM doc_versions
         WHERE project_id = ? AND file_id = 'cap.md' AND source != 'manual'`
      )
      .get(project.id) as { n: number };
    expect(autoRows.n).toBe(AUTO_RETENTION);

    // Manual rows never pruned
    for (let i = 0; i < 3; i++) {
      addVersion(db, {
        projectId: project.id, fileId: "cap.md", content: `m${i}`,
        authorId: "u1", source: "manual",
      });
    }
    // More autos — pruning still leaves manual untouched
    for (let i = 0; i < 5; i++) {
      addVersion(db, {
        projectId: project.id, fileId: "cap.md", content: `post${i}`,
        authorId: "u1", source: "auto",
      });
    }
    const counts = db
      .prepare(
        `SELECT source, COUNT(*) AS n FROM doc_versions
         WHERE project_id = ? AND file_id = 'cap.md' GROUP BY source`
      )
      .all(project.id) as Array<{ source: string; n: number }>;
    const bySource = Object.fromEntries(counts.map((c) => [c.source, c.n]));
    expect(bySource.manual).toBe(3);
    expect(bySource.auto).toBe(AUTO_RETENTION);
  });

  it("auth: viewer cannot create/restore; outsider gets 403; member can list", async () => {
    const { db, project, viewerTok, outsiderTok } = await setup();
    const v = addVersion(db, {
      projectId: project.id, fileId: "sec.md", content: "x",
      authorId: "u1", source: "manual",
    });

    // viewer → create denied
    let res = await POST(
      req("POST", `/api/projects/${project.id}/versions`, viewerTok, {
        fileId: "sec.md", content: "y",
      }),
      params(project.id)
    );
    expect(res.status).toBe(403);

    // viewer → restore denied
    res = await RESTORE(
      req("POST", `/api/projects/${project.id}/versions/restore`, viewerTok, {
        versionId: v.id,
      }),
      params(project.id)
    );
    expect(res.status).toBe(403);

    // outsider → list denied
    res = await GET(
      req("GET", `/api/projects/${project.id}/versions?fileId=sec.md`, outsiderTok),
      params(project.id)
    );
    expect(res.status).toBe(403);

    // viewer (member) → list allowed
    res = await GET(
      req("GET", `/api/projects/${project.id}/versions?fileId=sec.md`, viewerTok),
      params(project.id)
    );
    expect(res.status).toBe(200);
  });

  it("shouldAutoVersion: unit-level boundary cases", () => {
    const now = Date.now();
    const hash = (s: string) =>
      crypto.createHash("sha256").update(s, "utf8").digest("hex");
    // No history → create
    expect(shouldAutoVersion(null, "x", now).create).toBe(true);
    // Same hash → unchanged
    const same = shouldAutoVersion(
      { content: "abc", contentHash: hash("abc"), source: "auto", createdAt: now },
      "abc",
      now + 60_000
    );
    expect(same.create).toBe(false);
    // After 5min, small change → create
    const after = shouldAutoVersion(
      { content: "abc", contentHash: "h", source: "auto", createdAt: now },
      "abc!",
      now + 6 * 60_000
    );
    expect(after.create).toBe(true);
    // Previous was manual → treated as no-auto-history → create
    const afterManual = shouldAutoVersion(
      { content: "abc", contentHash: "h", source: "manual", createdAt: now },
      "abc!",
      now + 60_000
    );
    expect(afterManual.create).toBe(true);
  });
});
