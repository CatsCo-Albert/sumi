"use client";

/**
 * Sortable project table — the rich view inside DocumentListPane.
 * Inspired by litewrite's ProjectTable: checkbox multi-select, sortable
 * headers, hover-reveal row actions, relative timestamps, tag chips,
 * owner + member count columns. <640px: collapses to card list.
 */

import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/toast";

export interface TableProject {
  id: string;
  name: string;
  ownerUid: string;
  description?: string | null;
  tags?: string[];
  archived?: boolean;
  memberCount?: number;
  ownerDisplayName?: string | null;
  updatedAt: number;
}

type SortKey = "name" | "updatedAt";
type SortOrder = "asc" | "desc";

/** "3 分钟前" / "昨天" / "上周" / absolute date. */
function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  if (hours < 24) return `${hours} 小时前`;
  if (days === 1) return "昨天";
  if (days < 7) return `${days} 天前`;
  if (days < 14) return "上周";
  if (days < 60) return `${Math.floor(days / 7)} 周前`;
  return new Date(ts).toLocaleDateString();
}

/** Deterministic pastel tint for a tag chip from its name. */
function tagColor(tag: string): string {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(h) % 360} 60% 45%)`;
}

interface ProjectTableProps {
  projects: TableProject[];
  sessionSubjectId: string | null;
  selectedId: string | null;
  busy: Set<string>;
  onOpen: (p: TableProject) => void;
  onRename: (id: string, name: string) => Promise<TableProject | null>;
  onDelete: (id: string) => Promise<boolean>;
  onArchive: (id: string, archived: boolean) => Promise<TableProject | null>;
  onRemoved: (ids: string[]) => void;
  onUpdated: (p: TableProject) => void;
}

export default function ProjectTable({
  projects,
  sessionSubjectId,
  selectedId,
  busy,
  onOpen,
  onRename,
  onDelete,
  onArchive,
  onRemoved,
  onUpdated,
}: ProjectTableProps) {
  const [sort, setSort] = useState<SortKey>("updatedAt");
  const [order, setOrder] = useState<SortOrder>("desc");
  const [showArchived, setShowArchived] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDeleteIds, setConfirmDeleteIds] = useState<Set<string>>(
    new Set()
  );

  const visible = useMemo(
    () =>
      projects
        .filter((p) => showArchived || !p.archived)
        .sort((a, b) => {
          const c =
            sort === "name"
              ? a.name.localeCompare(b.name)
              : a.updatedAt - b.updatedAt;
          return order === "asc" ? c : -c;
        }),
    [projects, showArchived, sort, order]
  );

  const allChecked =
    visible.length > 0 && visible.every((p) => checked.has(p.id));
  const ownedSelected = [...checked].filter(
    (id) => projects.find((p) => p.id === id)?.ownerUid === sessionSubjectId
  );

  const toggleSort = (key: SortKey) => {
    if (sort === key) setOrder((o) => (o === "asc" ? "desc" : "asc"));
    else {
      setSort(key);
      setOrder(key === "name" ? "asc" : "desc");
    }
  };

  const toggleCheck = (id: string) =>
    setChecked((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const toggleAll = () =>
    setChecked(allChecked ? new Set() : new Set(visible.map((p) => p.id)));

  const submitRename = async (p: TableProject) => {
    if (busy.has(`rename-${p.id}`)) return;
    const next = await onRename(p.id, renameValue);
    setRenamingId(null);
    if (next) onUpdated(next);
  };

  const deleteOne = async (p: TableProject) => {
    const ok = await onDelete(p.id);
    if (ok) {
      onRemoved([p.id]);
      setChecked((s) => {
        const n = new Set(s);
        n.delete(p.id);
        return n;
      });
      setConfirmDeleteIds((s) => {
        const n = new Set(s);
        n.delete(p.id);
        return n;
      });
    }
  };

  const deleteSelected = async () => {
    for (const id of ownedSelected) {
      if (await onDelete(id)) {
        onRemoved([id]);
        setChecked((s) => {
          const n = new Set(s);
          n.delete(id);
          return n;
        });
      }
    }
    setConfirmDeleteIds(new Set());
  };

  const archiveSelected = async () => {
    for (const id of ownedSelected) {
      const next = await onArchive(id, true);
      if (next) onUpdated(next);
    }
    setChecked(new Set());
  };

  const sortIndicator = (key: SortKey) =>
    sort === key ? (order === "asc" ? " ↑" : " ↓") : "";

  const ownerLabel = (p: TableProject) =>
    p.ownerUid === sessionSubjectId ? "我" : p.ownerDisplayName || p.ownerUid;

  const archivedToggle = (
    <div className="flex items-center justify-between border-b border-border/60 px-3 py-1.5">
      <span className="text-[10px] text-muted-foreground/70">
        {visible.length} 个项目
      </span>
      <button
        onClick={() => setShowArchived((v) => !v)}
        className={cn(
          "text-[10px] transition-colors",
          showArchived
            ? "text-foreground"
            : "text-muted-foreground/70 hover:text-foreground"
        )}
      >
        {showArchived ? "隐藏已归档" : "显示已归档"}
      </button>
    </div>
  );

  if (visible.length === 0) {
    return (
      <div>
        {projects.length > 0 && archivedToggle}
        <div className="flex flex-col items-center justify-center p-8 text-center">
          <div className="text-[13px] font-medium text-foreground">
            {projects.length === 0 ? "还没有项目" : "没有可见的项目"}
          </div>
          <div className="mt-1 text-[12px] text-muted-foreground">
            {projects.length === 0
              ? "点右上角「+ 新建」创建第一个项目"
              : "所有项目都已归档"}
          </div>
        </div>
      </div>
    );
  }

  const nameCell = (p: TableProject) => (
    <div className="min-w-0">
      {renamingId === p.id ? (
        <input
          autoFocus
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitRename(p);
            if (e.key === "Escape") setRenamingId(null);
          }}
          onClick={(e) => e.stopPropagation()}
          onBlur={() => setRenamingId(null)}
          className="w-full rounded border border-border bg-background px-1.5 py-0.5 text-[12px] outline-none focus:ring-1 focus:ring-primary"
        />
      ) : (
        <button
          onClick={() => onOpen(p)}
          className={cn(
            "block max-w-full truncate text-left text-[13px] font-medium",
            selectedId === p.id ? "text-primary" : "text-foreground"
          )}
        >
          {p.name}
        </button>
      )}
      {p.description && (
        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {p.description}
        </div>
      )}
      {p.tags && p.tags.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {p.tags.slice(0, 3).map((t) => (
            <span
              key={t}
              className="rounded px-1.5 py-0.5 text-[9px] font-medium"
              style={{ backgroundColor: `${tagColor(t)}1f`, color: tagColor(t) }}
            >
              {t}
            </span>
          ))}
          {p.tags.length > 3 && (
            <span className="text-[9px] text-muted-foreground">
              +{p.tags.length - 3}
            </span>
          )}
        </div>
      )}
    </div>
  );

  const rowActions = (p: TableProject) => {
    const isOwner = p.ownerUid === sessionSubjectId;
    const confirming = confirmDeleteIds.has(p.id);
    return (
      <div className="flex items-center justify-end gap-2 whitespace-nowrap opacity-0 transition-opacity group-hover:opacity-100">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onOpen(p);
          }}
          className="text-[11px] text-muted-foreground hover:text-foreground"
        >
          打开
        </button>
        {isOwner && (
          <>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setRenamingId(p.id);
                setRenameValue(p.name);
              }}
              className="text-[11px] text-muted-foreground hover:text-foreground"
            >
              重命名
            </button>
            {confirming ? (
              <>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmDeleteIds((s) => {
                      const n = new Set(s);
                      n.delete(p.id);
                      return n;
                    });
                  }}
                  className="text-[11px] text-muted-foreground hover:text-foreground"
                >
                  取消
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteOne(p);
                  }}
                  disabled={busy.has(`delete-${p.id}`)}
                  className="text-[11px] font-medium text-destructive disabled:opacity-50"
                >
                  确认删除
                </button>
              </>
            ) : (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmDeleteIds((s) => new Set(s).add(p.id));
                }}
                className="text-[11px] text-muted-foreground hover:text-destructive"
              >
                删除
              </button>
            )}
          </>
        )}
      </div>
    );
  };

  return (
    <div className="relative">
      {/* Archived filter toggle */}
      {archivedToggle}

      {/* Table — sm and up */}
      <table className="hidden w-full sm:table">
        <thead>
          <tr className="border-b border-border/60 text-left text-[10px] font-medium text-muted-foreground">
            <th className="w-7 px-3 py-1.5">
              <input
                type="checkbox"
                checked={allChecked}
                onChange={toggleAll}
                className="h-3 w-3 accent-primary"
                aria-label="全选"
              />
            </th>
            <th
              onClick={() => toggleSort("name")}
              className="cursor-pointer px-1 py-1.5 hover:text-foreground"
            >
              名称{sortIndicator("name")}
            </th>
            <th className="w-20 px-1 py-1.5">Owner</th>
            <th className="w-10 px-1 py-1.5">成员</th>
            <th
              onClick={() => toggleSort("updatedAt")}
              className="w-20 cursor-pointer px-1 py-1.5 hover:text-foreground"
            >
              更新于{sortIndicator("updatedAt")}
            </th>
            <th className="w-36 px-3 py-1.5 text-right">操作</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((p) => (
            <tr
              key={p.id}
              onClick={() => onOpen(p)}
              className={cn(
                "group cursor-pointer border-b border-border/40 transition-colors",
                selectedId === p.id
                  ? "bg-accent/70"
                  : checked.has(p.id)
                    ? "bg-primary/5"
                    : "hover:bg-accent/40",
                p.archived && "opacity-55"
              )}
            >
              <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={checked.has(p.id)}
                  onChange={() => toggleCheck(p.id)}
                  className="h-3 w-3 accent-primary"
                  aria-label={`选择 ${p.name}`}
                />
              </td>
              <td className="max-w-0 px-1 py-2">{nameCell(p)}</td>
              <td className="px-1 py-2">
                <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  {ownerLabel(p)}
                  {p.ownerUid === sessionSubjectId && (
                    <span className="rounded bg-primary/10 px-1 text-[9px] font-medium text-primary">
                      我
                    </span>
                  )}
                </span>
              </td>
              <td className="px-1 py-2 text-[11px] text-muted-foreground">
                {p.memberCount ?? "—"}
              </td>
              <td className="px-1 py-2 text-[11px] text-muted-foreground/80">
                {relTime(p.updatedAt)}
              </td>
              <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                {rowActions(p)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Card list — under sm */}
      <ul className="divide-y divide-border/60 sm:hidden">
        {visible.map((p) => (
          <li
            key={p.id}
            onClick={() => onOpen(p)}
            className={cn(
              "group cursor-pointer px-4 py-2.5",
              selectedId === p.id ? "bg-accent" : "hover:bg-accent/50",
              p.archived && "opacity-55"
            )}
          >
            <div className="flex items-center justify-between">
              {nameCell(p)}
              <div className="ml-2 flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground/70">
                  {relTime(p.updatedAt)}
                </span>
                {rowActions(p)}
              </div>
            </div>
          </li>
        ))}
      </ul>

      {/* Floating bulk-action bar */}
      {checked.size > 0 && (
        <div className="material-glass sticky bottom-3 mx-3 mt-2 flex items-center justify-between rounded-lg px-3 py-2 shadow-md">
          <span className="text-[11px] text-foreground">
            已选 {checked.size} 项
          </span>
          <div className="flex items-center gap-3">
            <button
              onClick={archiveSelected}
              disabled={ownedSelected.length === 0}
              className="text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40"
              title={
                ownedSelected.length === 0 ? "只能归档自己的项目" : undefined
              }
            >
              归档
            </button>
            {confirmDeleteIds.has("*bulk*") ? (
              <>
                <button
                  onClick={() =>
                    setConfirmDeleteIds((s) => {
                      const n = new Set(s);
                      n.delete("*bulk*");
                      return n;
                    })
                  }
                  className="text-[11px] text-muted-foreground hover:text-foreground"
                >
                  取消
                </button>
                <button
                  onClick={deleteSelected}
                  disabled={ownedSelected.length === 0}
                  className="text-[11px] font-medium text-destructive disabled:opacity-40"
                >
                  确认删除 {ownedSelected.length} 项
                </button>
              </>
            ) : (
              <button
                onClick={() =>
                  ownedSelected.length === checked.size
                    ? setConfirmDeleteIds((s) => new Set(s).add("*bulk*"))
                    : toast({
                        title: "只能删除自己拥有的项目",
                        variant: "destructive",
                      })
                }
                className="text-[11px] text-muted-foreground hover:text-destructive"
              >
                删除
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
