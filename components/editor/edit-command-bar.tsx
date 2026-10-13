"use client";

/**
 * EditCommandBar — Cursor-style floating bar for pending-edit review.
 *
 * Renders at the top-right of the editor pane while there are pending edits:
 *   filename chip · ‹ x of n › · Undo All · Keep All · ×
 *
 * Shortcuts:
 *   Alt+↑ / Alt+↓   previous / next edit
 *   Ctrl+Y          keep current
 *   Ctrl+Shift+Y    keep all
 *   Ctrl+N          reject current
 */

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { useEditStore } from "@/stores/edit-store";

export function EditCommandBar() {
  const {
    pendingEdits,
    currentEditIndex,
    isCommandBarVisible,
    nextEdit,
    prevEdit,
    applyEdit,
    rejectEdit,
    applyAll,
    rejectAll,
    getCurrentEdit,
    getPendingCount,
    navigateToCurrentEdit,
  } = useEditStore();

  const currentEdit = getCurrentEdit();
  const pendingCount = getPendingCount();

  const pendingOnly = pendingEdits.filter((e) => e.status === "pending");
  const currentPendingIndex = pendingOnly.findIndex(
    (e) => e.id === currentEdit?.id
  );
  const currentFileName =
    currentEdit?.filePath?.split("/").pop() || "";

  const handleNext = () => {
    nextEdit();
    setTimeout(() => navigateToCurrentEdit(), 0);
  };
  const handlePrev = () => {
    prevEdit();
    setTimeout(() => navigateToCurrentEdit(), 0);
  };

  // Auto-navigate the first time the bar appears.
  const prevVisibleRef = useRef(false);
  useEffect(() => {
    if (isCommandBarVisible && pendingCount > 0 && !prevVisibleRef.current) {
      const timer = setTimeout(() => navigateToCurrentEdit(), 50);
      prevVisibleRef.current = true;
      return () => clearTimeout(timer);
    }
    if (!isCommandBarVisible) prevVisibleRef.current = false;
  }, [isCommandBarVisible, pendingCount, navigateToCurrentEdit]);

  // Keyboard shortcuts
  useEffect(() => {
    if (!isCommandBarVisible) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "y") {
        e.preventDefault();
        void applyAll();
        return;
      }
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "y") {
        e.preventDefault();
        if (currentEdit) void applyEdit(currentEdit.id);
        return;
      }
      if (e.ctrlKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        if (currentEdit) rejectEdit(currentEdit.id);
        return;
      }
      if (e.altKey && e.key === "ArrowUp") {
        e.preventDefault();
        handlePrev();
        return;
      }
      if (e.altKey && e.key === "ArrowDown") {
        e.preventDefault();
        handleNext();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isCommandBarVisible,
    currentEdit,
    applyAll,
    applyEdit,
    rejectEdit,
    currentEditIndex,
  ]);

  if (!isCommandBarVisible || pendingCount === 0) return null;

  const isApplying = currentEdit?.status === "applying";

  return (
    <div className="absolute top-2 right-2 z-50">
      <div className="flex items-center gap-1 rounded-lg border border-border bg-card/95 px-2 py-1.5 shadow-lg backdrop-blur-md">
        {/* Current file chip */}
        {currentFileName && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <FileIcon className="h-3 w-3" />
            <span className="max-w-[90px] truncate">{currentFileName}</span>
          </div>
        )}

        {/* ‹ x of n › */}
        <div className="flex items-center gap-0.5">
          <button
            onClick={handlePrev}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="上一个编辑 (Alt+↑)"
            aria-label="Previous edit"
          >
            <ChevronLeftIcon className="h-3.5 w-3.5" />
          </button>
          <span className="min-w-[50px] text-center text-xs font-medium text-foreground">
            {currentPendingIndex + 1} / {pendingCount}
          </span>
          <button
            onClick={handleNext}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="下一个编辑 (Alt+↓)"
            aria-label="Next edit"
          >
            <ChevronRightIcon className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="mx-1 h-4 w-px bg-border" />

        {/* Undo All */}
        <button
          onClick={rejectAll}
          disabled={isApplying}
          className={cn(
            "flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-all",
            "text-muted-foreground hover:bg-muted hover:text-foreground",
            isApplying && "cursor-not-allowed opacity-50"
          )}
          title="全部拒绝 (Undo All)"
        >
          <XIcon className="h-3 w-3" />
          全部拒绝
        </button>

        {/* Keep All */}
        <button
          onClick={() => void applyAll()}
          disabled={isApplying}
          className={cn(
            "flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-all",
            "bg-primary text-primary-foreground hover:bg-primary/90",
            isApplying && "cursor-not-allowed opacity-50"
          )}
          title="全部保留 (Ctrl+Shift+Y)"
        >
          {isApplying ? (
            <SpinnerIcon className="h-3 w-3 animate-spin" />
          ) : (
            <CheckIcon className="h-3 w-3" />
          )}
          全部保留
        </button>
      </div>
    </div>
  );
}

export default EditCommandBar;

// ---------------------------------------------------------------------------
// Inline icons (no icon dependency)
// ---------------------------------------------------------------------------

function ChevronLeftIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 3.5L5.5 8L10 12.5" />
    </svg>
  );
}
function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3.5L10.5 8L6 12.5" />
    </svg>
  );
}
function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8.5L6.5 12L13 4" />
    </svg>
  );
}
function XIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4L12 12M12 4L4 12" />
    </svg>
  );
}
function SpinnerIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M8 2A6 6 0 1 1 2 8" />
    </svg>
  );
}
function FileIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.5 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5v-7L9.5 2Z" />
      <path d="M9.5 2v3.5H13" />
    </svg>
  );
}
