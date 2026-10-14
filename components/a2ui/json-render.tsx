"use client";

/**
 * json-render (vercel-labs) integration — agent emits a Spec JSON,
 * we render it with our own component catalog.
 *
 * Spec format (flat adjacency map, root key):
 *   {
 *     root: "c1",
 *     elements: {
 *       c1: { type: "Card", props: {...}, children: ["t1","b1"] },
 *       t1: { type: "Text", props: { text: "…" } },
 *       b1: { type: "Button", props: { label:"打开", action:"open_document" } },
 *     }
 *   }
 *
 * Replaces the hand-rolled JsonRenderPayload renderers — agents get a
 * proper component grammar instead of a discriminated union.
 */

import { schema } from "@json-render/react/schema";
import { defineCatalog } from "@json-render/core";
import { defineRegistry, Renderer } from "@json-render/react";
import { z } from "zod";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Catalog — the components an agent is allowed to use
// ---------------------------------------------------------------------------

export const sumiCatalog = defineCatalog(schema, {
  components: {
    Card: {
      props: z.object({
        title: z.string().optional(),
        subtitle: z.string().optional(),
      }),
      description: "Card container with optional title/subtitle",
      slots: ["default"],
    },
    Row: {
      props: z.object({
        gap: z.enum(["xs", "sm", "md", "lg"]).optional(),
        align: z.enum(["start", "center", "end"]).optional(),
      }),
      description: "Horizontal flex row",
      slots: ["default"],
    },
    Column: {
      props: z.object({
        gap: z.enum(["xs", "sm", "md", "lg"]).optional(),
      }),
      description: "Vertical stack",
      slots: ["default"],
    },
    Divider: {
      props: z.object({}),
      description: "Horizontal divider line",
      slots: [],
    },
    Text: {
      props: z.object({
        text: z.string(),
        variant: z.enum(["h1", "h2", "h3", "body", "caption", "code"]).optional(),
      }),
      description: "Text block — h1/h2/h3 for headers, body for prose, caption for meta",
      slots: [],
    },
    Markdown: {
      props: z.object({ content: z.string() }),
      description: "Markdown body — headers, lists, code blocks",
      slots: [],
    },
    Badge: {
      props: z.object({
        text: z.string(),
        variant: z.enum(["default", "success", "warning", "destructive"]).optional(),
      }),
      description: "Inline status chip",
      slots: [],
    },
    DocumentCard: {
      props: z.object({
        title: z.string(),
        description: z.string().optional(),
        filePath: z.string().optional(),
        updatedAt: z.string().optional(),
      }),
      description: "A project document card — links into the workspace",
      slots: [],
    },
    Progress: {
      props: z.object({
        value: z.number().min(0).max(1),
        label: z.string().optional(),
        status: z.enum(["running", "success", "error"]).optional(),
      }),
      description: "Progress bar 0..1",
      slots: [],
    },
    Stat: {
      props: z.object({
        label: z.string(),
        value: z.string(),
        unit: z.string().optional(),
      }),
      description: "Metric tile — label + big value",
      slots: [],
    },
    Button: {
      props: z.object({
        label: z.string(),
        action: z.string(),
        variant: z.enum(["default", "primary", "outline", "destructive"]).optional(),
      }),
      description: "Clickable button — emits the named action",
      slots: [],
    },
    Link: {
      props: z.object({
        label: z.string(),
        url: z.string(),
      }),
      description: "External link",
      slots: [],
    },
  },

  actions: {
    open_document: {
      description: "Open a document in the editor",
      params: z.object({ documentId: z.string() }),
    },
    apply_pending_edit: {
      description: "Apply a pending edit by id",
      params: z.object({ editId: z.string() }),
    },
    copy_to_clipboard: {
      description: "Copy text to clipboard",
      params: z.object({ text: z.string() }),
    },
    open_url: {
      description: "Open external URL in a new tab",
      params: z.object({ url: z.string() }),
    },
  },
});

// ---------------------------------------------------------------------------
// Registry — map catalog names to React components
// ---------------------------------------------------------------------------

const gapMap = { xs: "gap-1", sm: "gap-2", md: "gap-3", lg: "gap-4" } as const;
const alignMap = {
  start: "items-start",
  center: "items-center",
  end: "items-end",
} as const;

export const { registry, handlers, executeAction } = defineRegistry(sumiCatalog, {
  components: {
    Card: ({ props, children }) => (
      <div className="rounded-lg border border-border/60 bg-card p-3 shadow-xs">
        {props.title && (
          <div className="mb-1 text-[12px] font-semibold">{props.title}</div>
        )}
        {props.subtitle && (
          <div className="mb-2 text-[11px] text-muted-foreground">
            {props.subtitle}
          </div>
        )}
        {children}
      </div>
    ),

    Row: ({ props, children }) => (
      <div
        className={cn(
          "flex",
          gapMap[props.gap || "sm"],
          alignMap[props.align || "start"]
        )}
      >
        {children}
      </div>
    ),

    Column: ({ props, children }) => (
      <div className={cn("flex flex-col", gapMap[props.gap || "sm"])}>
        {children}
      </div>
    ),

    Divider: () => <div className="my-1 h-px w-full bg-border/60" />,

    Text: ({ props }) => {
      const cls =
        props.variant === "h1"
          ? "text-lg font-bold"
          : props.variant === "h2"
          ? "text-base font-semibold"
          : props.variant === "h3"
          ? "text-sm font-medium"
          : props.variant === "caption"
          ? "text-[10px] text-muted-foreground"
          : props.variant === "code"
          ? "rounded bg-muted px-1 py-0.5 font-mono text-[11px]"
          : "text-[12px] leading-relaxed";
      return <p className={cls}>{props.text}</p>;
    },

    Markdown: ({ props }) => (
      <pre className="whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 font-sans text-[12px] leading-relaxed">
        {props.content}
      </pre>
    ),

    Badge: ({ props }) => {
      const variant =
        props.variant === "success"
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600"
          : props.variant === "warning"
          ? "border-amber-500/40 bg-amber-500/10 text-amber-600"
          : props.variant === "destructive"
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-border/60 bg-muted/40 text-muted-foreground";
      return (
        <span
          className={cn(
            "inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium",
            variant
          )}
        >
          {props.text}
        </span>
      );
    },

    DocumentCard: ({ props, emit }) => (
      <div className="group rounded-lg border border-border/60 bg-card px-3 py-2 transition-shadow hover:shadow-sm">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-medium">{props.title}</div>
            {props.description && (
              <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
                {props.description}
              </div>
            )}
            {props.filePath && (
              <div className="mt-1 font-mono text-[10px] text-muted-foreground/70">
                {props.filePath}
              </div>
            )}
          </div>
          {props.updatedAt && (
            <div className="shrink-0 text-[10px] text-muted-foreground/60">
              {props.updatedAt}
            </div>
          )}
        </div>
        {emit && (
          <button
            onClick={() => emit("press")}
            className="mt-2 rounded-md border border-border px-2 py-0.5 text-[10px] font-medium text-foreground hover:bg-accent"
          >
            打开
          </button>
        )}
      </div>
    ),

    Progress: ({ props }) => {
      const pct = Math.round(props.value * 100);
      const isError = props.status === "error";
      const isDone = props.status === "success";
      return (
        <div className="space-y-1">
          {props.label && (
            <div className="flex items-center justify-between">
              <div className="text-[11px] font-medium">{props.label}</div>
              <div className="text-[10px] text-muted-foreground">{pct}%</div>
            </div>
          )}
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                isError
                  ? "bg-destructive"
                  : isDone
                  ? "bg-emerald-500"
                  : "bg-primary"
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      );
    },

    Stat: ({ props }) => (
      <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2">
        <div className="text-[10px] font-medium text-muted-foreground">
          {props.label}
        </div>
        <div className="mt-0.5 text-[16px] font-semibold tabular-nums">
          {props.value}
          {props.unit && (
            <span className="ml-0.5 text-[11px] font-normal text-muted-foreground">
              {props.unit}
            </span>
          )}
        </div>
      </div>
    ),

    Button: ({ props, emit }) => (
      <button
        onClick={() => emit?.(props.action)}
        className={cn(
          "rounded-md border px-3 py-1.5 text-[12px] font-medium transition-colors",
          props.variant === "primary" &&
            "border-primary bg-primary text-primary-foreground hover:bg-primary/90",
          props.variant === "destructive" &&
            "border-destructive bg-destructive text-destructive-foreground hover:bg-destructive/90",
          props.variant === "outline" &&
            "border-border bg-transparent hover:bg-accent",
          (!props.variant || props.variant === "default") &&
            "border-border bg-accent/50 hover:bg-accent"
        )}
      >
        {props.label}
      </button>
    ),

    Link: ({ props }) => (
      <a
        href={props.url}
        target="_blank"
        rel="noreferrer"
        className="text-[12px] text-primary underline-offset-2 hover:underline"
      >
        {props.label}
      </a>
    ),
  },

  actions: {
    open_document: async (params) => {
      console.log("[a2ui] open_document", params);
    },
    apply_pending_edit: async (params) => {
      console.log("[a2ui] apply_pending_edit", params);
    },
    copy_to_clipboard: async (params) => {
      if (typeof navigator !== "undefined" && params?.text) {
        await navigator.clipboard.writeText(String(params.text));
      }
    },
    open_url: async (params) => {
      if (typeof window !== "undefined" && params?.url) {
        window.open(String(params.url), "_blank", "noopener,noreferrer");
      }
    },
  },
});

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface SumiSpecRendererProps {
  /** Spec JSON string or parsed Spec object. */
  spec: unknown;
  /** Forwarded named-action handler — the host decides what to do. */
  onAction?: (action: string, params?: Record<string, unknown>) => void;
  className?: string;
}

export function SumiSpecRenderer({
  spec,
  onAction: _onAction, // kept for API compat — actions route through catalog handlers
  className,
}: SumiSpecRendererProps) {
  const parsed = typeof spec === "string" ? safeParse(spec) : spec;
  if (!parsed || typeof parsed !== "object") {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
        无法解析渲染指令
      </div>
    );
  }
  const specObj = parsed as { root?: string; elements?: Record<string, unknown> };
  if (!specObj.root || !specObj.elements) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
        无效的 spec — 缺 root 或 elements
      </div>
    );
  }
  return (
    <div className={className}>
      <Renderer spec={specObj as Parameters<typeof Renderer>[0]["spec"]} registry={registry} />
    </div>
  );
}

function safeParse(text: string): unknown | null {
  const t = text.trim();
  if (!t.startsWith("{")) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}
