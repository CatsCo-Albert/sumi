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

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useSession } from "@/lib/use-session";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/stores/ui-store";
import { useUiEvents } from "@/lib/use-ui-events";
import CollaborativeEditor from "@/components/editor/collaborative-editor";
import DocumentListPane from "@/components/document-list-pane";
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

  return (
    <div className="relative h-screen w-full overflow-hidden bg-background text-foreground">
      {/* Canvas layer — main content */}
      <div
        className={cn(
          "absolute inset-0 transition-all duration-200 ease-out-quint",
          aiOpen && "canvas-retreat"
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

      {/* Omni dock — floating command surface */}
      <div className="pointer-events-none absolute inset-0 z-50 flex items-end justify-center p-6">
        <div
          className={cn(
            "pointer-events-auto w-full max-w-2xl transition-all duration-200 ease-spring",
            aiOpen
              ? "translate-y-0 opacity-100"
              : "pointer-events-none translate-y-4 opacity-0"
          )}
        >
          <OmniDock onClose={() => setPanelVisibility("ai", false)} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor pane
// ---------------------------------------------------------------------------

function EditorPane({
  documentId,
  attention,
  actor,
}: {
  documentId: string;
  attention: boolean;
  actor: { id: string; name: string; kind: "user" | "agent" };
}) {
  const [projectId, fileId] = splitDocId(documentId);
  const [collaborators, setCollaborators] = useState<Array<{ name: string; color: string; id?: string }>>([]);
  const { initialContent, loading, scheduleSave, lastSavedAt, error } =
    useDocPersistence(projectId, fileId);

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
        {/* Save indicator */}
        <div className="text-[10px] text-muted-foreground/60">
          {error ? (
            <span className="text-destructive">{error}</span>
          ) : lastSavedAt ? (
            `已保存 ${new Date(lastSavedAt).toLocaleTimeString()}`
          ) : null}
        </div>
        {/* Live collaborators — colored dots + tooltip name */}
        <div className="ml-auto flex items-center gap-2">
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
      <div className="flex-1 overflow-hidden">
        {loading ? (
          <LoadingPane />
        ) : (
          <CollaborativeEditor
            projectId={projectId}
            fileId={fileId}
            mode="markdown"
            userId={actor.id}
            userName={actor.name}
            initialContent={initialContent ?? ""}
            prefillOnConnect
            onContentChange={scheduleSave}
            onCollaboratorsChange={setCollaborators}
          />
        )}
      </div>
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

// ---------------------------------------------------------------------------
// Omni dock — floating AI command surface
// ---------------------------------------------------------------------------

function OmniDock({ onClose }: { onClose: () => void }) {
  const promptCommand = useUiStore((s) => s.promptCommand);
  const consumePromptCommand = useUiStore((s) => s.consumePromptCommand);
  const pendingPromptCommands = useUiStore((s) => s.pendingPromptCommands);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [response, setResponse] = useState<string | null>(null);

  const submit = async () => {
    const prompt = input.trim();
    if (!prompt || busy) return;
    setBusy(true);
    setResponse(null);
    try {
      // Stub agent — echo back so the wiring is testable end-to-end.
      // Real agent path goes through src/agent-client.ts.
      setResponse(`收到「${prompt}」— agent 待接入`);
      setInput("");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (promptCommand) {
      setInput(promptCommand.prompt);
      if (promptCommand.autoSend) {
        submit();
      }
      consumePromptCommand();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promptCommand]);

  return (
    <div className="material-glass shadow-xl rounded-2xl p-1.5">
      <div className="flex items-center gap-2 rounded-[14px] bg-background/60 px-4 py-3 ring-1 ring-border/60">
        <svg
          className="h-4 w-4 text-muted-foreground"
          viewBox="0 0 16 16"
          fill="none"
        >
          <path
            d="M8 1.5L9.5 6.5L14.5 8L9.5 9.5L8 14.5L6.5 9.5L1.5 8L6.5 6.5L8 1.5Z"
            fill="currentColor"
            opacity="0.6"
          />
        </svg>
        <input
          autoFocus
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "Enter") submit();
          }}
          disabled={busy}
          placeholder="让 Sumi 做点什么…"
          className="flex-1 bg-transparent text-[14px] outline-none placeholder:text-muted-foreground/60 disabled:opacity-50"
        />
        {response && (
          <span className="max-w-[200px] truncate text-[11px] text-muted-foreground">
            {response}
          </span>
        )}
        {pendingPromptCommands.length > 0 && (
          <span className="text-[11px] text-muted-foreground">
            +{pendingPromptCommands.length}
          </span>
        )}
        <kbd className="hidden rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline-block">
          esc
        </kbd>
      </div>
    </div>
  );
}

