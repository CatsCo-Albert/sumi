"use client";

/**
 * Project + document browser — the welcome surface when no doc is open.
 * Apple-grade: clean list, hairlines, no chrome.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getAuthHeaders } from "@/lib/use-session";
import { apiPath } from "@/lib/api-path";
import { cn } from "@/lib/utils";

interface Project {
  id: string;
  name: string;
  ownerUid: string;
  updatedAt: number;
}
interface Document {
  id: string;
  projectId: string;
  fileId: string;
  title: string | null;
  updatedAt: number;
}
interface Member {
  subjectId: string;
  role: string;
  displayName: string | null;
  kind: string | null;
}

export default function DocumentListPane() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<Project | null>(null);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [showNewDoc, setShowNewDoc] = useState(false);
  const [newFileId, setNewFileId] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [showNewProject, setShowNewProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [showMembers, setShowMembers] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [newMemberId, setNewMemberId] = useState("");
  const [newMemberRole, setNewMemberRole] = useState<"viewer" | "editor">("editor");
  const [error, setError] = useState<string | null>(null);

  // Load projects on mount
  useEffect(() => {
    fetch(apiPath("/api/projects"), { headers: getAuthHeaders() })
      .then((r) => (r.ok ? r.json() : { projects: [] }))
      .then((d) => setProjects(d.projects || []))
      .catch(() => setProjects([]));
  }, []);

  // Load documents when a project is selected
  useEffect(() => {
    if (!selected) {
      setDocuments([]);
      return;
    }
    setLoadingDocs(true);
    fetch(apiPath(`/api/projects/${selected.id}/documents`), { headers: getAuthHeaders() })
      .then((r) => (r.ok ? r.json() : { documents: [] }))
      .then((d) => setDocuments(d.documents || []))
      .catch(() => setDocuments([]))
      .finally(() => setLoadingDocs(false));
  }, [selected]);

  const createProject = async () => {
    if (!newProjectName.trim()) return;
    setError(null);
    const res = await fetch(apiPath("/api/projects"), {
      method: "POST",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: newProjectName.trim() }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "failed");
      return;
    }
    const { project } = await res.json();
    setProjects((p) => [project, ...p]);
    setNewProjectName("");
    setShowNewProject(false);
    setSelected(project);
  };

  const createDocument = async () => {
    if (!selected || !newFileId.trim()) return;
    setError(null);
    const res = await fetch(apiPath(`/api/projects/${selected.id}/documents`), {
      method: "POST",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        fileId: newFileId.trim(),
        title: newTitle.trim() || undefined,
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "failed");
      return;
    }
    const { document } = await res.json();
    setDocuments((d) => [document, ...d]);
    setNewFileId("");
    setNewTitle("");
    setShowNewDoc(false);
    // Navigate to the new doc
    router.push(`/?doc=${document.id}`);
  };

  // Load members when the members panel opens
  useEffect(() => {
    if (!selected || !showMembers) return;
    fetch(apiPath(`/api/projects/${selected.id}/members`), { headers: getAuthHeaders() })
      .then((r) => (r.ok ? r.json() : { members: [] }))
      .then((d) => setMembers(d.members || []))
      .catch(() => setMembers([]));
  }, [selected, showMembers]);

  const addMember = async () => {
    if (!selected || !newMemberId.trim()) return;
    setError(null);
    const res = await fetch(apiPath(`/api/projects/${selected.id}/members`), {
      method: "POST",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        subjectId: newMemberId.trim(),
        role: newMemberRole,
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "failed");
      return;
    }
    setNewMemberId("");
    // Refresh
    fetch(apiPath(`/api/projects/${selected.id}/members`), { headers: getAuthHeaders() })
      .then((r) => r.json())
      .then((d) => setMembers(d.members || []));
  };

  const removeMember = async (subjectId: string) => {
    if (!selected) return;
    const res = await fetch(apiPath(`/api/projects/${selected.id}/members`), {
      method: "DELETE",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ subjectId }),
    });
    if (res.ok) {
      setMembers((m) => m.filter((x) => x.subjectId !== subjectId));
    }
  };

  const openDoc = (doc: Document) => {
    router.push(`/?doc=${doc.id}`);
  };

  return (
    <div className="flex h-full">
      {/* Sidebar — project list */}
      <aside className="w-64 shrink-0 border-r border-border/60 bg-sidebar text-sidebar-foreground">
        <div className="flex h-11 items-center justify-between border-b border-border/60 px-4">
          <div className="text-[12px] font-medium text-muted-foreground">
            项目
          </div>
          <button
            onClick={() => setShowNewProject(true)}
            className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            + 新建
          </button>
        </div>
        <div className="overflow-auto">
          {showNewProject && (
            <div className="border-b border-border/60 p-3">
              <input
                autoFocus
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") createProject();
                  if (e.key === "Escape") setShowNewProject(false);
                }}
                placeholder="项目名称"
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-[13px] outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          )}
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => setSelected(p)}
              className={cn(
                "block w-full px-4 py-2.5 text-left text-[13px] transition-colors",
                selected?.id === p.id
                  ? "bg-accent text-accent-foreground"
                  : "text-foreground hover:bg-accent/50"
              )}
            >
              {p.name}
            </button>
          ))}
          {projects.length === 0 && !showNewProject && (
            <div className="p-4 text-[12px] text-muted-foreground">
              暂无项目，点右上角新建
            </div>
          )}
        </div>
      </aside>

      {/* Main — document list for selected project */}
      <main className="flex-1 overflow-auto">
        {!selected ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <div className="text-[15px] font-medium text-foreground">
                选择一个项目查看文档
              </div>
              <div className="mt-1 text-[13px] text-muted-foreground">
                或在左侧新建一个项目
              </div>
            </div>
          </div>
        ) : (
          <>
            <header className="flex h-11 items-center justify-between border-b border-border/60 px-4">
              <div className="text-[13px] font-medium">{selected.name}</div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setShowMembers((v) => !v)}
                  className={cn(
                    "text-[11px] transition-colors",
                    showMembers
                      ? "text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  成员
                </button>
                <button
                  onClick={() => setShowNewDoc(true)}
                  className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                >
                  + 新建文档
                </button>
              </div>
            </header>
            {showMembers && (
              <div className="border-b border-border/60 bg-accent/20 p-4">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-[12px] font-medium text-muted-foreground">
                    成员（{members.length}）
                  </div>
                </div>
                <ul className="mb-3 divide-y divide-border/40">
                  {members.map((m) => (
                    <li
                      key={m.subjectId}
                      className="flex items-center justify-between py-2"
                    >
                      <div className="flex items-center gap-2">
                        <span className={cn(
                          "inline-flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold text-white",
                          m.kind === "agent" ? "bg-violet-500" : "bg-primary"
                        )}>
                          {(m.displayName || m.subjectId).slice(0, 1).toUpperCase()}
                        </span>
                        <div>
                          <div className="text-[12px] font-medium">
                            {m.displayName || m.subjectId}
                          </div>
                          <div className="font-mono text-[10px] text-muted-foreground">
                            {m.subjectId} · {m.role}
                          </div>
                        </div>
                      </div>
                      {m.role !== "owner" && (
                        <button
                          onClick={() => removeMember(m.subjectId)}
                          className="text-[11px] text-muted-foreground hover:text-destructive"
                        >
                          移除
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
                <div className="flex items-center gap-2">
                  <input
                    value={newMemberId}
                    onChange={(e) => setNewMemberId(e.target.value)}
                    placeholder="u123 或 a456"
                    className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[12px] outline-none focus:ring-1 focus:ring-primary"
                  />
                  <select
                    value={newMemberRole}
                    onChange={(e) => setNewMemberRole(e.target.value as "viewer" | "editor")}
                    className="rounded-md border border-border bg-background px-2 py-1.5 text-[12px] outline-none"
                  >
                    <option value="editor">editor</option>
                    <option value="viewer">viewer</option>
                  </select>
                  <button
                    onClick={addMember}
                    className="rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground"
                  >
                    添加
                  </button>
                </div>
              </div>
            )}
            {showNewDoc && (
              <div className="border-b border-border/60 bg-accent/30 p-4">
                <div className="flex gap-2">
                  <input
                    autoFocus
                    value={newFileId}
                    onChange={(e) => setNewFileId(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") createDocument();
                      if (e.key === "Escape") setShowNewDoc(false);
                    }}
                    placeholder="文件路径 (如 notes/intro.md)"
                    className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[12px] outline-none focus:ring-1 focus:ring-primary"
                  />
                  <input
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    placeholder="标题（可选）"
                    className="w-48 rounded-md border border-border bg-background px-2 py-1.5 text-[13px] outline-none focus:ring-1 focus:ring-primary"
                  />
                  <button
                    onClick={createDocument}
                    className="rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground"
                  >
                    创建
                  </button>
                </div>
              </div>
            )}
            {error && (
              <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-[12px] text-destructive">
                {error}
              </div>
            )}
            {loadingDocs ? (
              <div className="p-4 text-[12px] text-muted-foreground">载入中…</div>
            ) : documents.length === 0 ? (
              <div className="p-8 text-center text-[13px] text-muted-foreground">
                这个项目还没有文档
              </div>
            ) : (
              <ul className="divide-y divide-border/60">
                {documents.map((doc) => (
                  <li key={doc.id}>
                    <button
                      onClick={() => openDoc(doc)}
                      className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-accent/50"
                    >
                      <div>
                        <div className="text-[13px] font-medium text-foreground">
                          {doc.title || doc.fileId}
                        </div>
                        <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                          {doc.fileId}
                        </div>
                      </div>
                      <div className="text-[11px] text-muted-foreground/70">
                        {new Date(doc.updatedAt).toLocaleDateString()}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </main>
    </div>
  );
}
