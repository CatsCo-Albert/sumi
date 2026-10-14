/**
 * Version history —— 文档历史版本（用户可见、可恢复）。
 *
 * 与 doc_snapshots 的区别：
 *   - doc_snapshots 是 pending-edit 漂移检测的操作性基线，单 latest 行
 *   - doc_versions 是追加式历史；auto 由保存路径触发（服务端防抖去重），
 *     manual 由用户点「快照」，restore 是恢复前对当前内容的保护性快照
 *
 * Auto-version 防抖（服务端裁决，路由返回 { created: false } 时跳过）：
 *   a) 距上一条 auto version < AUTO_MIN_INTERVAL_MS 且变化未超阈值 → 跳过
 *   b) 与最近版本 hash 相同 → 跳过
 *   c) 与最近版本差异 <=20% 且 <=500 字符 → 跳过
 *      （B 规则独立生效：内容差异足够大时无视时间间隔）
 *
 * 保留策略：auto/restore 版本每个 (project, file) 最多保留
 * AUTO_RETENTION 条；manual 版本不受 cap 影响。
 */

import crypto from "crypto";
import type { DatabaseSync } from "node:sqlite";

export type VersionSource = "auto" | "manual" | "restore";

export interface DocVersionRow {
  id: string;
  projectId: string;
  fileId: string;
  content: string;
  contentHash: string;
  authorId: string;
  authorName: string | null;
  label: string | null;
  source: VersionSource;
  sizeBytes: number;
  createdAt: number;
}

/** 列表条目 —— 不含 content（可能很大），预览单独截取。 */
export type DocVersionSummary = Omit<DocVersionRow, "content">;

export const AUTO_MIN_INTERVAL_MS = 5 * 60_000;
export const AUTO_CHANGE_RATIO = 0.2;
export const AUTO_CHANGE_CHARS = 500;
export const AUTO_RETENTION = 50;

const newId = () =>
  `ver_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

export const hashContent = (s: string) =>
  crypto.createHash("sha256").update(s, "utf8").digest("hex");

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface RawRow {
  id: string;
  project_id: string;
  file_id: string;
  content: string;
  content_hash: string;
  author_id: string;
  author_name: string | null;
  label: string | null;
  source: string;
  size_bytes: number;
  created_at: number;
}

function toRow(r: RawRow): DocVersionRow {
  return {
    id: r.id,
    projectId: r.project_id,
    fileId: r.file_id,
    content: r.content,
    contentHash: r.content_hash,
    authorId: r.author_id,
    authorName: r.author_name,
    label: r.label,
    source: r.source as VersionSource,
    sizeBytes: r.size_bytes,
    createdAt: r.created_at,
  };
}

function toSummary(r: Omit<RawRow, "content">): DocVersionSummary {
  const { content, ...row } = toRow({ ...r, content: "" });
  return row;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function addVersion(
  db: DatabaseSync,
  input: {
    projectId: string;
    fileId: string;
    content: string;
    authorId: string;
    authorName?: string;
    label?: string;
    source: VersionSource;
  }
): DocVersionRow {
  const id = newId();
  const row: RawRow = {
    id,
    project_id: input.projectId,
    file_id: input.fileId,
    content: input.content,
    content_hash: hashContent(input.content),
    author_id: input.authorId,
    author_name: input.authorName ?? null,
    label: input.label ?? null,
    source: input.source,
    size_bytes: Buffer.byteLength(input.content, "utf8"),
    created_at: Date.now(),
  };
  db.prepare(
    `INSERT INTO doc_versions
       (id, project_id, file_id, content, content_hash, author_id, author_name, label, source, size_bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.project_id,
    row.file_id,
    row.content,
    row.content_hash,
    row.author_id,
    row.author_name,
    row.label,
    row.source,
    row.size_bytes,
    row.created_at
  );
  if (input.source !== "manual") pruneAutoVersions(db, input.projectId, input.fileId);
  return toRow(row);
}

export function getVersion(
  db: DatabaseSync,
  id: string
): DocVersionRow | null {
  const r = db
    .prepare("SELECT * FROM doc_versions WHERE id = ?")
    .get(id) as RawRow | undefined;
  return r ? toRow(r) : null;
}

/** 最近的版本（含 content，供防抖比较）。 */
export function latestVersion(
  db: DatabaseSync,
  projectId: string,
  fileId: string
): DocVersionRow | null {
  const r = db
    .prepare(
      `SELECT * FROM doc_versions
       WHERE project_id = ? AND file_id = ?
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(projectId, fileId) as RawRow | undefined;
  return r ? toRow(r) : null;
}

export function listVersions(
  db: DatabaseSync,
  input: {
    projectId: string;
    fileId: string;
    source?: VersionSource;
    limit?: number;
    offset?: number;
  }
): { versions: DocVersionSummary[]; total: number } {
  const conds = ["project_id = ?", "file_id = ?"];
  const args: unknown[] = [input.projectId, input.fileId];
  if (input.source) {
    conds.push("source = ?");
    args.push(input.source);
  }
  const where = conds.join(" AND ");
  const total = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM doc_versions WHERE ${where}`)
      .get(...(args as string[])) as { n: number }
  ).n;
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const offset = Math.max(input.offset ?? 0, 0);
  const rows = db
    .prepare(
      `SELECT id, project_id, file_id, content_hash, author_id, author_name,
              label, source, size_bytes, created_at
       FROM doc_versions WHERE ${where}
       ORDER BY created_at DESC LIMIT ? OFFSET ?`
    )
    .all(...(args as string[]), limit, offset) as unknown as Omit<RawRow, "content">[];
  return { versions: rows.map(toSummary), total };
}

// ---------------------------------------------------------------------------
// Auto-version 防抖 —— 纯函数判定，路由层调用
// ---------------------------------------------------------------------------

export type AutoDecision = { create: true } | { create: false; reason: string };

export function shouldAutoVersion(
  prev: Pick<DocVersionRow, "content" | "contentHash" | "source" | "createdAt"> | null,
  nextContent: string,
  now = Date.now()
): AutoDecision {
  const nextHash = hashContent(nextContent);
  // 无历史 → 存第一条（也覆盖 prev.source=manual/restore 的边界情况）
  if (!prev || prev.source !== "auto") {
    if (prev && prev.contentHash === nextHash) {
      return { create: false, reason: "unchanged" };
    }
    return { create: true };
  }
  if (prev.contentHash === nextHash) return { create: false, reason: "unchanged" };

  const elapsed = now - prev.createdAt;
  const diffChars = lineDiffSize(prev.content, nextContent);
  const bigChange =
    diffChars > AUTO_CHANGE_CHARS ||
    diffChars > Math.max(prev.content.length, 1) * AUTO_CHANGE_RATIO;
  if (elapsed < AUTO_MIN_INTERVAL_MS && !bigChange) {
    return { create: false, reason: "debounced" };
  }
  return { create: true };
}

/** 简单差异度量：两侧对称差行内容的总字符数。 */
function lineDiffSize(a: string, b: string): number {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const count = (lines: string[]) => {
    const m = new Map<string, number>();
    for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const am = count(aLines);
  const bm = count(bLines);
  let diff = 0;
  for (const [l, n] of am) {
    const extra = n - (bm.get(l) ?? 0);
    if (extra > 0) diff += extra * (l.length + 1);
  }
  for (const [l, n] of bm) {
    const extra = n - (am.get(l) ?? 0);
    if (extra > 0) diff += extra * (l.length + 1);
  }
  return diff;
}

// ---------------------------------------------------------------------------
// 保留 —— auto/restore 版本 cap 50；manual 豁免
// ---------------------------------------------------------------------------

export function pruneAutoVersions(
  db: DatabaseSync,
  projectId: string,
  fileId: string
): number {
  const res = db
    .prepare(
      `DELETE FROM doc_versions
       WHERE project_id = ? AND file_id = ? AND source != 'manual'
         AND id NOT IN (
           SELECT id FROM doc_versions
           WHERE project_id = ? AND file_id = ? AND source != 'manual'
           ORDER BY created_at DESC LIMIT ${AUTO_RETENTION}
         )`
    )
    .run(projectId, fileId, projectId, fileId);
  return Number(res.changes);
}
