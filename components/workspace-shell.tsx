"use client";

/**
 * Workspace shell — three-layer composition:
 *   canvas (main content)
 *   dim    (engagement overlay when the omni dock has focus)
 *   omni   (floating command surface, bottom-center)
 *
 * Apple-inspired: flat canvas, hairline separators, single accent,
 * blur only on the floating surface.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { EditorView } from "@codemirror/view";
import { useSession, getAuthHeaders } from "@/lib/use-session";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/stores/ui-store";
import { useUiEvents } from "@/lib/use-ui-events";
import CollaborativeEditor from "@/components/editor/collaborative-editor";
import { AskAgentDialog } from "@/components/ask-agent-dialog";
import { AiChatPanel } from "@/components/ai-chat-panel";
import EditCommandBar from "@/components/editor/edit-command-bar";
import { useEditStore } from "@/stores/edit-store";
import DocumentListPane from "@/components/document-list-pane";
import MarkdownPreview from "@/components/markdown-preview";
import { Toaster } from "@/components/ui/toast";
import { useIntentStore } from "@/stores/intent-store";
import { useDocPersistence } from "@/lib/use-doc-persistence";

export default function WorkspaceShell() {
  const searchParams = useSearchParams();
  const documentId = searchParams.get("doc");

  const currentDocumentId = useUiStore((s) => s.currentDocumentId);
  const activeMainBlock = useUiStore((s) => s.activeMainBlock);
  const attentionSignal = useUiStore((s) => s.attentionSignal);
  const consumeAttention = useUiStore((s) => s.consumeAttention);
  const panelVisibility = useUiStore((s) => s.panelVisibility);
  const panelWidth = useUiStore((s) => s.panelWidth);
  const setCurrentDocumentId = useUiStore((s) => s.setCurrentDocumentId);
  const setPanelVisibility = useUiStore((s) => s.setPanelVisibility);

  // Live push: subscribe to UI patches from the SSE endpoint.
  useUiEvents({ projectId: null });

  // Hydrate store from URL
  useEffect(() => {
    setCurrentDocumentId(documentId);
  }, [documentId, setCurrentDocumentId]);

  // Flash the attention target briefly, then clear
  useEffect(() => {
    if (!attentionSignal) return;
    const t = setTimeout(() => consumeAttention(), 1500);
    return () => clearTimeout(t);
  }, [attentionSignal, consumeAttention]);

  const aiOpen = panelVisibility.ai;
  const attentionTarget = attentionSignal?.target;

  const { actor, loading } = useSession();

  const [aiProjectId, aiFileId] = currentDocumentId
    ? splitDocId(currentDocumentId)
    : [null, null];

  return (
    <div className="relative h-screen w-full overflow-hidden bg-background text-foreground">
      {/* Canvas layer — main content (shrinks right when the AI panel opens) */}
      <div
        className={cn(
          "absolute inset-0 transition-all duration-200 ease-out-quint",
          aiOpen && "canvas-retreat",
          aiOpen && "right-[360px]"
        )}
      >
        {loading ? (
          <LoadingPane />
        ) : !actor ? (
          <SignInPane />
        ) : currentDocumentId ? (
          <EditorPane
            documentId={currentDocumentId}
            attention={attentionTarget === "editor"}
            actor={actor}
          />
        ) : (
          <DocumentListPane />
        )}
      </div>

      {/* Dim layer — subtle veil when AI dock is engaged */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 bg-black/[0.03] transition-opacity duration-200",
          aiOpen ? "opacity-100" : "opacity-0"
        )}
      />

      {/* AI chat panel — right slide-over with intent threads + composer */}
      {actor && (
        <AiChatPanel
          open={aiOpen}
          onClose={() => setPanelVisibility("ai", false)}
          projectId={aiProjectId}
          fileId={aiFileId}
          actorId={actor.id}
        />
      )}

      <Toaster />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor pane
// ---------------------------------------------------------------------------

type EditorViewMode = "source" | "preview" | "split";

// NEXT_PUBLIC_TAP_ENABLED —— TAP ghost-text 的功能开关（默认关闭，opt-in）
const TAP_AVAILABLE = process.env.NEXT_PUBLIC_TAP_ENABLED === "true";

function EditorPane({
  documentId,
  attention,
  actor,
}: {
  documentId: string;
  attention: boolean;
  actor: { id: string; name: string; kind: "user" | "agent" };
}) {
  const router = useRouter();
  const [projectId, fileId] = splitDocId(documentId);
  const [collaborators, setCollaborators] = useState<Array<{ name: string; color: string; id?: string }>>([]);
  const [viewMode, setViewMode] = useState<EditorViewMode>("source");
  const [tapEnabled, setTapEnabled] = useState(false);
  const [currentContent, setCurrentContent] = useState("");
  const [askOpen, setAskOpen] = useState(false);
  const [askSelection, setAskSelection] = useState<{
    text: string;
    startLine: number;
    endLine: number;
  } | null>(null);
  const [agents, setAgents] = useState<
    Array<{ subjectId: string; name: string | null }>
  >([]);
  const editorViewRef = useRef<EditorView | null>(null);
  const applyUiPatch = useUiStore((s) => s.applyUiPatch);
  const { initialContent, loading, scheduleSave, lastSavedAt, error, conflicted } =
    useDocPersistence(projectId, fileId);

  const handleContentChange = (content: string) => {
    setCurrentContent(content);
    scheduleSave(content);
  };

  // Load agent members for the ask-agent dialog target picker.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${projectId}/members`, { headers: getAuthHeaders() })
      .then((r) => (r.ok ? r.json() : { members: [] }))
      .then((d) => {
        if (cancelled) return;
        const list = (d.members || []).filter(
          (m: any) => m.subjectId?.startsWith("a") && m.status !== "disabled"
        );
        setAgents(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const handleAskAgent = (
    sel: { text: string; startLine: number; endLine: number } | null
  ) => {
    setAskSelection(sel);
    if (sel) {
      // Selection anchored — quick-input dialog keeps the line context.
      setAskOpen(true);
    } else {
      // No selection — the AI panel is the conversation surface.
      applyUiPatch({ type: "set_panel_visibility", panel: "ai", visible: true });
    }
  };

  // Cmd+K — grab current selection, push it into the AI dock as a prompt.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        const view = editorViewRef.current;
        if (!view) return;
        const sel = view.state.selection.main;
        const selected = view.state.sliceDoc(sel.from, sel.to);
        if (!selected.trim()) return;
        e.preventDefault();
        const prompt = `在文档 ${fileId} 中，请处理这段内容：\n\n\`\`\`\n${selected}\n\`\`\`\n\n`;
        applyUiPatch({
          type: "queue_prompt",
          prompt,
          autoSend: false,
        });
        applyUiPatch({ type: "set_panel_visibility", panel: "ai", visible: true });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [fileId, applyUiPatch]);

  // Pending-edit navigation: switch doc when the target edit lives in a
  // different file (doc id is `${projectId}-${fileId}`), then scroll to the
  // edit's startLine. Same-file jumps scroll the live view directly.
  useEffect(() => {
    const store = useEditStore.getState();
    store.setNavigateToFileCallback((filePath, line) => {
      const targetFileId = filePath || fileId;
      const sameFile =
        targetFileId === fileId ||
        targetFileId.endsWith(fileId) ||
        fileId.endsWith(targetFileId);

      if (!sameFile) {
        // The queued pendingScrollLine is consumed by the new editor mount
        // once its Yjs sync completes.
        router.push(`/?doc=${projectId}-${encodeURIComponent(targetFileId)}`);
        return;
      }

      // Same file — scroll now.
      const pending = useEditStore.getState().consumePendingScrollLine();
      const targetLine = line ?? pending;
      const view = editorViewRef.current;
      if (targetLine && view) {
        try {
          const clamped = Math.max(
            1,
            Math.min(targetLine, view.state.doc.lines)
          );
          const pos = view.state.doc.line(clamped).from;
          view.dispatch({
            selection: { anchor: pos },
            effects: EditorView.scrollIntoView(pos, { y: "center" }),
          });
        } catch {
          // doc may be mid-update — ignore
        }
      }
    });
    return () => store.setNavigateToFileCallback(null);
  }, [projectId, fileId, router]);

  return (
    <div
      className={cn(
        "flex h-full flex-col transition-shadow duration-200",
        attention && "ring-1 ring-primary/40"
      )}
    >
      {/* Title bar — hairline separator, minimal chrome */}
      <header className="flex h-11 items-center gap-3 border-b border-border/60 px-4">
        <div className="text-[13px] font-medium text-muted-foreground">
          {fileId.split("/").pop() || fileId}
        </div>
        {/* View mode toggle */}
        <div className="flex items-center gap-0.5 rounded-md border border-border/60 p-0.5">
          {(["source", "split", "preview"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setViewMode(m)}
              className={cn(
                "rounded px-2 py-0.5 text-[10px] font-medium transition-colors",
                viewMode === m
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {m === "source" ? "源码" : m === "split" ? "双栏" : "预览"}
            </button>
          ))}
        </div>
        {/* Save indicator */}
        <div className="text-[10px] text-muted-foreground/60">
          {conflicted ? (
            <span className="text-amber-500">冲突 — 已回退重试</span>
          ) : error ? (
            <span className="text-destructive">{error}</span>
          ) : lastSavedAt ? (
            `已保存 ${new Date(lastSavedAt).toLocaleTimeString()}`
          ) : null}
        </div>
        {/* Live collaborators — colored dots + tooltip name */}
        <div className="ml-auto flex items-center gap-2">
          {/* TAP ghost-text 补全开关 */}
          {TAP_AVAILABLE && (
            <button
              onClick={() => setTapEnabled((v) => !v)}
              title={tapEnabled ? "关闭 TAP 补全" : "开启 TAP 补全"}
              className={cn(
                "rounded-md border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide transition-colors",
                tapEnabled
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border/60 text-muted-foreground/70 hover:text-foreground"
              )}
            >
              TAP
            </button>
          )}
          {collaborators.length > 1 && (
            <div className="flex items-center -space-x-1.5">
              {collaborators.slice(0, 5).map((c, i) => (
                <div
                  key={c.id || i}
                  className="flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold text-white ring-2 ring-background"
                  style={{ background: c.color }}
                  title={c.name}
                >
                  {c.name.slice(0, 1).toUpperCase()}
                </div>
              ))}
            </div>
          )}
          <div className="text-[11px] text-muted-foreground/70">
            {actor.name}
          </div>
        </div>
      </header>
      <div className="relative flex-1 overflow-hidden">
        {/* Cursor-style pending-edit command bar (overlays editor) */}
        <EditCommandBar />
        {loading ? (
          <LoadingPane />
        ) : viewMode === "preview" ? (
          <MarkdownPreview
            content={currentContent || initialContent || ""}
            className="h-full overflow-auto"
          />
        ) : viewMode === "split" ? (
          <div className="flex h-full">
            <div className="flex-1 overflow-hidden border-r border-border/60">
              <CollaborativeEditor
                projectId={projectId}
                fileId={fileId}
                mode="markdown"
                userId={actor.id}
                userName={actor.name}
                initialContent={initialContent ?? ""}
                prefillOnConnect
                tapEnabled={tapEnabled}
                onContentChange={handleContentChange}
                onCollaboratorsChange={setCollaborators}
                onEditorReady={(v) => (editorViewRef.current = v)}
                onAskAgent={handleAskAgent}
              />
            </div>
            <div className="flex-1 overflow-auto bg-background">
              <MarkdownPreview content={currentContent || initialContent || ""} />
            </div>
          </div>
        ) : (
          <CollaborativeEditor
            projectId={projectId}
            fileId={fileId}
            mode="markdown"
            userId={actor.id}
            userName={actor.name}
            initialContent={initialContent ?? ""}
            prefillOnConnect
            tapEnabled={tapEnabled}
            onContentChange={handleContentChange}
            onCollaboratorsChange={setCollaborators}
            onEditorReady={(v) => (editorViewRef.current = v)}
            onAskAgent={handleAskAgent}
          />
        )}
      </div>

      {/* Cmd+Shift+I — ask agent about selection */}
      <AskAgentDialog
        open={askOpen}
        projectId={projectId}
        fileId={fileId}
        selection={askSelection}
        agents={agents}
        onClose={() => setAskOpen(false)}
        onCreated={(intent) => {
          if (intent) useIntentStore.getState().upsertIntent(intent);
        }}
      />
    </div>
  );
}

function LoadingPane() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-[13px] text-muted-foreground">载入中…</div>
    </div>
  );
}

function SignInPane() {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/auth/me", {
        headers: { Authorization: `Bearer ${token.trim()}` },
      });
      if (!res.ok) {
        setError("无效的 CatsCo token");
        return;
      }
      // Persist for subsequent loads — Bearer in header is fine for API calls,
      // but the WS provider reads ?token= from the URL; stash in sessionStorage.
      sessionStorage.setItem("sumi.token", token.trim());
      window.location.reload();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-3 rounded-2xl border border-border/60 p-6 shadow-sm"
      >
        <div className="text-[15px] font-medium">登录 Sumi</div>
        <div className="text-[12px] text-muted-foreground">
          粘贴你的 CatsCo Bearer token（JWT）
        </div>
        <textarea
          required
          rows={4}
          placeholder="eyJhbGciOiJIUzI1NiIs…"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-[12px] outline-none focus:ring-1 focus:ring-primary"
        />
        {error && (
          <div className="text-[12px] text-destructive">{error}</div>
        )}
        <button
          type="submit"
          disabled={busy || !token.trim()}
          className="w-full rounded-lg bg-primary py-2 text-[13px] font-medium text-primary-foreground transition-opacity disabled:opacity-50"
        >
          {busy ? "…" : "登录"}
        </button>
        <div className="text-center text-[11px] text-muted-foreground/70">
          Agent 接入：连接 WS 时加 <code>?api_key=cc_…</code>
        </div>
      </form>
    </div>
  );
}

function splitDocId(docId: string): [string, string] {
  const idx = docId.indexOf("-");
  if (idx === -1) return ["default", docId];
  return [docId.slice(0, idx), docId.slice(idx + 1)];
}

