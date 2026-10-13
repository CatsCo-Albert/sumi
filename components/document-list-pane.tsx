"use client";

/**
 * Project + document browser — the welcome surface when no doc is open.
 * Apple-grade: clean list, hairlines, no chrome.
 */

import { useEffect, useState } from "react";
import { apiPath } from "@/lib/api-path";
import { useRouter } from "next/navigation";
import { getAuthHeaders } from "@/lib/use-session";
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
  status?: string | null;  // 'active' | 'disabled' | null
}
interface AgentSetup {
  subjectId: string;
  role: string;
  fileId: string;
  wsBaseUrl: string;
  roomName: string;
  instructions: string;
  envBlock: string;
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
  // Agent onboarding: which member's setup card is expanded
  const [agentSetupFor, setAgentSetupFor] = useState<string | null>(null);
  const [agentSetup, setAgentSetup] = useState<AgentSetup | null>(null);
  const [agentSetupFileId, setAgentSetupFileId] = useState("");
  const [copied, setCopied] = useState(false);
  const [confirmDeleteProject, setConfirmDeleteProject] = useState(false);
  const [confirmDeleteDoc, setConfirmDeleteDoc] = useState<string | null>(null);
  const [sessionSubjectId, setSessionSubjectId] = useState<string | null>(null);
  const [renamingDoc, setRenamingDoc] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [renameFileId, setRenameFileId] = useState("");

  // Load projects + whoami on mount
  useEffect(() => {
    fetch(apiPath("/api/projects"), { headers: getAuthHeaders() })
      .then((r) => (r.ok ? r.json() : { projects: [] }))
      .then((d) => setProjects(d.projects || []))
      .catch(() => setProjects([]));
    fetch(apiPath("/api/auth/me"), { headers: getAuthHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.actor?.id) setSessionSubjectId(d.actor.id);
      })
      .catch(() => {});
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
    setConfirmDeleteProject(false);
    setConfirmDeleteDoc(null);
  }, [selected]);

  // Load members when the members panel opens
  useEffect(() => {
    if (!selected || !showMembers) return;
    fetch(apiPath(`/api/projects/${selected.id}/members`), { headers: getAuthHeaders() })
      .then((r) => (r.ok ? r.json() : { members: [] }))
      .then((d) => setMembers(d.members || []))
      .catch(() => setMembers([]));
  }, [selected, showMembers]);

  const isOwner = selected && sessionSubjectId && selected.ownerUid === sessionSubjectId;

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

  const deleteProject = async () => {
    if (!selected) return;
    const res = await fetch(apiPath(`/api/projects/${selected.id}`), {
      method: "DELETE",
      headers: getAuthHeaders(),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "failed");
      return;
    }
    setProjects((p) => p.filter((x) => x.id !== selected.id));
    setSelected(null);
    setConfirmDeleteProject(false);
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
    router.push(`/?doc=${document.id}`);
  };

  const deleteDocument = async (doc: Document) => {
    if (!selected) return;
    const res = await fetch(apiPath(`/api/projects/${selected.id}/documents`), {
      method: "DELETE",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ fileId: doc.fileId }),
    });
    if (res.ok) {
      setDocuments((d) => d.filter((x) => x.id !== doc.id));
    }
    setConfirmDeleteDoc(null);
  };

  const startRename = (doc: Document) => {
    setRenamingDoc(doc.id);
    setRenameTitle(doc.title || "");
    setRenameFileId(doc.fileId);
  };

  const saveRename = async () => {
    if (!selected || !renamingDoc) return;
    const doc = documents.find((d) => d.id === renamingDoc);
    if (!doc) return;
    const res = await fetch(apiPath(`/api/projects/${selected.id}/documents`), {
      method: "PATCH",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        fileId: doc.fileId,
        newFileId: renameFileId.trim() !== doc.fileId ? renameFileId.trim() : undefined,
        title: renameTitle.trim() || null,
      }),
    });
    if (res.ok) {
      const { document } = await res.json();
      setDocuments((d) =>
        d.map((x) => (x.id === renamingDoc ? document : x))
      );
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "rename failed");
    }
    setRenamingDoc(null);
  };

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
    const added = newMemberId.trim();
    setNewMemberId("");
    // Refresh list, and if it was an agent — auto-open the onboarding card
    fetch(apiPath(`/api/projects/${selected.id}/members`), { headers: getAuthHeaders() })
      .then((r) => r.json())
      .then((d) => setMembers(d.members || []));
    if (added.startsWith("a")) {
      toggleAgentSetup(added);
    }
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
      if (agentSetupFor === subjectId) {
        setAgentSetupFor(null);
        setAgentSetup(null);
      }
    }
  };

  const toggleAgentStatus = async (subjectId: string, currentStatus: string | null) => {
    if (!selected) return;
    const next = currentStatus === "disabled" ? "active" : "disabled";
    const res = await fetch(apiPath(`/api/projects/${selected.id}/members`), {
      method: "PATCH",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ subjectId, status: next }),
    });
    if (res.ok) {
      setMembers((m) =>
        m.map((x) =>
          x.subjectId === subjectId ? { ...x, status: next } : x
        )
      );
    }
  };

  const toggleAgentSetup = async (subjectId: string, fileId?: string) => {
    if (!selected) return;
    if (agentSetupFor === subjectId && fileId === undefined) {
      setAgentSetupFor(null);
      setAgentSetup(null);
      return;
    }
    setAgentSetupFor(subjectId);
    setAgentSetup(null);
    const targetFile = fileId ?? agentSetupFileId.trim();
    const params = targetFile
      ? `subjectId=${subjectId}&fileId=${encodeURIComponent(targetFile)}`
      : `subjectId=${subjectId}`;
    const res = await fetch(
      `/api/projects/${selected.id}/agent-setup?${params}`,
      { headers: getAuthHeaders() }
    );
    if (res.ok) {
      const data = await res.json();
      setAgentSetup(data);
    }
  };

  const copyInstructions = async () => {
    if (!agentSetup) return;
    try {
      await navigator.clipboard.writeText(agentSetup.instructions);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
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
            <div
              key={p.id}
              className={cn(
                "group flex items-center justify-between px-4 py-2.5 text-[13px] transition-colors",
                selected?.id === p.id
                  ? "bg-accent text-accent-foreground"
                  : "text-foreground hover:bg-accent/50"
              )}
            >
              <button onClick={() => setSelected(p)} className="flex-1 text-left">
                {p.name}
              </button>
              {sessionSubjectId === p.ownerUid && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelected(p);
                    setConfirmDeleteProject(true);
                  }}
                  className="ml-2 hidden text-[10px] text-muted-foreground/70 hover:text-destructive group-hover:inline"
                  title="删除项目"
                >
                  ✕
                </button>
              )}
            </div>
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

            {/* Confirm delete project */}
            {confirmDeleteProject && (
              <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="text-[12px] text-destructive">
                    删除项目「{selected.name}」会同时删除其所有文档和成员关系。
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setConfirmDeleteProject(false)}
                      className="text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      取消
                    </button>
                    <button
                      onClick={deleteProject}
                      className="rounded-md bg-destructive px-3 py-1 text-[11px] font-medium text-destructive-foreground"
                    >
                      确认删除
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Members panel */}
            {showMembers && (
              <div className="border-b border-border/60 bg-accent/20 p-4">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-[12px] font-medium text-muted-foreground">
                    成员（{members.length}）
                  </div>
                </div>
                <ul className="mb-3 divide-y divide-border/40">
                  {members.map((m) => {
                    const isAgent = m.subjectId.startsWith("a") || m.kind === "agent";
                    const isDisabled = m.status === "disabled";
                    const setupOpen = agentSetupFor === m.subjectId;
                    return (
                      <li key={m.subjectId} className={cn("py-2", isDisabled && "opacity-50")}>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className={cn(
                              "inline-flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold text-white",
                              isDisabled
                                ? "bg-muted-foreground/40"
                                : isAgent ? "bg-violet-500" : "bg-primary"
                            )}>
                              {(m.displayName || m.subjectId).slice(0, 1).toUpperCase()}
                            </span>
                            <div>
                              <div className="text-[12px] font-medium">
                                {m.displayName || m.subjectId}
                                {isAgent && (
                                  <span className="ml-1.5 rounded-full bg-violet-500/10 px-1.5 py-0.5 text-[9px] font-medium text-violet-600">
                                    agent
                                  </span>
                                )}
                                {isDisabled && (
                                  <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">
                                    已禁用
                                  </span>
                                )}
                              </div>
                              <div className="font-mono text-[10px] text-muted-foreground">
                                {m.subjectId} · {m.role}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-3">
                            {isAgent && (
                              <>
                                <button
                                  onClick={() => toggleAgentSetup(m.subjectId)}
                                  className={cn(
                                    "text-[11px]",
                                    setupOpen
                                      ? "text-foreground"
                                      : "text-muted-foreground hover:text-foreground"
                                  )}
                                >
                                  {setupOpen ? "收起接入指南" : "接入指南"}
                                </button>
                                {isOwner && (
                                  <button
                                    onClick={() => toggleAgentStatus(m.subjectId, m.status ?? null)}
                                    className="text-[11px] text-muted-foreground hover:text-amber-600"
                                  >
                                    {isDisabled ? "启用" : "禁用"}
                                  </button>
                                )}
                              </>
                            )}
                            {m.role !== "owner" && (
                              <button
                                onClick={() => removeMember(m.subjectId)}
                                className="text-[11px] text-muted-foreground hover:text-destructive"
                              >
                                移除
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Agent onboarding card */}
                        {setupOpen && (
                          <div className="mt-2 rounded-md border border-violet-500/30 bg-violet-500/5 p-3">
                            {!agentSetup ? (
                              <div className="text-[11px] text-muted-foreground">
                                载入中…
                              </div>
                            ) : (
                              <>
                                <div className="mb-2 flex items-center justify-between">
                                  <div className="text-[11px] font-medium text-violet-700">
                                    把下面这段内容粘给你的 agent —— 它会自己连进来
                                  </div>
                                  <button
                                    onClick={copyInstructions}
                                    className="rounded bg-violet-600 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-violet-700"
                                  >
                                    {copied ? "已复制" : "复制"}
                                  </button>
                                </div>
                                <div className="mb-2 flex items-center gap-2">
                                  <span className="text-[10px] text-muted-foreground">
                                    目标文件:
                                  </span>
                                  <input
                                    value={agentSetupFileId}
                                    onChange={(e) => setAgentSetupFileId(e.target.value)}
                                    onBlur={() => {
                                      if (agentSetupFileId.trim()) {
                                        toggleAgentSetup(m.subjectId, agentSetupFileId.trim());
                                      }
                                    }}
                                    placeholder={agentSetup.fileId}
                                    className="flex-1 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] outline-none"
                                  />
                                </div>
                                <pre className="max-h-64 overflow-auto rounded bg-background p-2 font-mono text-[10px] leading-relaxed text-foreground">
                                  {agentSetup.instructions}
                                </pre>
                                <details className="mt-2">
                                  <summary className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground">
                                    环境变量（供 agent host 使用）
                                  </summary>
                                  <pre className="mt-1 overflow-auto rounded bg-background p-2 font-mono text-[10px] text-foreground">
                                    {agentSetup.envBlock}
                                  </pre>
                                </details>
                              </>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
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
                <div className="mt-2 text-[10px] leading-relaxed text-muted-foreground/80">
                  添加 <code className="font-mono">a*</code> subject 后会自动展开接入指南 —— 复制给 agent 即可。
                </div>
              </div>
            )}

            {/* New doc form */}
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
                  <li key={doc.id} className="group relative">
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
                      <div className="flex items-center gap-3">
                        <span className="text-[11px] text-muted-foreground/70">
                          {new Date(doc.updatedAt).toLocaleDateString()}
                        </span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            startRename(doc);
                          }}
                          className="hidden text-[11px] text-muted-foreground/70 hover:text-foreground group-hover:inline"
                          title="重命名"
                        >
                          重命名
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmDeleteDoc(doc.id);
                          }}
                          className="hidden text-[11px] text-muted-foreground/70 hover:text-destructive group-hover:inline"
                          title="删除文档"
                        >
                          删除
                        </button>
                      </div>
                    </button>
                    {renamingDoc === doc.id && (
                      <div className="border-t border-border/60 bg-accent/30 px-4 py-3">
                        <div className="space-y-2">
                          <input
                            value={renameTitle}
                            onChange={(e) => setRenameTitle(e.target.value)}
                            placeholder="标题"
                            className="w-full rounded-md border border-border bg-background px-2 py-1 text-[12px] outline-none focus:ring-1 focus:ring-primary"
                          />
                          <input
                            value={renameFileId}
                            onChange={(e) => setRenameFileId(e.target.value)}
                            placeholder="fileId"
                            className="w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] outline-none focus:ring-1 focus:ring-primary"
                          />
                          <div className="flex gap-2">
                            <button
                              onClick={() => setRenamingDoc(null)}
                              className="text-[11px] text-muted-foreground hover:text-foreground"
                            >
                              取消
                            </button>
                            <button
                              onClick={saveRename}
                              className="rounded bg-primary px-3 py-1 text-[11px] font-medium text-primary-foreground"
                            >
                              保存
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                    {confirmDeleteDoc === doc.id && (
                      <div className="border-t border-destructive/30 bg-destructive/10 px-4 py-2">
                        <div className="flex items-center justify-between">
                          <div className="text-[11px] text-destructive">
                            确认删除「{doc.title || doc.fileId}」？
                          </div>
                          <div className="flex gap-2">
                            <button
                              onClick={() => setConfirmDeleteDoc(null)}
                              className="text-[11px] text-muted-foreground hover:text-foreground"
                            >
                              取消
                            </button>
                            <button
                              onClick={() => deleteDocument(doc)}
                              className="rounded bg-destructive px-2 py-0.5 text-[11px] font-medium text-destructive-foreground"
                            >
                              确认
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
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
