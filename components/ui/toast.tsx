"use client";

/**
 * Minimal toast — bottom-right corner, auto-dismiss.
 * Apple-grade: surface = material-glass, single accent border.
 */

import { create } from "zustand";
import { useEffect } from "react";
import { cn } from "@/lib/utils";

export interface ToastItem {
  id: string;
  title: string;
  description?: string;
  variant?: "default" | "success" | "destructive";
}

interface ToastStore {
  toasts: ToastItem[];
  push: (t: Omit<ToastItem, "id">) => void;
  dismiss: (id: string) => void;
}

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  push: (t) =>
    set((s) => ({
      toasts: [...s.toasts, { ...t, id: `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` }],
    })),
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));

export function toast(t: Omit<ToastItem, "id">) {
  useToastStore.getState().push(t);
}

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-[100] flex flex-col gap-2">
      {toasts.map((t) => (
        <ToastCard key={t.id} item={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastCard({
  item,
  onDismiss,
}: {
  item: ToastItem;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 4000);
    return () => clearTimeout(t);
  }, [onDismiss]);

  const accent =
    item.variant === "destructive"
      ? "border-l-destructive"
      : item.variant === "success"
      ? "border-l-emerald-500"
      : "border-l-primary";

  return (
    <div
      className={cn(
        "material-glass pointer-events-auto flex min-w-[240px] max-w-sm items-start gap-3 rounded-lg border-l-[3px] px-3 py-2.5 shadow-md animate-in fade-in slide-in-from-bottom-2",
        accent
      )}
    >
      <div className="flex-1">
        <div className="text-[12px] font-medium text-foreground">{item.title}</div>
        {item.description && (
          <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
            {item.description}
          </div>
        )}
      </div>
      <button
        onClick={onDismiss}
        className="text-[10px] text-muted-foreground/60 hover:text-foreground"
        aria-label="dismiss"
      >
        ✕
      </button>
    </div>
  );
}
