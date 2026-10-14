/**
 * Shadow docs —— agent 的私密草稿区。
 *
 * 与 pending edits 的区别：
 *   - shadow 是工作区，不是提案 —— 不渲染进编辑器，不进 Yjs，不产生锁定
 *   - agent 在 shadow 里反复迭代；满意后 promote 成 pending_edit 走人工审核
 *
 * 数据模型：一行 = 一份草稿。owner 是创建它的 subject（通常 a*）。
 */

import crypto from "crypto";
import type { DatabaseSync } from "node:sqlite";
import type { EditBlock } from "./server/edit-position-tracker";
import { publishUiPatch } from "./ui-bus/event-bus";

export type ShadowStatus = "draft" | "promoted" | "discarded";

export interface ShadowDocRow {
  id: string;
  projectId: string;
  fileId: string;
  ownerId: string;
  title: string | null;
  content: string;
  baseDocHash: string | null;
  status: ShadowStatus;
  promotedEditId: string | null;
  createdAt: number;
  updatedAt: number;
}

const newId = () =>
  `shadow_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface RawRow {
  id: string;
  project_id: string;
  file_id: string;
  owner_id: string;
  title: string | null;
  content: string;
  base_doc_hash: string | null;
  status: string;
  promoted_edit_id: string | null;
  created_at: number;
  updated_at: number;
}

function toRow(r: RawRow): ShadowDocRow {
  return {
    id: r.id,
    projectId: r.project_id,
    fileId: r.file_id,
    ownerId: r.owner_id,
    title: r.title,
    content: r.content,
    baseDocHash: r.base_doc_hash,
    status: r.status as ShadowStatus,
    promotedEditId: r.promoted_edit_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function createShadowDoc(
  db: DatabaseSync,
  input: {
    projectId: string;
    fileId: string;
    ownerId: string;
    content: string;
    title?: string;
    baseDocHash?: string | null;
  }
): ShadowDocRow {
  const id = newId();
  const now = Date.now();
  db.prepare(
    `INSERT INTO shadow_docs
       (id, project_id, file_id, owner_id, title, content, base_doc_hash, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`
  ).run(
    id,
    input.projectId,
    input.fileId,
    input.ownerId,
    input.title ?? null,
    input.content,
    input.baseDocHash ?? null,
    now,
    now
  );
  return getShadowDoc(db, id)!;
}

export function getShadowDoc(
  db: DatabaseSync,
  id: string
): ShadowDocRow | null {
  const r = db
    .prepare(`SELECT * FROM shadow_docs WHERE id = ?`)
    .get(id) as RawRow | undefined;
  return r ? toRow(r) : null;
}

export function listShadowDocs(
  db: DatabaseSync,
  input: {
    projectId: string;
    fileId?: string;
    ownerId?: string;
    /** 默认只列 draft —— promoted/discarded 属历史，需要显式查询 */
    status?: ShadowStatus;
    includeArchived?: boolean;
  }
): ShadowDocRow[] {
  const conds: string[] = ["project_id = ?"];
  const args: unknown[] = [input.projectId];
  if (input.fileId) {
    conds.push("file_id = ?");
    args.push(input.fileId);
  }
  if (input.ownerId) {
    conds.push("owner_id = ?");
    args.push(input.ownerId);
  }
  if (input.status) {
    conds.push("status = ?");
    args.push(input.status);
  } else if (!input.includeArchived) {
    conds.push("status = 'draft'");
  }
  const rows = db
    .prepare(
      `SELECT * FROM shadow_docs WHERE ${conds.join(" AND ")}
       ORDER BY updated_at DESC`
    )
    .all(...(args as string[])) as unknown as RawRow[];
  return rows.map(toRow);
}

/** 更新草稿字段。返回 false = 不存在或非 draft。 */
export function updateShadowDoc(
  db: DatabaseSync,
  input: {
    id: string;
    content?: string;
    title?: string;
    status?: ShadowStatus;
    promotedEditId?: string;
  }
): ShadowDocRow | null {
  const existing = getShadowDoc(db, input.id);
  if (!existing) return null;

  const sets: string[] = ["updated_at = ?"];
  const args: unknown[] = [Date.now()];
  if (input.content !== undefined) {
    sets.push("content = ?");
    args.push(input.content);
  }
  if (input.title !== undefined) {
    sets.push("title = ?");
    args.push(input.title);
  }
  if (input.status !== undefined) {
    sets.push("status = ?");
    args.push(input.status);
  }
  if (input.promotedEditId !== undefined) {
    sets.push("promoted_edit_id = ?");
    args.push(input.promotedEditId);
  }
  args.push(input.id);
  db.prepare(
    `UPDATE shadow_docs SET ${sets.join(", ")} WHERE id = ?`
  ).run(...(args as (string | number)[]));
  return getShadowDoc(db, input.id);
}

export function deleteShadowDoc(db: DatabaseSync, id: string): boolean {
  return db.prepare("DELETE FROM shadow_docs WHERE id = ?").run(id).changes > 0;
}

// ---------------------------------------------------------------------------
// 广播 —— 项目全体成员（含 agents），fire-and-forget
// ---------------------------------------------------------------------------

export type ShadowEventType =
  | "shadow_doc_created"
  | "shadow_doc_updated"
  | "shadow_doc_promoted"
  | "shadow_doc_discarded";

/**
 * Tell every project member that a shadow doc changed.
 *
 * Awaited by callers: the HTTP response reports the change, so the patches must
 * be published before it is sent. The previous fire-and-forget wrapper let a
 * patch land after the response, which a client can miss by reloading, and
 * which leaked across test cases because a late patch arrived while the next
 * case's listener was already attached.
 */
export async function notifyShadow(
  db: DatabaseSync,
  patch: {
    type: ShadowEventType;
    projectId: string;
    fileId: string;
    shadow?: unknown;
    shadowId?: string;
    edits?: unknown[];
  }
): Promise<void> {
  const members = db
    .prepare("SELECT subject_id FROM project_members WHERE project_id = ?")
    .all(patch.projectId) as { subject_id: string }[];
  for (const m of members) {
    await publishUiPatch({
      userId: m.subject_id,
      projectId: patch.projectId,
      patch,
      source: "external_agent",
    });
  }
}

// ---------------------------------------------------------------------------
// Promotion —— shadow → pending_edit 的 diff 计算
// ---------------------------------------------------------------------------

interface DiffOp {
  op: "equal" | "replace" | "insert" | "delete";
  /** equal: 共有行数；replace/delete: 旧行数；insert/replace: 新行数 */
  oldCount: number;
  newCount: number;
}

/**
 * Myers O(ND) 行级 diff —— 返回最少编辑脚本。
 * 输入按行切分；输出一串 op，可重放出 newLines。
 */
function myersLines(oldLines: string[], newLines: string[]): DiffOp[] {
  const N = oldLines.length;
  const M = newLines.length;

  // 公共前缀/后缀先剥掉 —— 大部分编辑只动中间一小块
  let pre = 0;
  while (pre < N && pre < M && oldLines[pre] === newLines[pre]) pre++;
  let suf = 0;
  while (
    suf < N - pre &&
    suf < M - pre &&
    oldLines[N - 1 - suf] === newLines[M - 1 - suf]
  ) {
    suf++;
  }

  const a = oldLines.slice(pre, N - suf);
  const b = newLines.slice(pre, M - suf);

  const ops: DiffOp[] = [];
  if (pre > 0) ops.push({ op: "equal", oldCount: pre, newCount: pre });

  if (a.length === 0 && b.length === 0) {
    if (suf > 0) ops.push({ op: "equal", oldCount: suf, newCount: suf });
    return ops;
  }
  if (a.length === 0) {
    ops.push({ op: "insert", oldCount: 0, newCount: b.length });
    if (suf > 0) ops.push({ op: "equal", oldCount: suf, newCount: suf });
    return ops;
  }
  if (b.length === 0) {
    ops.push({ op: "delete", oldCount: a.length, newCount: 0 });
    if (suf > 0) ops.push({ op: "equal", oldCount: suf, newCount: suf });
    return ops;
  }

  // 行 → 整数 id（同一个 Map，两端共享）
  const ids = new Map<string, number>();
  const toId = (s: string) => {
    let v = ids.get(s);
    if (v === undefined) {
      v = ids.size;
      ids.set(s, v);
    }
    return v;
  };
  const ai = a.map(toId);
  const bi = b.map(toId);
  const n = ai.length;
  const m = bi.length;

  // Myers：追踪每轮 d 的 V 数组，回溯出编辑路径
  const max = n + m;
  const trace: Int32Array[] = [];
  let v = new Int32Array(2 * max + 1);
  let found = -1;

  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      // k = x - y；在 V 数组里的下标偏移 max
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + max] < v[k + 1 + max])) {
        x = v[k + 1 + max]; // 下移（insert）
      } else {
        x = v[k - 1 + max] + 1; // 右移（delete）
      }
      let y = x - k;
      while (x < n && y < m && ai[x] === bi[y]) {
        x++;
        y++;
      }
      v[k + max] = x;
      if (x >= n && y >= m) {
        found = d;
        break outer;
      }
    }
  }

  if (found === -1) {
    // 防御：理论上不可达，兜底为整段替换
    ops.push({ op: "replace", oldCount: a.length, newCount: b.length });
    if (suf > 0) ops.push({ op: "equal", oldCount: suf, newCount: suf });
    return ops;
  }

  // 回溯 trace → op 序列（中段），顺序从后往前
  const midOps: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && prev[k - 1 + max] < prev[k + 1 + max])) {
      prevK = k + 1; // 来自下移 → insert
    } else {
      prevK = k - 1; // 来自右移 → delete
    }
    const prevX = prev[prevK + max];
    const prevY = prevX - prevK;

    // snake 段 = equal
    const snake = x - Math.max(prevX, prevK === k + 1 ? prevX : prevX + 1);
    if (snake > 0) {
      midOps.push({ op: "equal", oldCount: snake, newCount: snake });
      x -= snake;
      y -= snake;
    }

    if (prevK === k + 1) {
      midOps.push({ op: "insert", oldCount: 0, newCount: 1 });
      y -= 1;
    } else {
      midOps.push({ op: "delete", oldCount: 1, newCount: 0 });
      x -= 1;
    }
  }
  if (x > 0 || y > 0) {
    // d=0 的剩余 snake
    const rest = Math.min(x, y);
    midOps.push({ op: "equal", oldCount: rest, newCount: rest });
  }

  // 反转回正序 + 合并相邻同类 + delete/insert 相邻合并为 replace
  midOps.reverse();
  const merged: DiffOp[] = [];
  for (const op of midOps) {
    const last = merged[merged.length - 1];
    if (last && last.op === op.op) {
      last.oldCount += op.oldCount;
      last.newCount += op.newCount;
    } else {
      merged.push({ ...op });
    }
  }
  // delete+insert 相邻 → replace（保留顺序无关：insert+delete 也按 replace 处理）
  const finalOps: DiffOp[] = [];
  for (let i = 0; i < merged.length; i++) {
    const cur = merged[i];
    const next = merged[i + 1];
    if (
      next &&
      ((cur.op === "delete" && next.op === "insert") ||
        (cur.op === "insert" && next.op === "delete"))
    ) {
      const del = cur.op === "delete" ? cur : next;
      const ins = cur.op === "insert" ? cur : next;
      finalOps.push({
        op: "replace",
        oldCount: del.oldCount,
        newCount: ins.newCount,
      });
      i++;
    } else {
      finalOps.push(cur);
    }
  }

  ops.push(...finalOps);
  if (suf > 0) ops.push({ op: "equal", oldCount: suf, newCount: suf });
  return ops;
}

/**
 * shadow → EditBlock[]。base 是创建 shadow 时锚定的文档（或当前文档）。
 * 返回 null = 无差异（不应 promote）。
 *
 * 输出策略：
 *   - 每个差异区域一个 block；`original` 记旧内容供 diff 视图
 *   - 差异区域间隔 <2 行时合并为一个 block（减少人类 review 噪音）
 */
export function shadowToBlocks(
  baseContent: string,
  shadowContent: string
): EditBlock[] | null {
  if (baseContent === shadowContent) return null;

  const oldLines = baseContent.split("\n");
  const newLines = shadowContent.split("\n");
  const ops = myersLines(oldLines, newLines);

  // 把 ops 转成 [oldStart, oldEnd, newText] 区域（1-based inclusive）
  interface Region {
    oldStart: number;
    oldEnd: number; // exclusive of insert-only
    newStart: number;
    newEnd: number;
  }
  const regions: Region[] = [];
  let oldPos = 1;
  let newPos = 1;
  for (const op of ops) {
    if (op.op === "equal") {
      oldPos += op.oldCount;
      newPos += op.newCount;
    } else if (op.op === "replace") {
      regions.push({
        oldStart: oldPos,
        oldEnd: oldPos + op.oldCount - 1,
        newStart: newPos,
        newEnd: newPos + op.newCount - 1,
      });
      oldPos += op.oldCount;
      newPos += op.newCount;
    } else if (op.op === "delete") {
      regions.push({
        oldStart: oldPos,
        oldEnd: oldPos + op.oldCount - 1,
        newStart: newPos,
        newEnd: newPos - 1,
      });
      oldPos += op.oldCount;
    } else {
      // insert —— 挂在前一行之后。oldEnd < oldStart 表示纯插入。
      regions.push({
        oldStart: oldPos,
        oldEnd: oldPos - 1,
        newStart: newPos,
        newEnd: newPos + op.newCount - 1,
      });
      newPos += op.newCount;
    }
  }
  if (regions.length === 0) return null;

  // 近邻合并：相隔 ≤1 行的区域合成一个 block
  const mergedRegions: Region[] = [];
  for (const r of regions) {
    const last = mergedRegions[mergedRegions.length - 1];
    if (last && r.oldStart - last.oldEnd <= 2) {
      last.oldEnd = Math.max(last.oldEnd, r.oldEnd);
      last.newEnd = Math.max(last.newEnd, r.newEnd);
    } else {
      mergedRegions.push({ ...r });
    }
  }

  return mergedRegions.map((r) => {
    let startLine = r.oldStart;
    let endLine = r.oldEnd;
    let newText: string;
    if (r.oldEnd < r.oldStart) {
      // 纯插入：EditBlock 只表达闭区间替换，把插入点处那一行纳入范围。
      // oldStart 越过末尾 → 追加到最后一行；否则插入到 oldStart 行之前，
      // 用「新行 + 原行」替换原行。
      const ins = newLines.slice(r.newStart - 1, r.newEnd).join("\n");
      if (r.oldStart > oldLines.length) {
        startLine = oldLines.length;
        endLine = oldLines.length;
        newText = (oldLines[oldLines.length - 1] ?? "") + "\n" + ins;
      } else {
        startLine = r.oldStart;
        endLine = r.oldStart;
        newText = ins + "\n" + oldLines[r.oldStart - 1];
      }
    } else {
      newText = newLines.slice(r.newStart - 1, r.newEnd).join("\n");
    }
    const original = oldLines.slice(startLine - 1, endLine).join("\n");
    return { startLine, endLine, updated: newText, original };
  });
}


