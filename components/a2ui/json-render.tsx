"use client";

/**
 * json-render (vercel-labs) — shadcn/ui variant.
 *
 * Agents emit a flat Spec JSON:
 *   {
 *     root: "c1",
 *     elements: {
 *       c1: { type: "Card", props: {...}, children: ["t1","b1"] },
 *       t1: { type: "Text", props: { text: "…" } },
 *       b1: { type: "Button", props: { label:"打开", action:"open_document" } },
 *     }
 *   }
 *
 * We use the official shadcn component catalog + registry — 36 components
 * out of the box, no custom renderer code needed.
 */

import { schema } from "@json-render/react/schema";
import { defineCatalog } from "@json-render/core";
import { defineRegistry, Renderer } from "@json-render/react";
import { shadcnComponents, shadcnComponentDefinitions } from "@json-render/shadcn";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Catalog — merge our custom domain components with shadcn's built-ins
// ---------------------------------------------------------------------------

export const sumiCatalog = defineCatalog(schema, {
  components: {
    // Domain-specific — keep for Sumi documents
    DocumentCard: {
      props: z.object({
        title: z.string(),
        filePath: z.string().optional(),
        updatedAt: z.string().optional(),
        description: z.string().optional(),
      }),
      slots: [],
      description: "A project document card — links into the workspace",
      example: { title: "intro.md", filePath: "docs/intro.md" },
    },
    // Shadcn built-ins — the whole kit
    ...shadcnComponentDefinitions,
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
// Registry — use the official shadcn renderer components
// ---------------------------------------------------------------------------

export const { registry, handlers, executeAction } = defineRegistry(sumiCatalog, {
  components: {
    // Shadcn's own implementations — full Radix UI + Tailwind
    ...shadcnComponents,
    // Custom domain component — needs a renderer
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
  },

  actions: {
    open_document: async (params) => {
      console.log("[a2ui] open_document", params);
    },
    apply_pending_edit: async (params) => {
      console.log("[a2ui] apply_pending_edit", params);
    },
    copy_to_clipboard: async (params) => {
      const p = params as { text?: string } | undefined;
      if (typeof navigator !== "undefined" && p?.text) {
        await navigator.clipboard.writeText(String(p.text));
      }
    },
    open_url: async (params) => {
      const p = params as { url?: string } | undefined;
      if (typeof window !== "undefined" && p?.url) {
        window.open(String(p.url), "_blank", "noopener,noreferrer");
      }
    },
  },
});

// ---------------------------------------------------------------------------
// Entry point — drop-in renderer for any spec
// ---------------------------------------------------------------------------

export interface SumiSpecRendererProps {
  /** Spec JSON string or parsed Spec object. */
  spec: unknown;
  className?: string;
}

export function SumiSpecRenderer({ spec, className }: SumiSpecRendererProps) {
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
