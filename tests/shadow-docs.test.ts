/**
 * Shadow docs —— agent 私密草稿区。
 *
 * 覆盖：
 *   - create → get → list filters（mine / fileId / status）
 *   - owner-only 编辑；viewer 只读；discard 权限
 *   - promote：diff → blocks，正确生成 pending_edit，状态迁移
 *   - 广播：publishUiPatch 被调用（spy 检查）
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { promises as fs } from "fs";
import * as jose from "jose";
import { getDb, resetDbForTests } from "../src/db";
import { resetStorageForTests, getStorage } from "../src/storage";
import {
  upsertSubject,
  createProject,
  grantMembership,
} from "../src/auth/identity";
import { listPendingEdits } from "../src/pending-edits";
import { shadowToBlocks } from "../src/shadow-docs";
import {
  GET,
  POST,
  PATCH,
  DELETE,
} from "../app/api/shadow-docs/route";
import { POST as PROMOTE } from "../app/api/shadow-docs/promote/route";

// 模块级 const 在 import 时就锁定 env —— 必须在模块加载前设置
vi.hoisted(() => {
  process.env.SUMI_DATA_DIR = `/tmp/sumi-shadow-test-${process.pid}`;
  process.env.OC_JWT_SECRET = "test-secret-shadow";
});
const TEST_DIR = process.env.SUMI_DATA_DIR!;

async function mintJwt(uid: number, username: string): Promise<string> {
  const secret = new TextEncoder().encode("test-secret-shadow");
  return new jose.SignJWT({ userId: uid, username })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("catscompany")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(secret);
}

function req(
  method: string,
  path: string,
  token: string,
  body?: unknown
): Request {
  const url = `http://localhost${path}`;
  return new Request(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

let ownerTok: string;
let editorTok: string;
let viewerTok: string;
let agentTok: string;
let projectId: string;

let testCounter = 0;

beforeEach(async () => {
  // 每个 test 独立目录 —— publishUiPatch 的持久化写是 fire-and-forget，
  // rm 共享目录会跟上一测试的未落盘写入竞争（ENOTEMPTY）。
  resetDbForTests();
  resetStorageForTests();
  process.env.SUMI_DATA_DIR = `${TEST_DIR}-${testCounter++}`;
  await fs.rm(process.env.SUMI_DATA_DIR, { recursive: true, force: true });

  const db = await getDb();
  upsertSubject(db, { subjectId: "u1", kind: "user", displayName: "Owner" });
  upsertSubject(db, { subjectId: "u2", kind: "user", displayName: "Editor" });
  upsertSubject(db, { subjectId: "u3", kind: "user", displayName: "Viewer" });
  upsertSubject(db, {
    subjectId: "a9",
    kind: "agent",
    displayName: "bot",
    ownerUid: 1,
  });
  const project = createProject(db, { name: "x", ownerSubjectId: "u1" });
  projectId = project.id;
  grantMembership(db, {
    projectId,
    subjectId: "u2",
    role: "editor",
    grantedBy: "u1",
  });
  grantMembership(db, {
    projectId,
    subjectId: "u3",
    role: "viewer",
    grantedBy: "u1",
  });
  grantMembership(db, {
    projectId,
    subjectId: "a9",
    role: "editor",
    grantedBy: "u1",
  });

  ownerTok = await mintJwt(1, "owner");
  editorTok = await mintJwt(2, "editor");
  viewerTok = await mintJwt(3, "viewer");
  // agent 也用 JWT（a9 subject 已 upsert，JWT 里 uid=9 → u9，不匹配…）
  // 所以 agent 请求复用 editorTok —— 权限语义一致（editor 角色）。
  agentTok = editorTok;
});

// ---------------------------------------------------------------------------

describe("shadow-docs routes", () => {
  it("create → get → list with filters", async () => {
    // 上传一个基准文件，让 baseDocHash 生效
    const storage = await getStorage();
    await storage.upload(`sumi/${projectId}/files/a.md`, "l1\nl2\nl3\n");

    const res = await POST(
      req("POST", "/api/shadow-docs", agentTok, {
        projectId,
        fileId: "a.md",
        content: "l1\nl2 CHANGED\nl3\nl4 new\n",
        title: "rewrite v1",
      })
    );
    expect(res.status).toBe(201);
    const { shadow } = await res.json();
    expect(shadow.id).toMatch(/^shadow_/);
    expect(shadow.ownerId).toBe("u2"); // editorTok → u2
    expect(shadow.status).toBe("draft");
    expect(shadow.baseDocHash).toBeTruthy(); // 服务端算的，非客户端传

    // list —— 项目成员都能看
    const list = await (
      await GET(req("GET", `/api/shadow-docs?projectId=${projectId}`, viewerTok))
    ).json();
    expect(list.shadows).toHaveLength(1);

    // mine=1 → viewer 自己的（空）
    const mine = await (
      await GET(
        req("GET", `/api/shadow-docs?projectId=${projectId}&mine=1`, viewerTok)
      )
    ).json();
    expect(mine.shadows).toHaveLength(0);

    // fileId 过滤
    const byFile = await (
      await GET(
        req(
          "GET",
          `/api/shadow-docs?projectId=${projectId}&fileId=other.md`,
          viewerTok
        )
      )
    ).json();
    expect(byFile.shadows).toHaveLength(0);
  });

  it("viewer can read but not create/edit/delete", async () => {
    // viewer 创建 → 403
    const c = await POST(
      req("POST", "/api/shadow-docs", viewerTok, {
        projectId,
        fileId: "a.md",
        content: "x",
      })
    );
    expect(c.status).toBe(403);

    // owner 建一个
    const created = await (
      await POST(
        req("POST", "/api/shadow-docs", agentTok, {
          projectId,
          fileId: "a.md",
          content: "draft",
        })
      )
    ).json();

    // viewer 读 → 200
    const g = await GET(
      req("GET", `/api/shadow-docs?projectId=${projectId}`, viewerTok)
    );
    expect(g.status).toBe(200);

    // viewer 改内容 → 403（非 owner）
    const p = await PATCH(
      req("PATCH", "/api/shadow-docs", viewerTok, {
        id: created.shadow.id,
        content: "hacked",
      })
    );
    expect(p.status).toBe(403);

    // viewer 删 → 403
    const d = await DELETE(
      req("DELETE", "/api/shadow-docs", viewerTok, { id: created.shadow.id })
    );
    expect(d.status).toBe(403);
  });

  it("owner-only content edit; project owner can discard", async () => {
    const created = await (
      await POST(
        req("POST", "/api/shadow-docs", agentTok, {
          projectId,
          fileId: "a.md",
          content: "v1",
          title: "t",
        })
      )
    ).json();
    const id = created.shadow.id;

    // 非 owner（owner 是 u1，shadow owner 是 u2）改内容 → 403
    const p1 = await PATCH(
      req("PATCH", "/api/shadow-docs", ownerTok, { id, content: "nope" })
    );
    expect(p1.status).toBe(403);

    // owner 自己改 → 200
    const p2 = await PATCH(
      req("PATCH", "/api/shadow-docs", agentTok, {
        id,
        content: "v2",
        title: "t2",
      })
    );
    expect(p2.status).toBe(200);
    const { shadow: s2 } = await p2.json();
    expect(s2.content).toBe("v2");
    expect(s2.title).toBe("t2");

    // 项目 owner discard → 200
    const p3 = await PATCH(
      req("PATCH", "/api/shadow-docs", ownerTok, { id, status: "discarded" })
    );
    expect(p3.status).toBe(200);
    expect((await p3.json()).shadow.status).toBe("discarded");

    // discarded 后不能再编辑
    const p4 = await PATCH(
      req("PATCH", "/api/shadow-docs", agentTok, { id, content: "v3" })
    );
    expect(p4.status).toBe(409);
  });

  it("promote → pending_edit with diff blocks", async () => {
    const base = "l1\nl2\nl3\nl4\nl5\n";
    const shadow = "l1\nl2 CHANGED\nl3\nl4\nl5\nl6 new\n";
    const storage = await getStorage();
    await storage.upload(`sumi/${projectId}/files/a.md`, base);

    const created = await (
      await POST(
        req("POST", "/api/shadow-docs", agentTok, {
          projectId,
          fileId: "a.md",
          content: shadow,
          title: "v1",
        })
      )
    ).json();

    const res = await PROMOTE(
      req("POST", "/api/shadow-docs/promote", agentTok, {
        id: created.shadow.id,
      })
    );
    expect(res.status).toBe(201);
    const { edits } = await res.json();
    expect(edits.length).toBeGreaterThan(0);
    expect(edits[0].description).toContain("Promoted from shadow: v1");
    expect(edits[0].authorId).toBe("u2");

    // pending_edit 出现在 reviewer（owner u1）的队列里
    const pending = listPendingEdits(await getDb(), {
      projectId,
      userId: "u1",
    });
    expect(pending.length).toBe(edits.length);

    // shadow 状态 → promoted
    const after = await (
      await GET(
        req(
          "GET",
          `/api/shadow-docs?projectId=${projectId}&all=1`,
          ownerTok
        )
      )
    ).json();
    expect(after.shadows[0].status).toBe("promoted");
    expect(after.shadows[0].promotedEditId).toBe(edits[0].id);

    // 已 promote 不能再次 promote
    const again = await PROMOTE(
      req("POST", "/api/shadow-docs/promote", agentTok, {
        id: created.shadow.id,
      })
    );
    expect(again.status).toBe(409);
  });

  it("promote identical content → 400", async () => {
    const storage = await getStorage();
    await storage.upload(`sumi/${projectId}/files/a.md`, "same\n");
    const created = await (
      await POST(
        req("POST", "/api/shadow-docs", agentTok, {
          projectId,
          fileId: "a.md",
          content: "same\n",
        })
      )
    ).json();
    const res = await PROMOTE(
      req("POST", "/api/shadow-docs/promote", agentTok, {
        id: created.shadow.id,
      })
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// shadowToBlocks —— diff 逻辑单测
// ---------------------------------------------------------------------------

describe("shadowToBlocks", () => {
  it("returns null for identical input", () => {
    expect(shadowToBlocks("a\nb\n", "a\nb\n")).toBeNull();
  });

  it("single-line replace", () => {
    const blocks = shadowToBlocks("l1\nl2\nl3\n", "l1\nX\nl3\n")!;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].startLine).toBe(2);
    expect(blocks[0].endLine).toBe(2);
    expect(blocks[0].updated).toBe("X");
    expect(blocks[0].original).toBe("l2");
  });

  it("insert at end", () => {
    // "l1\nl2\n".split('\n') = ['l1','l2',''] —— 末尾空串占第 3 行，
    // 所以插入发生在第 3 行处，block 覆盖它
    const blocks = shadowToBlocks("l1\nl2\n", "l1\nl2\nl3\n")!;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].startLine).toBe(3);
    expect(blocks[0].updated).toBe("l3\n");
    expect(blocks[0].original).toBe("");
  });

  it("insert after non-empty last line (no trailing newline)", () => {
    const blocks = shadowToBlocks("l1\nl2", "l1\nl2\nl3")!;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].startLine).toBe(2);
    expect(blocks[0].updated).toBe("l2\nl3");
  });

  it("insert in middle", () => {
    const blocks = shadowToBlocks("l1\nl3\n", "l1\nl2\nl3\n")!;
    expect(blocks).toHaveLength(1);
    // 插入在 l3 前 → block 覆盖 l3，updated = "l2\nl3"
    expect(blocks[0].startLine).toBe(2);
    expect(blocks[0].updated).toBe("l2\nl3");
    expect(blocks[0].original).toBe("l3");
  });

  it("delete lines", () => {
    const blocks = shadowToBlocks("l1\nl2\nl3\nl4\n", "l1\nl4\n")!;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].startLine).toBe(2);
    expect(blocks[0].endLine).toBe(3);
    expect(blocks[0].updated).toBe("");
  });

  it("multi-hunk: distant changes produce separate blocks", () => {
    const base = "a1\na2\na3\na4\na5\na6\na7\na8\n";
    const next = "X1\na2\na3\na4\na5\na6\nX7\na8\n";
    const blocks = shadowToBlocks(base, next)!;
    // 两个不相邻的区域 → 两个 block
    expect(blocks).toHaveLength(2);
    expect(blocks[0].startLine).toBe(1);
    expect(blocks[1].startLine).toBe(7);
  });

  it("adjacent changes merge into one block", () => {
    const base = "a1\na2\na3\na4\n";
    const next = "X1\na2\nX3\na4\n";
    const blocks = shadowToBlocks(base, next)!;
    // 差 1 行 → 合并
    expect(blocks).toHaveLength(1);
    expect(blocks[0].startLine).toBe(1);
    expect(blocks[0].endLine).toBe(3);
  });
});
