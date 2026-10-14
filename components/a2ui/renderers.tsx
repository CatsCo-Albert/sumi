"use client";

/**
 * Renderers for JsonRenderPayload — agents can return rich cards instead of
 * plain text when answering intents / chat.
 *
 * Four kinds: document_cards / progress / report / status.
 * Render inside the ai-chat-panel or any surface that receives a
 * `{ type: "json_render", payload }` chat item.
 */

import { cn } from "@/lib/utils";
import type {
  JsonRenderPayload,
  DocumentCard,
  RenderAction,
} from "@/src/a2ui/schema";

export function JsonRenderer({ payload }: { payload: JsonRenderPayload }) {
  switch (payload.kind) {
    case "document_cards":
      return <DocumentCardsRenderer payload={payload} />;
    case "progress":
      return <ProgressRenderer payload={payload} />;
    case "report":
      return <ReportRenderer payload={payload} />;
    case "status":
      return <StatusRenderer payload={payload} />;
    default:
      return (
        <div className="rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
          未知的渲染类型
        </div>
      );
  }
}

// ---------------------------------------------------------------------------
// document_cards — a grid of document cards with optional actions
// ---------------------------------------------------------------------------

function DocumentCardsRenderer({
  payload,
}: {
  payload: Extract<JsonRenderPayload, { kind: "document_cards" }>;
}) {
  const docs = payload.documents || [];
  return (
    <div className="space-y-2">
      {(payload.title || payload.subtitle) && (
        <div>
          {payload.title && (
            <div className="text-[12px] font-semibold">{payload.title}</div>
          )}
          {payload.subtitle && (
            <div className="text-[11px] text-muted-foreground">
              {payload.subtitle}
            </div>
          )}
        </div>
      )}
      {docs.length === 0 ? (
        <div className="rounded-md border border-dashed border-border/60 px-3 py-4 text-center text-[11px] text-muted-foreground">
          {payload.emptyMessage || "暂无文档"}
        </div>
      ) : (
        <div className="grid gap-2">
          {docs.map((d) => (
            <DocumentCardView key={d.id} doc={d} />
          ))}
        </div>
      )}
    </div>
  );
}

function DocumentCardView({ doc }: { doc: DocumentCard }) {
  return (
    <div className="rounded-lg border border-border/60 bg-card px-3 py-2 shadow-xs transition-shadow hover:shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-medium">{doc.name}</div>
          {doc.description && (
            <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
              {doc.description}
            </div>
          )}
          {doc.mainFile && (
            <div className="mt-1 font-mono text-[10px] text-muted-foreground/70">
              {doc.mainFile}
            </div>
          )}
        </div>
        {doc.updatedAt && (
          <div className="shrink-0 text-[10px] text-muted-foreground/60">
            {formatRelative(doc.updatedAt)}
          </div>
        )}
      </div>
      {doc.actions && doc.actions.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {doc.actions.map((a, i) => (
            <ActionButton key={i} action={a} />
          ))}
        </div>
      )}
    </div>
  );
}

function ActionButton({ action }: { action: RenderAction }) {
  const variant =
    action.variant === "destructive"
      ? "border-destructive/40 text-destructive hover:bg-destructive/10"
      : action.variant === "secondary"
      ? "border-border text-muted-foreground hover:text-foreground"
      : "border-border text-foreground hover:bg-accent";

  return (
    <button
      className={cn(
        "rounded-md border px-2 py-0.5 text-[10px] font-medium transition-colors",
        variant
      )}
      title={action.confirmDescription || action.label}
    >
      {action.label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// progress — live progress bar for a running task
// ---------------------------------------------------------------------------

function ProgressRenderer({
  payload,
}: {
  payload: Extract<JsonRenderPayload, { kind: "progress" }>;
}) {
  const pct = Math.round(payload.progress * 100);
  const isError = payload.status === "error";
  const isDone = payload.status === "completed";

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-medium">
          {payload.stage || "处理中"}
        </div>
        <div className="text-[10px] text-muted-foreground">{pct}%</div>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-all duration-300",
            isError
              ? "bg-destructive"
              : isDone
              ? "bg-emerald-500"
              : "bg-primary"
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      {payload.message && (
        <div className="text-[10px] text-muted-foreground/80">
          {payload.message}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// report — agent-generated markdown report card
// ---------------------------------------------------------------------------

function ReportRenderer({
  payload,
}: {
  payload: Extract<JsonRenderPayload, { kind: "report" }>;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="text-[12px] font-semibold">{payload.title}</div>
        <div className="rounded bg-muted px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">
          {payload.runId.slice(0, 8)}
        </div>
      </div>
      {payload.summary && (
        <div className="text-[11px] text-muted-foreground">
          {payload.summary}
        </div>
      )}
      {payload.error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
          {payload.error}
        </div>
      )}
      {payload.bodyMarkdown && (
        <details className="rounded-md border border-border/60 bg-muted/30">
          <summary className="cursor-pointer px-3 py-2 text-[11px] font-medium hover:bg-accent/50">
            查看详情
          </summary>
          <div className="prose-sm max-w-none px-3 pb-3 pt-1 text-[12px] [&_h1]:text-[14px] [&_h2]:text-[13px] [&_h3]:text-[12px] [&_code]:bg-muted [&_code]:px-1 [&_code]:rounded [&_pre]:bg-muted [&_pre]:p-2 [&_pre]:rounded [&_pre]:overflow-x-auto">
            {/* Simple markdown → render as text with light formatting. For rich
                rendering the caller should hydrate into a markdown component. */}
            <pre className="whitespace-pre-wrap font-sans">{payload.bodyMarkdown}</pre>
          </div>
        </details>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// status — lightweight inline status chip
// ---------------------------------------------------------------------------

function StatusRenderer({
  payload,
}: {
  payload: Extract<JsonRenderPayload, { kind: "status" }>;
}) {
  const color =
    payload.status === "success"
      ? "text-emerald-600 border-emerald-500/40 bg-emerald-500/10"
      : payload.status === "error"
      ? "text-destructive border-destructive/40 bg-destructive/10"
      : "text-muted-foreground border-border/60 bg-muted/40";

  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 rounded-md border px-2 py-1 text-[11px] font-medium",
        color
      )}
    >
      <span>
        {payload.status === "success"
          ? "✓"
          : payload.status === "error"
          ? "✕"
          : "…"}
      </span>
      <span className="font-mono text-[10px]">{payload.requestId.slice(0, 8)}</span>
      {payload.action?.type === "open_full_preview" && (
        <button className="ml-1 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary hover:bg-primary/20">
          打开预览
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} 天前`;
  return new Date(t).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}
