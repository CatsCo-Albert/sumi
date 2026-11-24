/**
 * Pure file-tree logic — build a folder tree from flat slash-separated
 * fileIds (no schema change; folders are derived client-side).
 */

export interface FileTreeDoc {
  id: string;
  fileId: string;
  title: string | null;
  updatedAt?: number;
}

export interface TreeNode {
  /** Last path segment. Root node has "". */
  name: string;
  /** Full path from root ("" for root, "notes" for top folder). */
  path: string;
  kind: "folder" | "file";
  /** Only set on file nodes. */
  doc?: FileTreeDoc;
  children: TreeNode[];
}

/** Split a fileId into non-empty segments. */
export function splitPath(fileId: string): string[] {
  return fileId.split("/").filter((s) => s.length > 0);
}

/** Parent folder path of a fileId, or null for root-level files. */
export function parentFolder(fileId: string): string | null {
  const parts = splitPath(fileId);
  if (parts.length <= 1) return null;
  return parts.slice(0, -1).join("/");
}

/** Sort folders first, then files, alphabetical within each level. */
function sortNode(node: TreeNode): void {
  node.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  node.children.forEach(sortNode);
}

/** Build the tree. Returns a synthetic root node (path "", kind folder). */
export function buildFileTree(docs: FileTreeDoc[]): TreeNode {
  const root: TreeNode = { name: "", path: "", kind: "folder", children: [] };
  for (const doc of docs) {
    const parts = splitPath(doc.fileId);
    if (parts.length === 0) continue;
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      const path = node.path ? `${node.path}/${seg}` : seg;
      let child = node.children.find(
        (c) => c.kind === "folder" && c.name === seg
      );
      if (!child) {
        child = { name: seg, path, kind: "folder", children: [] };
        node.children.push(child);
      }
      node = child;
    }
    node.children.push({
      name: parts[parts.length - 1],
      path: doc.fileId,
      kind: "file",
      doc,
      children: [],
    });
  }
  sortNode(root);
  return root;
}

/** All docs whose fileId lives inside `folder` (recursive). */
export function docsInFolder<T extends FileTreeDoc>(
  docs: T[],
  folder: string
): T[] {
  const prefix = folder + "/";
  return docs.filter((d) => d.fileId.startsWith(prefix));
}

/** Rewrite a fileId when its parent folder `oldFolder` → `newFolder`. */
export function renameFolderPrefix(
  fileId: string,
  oldFolder: string,
  newFolder: string
): string {
  if (!fileId.startsWith(oldFolder + "/")) return fileId;
  return newFolder + fileId.slice(oldFolder.length);
}

/**
 * Substring filter (case-insensitive). A file matches when its fileId
 * contains the query; a folder matches when its path contains the query
 * (keeps whole subtree) or any descendant matches (keeps ancestor chain).
 */
export function filterTree(nodes: TreeNode[], query: string): TreeNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;
  const walk = (list: TreeNode[]): TreeNode[] => {
    const out: TreeNode[] = [];
    for (const n of list) {
      if (n.kind === "folder") {
        if (n.path.toLowerCase().includes(q)) {
          out.push(n); // folder name matched — keep entire subtree
          continue;
        }
        const kids = walk(n.children);
        if (kids.length) out.push({ ...n, children: kids });
      } else if (n.path.toLowerCase().includes(q)) {
        out.push(n);
      }
    }
    return out;
  };
  return walk(nodes);
}

/** Split text into segments flagged for highlight (case-insensitive substring). */
export function highlightSegments(
  text: string,
  query: string
): Array<{ text: string; match: boolean }> {
  const q = query.trim();
  if (!q) return [{ text, match: false }];
  const lower = text.toLowerCase();
  const lq = q.toLowerCase();
  const segs: Array<{ text: string; match: boolean }> = [];
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(lq, i);
    if (idx === -1) {
      segs.push({ text: text.slice(i), match: false });
      break;
    }
    if (idx > i) segs.push({ text: text.slice(i, idx), match: false });
    segs.push({ text: text.slice(idx, idx + q.length), match: true });
    i = idx + q.length;
  }
  if (segs.length === 0) segs.push({ text: "", match: false });
  return segs;
}
