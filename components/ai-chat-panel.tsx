"use client";

/**
 * AI chat panel — right-side slide-over for intent threads + new asks.
 *
 * Two halves:
 *   top    — intent thread list for the current project+file, grouped
 *            oldest→newest; answered cards expand to show the answer and
 *            a jump-to-edit link.
 *   bottom — composer: target picker + prompt input; Cmd+Shift+I focuses it.
 *
 * Multi-turn: "追问" focuses the composer and chains the new intent via the
 * parent's threadId (with the answering agent pre-selected as the target).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { getAuthHeaders } from "@/lib/use-session";
import { useIntentStore } from "@/stores/intent-store";
import { useEditStore } from "@/stores/edit-store";
import { JsonRenderer } from "@/components/a2ui/renderers";
import type { JsonRenderPayload } from "@/src/a2ui/schema";
import type { IntentRow } from "@/src/intents";

/** Try parsing answerText as a JsonRenderPayload — returns null on miss. */
function tryParseJsonRender(
  text: string | null | undefined
): JsonRenderPayload | null {
  if (!text) return null;
  const t = text.trim();
  if (!t.startsWith("{")) return null;
  try {
    const obj = JSON.parse(t);
    if (
      obj &&
      typeof obj === "object" &&
      ["document_cards", "progress", "report", "status"].includes(obj.kind)
    ) {
      return obj as JsonRenderPayload;
    }
  } catch {
    /* not JSON — fall through to plain text */
  }
  return null;
}
import { toast } from "@/components/ui/toast";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_META: Record<
  IntentRow["status"],
  { icon: string; label: string; className: string }
> = {
  open: { icon: "○", label: "待处理", className: "text-muted-foreground" },
  claimed: { icon: "◐", label: "已认领", className: "text-amber-500" },
  answered: { icon: "✓", label: "已回答", className: "text-emerald-500" },
  closed: { icon: "✕", label: "已关闭", className: "text-muted-foreground/60" },
};

function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "刚刚";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  return `${d} 天前`;
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n) + "…" : flat;
}

/** Derive `u_ab` / `a_editor` style subject ids into an avatar glyph. */
function initials(name: string | null, id: string): string {
  const src = (name || id || "?").trim();
  return src.slice(0, 1).toUpperCase();
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

interface AiChatPanelProps {
  open: boolean;
  onClose: () => void;
  /** Null when no document is open — panel then shows project-wide intents
   *  (or an empty hint if there's no project either). */
  projectId: string | null;
  fileId: string | null;
  /** Current user's subject id — for close affordances. */
  actorId: string;
}

export function AiChatPanel({
  open,
  onClose,
  projectId,
  fileId,
  actorId,
}: AiChatPanelProps) {
  const intents = useIntentStore((s) => s.intents);
  const scope = useIntentStore((s) => s.scope);
  const setScope = useIntentStore((s) => s.setScope);
  const setIntents = useIntentStore((s) => s.setIntents);
  const upsertIntent = useIntentStore((s) => s.upsertIntent);

  const [agents, setAgents] = useState<
    Array<{ subjectId: string; name: string | null }>
  >([]);
  const [loading, setLoading] = useState(false);
  /** 追问 chaining state — set by a card, consumed by the composer. */
  const [followUp, setFollowUp] = useState<{
    threadId: string;
    agentId?: string;
  } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the store scope in sync + fetch the list on scope change / open.
  useEffect(() => {
    if (!open || !projectId) return;
    if (scope.projectId !== projectId || scope.fileId !== fileId) {
      setScope({ projectId, fileId });
    }
    let cancelled = false;
    setLoading(true);
    const url = new URL("/api/intents", window.location.origin);
    url.searchParams.set("projectId", projectId);
    if (fileId) url.searchParams.set("fileId", fileId);
    fetch(url.toString(), { headers: getAuthHeaders() })
      .then((r) => (r.ok ? r.json() : { intents: [] }))
      .then((d) => {
        if (cancelled) return;
        setIntents(d.intents ?? []);
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId, fileId]);

  // Load agent members for the target picker.
  useEffect(() => {
    if (!open || !projectId) return;
    let cancelled = false;
    fetch(`/api/projects/${projectId}/members`, { headers: getAuthHeaders() })
      .then((r) => (r.ok ? r.json() : { members: [] }))
      .then((d) => {
        if (cancelled) return;
        const list = (d.members || []).filter(
          (m: { subjectId?: string; status?: string | null }) =>
            m.subjectId?.startsWith("a") && m.status !== "disabled"
        );
        setAgents(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  // Group into threads; threads ordered by latest activity (oldest thread
  // first for a chat-like reading flow), intents within a thread
  // oldest→newest.
  const threads = useMemo(() => {
    const byThread = new Map<string, IntentRow[]>();
    for (const i of intents) {
      const arr = byThread.get(i.threadId) ?? [];
      arr.push(i);
      byThread.set(i.threadId, arr);
    }
    const groups = [...byThread.values()].map((rows) =>
      rows.slice().sort((a, b) => a.createdAt - b.createdAt)
    );
    groups.sort(
      (a, b) => a[a.length - 1].createdAt - b[b.length - 1].createdAt
    );
    return groups;
  }, [intents]);

  // Focus input when opened (Cmd+Shift+I routes through the same toggle).
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 250);
    return () => clearTimeout(t);
  }, [open]);

  // Auto-scroll to the newest intent.
  const lastId = threads.length
    ? threads[threads.length - 1][threads[threads.length - 1].length - 1].id
    : null;
  useEffect(() => {
    if (!lastId) return;
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [lastId]);

  const closeIntent = async (id: string) => {
    const res = await fetch("/api/intents", {
      method: "PATCH",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ id, status: "closed" }),
    }).catch(() => null);
    if (res?.ok) {
      const { intent } = await res.json().catch(() => ({ intent: null }));
      if (intent) upsertIntent(intent);
    }
  };

  return (
    <aside
      aria-hidden={!open}
      className={cn(
        "absolute inset-y-0 right-0 z-40 w-[360px]",
        "flex flex-col border-l border-border/60 material-glass",
        "transition-transform duration-200 ease-out-quint",
        open
          ? "pointer-events-auto translate-x-0"
          : "pointer-events-none translate-x-full"
      )}
    >
      {/* Header */}
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-border/60 px-3">
        <div className="text-[12px] font-medium text-muted-foreground">
          对话记录
          {fileId && (
            <span className="ml-2 text-foreground/80">
              {fileId.split("/").pop()}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground/60">
            {intents.length} 条
          </span>
          <button
            onClick={onClose}
            aria-label="关闭"
            className="rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground/70 hover:bg-accent hover:text-foreground"
          >
            ✕
          </button>
        </div>
      </header>

      {/* Thread list */}
      <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {!projectId ? (
          <EmptyHint text="打开一个文档后可向 agent 提问" />
        ) : loading && intents.length === 0 ? (
          <EmptyHint text="载入中…" />
        ) : threads.length === 0 ? (
          <EmptyHint text="还没有对话 — 在下方向 agent 提问" />
        ) : (
          threads.map((thread) => (
            <div key={thread[0].threadId} className="space-y-2">
              {thread.map((intent) => (
                <IntentCard
                  key={intent.id}
                  intent={intent}
                  isOwn={intent.authorId === actorId}
                  agents={agents}
                  onClose={() => void closeIntent(intent.id)}
                  onFollowUp={(agentId) => {
                    setFollowUp({ threadId: intent.threadId, agentId });
                    setTimeout(() => inputRef.current?.focus(), 50);
                  }}
                />
              ))}
              {threads.length > 1 && (
                <div className="border-b border-border/40" />
              )}
            </div>
          ))
        )}
      </div>

      {/* Composer */}
      <Composer
        inputRef={inputRef}
        projectId={projectId}
        fileId={fileId}
        agents={agents}
        followUp={followUp}
        onClearFollowUp={() => setFollowUp(null)}
        onCreated={(row) => {
          upsertIntent(row);
          setFollowUp(null);
        }}
      />
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Intent card
// ---------------------------------------------------------------------------

function IntentCard({
  intent,
  isOwn,
  agents,
  onClose,
  onFollowUp,
}: {
  intent: IntentRow;
  isOwn: boolean;
  agents: Array<{ subjectId: string; name: string | null }>;
  onClose: () => void;
  onFollowUp: (agentId?: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const meta = STATUS_META[intent.status];
  const targetName =
    agents.find((a) => a.subjectId === intent.targetAgentId)?.name ??
    intent.targetAgentId;

  const jumpToEdit = () => {
    const store = useEditStore.getState();
    const idx = store.pendingEdits.findIndex(
      (e) => e.id === intent.answerEditId
    );
    if (idx !== -1) {
      store.setCurrentEditIndex(idx);
      setTimeout(() => store.navigateToCurrentEdit(), 0);
    } else {
      toast({ title: "编辑已不在待处理队列中", variant: "destructive" });
    }
  };

  return (
    <div
      className={cn(
        "rounded-xl border border-border/50 bg-background/70 px-3 py-2.5",
        "transition-colors hover:border-border"
      )}
    >
      {/* Author row */}
      <div className="flex items-center gap-2">
        <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent text-[9px] font-semibold text-accent-foreground">
          {initials(intent.authorName, intent.authorId)}
        </div>
        <span className="truncate text-[11px] font-medium">
          {intent.authorName || intent.authorId}
        </span>
        <span
          className={cn("flex items-center gap-0.5 text-[10px]", meta.className)}
        >
          <span>{meta.icon}</span>
          <span>{meta.label}</span>
        </span>
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/60">
          {timeAgo(intent.createdAt)}
        </span>
      </div>

      {/* Prompt */}
      <div className="mt-1.5 whitespace-pre-wrap break-words text-[12px] leading-relaxed">
        {intent.prompt}
      </div>

      {/* Selection snapshot */}
      {intent.selectionText && (
        <div className="mt-1.5 rounded-md bg-muted/60 px-2 py-1 font-mono text-[10px] text-muted-foreground">
          {truncate(intent.selectionText, 80)}
          {intent.selectionStart != null && (
            <span className="ml-1.5 font-sans text-muted-foreground/60">
              L{intent.selectionStart}
              {intent.selectionEnd != null &&
              intent.selectionEnd !== intent.selectionStart
                ? `–${intent.selectionEnd}`
                : ""}
            </span>
          )}
        </div>
      )}

      {/* Footer: target + actions */}
      <div className="mt-2 flex items-center gap-2">
        <span className="text-[10px] text-muted-foreground/70">
          → {targetName || "所有 agent"}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          {intent.status === "answered" && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {expanded ? "收起" : "查看回答"}
            </button>
          )}
          {(intent.status === "answered" || intent.status === "claimed") && (
            <button
              onClick={() =>
                onFollowUp(
                  intent.answeredBy || intent.targetAgentId || undefined
                )
              }
              className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              追问
            </button>
          )}
          {isOwn && intent.status !== "closed" && (
            <button
              onClick={onClose}
              title="标记为已解决"
              className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-foreground"
            >
              关闭
            </button>
          )}
        </span>
      </div>

      {/* Answer (expanded) — try JSON render payload first, fall back to plain text */}
      {expanded && intent.status === "answered" && (
        <div className="mt-2 border-t border-border/50 pt-2">
          {(() => {
            const payload = tryParseJsonRender(intent.answerText);
            if (payload) {
              return <JsonRenderer payload={payload} />;
            }
            return intent.answerText ? (
              <div className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-foreground/90">
                {intent.answerText}
              </div>
            ) : null;
          })()}
          <div className="mt-1 flex items-center gap-2">
            {intent.answeredBy && (
              <span className="text-[10px] text-muted-foreground/60">
                {agents.find((a) => a.subjectId === intent.answeredBy)?.name ||
                  intent.answeredBy}
              </span>
            )}
            {intent.answeredAt && (
              <span className="text-[10px] text-muted-foreground/60">
                {timeAgo(intent.answeredAt)}
              </span>
            )}
            {intent.answerEditId && (
              <button
                onClick={jumpToEdit}
                className="ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium text-primary hover:bg-accent"
              >
                查看编辑 →
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function Composer({
  inputRef,
  projectId,
  fileId,
  agents,
  followUp,
  onClearFollowUp,
  onCreated,
}: {
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  projectId: string | null;
  fileId: string | null;
  agents: Array<{ subjectId: string; name: string | null }>;
  followUp: { threadId: string; agentId?: string } | null;
  onClearFollowUp: () => void;
  onCreated: (row: IntentRow) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [targetAgent, setTargetAgent] = useState("");
  const [busy, setBusy] = useState(false);

  const disabled = !projectId || !fileId;

  // 追问 — adopt the parent's threadId; target the answering agent when known.
  useEffect(() => {
    if (followUp?.agentId) setTargetAgent(followUp.agentId);
  }, [followUp]);

  const submit = async () => {
    const text = prompt.trim();
    if (!text || busy || disabled) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        projectId,
        fileId,
        prompt: text,
      };
      if (targetAgent) body.targetAgentId = targetAgent;
      if (followUp?.threadId) body.threadId = followUp.threadId;
      const res = await fetch("/api/intents", {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast({
          title: "发送失败",
          description: data.error || `${res.status}`,
          variant: "destructive",
        });
        return;
      }
      const { intent } = await res.json();
      if (intent) onCreated(intent);
      setPrompt("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="shrink-0 border-t border-border/60 p-3">
      {followUp && (
        <div className="mb-1.5 flex items-center gap-1.5 text-[10px] text-muted-foreground/70">
          <span>追问中</span>
          <button
            onClick={onClearFollowUp}
            className="rounded px-1 py-0.5 hover:bg-accent hover:text-foreground"
            title="取消追问"
          >
            ✕
          </button>
        </div>
      )}
      <div className="rounded-xl border border-border/60 bg-background/70 px-3 py-2 focus-within:ring-1 focus-within:ring-primary/50">
        <textarea
          ref={inputRef}
          rows={2}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          disabled={disabled || busy}
          placeholder={disabled ? "打开文档后可用" : "问 agent 什么…"}
          className="w-full resize-none bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/50 disabled:opacity-50"
        />
        <div className="flex items-center gap-2">
          <select
            value={targetAgent}
            onChange={(e) => setTargetAgent(e.target.value)}
            disabled={disabled}
            className="rounded-md border border-border/60 bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground outline-none"
          >
            <option value="">所有 agent</option>
            {agents.map((a) => (
              <option key={a.subjectId} value={a.subjectId}>
                {a.name || a.subjectId}
              </option>
            ))}
          </select>
          <span className="ml-auto text-[10px] text-muted-foreground/50">
            ⌘↩ 询问
          </span>
          <button
            onClick={() => void submit()}
            disabled={disabled || busy || !prompt.trim()}
            className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition-opacity disabled:opacity-40"
          >
            {busy ? "…" : "询问"}
          </button>
        </div>
      </div>
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div className="flex h-32 items-center justify-center text-[12px] text-muted-foreground/60">
      {text}
    </div>
  );
}
