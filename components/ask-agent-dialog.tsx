"use client";

/**
 * Ask-agent dialog — floating card over the editor for creating an intent.
 *
 * Opened via Cmd+I in the editor. Pre-fills selection if the user had
 * text selected; otherwise anchors to the whole file.
 */

import { useEffect, useRef, useState } from "react";
import { getAuthHeaders } from "@/lib/use-session";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

interface AskAgentDialogProps {
  open: boolean;
  projectId: string;
  fileId: string;
  /** Selected text + line range, if any. */
  selection?: {
    text: string;
    startLine: number;
    endLine: number;
  } | null;
  /** Agent members in the project — for picking a target. */
  agents: Array<{ subjectId: string; name: string | null }>;
  onClose: () => void;
  onCreated: () => void;
}

export function AskAgentDialog({
  open,
  projectId,
  fileId,
  selection,
  agents,
  onClose,
  onCreated,
}: AskAgentDialogProps) {
  const [prompt, setPrompt] = useState("");
  const [targetAgent, setTargetAgent] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      setPrompt("");
      setTargetAgent("");
      setBusy(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  if (!open) return null;

  const submit = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    try {
      const body: any = {
        projectId,
        fileId,
        prompt: prompt.trim(),
      };
      if (targetAgent) body.targetAgentId = targetAgent;
      if (selection) {
        body.selectionStart = selection.startLine;
        body.selectionEnd = selection.endLine;
        body.selectionText = selection.text;
      }
      const res = await fetch("/api/intents", {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast({
          title: "发起失败",
          description: data.error || `${res.status}`,
          variant: "destructive",
        });
        return;
      }
      toast({ title: "已询问 agent", variant: "success" });
      onCreated();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-50 w-[560px]">
      <div className="material-glass shadow-xl rounded-2xl p-4 border border-border">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div className="text-[12px] font-medium text-muted-foreground">
            询问 agent · <span className="text-foreground">{fileId}</span>
            {selection && (
              <span className="ml-2 text-[10px] text-muted-foreground/70">
                L{selection.startLine}–{selection.endLine}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground/60 hover:text-foreground text-[11px]"
            aria-label="close"
          >
            ✕
          </button>
        </div>

        {/* Selection preview */}
        {selection && (
          <div className="mb-2 max-h-20 overflow-y-auto rounded-md bg-muted/60 px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
            {selection.text.length > 240
              ? selection.text.slice(0, 240) + "…"
              : selection.text}
          </div>
        )}

        {/* Prompt */}
        <textarea
          ref={inputRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
            if (e.key === "Escape") onClose();
          }}
          placeholder="让 agent 做什么？例：把这段改成正式语气"
          rows={3}
          className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-[13px] outline-none focus:ring-1 focus:ring-primary"
        />

        {/* Footer: target picker + submit */}
        <div className="mt-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground">给:</span>
            <select
              value={targetAgent}
              onChange={(e) => setTargetAgent(e.target.value)}
              className="rounded-md border border-border bg-background px-2 py-1 text-[12px] outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="">所有 agent</option>
              {agents.map((a) => (
                <option key={a.subjectId} value={a.subjectId}>
                  {a.name || a.subjectId}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground/70">
              ⌘↩ 发送 · Esc 取消
            </span>
            <button
              onClick={submit}
              disabled={!prompt.trim() || busy}
              className={cn(
                "rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground",
                "disabled:opacity-50 transition-opacity"
              )}
            >
              {busy ? "发送中…" : "发送"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
