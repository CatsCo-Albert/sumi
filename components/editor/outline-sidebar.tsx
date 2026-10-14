"use client";

/**
 * Outline sidebar — live markdown heading structure for the open document.
 *
 * Data flow: the parent re-renders us whenever `content` changes (every doc
 * change flows through onContentChange) and when `cursorLine` moves. We
 * re-parse headings on render — cheap for doc-sized markdown.
 *
 * Clicking a heading scrolls the editor and places the cursor at line start.
 */

import { useMemo } from "react";
import { EditorView } from "@codemirror/view";
import { cn } from "@/lib/utils";
import { extractHeadings, headingForLine, type Heading } from "@/lib/outline";

interface OutlineSidebarProps {
  /** Live editor view — may be null in preview mode or before mount. */
  view: EditorView | null;
  /** Current document text (from onContentChange). */
  content: string;
  /** 1-based cursor line, from onCursorLineChange. */
  cursorLine: number | null;
  className?: string;
}

export default function OutlineSidebar({
  view,
  content,
  cursorLine,
  className,
}: OutlineSidebarProps) {
  const headings = useMemo(() => extractHeadings(content), [content]);
  const active = cursorLine ? headingForLine(headings, cursorLine) : null;

  const jumpTo = (h: Heading) => {
    if (!view) return;
    try {
      const line = Math.min(h.line, view.state.doc.lines);
      const pos = view.state.doc.line(line).from;
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 8 }),
      });
      view.focus();
    } catch {
      // doc mid-update — ignore
    }
  };

  return (
    <nav className={cn("flex h-full flex-col overflow-hidden", className)}>
      {headings.length === 0 ? (
        <div className="p-4 text-[12px] text-muted-foreground">暂无标题</div>
      ) : (
        <ul className="flex-1 overflow-auto py-2">
          {headings.map((h, i) => {
            const isActive = active === h;
            return (
              <li key={`${h.line}-${i}`}>
                <button
                  onClick={() => jumpTo(h)}
                  className={cn(
                    "flex w-full items-baseline gap-1.5 truncate py-1 pr-3 text-left text-[12px] transition-colors",
                    isActive
                      ? "bg-accent font-medium text-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                  )}
                  style={{ paddingLeft: `${(h.level - 1) * 10 + 10}px` }}
                  title={h.text}
                >
                  <span className="shrink-0 font-mono text-[9px] text-muted-foreground/50">
                    H{h.level}
                  </span>
                  <span className="truncate">{h.text || "（空标题）"}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}
