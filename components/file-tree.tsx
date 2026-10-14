"use client";

/**
 * File tree — renders flat slash-separated fileIds as a folder hierarchy.
 * Folders are derived (no server-side entity); empty folders don't exist.
 *
 * Presentational: file-level actions delegate to callbacks, folder
 * rename/delete ask the parent to run the batch PATCH/DELETE.
 */

import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import {
  buildFileTree,
  filterTree,
  highlightSegments,
  docsInFolder,
  type FileTreeDoc,
  type TreeNode,
} from "@/lib/file-tree";

interface FileTreeProps<T extends FileTreeDoc> {
  documents: T[];
  onSelect: (doc: T) => void;
  onRename: (doc: T) => void;
  onDelete: (doc: T) => void;
  /** Prefill a new-doc form with `${folder}/`. */
  onNewInFolder: (folder: string | null) => void;
  /** Rename every doc under `oldPath` to `newPath` prefix (batch PATCH). */
  onRenameFolder: (oldPath: string, newPath: string, docs: T[]) => void;
  /** Cascade-delete every doc under `path`. */
  onDeleteFolder: (path: string, docs: T[]) => void;
  /** Doc currently being renamed (parent owns the modal/inline form). */
  renamingDocId?: string | null;
  /** Doc currently in delete-confirm (parent owns the confirm row). */
  confirmDeleteDocId?: string | null;
  /** Rendered under each file row — parent's inline rename/confirm UI. */
  renderFileDetail?: (doc: T) => React.ReactNode;
}

export default function FileTree<T extends FileTreeDoc>({
  documents,
  onSelect,
  onRename,
  onDelete,
  onNewInFolder,
  onRenameFolder,
  onDeleteFolder,
  renamingDocId,
  confirmDeleteDocId,
  renderFileDetail,
}: FileTreeProps<T>) {
  const [query, setQuery] = useState("");
  // Empty = expand-all on first load; collapse toggles add paths here.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
  const [folderRenameValue, setFolderRenameValue] = useState("");
  const [confirmDeleteFolder, setConfirmDeleteFolder] = useState<string | null>(
    null
  );

  const tree = useMemo(() => buildFileTree(documents), [documents]);
  const visible = useMemo(
    () => filterTree(tree.children, query),
    [tree, query]
  );
  const filtering = query.trim().length > 0;

  const toggle = (path: string) => {
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const submitFolderRename = (oldPath: string) => {
    const name = folderRenameValue.trim();
    setRenamingFolder(null);
    if (!name || name === oldPath.split("/").pop()) return;
    const parent = oldPath.split("/").slice(0, -1).join("/");
    const newPath = parent ? `${parent}/${name}` : name;
    onRenameFolder(oldPath, newPath, docsInFolder(documents, oldPath));
  };

  const highlight = (text: string) => {
    const segs = highlightSegments(text, query);
    if (segs.length === 1 && !segs[0].match) return text;
    return (
      <>
        {segs.map((s, i) =>
          s.match ? (
            <mark key={i} className="bg-amber-300/60 text-inherit">
              {s.text}
            </mark>
          ) : (
            <span key={i}>{s.text}</span>
          )
        )}
      </>
    );
  };

  const renderNode = (node: TreeNode, depth: number) => {
    const pad = { paddingLeft: `${depth * 12 + 8}px` };
    if (node.kind === "folder") {
      const isCollapsed = !filtering && collapsed.has(node.path);
      const isRenaming = renamingFolder === node.path;
      const isConfirmingDelete = confirmDeleteFolder === node.path;
      const folderDocs = docsInFolder(documents, node.path);
      return (
        <li key={`d:${node.path}`}>
          <div
            className={cn(
              "group relative flex items-center gap-1 py-1 pr-2 text-[12px]",
              "text-foreground transition-colors hover:bg-accent/50"
            )}
            style={pad}
          >
            <button
              onClick={() => toggle(node.path)}
              className="w-3 shrink-0 text-center text-[9px] text-muted-foreground"
              aria-label={isCollapsed ? "展开" : "折叠"}
            >
              {isCollapsed ? "▸" : "▾"}
            </button>
            <span className="shrink-0 text-[11px] text-muted-foreground/80">
              📁
            </span>
            {isRenaming ? (
              <input
                autoFocus
                value={folderRenameValue}
                onChange={(e) => setFolderRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitFolderRename(node.path);
                  if (e.key === "Escape") setRenamingFolder(null);
                }}
                onBlur={() => submitFolderRename(node.path)}
                onClick={(e) => e.stopPropagation()}
                className="min-w-0 flex-1 rounded border border-border bg-background px-1 py-0 text-[12px] outline-none focus:ring-1 focus:ring-primary"
              />
            ) : (
              <button
                onClick={() => toggle(node.path)}
                className="min-w-0 flex-1 truncate text-left font-medium"
                title={node.path}
              >
                {highlight(node.name)}
              </button>
            )}
            {!isRenaming && (
              <span className="hidden shrink-0 items-center gap-2 group-hover:flex">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onNewInFolder(node.path);
                  }}
                  className="text-[10px] text-muted-foreground/70 hover:text-foreground"
                  title="在此文件夹新建文档"
                >
                  新建文档
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setRenamingFolder(node.path);
                    setFolderRenameValue(node.name);
                    setConfirmDeleteFolder(null);
                  }}
                  className="text-[10px] text-muted-foreground/70 hover:text-foreground"
                  title="重命名文件夹"
                >
                  重命名
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmDeleteFolder(node.path);
                    setRenamingFolder(null);
                  }}
                  className="text-[10px] text-muted-foreground/70 hover:text-destructive"
                  title="删除文件夹及所有文档"
                >
                  删除
                </button>
              </span>
            )}
          </div>
          {isConfirmingDelete && (
            <div className="border-y border-destructive/30 bg-destructive/10 px-4 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] text-destructive">
                  删除文件夹「{node.name}」及其 {folderDocs.length} 个文档？
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    onClick={() => setConfirmDeleteFolder(null)}
                    className="text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    取消
                  </button>
                  <button
                    onClick={() => {
                      onDeleteFolder(node.path, folderDocs);
                      setConfirmDeleteFolder(null);
                    }}
                    className="rounded bg-destructive px-2 py-0.5 text-[11px] font-medium text-destructive-foreground"
                  >
                    确认
                  </button>
                </div>
              </div>
            </div>
          )}
          {!isCollapsed && (
            <ul>{node.children.map((c) => renderNode(c, depth + 1))}</ul>
          )}
        </li>
      );
    }
    // file
    const doc = node.doc as T;
    const isRenamingDoc = renamingDocId === doc.id;
    const isConfirmingDoc = confirmDeleteDocId === doc.id;
    return (
      <li key={`f:${doc.id}`}>
        <div
          className={cn(
            "group relative flex items-center gap-1 py-1 pr-2 text-[12px]",
            "text-foreground transition-colors hover:bg-accent/50"
          )}
          style={pad}
        >
          <span className="w-3 shrink-0" />
          <span className="shrink-0 text-[11px] text-muted-foreground/80">
            📄
          </span>
          <button
            onClick={() => onSelect(doc)}
            className="min-w-0 flex-1 truncate text-left"
            title={doc.fileId}
          >
            {highlight(doc.title || node.name)}
            {doc.title && (
              <span className="ml-1.5 font-mono text-[10px] text-muted-foreground/60">
                {node.name}
              </span>
            )}
          </button>
          <span className="hidden shrink-0 items-center gap-2 group-hover:flex">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRename(doc);
              }}
              className="text-[10px] text-muted-foreground/70 hover:text-foreground"
              title="重命名"
            >
              重命名
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete(doc);
              }}
              className="text-[10px] text-muted-foreground/70 hover:text-destructive"
              title="删除文档"
            >
              删除
            </button>
          </span>
        </div>
        {(isRenamingDoc || isConfirmingDoc) && renderFileDetail?.(doc)}
      </li>
    );
  };

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 border-b border-border/60 bg-background px-3 py-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索"
          className="w-full rounded-md border border-border bg-background px-2 py-1 text-[12px] outline-none placeholder:text-muted-foreground/60 focus:ring-1 focus:ring-primary"
        />
      </div>
      {visible.length === 0 ? (
        <div className="p-4 text-[12px] text-muted-foreground">
          {filtering ? "没有匹配的文档" : "还没有文档"}
        </div>
      ) : (
        <ul className="py-1">{visible.map((n) => renderNode(n, 0))}</ul>
      )}
    </div>
  );
}
