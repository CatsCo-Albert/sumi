"use client";

/**
 * Version history panel —— 版本历史。
 *
 * Lives inside the SidePanel as the 「历史」 tab:
 *   - list of versions (relative time, author, label, size, source badge)
 *   - click to expand a ~20-line inline preview
 *   - 恢复 → inline confirm → POST /restore → editor reloads via Yjs
 *   - 对比当前 → unified line-diff (history version ↔ live content)
 *   - 快照 → manual snapshot POST (optional label)
 */

import { useCallback, useEffect, useState } from "react";
import { getAuthHeaders } from "@/lib/use-session";
import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/toast";
import { useUiStore } from "@/stores/ui-store";

interface VersionSummary {
  id: string;
  createdAt: number;
  authorId: string;
  authorName: string | null;
  label: string | null;
  source: "auto" | "manual" | "restore";
  sizeBytes: number;
  contentHash: string;
}

const SOURCE_LABEL: Record<VersionSummary["source"], string> = {
  auto: "自动",
  manual: "手动",
  restore: "恢复",
};

// ---------------------------------------------------------------------------
// Diff —— unified line diff (old = version, new = current). Simple LCS; docs
// here are small enough that O(n·m) memory is fine, with a size guard.
// ---------------------------------------------------------------------------

type DiffRow = { tag: " " | "-" | "+"; text: string };

function unifiedDiff(oldText: string, newText: string): DiffRow[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;
  // Guard: degenerate to a full replace when the matrix would blow up.
  if (n * m > 4_000_000) {
    const rows: DiffRow[] = [];
    for (const l of a) rows.push({ tag: "-", text: l });
    for (const l of b) rows.push({ tag: "+", text: l });
    return rows;
  }

  // LCS DP (row-compressed per i).
  let prev = new Uint32Array(m + 1);
  const dp: Uint32Array[] = [prev];
  for (let i = 1; i <= n; i++) {
    const cur = new Uint32Array(m + 1);
    for (let j = 1; j <= m; j++) {
      cur[j] =
        a[i - 1] === b[j - 1]
          ? prev[j - 1] + 1
          : Math.max(prev[j], cur[j - 1]);
    }
    dp.push(cur);
    prev = cur;
  }

  // Backtrack → rows
  const rows: DiffRow[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      rows.push({ tag: " ", text: a[i - 1] });
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      rows.push({ tag: "-", text: a[i - 1] });
      i--;
    } else {
      rows.push({ tag: "+", text: b[j - 1] });
      j--;
    }
  }
  while (i > 0) {
    rows.push({ tag: "-", text: a[i - 1] });
    i--;
  }
  while (j > 0) {
    rows.push({ tag: "+", text: b[j - 1] });
    j--;
  }
  rows.reverse();

  // Collapse long equal runs → "… N 行未变化 …"
  const out: DiffRow[] = [];
  const CTX = 3;
  let k = 0;
  while (k < rows.length) {
    if (rows[k].tag !== " ") {
      out.push(rows[k]);
      k++;
      continue;
    }
    let end = k;
    while (end < rows.length && rows[end].tag === " ") end++;
    const runLen = end - k;
    if (runLen > CTX * 2 + 1) {
      for (let x = 0; x < CTX; x++) out.push(rows[k + x]);
      out.push({ tag: " ", text: `⋯ ${runLen - CTX * 2} 行未变化 ⋯` });
      for (let x = end - CTX; x < end; x++) out.push(rows[x]);
    } else {
      for (let x = k; x < end; x++) out.push(rows[x]);
    }
    k = end;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function relativeTime(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "刚刚";
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)} 分钟前`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)} 小时前`;
  const d = h / 24;
  if (d < 30) return `${Math.floor(d)} 天前`;
  return new Date(ts).toLocaleDateString();
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function VersionHistory({
  projectId,
  fileId,
  currentContent,
  className,
}: {
  projectId: string;
  fileId: string;
  /** Live doc content — used as the "current" side of 对比当前. */
  currentContent: string;
  className?: string;
}) {
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, string>>({});
  const [diffFor, setDiffFor] = useState<{ id: string; rows: DiffRow[] } | null>(null);
  const [fullViewId, setFullViewId] = useState<string | null>(null);
  const [confirmRestoreId, setConfirmRestoreId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [labelOpen, setLabelOpen] = useState(false);
  const [labelInput, setLabelInput] = useState("");
  const lastRestore = useUiStore((s) => s.lastRestore);

  const load = useCallback(() => {
    if (!projectId || !fileId) return;
    setLoading(true);
    fetch(
      `/api/projects/${projectId}/versions?fileId=${encodeURIComponent(fileId)}`,
      { headers: getAuthHeaders() }
    )
      .then((r) => (r.ok ? r.json() : { versions: [] }))
      .then((d) => setVersions(d.versions ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [projectId, fileId]);

  useEffect(load, [load]);

  // Refresh after a restore lands (doc_restored broadcast).
  useEffect(() => {
    if (lastRestore && lastRestore.documentId === `${projectId}-${fileId}`) {
      load();
    }
  }, [lastRestore, projectId, fileId, load]);

  const fetchContent = useCallback(
    async (id: string): Promise<string | null> => {
      if (detail[id] !== undefined) return detail[id];
      try {
        const r = await fetch(
          `/api/projects/${projectId}/versions?fileId=${encodeURIComponent(fileId)}&id=${encodeURIComponent(id)}`,
          { headers: getAuthHeaders() }
        );
        if (!r.ok) return null;
        const d = await r.json();
        const c = (d.version?.content ?? "") as string;
        setDetail((s) => ({ ...s, [id]: c }));
        return c;
      } catch {
        return null;
      }
    },
    [detail, projectId, fileId]
  );

  const toggleExpand = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    setConfirmRestoreId(null);
    setDiffFor(null);
    setFullViewId(null);
    await fetchContent(id);
  };

  const showDiff = async (id: string) => {
    if (diffFor?.id === id) {
      setDiffFor(null);
      return;
    }
    const content = await fetchContent(id);
    if (content === null) return;
    setDiffFor({ id, rows: unifiedDiff(content, currentContent) });
  };

  const restore = async (id: string) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/projects/${projectId}/versions/restore`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ versionId: id }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || `恢复失败 (${r.status})`);
      }
      toast({ title: "已恢复到此版本", variant: "success" });
      setConfirmRestoreId(null);
      load();
    } catch (err) {
      toast({
        title: "恢复失败",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  const snapshot = async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/projects/${projectId}/versions`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          fileId,
          source: "manual",
          content: currentContent,
          label: labelInput.trim() || undefined,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `快照失败 (${r.status})`);
      if (d.created === false) {
        toast({ title: "内容未变化", description: "与最近版本相同，已跳过" });
      } else {
        toast({ title: "快照已保存", variant: "success" });
      }
      setLabelOpen(false);
      setLabelInput("");
      load();
    } catch (err) {
      toast({
        title: "快照失败",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      {/* Header — 快照 button */}
      <div className="flex shrink-0 items-center justify-between px-3 py-2">
        <span className="text-[11px] text-muted-foreground/70">
          {versions.length} 个版本
        </span>
        {labelOpen ? (
          <div className="flex items-center gap-1">
            <input
              autoFocus
              value={labelInput}
              onChange={(e) => setLabelInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") snapshot();
                if (e.key === "Escape") setLabelOpen(false);
              }}
              placeholder="标签（可选）"
              className="h-6 w-24 rounded border border-border bg-background px-1.5 text-[10px] outline-none focus:ring-1 focus:ring-primary"
            />
            <button
              onClick={snapshot}
              disabled={busy}
              className="rounded bg-primary px-2 py-0.5 text-[10px] font-medium text-primary-foreground disabled:opacity-50"
            >
              保存
            </button>
            <button
              onClick={() => setLabelOpen(false)}
              className="text-[10px] text-muted-foreground/70 hover:text-foreground"
            >
              ✕
            </button>
          </div>
        ) : (
          <button
            onClick={() => setLabelOpen(true)}
            className="rounded-md border border-border/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            快照
          </button>
        )}
      </div>

      {/* List */}
      <ul className="flex-1 overflow-auto pb-2">
        {loading ? (
          <li className="p-4 text-[12px] text-muted-foreground">载入中…</li>
        ) : versions.length === 0 ? (
          <li className="p-4 text-[12px] text-muted-foreground">
            暂无历史版本
          </li>
        ) : (
          versions.map((v) => (
            <li key={v.id} className="border-b border-border/40 last:border-0">
              <button
                onClick={() => toggleExpand(v.id)}
                className="flex w-full flex-col gap-0.5 px-3 py-2 text-left transition-colors hover:bg-accent/40"
              >
                <div className="flex items-center gap-1.5">
                  {v.label && (
                    <span className="rounded bg-primary/10 px-1 py-px text-[9px] font-medium text-primary">
                      {v.label}
                    </span>
                  )}
                  <span
                    className={cn(
                      "rounded px-1 py-px text-[9px]",
                      v.source === "manual"
                        ? "bg-emerald-500/10 text-emerald-600"
                        : v.source === "restore"
                          ? "bg-amber-500/10 text-amber-600"
                          : "bg-muted text-muted-foreground/70"
                    )}
                  >
                    {SOURCE_LABEL[v.source]}
                  </span>
                  <span className="ml-auto text-[10px] text-muted-foreground/60">
                    {fmtSize(v.sizeBytes)}
                  </span>
                </div>
                <div className="flex items-baseline gap-1.5 text-[11px]">
                  <span className="truncate font-medium text-foreground">
                    {v.authorName || v.authorId}
                  </span>
                  <span className="text-[10px] text-muted-foreground/60">
                    {relativeTime(v.createdAt)}
                  </span>
                </div>
              </button>

              {/* Expanded detail */}
              {expandedId === v.id && (
                <div className="border-t border-border/40 bg-accent/20 px-3 py-2">
                  {detail[v.id] === undefined ? (
                    <div className="py-2 text-[10px] text-muted-foreground">
                      载入中…
                    </div>
                  ) : diffFor?.id === v.id ? (
                    <DiffView rows={diffFor.rows} />
                  ) : (
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-muted-foreground">
                      {fullViewId === v.id
                        ? detail[v.id]
                        : detail[v.id].split("\n").slice(0, 20).join("\n") +
                          (detail[v.id].split("\n").length > 20 ? "\n…" : "")}
                    </pre>
                  )}
                  <div className="mt-2 flex items-center gap-1.5">
                    <button
                      onClick={() =>
                        setFullViewId((s) => (s === v.id ? null : v.id))
                      }
                      className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {fullViewId === v.id ? "收起" : "查看全部"}
                    </button>
                    <button
                      onClick={() => showDiff(v.id)}
                      className={cn(
                        "rounded border px-1.5 py-0.5 text-[10px] font-medium transition-colors",
                        diffFor?.id === v.id
                          ? "border-primary/40 bg-primary/10 text-primary"
                          : "border-border/60 text-muted-foreground hover:text-foreground"
                      )}
                    >
                      对比当前
                    </button>
                    {confirmRestoreId === v.id ? (
                      <>
                        <span className="text-[10px] text-amber-600">
                          恢复此版本？
                        </span>
                        <button
                          onClick={() => restore(v.id)}
                          disabled={busy}
                          className="rounded bg-destructive px-1.5 py-0.5 text-[10px] font-medium text-destructive-foreground disabled:opacity-50"
                        >
                          确认
                        </button>
                        <button
                          onClick={() => setConfirmRestoreId(null)}
                          className="text-[10px] text-muted-foreground/70 hover:text-foreground"
                        >
                          取消
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => setConfirmRestoreId(v.id)}
                        className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                      >
                        恢复
                      </button>
                    )}
                  </div>
                </div>
              )}
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

function DiffView({ rows }: { rows: DiffRow[] }) {
  const changed = rows.filter((r) => r.tag !== " ").length;
  return (
    <div className="max-h-64 overflow-auto rounded border border-border/60 bg-background">
      {changed === 0 ? (
        <div className="p-3 text-[10px] text-muted-foreground">
          与当前内容相同
        </div>
      ) : (
        <pre className="font-mono text-[10px] leading-relaxed">
          {rows.map((r, i) => (
            <div
              key={i}
              className={cn(
                "whitespace-pre-wrap px-2",
                r.tag === "+"
                  ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                  : r.tag === "-"
                    ? "bg-red-500/10 text-red-700 dark:text-red-400"
                    : "text-muted-foreground"
              )}
            >
              {r.tag === " " ? "  " : `${r.tag} `}
              {r.text}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}
