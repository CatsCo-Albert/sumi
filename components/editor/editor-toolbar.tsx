"use client";

/**
 * Editor toolbar — markdown-aware formatting chrome above the CodeMirror
 * surface, modeled after litewrite's editor-toolbar.
 *
 * Layout: [undo/redo] [inline fmt] [block] [insert] ··· [status]
 * Overflow: groups that don't fit collapse into a trailing "···" menu
 * (ResizeObserver on the groups container — never wraps).
 *
 * No lucide-react in this project — icons are inline 16×16 stroke SVGs or
 * short text labels. Buttons use onMouseDown preventDefault so the editor
 * never loses focus.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { EditorView } from "@codemirror/view";
import { undo, redo } from "@codemirror/commands";
import { cn } from "@/lib/utils";
import { getAuthHeaders } from "@/lib/use-session";
import {
  wrapSelectionWith,
  insertText,
  insertBlock,
  toggleLinePrefix,
  setHeadingLevel,
  getActiveFormats,
} from "./format-helpers";

export interface EditorToolbarProps {
  editorView: EditorView | null;
  projectId: string;
  fileId: string;
  /** WS connection state */
  isConnected?: boolean;
  isSynced?: boolean;
  collaboratorCount?: number;
  /** TAP ghost-text toggle — rendered only when the feature is enabled. */
  tapAvailable?: boolean;
  tapEnabled?: boolean;
  onTapToggle?: () => void;
  /** Cmd+Shift+I — open the ask-agent dialog. */
  onAskAgent?: () => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// Icons — 16×16 stroke SVGs, kept minimal
// ---------------------------------------------------------------------------

type IconProps = { className?: string };
const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const IconUndo = ({ className }: IconProps) => (
  <svg viewBox="0 0 16 16" className={className} {...stroke}>
    <path d="M3 6.5h6a3.5 3.5 0 1 1 0 7H6" />
    <path d="M5.5 3.5 3 6.5l2.5 3" />
  </svg>
);
const IconRedo = ({ className }: IconProps) => (
  <svg viewBox="0 0 16 16" className={className} {...stroke}>
    <path d="M13 6.5H7a3.5 3.5 0 1 0 0 7h3" />
    <path d="M10.5 3.5 13 6.5l-2.5 3" />
  </svg>
);
const IconBold = ({ className }: IconProps) => (
  <svg viewBox="0 0 16 16" className={className} {...stroke}>
    <path d="M4.5 3h4a2.25 2.25 0 0 1 0 4.5h-4zM4.5 7.5H9.5a2.75 2.75 0 0 1 0 5.5H4.5z" />
  </svg>
);
const IconItalic = ({ className }: IconProps) => (
  <svg viewBox="0 0 16 16" className={className} {...stroke}>
    <path d="M6.5 3h5M4.5 13h5M9 3 7 13" />
  </svg>
);
const IconUnderline = ({ className }: IconProps) => (
  <svg viewBox="0 0 16 16" className={className} {...stroke}>
    <path d="M4.5 2.5v5a3.5 3.5 0 0 0 7 0v-5" />
    <path d="M4 13.5h8" />
  </svg>
);
const IconStrike = ({ className }: IconProps) => (
  <svg viewBox="0 0 16 16" className={className} {...stroke}>
    <path d="M2.5 8h11" />
    <path d="M11.5 5.5c-.3-1.7-1.7-2.7-3.5-2.7-2 0-3.5 1-3.5 2.6 0 .6.2 1.1.7 1.6" />
    <path d="M4.5 10.5c.3 1.7 1.7 2.7 3.5 2.7 2 0 3.5-1 3.5-2.6 0-.6-.2-1.1-.7-1.6" />
  </svg>
);
const IconInlineCode = ({ className }: IconProps) => (
  <svg viewBox="0 0 16 16" className={className} {...stroke}>
    <path d="m5.5 4.5-3 3.5 3 3.5M10.5 4.5l3 3.5-3 3.5" />
  </svg>
);
const IconLink = ({ className }: IconProps) => (
  <svg viewBox="0 0 16 16" className={className} {...stroke}>
    <path d="M6.5 9.5a3 3 0 0 0 4.2.3l2-2a3 3 0 0 0-4.2-4.2l-1 1" />
    <path d="M9.5 6.5a3 3 0 0 0-4.2-.3l-2 2a3 3 0 0 0 4.2 4.2l1-1" />
  </svg>
);
const IconImage = ({ className }: IconProps) => (
  <svg viewBox="0 0 16 16" className={className} {...stroke}>
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <circle cx="5.5" cy="6.5" r="1" />
    <path d="m3.5 12 3.5-3.5 2.5 2.5 2-2 1.5 1.5" />
  </svg>
);
const IconTable = ({ className }: IconProps) => (
  <svg viewBox="0 0 16 16" className={className} {...stroke}>
    <rect x="2" y="3" width="12" height="10" rx="1" />
    <path d="M2 6.5h12M2 10h12M7.5 3v10" />
  </svg>
);
const IconChevron = ({ className }: IconProps) => (
  <svg viewBox="0 0 16 16" className={className} {...stroke}>
    <path d="m4.5 6 3.5 3.5L11.5 6" />
  </svg>
);
const IconMore = ({ className }: IconProps) => (
  <svg viewBox="0 0 16 16" className={className} fill="currentColor">
    <circle cx="3.5" cy="8" r="1.2" />
    <circle cx="8" cy="8" r="1.2" />
    <circle cx="12.5" cy="8" r="1.2" />
  </svg>
);

// ---------------------------------------------------------------------------
// Small primitives — button, separator, dropdown
// ---------------------------------------------------------------------------

const BTN =
  "flex h-9 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent";

function ToolButton({
  title,
  onRun,
  disabled,
  active,
  children,
  className,
}: {
  title: string;
  onRun: () => void;
  disabled?: boolean;
  /** Mark the button as "format applies at cursor" — primary-tinted bg. */
  active?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      className={cn(
        BTN,
        active &&
          "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
        className
      )}
      // Don't steal editor focus — action runs on mousedown-safe click.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onRun}
    >
      {children}
    </button>
  );
}

const Sep = () => (
  <div className="mx-1 h-5 w-px shrink-0 bg-border/60" aria-hidden />
);

/** Minimal dropdown — absolute-positioned, closes on outside click / Esc. */
function Dropdown({
  trigger,
  align = "start",
  children,
  disabled,
  label,
}: {
  trigger: ReactNode;
  align?: "start" | "end";
  children: (close: () => void) => ReactNode;
  disabled?: boolean;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        title={label}
        aria-label={label}
        aria-expanded={open}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-9 items-center gap-1 rounded-md px-2 text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40",
          open && "bg-accent text-foreground"
        )}
      >
        {trigger}
        <IconChevron className="h-3 w-3" />
      </button>
      {open && (
        <div
          className={cn(
            "absolute top-full z-50 mt-1 min-w-[10rem] rounded-lg border border-border/60 bg-popover p-1 shadow-md",
            align === "end" ? "right-0" : "left-0"
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  onSelect,
  children,
  disabled,
}: {
  onSelect: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-foreground transition-colors hover:bg-accent disabled:opacity-40"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onSelect}
    >
      {children}
    </button>
  );
}

const MenuLabel = ({ children }: { children: ReactNode }) => (
  <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
    {children}
  </div>
);
const MenuSep = () => <div className="mx-1 my-1 h-px bg-border/60" />;

// ---------------------------------------------------------------------------
// Link popover — inline URL prompt (never window.prompt)
// ---------------------------------------------------------------------------

function LinkPopover({
  view,
  disabled,
}: {
  view: EditorView | null;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const apply = () => {
    if (!view) return;
    const sel = view.state.selection.main;
    const text = view.state.sliceDoc(sel.from, sel.to);
    const label = text || "链接文本";
    const href = url.trim() || "https://";
    view.dispatch({
      changes: {
        from: sel.from,
        to: sel.to,
        insert: `[${label}](${href})`,
      },
      selection: { anchor: sel.from + label.length + href.length + 4 },
    });
    view.focus();
    setUrl("");
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        title="插入链接"
        aria-label="插入链接"
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        className={cn(BTN, open && "bg-accent text-foreground")}
      >
        <IconLink className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-64 rounded-lg border border-border/60 bg-popover p-2 shadow-md">
          <div className="mb-1.5 text-[11px] text-muted-foreground">
            链接地址
          </div>
          <div className="flex items-center gap-1.5">
            <input
              ref={inputRef}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") apply();
                if (e.key === "Escape") setOpen(false);
              }}
              placeholder="https://…"
              className="h-8 flex-1 rounded-md border border-border/60 bg-background px-2 text-[12px] outline-none focus:ring-1 focus:ring-primary"
            />
            <button
              type="button"
              onClick={apply}
              className="h-8 rounded-md bg-primary px-2.5 text-[12px] font-medium text-primary-foreground"
            >
              插入
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Block-style dropdown data
// ---------------------------------------------------------------------------

type BlockAction =
  | { kind: "heading"; level: number }
  | { kind: "prefix"; prefix: string }
  | { kind: "block"; text: string };

const BLOCK_OPTIONS: { label: string; action: BlockAction }[] = [
  { label: "正文", action: { kind: "heading", level: 0 } },
  { label: "标题 1", action: { kind: "heading", level: 1 } },
  { label: "标题 2", action: { kind: "heading", level: 2 } },
  { label: "标题 3", action: { kind: "heading", level: 3 } },
  { label: "引用", action: { kind: "prefix", prefix: "> " } },
  { label: "无序列表", action: { kind: "prefix", prefix: "- " } },
  { label: "有序列表", action: { kind: "prefix", prefix: "1. " } },
  {
    label: "代码块",
    action: { kind: "block", text: "```\n\n```" },
  },
  { label: "分割线", action: { kind: "block", text: "---" } },
];

const TABLE_TEMPLATE = `| 列 1 | 列 2 | 列 3 |
| ---- | ---- | ---- |
|      |      |      |`;

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

export function EditorToolbar({
  editorView,
  projectId,
  fileId: _fileId,
  isConnected = false,
  isSynced = false,
  collaboratorCount = 0,
  tapAvailable = false,
  tapEnabled = false,
  onTapToggle,
  onAskAgent,
  className,
}: EditorToolbarProps) {
  const view = editorView;
  const disabled = !view;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const run = useCallback(
    (fn: (v: EditorView) => boolean | void) => {
      if (!view) return;
      fn(view);
      view.focus();
    },
    [view]
  );

  const applyBlock = (action: BlockAction) => {
    run((v) => {
      if (action.kind === "heading") setHeadingLevel(v, action.level);
      else if (action.kind === "prefix") toggleLinePrefix(v, action.prefix);
      else insertBlock(v, action.text);
    });
  };

  const insertLinkAtSelection = () => {
    run((v) => insertText(v, "[链接文本](https://)", 1));
  };

  // Image upload — POST /api/projects/:id/assets → ![](url)
  const handleImageFile = async (file: File) => {
    if (!view) return;
    setUploading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/assets`, {
        method: "POST",
        headers: {
          ...getAuthHeaders(),
          "content-type": file.type || "application/octet-stream",
          "x-file-name": file.name,
        },
        body: file,
      });
      if (!res.ok) throw new Error(`upload failed: ${res.status}`);
      const { url } = (await res.json()) as { url: string };
      insertBlock(view, `![](${url})`);
      view.focus();
    } catch (err) {
      console.error("asset upload failed", err);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // -------------------------------------------------------------------------
  // Overflow — groups that would clip collapse into a trailing "···" menu.
  // Same approach as litewrite: ResizeObserver + right-edge detection.
  // -------------------------------------------------------------------------
  const groupsRef = useRef<HTMLDivElement>(null);
  const groupRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [hiddenGroups, setHiddenGroups] = useState<Set<number>>(new Set());
  const setGroupRef =
    (index: number) => (el: HTMLDivElement | null) => {
      groupRefs.current[index] = el;
    };

  useEffect(() => {
    const check = () => {
      const container = groupsRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const hidden = new Set<number>();
      groupRefs.current.forEach((el, i) => {
        if (!el) return;
        if (el.getBoundingClientRect().right > rect.right + 2) hidden.add(i);
      });
      setHiddenGroups((prev) => {
        if (prev.size === hidden.size && [...prev].every((x) => hidden.has(x)))
          return prev;
        return hidden;
      });
    };
    const t = setTimeout(check, 60);
    const ro = new ResizeObserver(() => requestAnimationFrame(check));
    if (groupsRef.current) ro.observe(groupsRef.current);
    return () => {
      clearTimeout(t);
      ro.disconnect();
    };
  }, []);

  const inOverflow = (i: number) => hiddenGroups.has(i);

  // -- live format-state tracking ------------------------------------------
  // Recompute which inline formats are active at the cursor on every
  // doc/selection change. We subscribe via view.updateListener-less polling
  // through a rAF loop driven by pointer/keyup — cheap enough at this scale.
  const [activeFormats, setActiveFormats] = useState<Set<string>>(
    () => new Set()
  );
  useEffect(() => {
    if (!editorView) {
      setActiveFormats(new Set());
      return;
    }
    const refresh = () => {
      const next = getActiveFormats(editorView);
      setActiveFormats((prev) => {
        if (prev.size === next.size && [...prev].every((x) => next.has(x)))
          return prev;
        return next;
      });
    };
    refresh();
    const dom = editorView.dom;
    dom.addEventListener("keyup", refresh);
    dom.addEventListener("mouseup", refresh);
    // Doc changes also matter (user types `**` — bold state flips)
    const interval = setInterval(refresh, 500);
    return () => {
      dom.removeEventListener("keyup", refresh);
      dom.removeEventListener("mouseup", refresh);
      clearInterval(interval);
    };
  }, [editorView]);

  // -- inline-format group body (shared between bar + overflow menu) -------
  const inlineActions: {
    title: string;
    icon: ReactNode;
    /** Format token matched against `activeFormats`. */
    fmt: string;
    run: () => void;
  }[] = [
    {
      title: "加粗 (⌘B)",
      icon: <IconBold className="h-4 w-4" />,
      fmt: "bold",
      run: () => run(wrapSelectionWith("**")),
    },
    {
      title: "斜体 (⌘I)",
      icon: <IconItalic className="h-4 w-4" />,
      fmt: "italic",
      run: () => run(wrapSelectionWith("*")),
    },
    {
      title: "下划线 (⌘U)",
      icon: <IconUnderline className="h-4 w-4" />,
      fmt: "underline",
      run: () => run(wrapSelectionWith("<u>", "</u>")),
    },
    {
      title: "删除线 (⌘⇧X)",
      icon: <IconStrike className="h-4 w-4" />,
      fmt: "strike",
      run: () => run(wrapSelectionWith("~~")),
    },
    {
      title: "行内代码 (⌘E)",
      icon: <IconInlineCode className="h-4 w-4" />,
      fmt: "code",
      run: () => run(wrapSelectionWith("`")),
    },
  ];

  const statusDot = isConnected
    ? isSynced
      ? "bg-emerald-500"
      : "bg-amber-500 animate-pulse"
    : "bg-muted-foreground/40";
  const statusText = !isConnected
    ? "离线"
    : isSynced
    ? "已连接"
    : "同步中";

  return (
    <div
      className={cn(
        "relative z-10 flex h-10 items-center gap-0.5 border-b border-border/60 bg-background/80 px-2 backdrop-blur-sm",
        className
      )}
      data-testid="editor-toolbar"
    >
      {/* Left — formatting groups; clipped ones surface in the ··· menu */}
      <div
        ref={groupsRef}
        className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden"
      >
        {/* Group 0 — undo/redo */}
        <div ref={setGroupRef(0)} className="flex shrink-0 items-center">
          <ToolButton title="撤销 (⌘Z)" disabled={disabled} onRun={() => run(undo)}>
            <IconUndo className="h-4 w-4" />
          </ToolButton>
          <ToolButton title="重做 (⌘⇧Z)" disabled={disabled} onRun={() => run(redo)}>
            <IconRedo className="h-4 w-4" />
          </ToolButton>
          <Sep />
        </div>

        {/* Group 1 — inline formatting */}
        <div ref={setGroupRef(1)} className="flex shrink-0 items-center">
          {inlineActions.map((a) => (
            <ToolButton
              key={a.title}
              title={a.title}
              disabled={disabled}
              active={activeFormats.has(a.fmt)}
              onRun={a.run}
            >
              {a.icon}
            </ToolButton>
          ))}
          <Sep />
        </div>

        {/* Group 2 — block structure */}
        <div ref={setGroupRef(2)} className="flex shrink-0 items-center">
          <Dropdown
            label="段落样式"
            disabled={disabled}
            trigger={<span>正文</span>}
          >
            {(close) =>
              BLOCK_OPTIONS.map((opt) => (
                <MenuItem
                  key={opt.label}
                  onSelect={() => {
                    applyBlock(opt.action);
                    close();
                  }}
                >
                  {opt.label}
                </MenuItem>
              ))
            }
          </Dropdown>
          <Sep />
        </div>

        {/* Group 3 — insert */}
        <div ref={setGroupRef(3)} className="flex shrink-0 items-center">
          <LinkPopover view={view} disabled={disabled} />
          <ToolButton
            title={uploading ? "上传中…" : "插入图片"}
            disabled={disabled || uploading}
            onRun={() => fileInputRef.current?.click()}
          >
            <IconImage className="h-4 w-4" />
          </ToolButton>
          <ToolButton
            title="插入表格"
            disabled={disabled}
            onRun={() => run((v) => insertBlock(v, TABLE_TEMPLATE))}
          >
            <IconTable className="h-4 w-4" />
          </ToolButton>
        </div>
      </div>

      {/* Overflow menu */}
      {hiddenGroups.size > 0 && (
        <Dropdown
          label="更多"
          align="end"
          disabled={disabled}
          trigger={<IconMore className="h-4 w-4" />}
        >
          {(close) => (
            <>
              {inOverflow(0) && (
                <>
                  <MenuItem
                    onSelect={() => {
                      run(undo);
                      close();
                    }}
                  >
                    <IconUndo className="h-3.5 w-3.5" /> 撤销
                  </MenuItem>
                  <MenuItem
                    onSelect={() => {
                      run(redo);
                      close();
                    }}
                  >
                    <IconRedo className="h-3.5 w-3.5" /> 重做
                  </MenuItem>
                  <MenuSep />
                </>
              )}
              {inOverflow(1) && (
                <>
                  {inlineActions.map((a) => (
                    <MenuItem
                      key={a.title}
                      onSelect={() => {
                        a.run();
                        close();
                      }}
                    >
                      {a.icon} {a.title.split(" (")[0]}
                    </MenuItem>
                  ))}
                  <MenuSep />
                </>
              )}
              {inOverflow(2) && (
                <>
                  <MenuLabel>段落样式</MenuLabel>
                  {BLOCK_OPTIONS.map((opt) => (
                    <MenuItem
                      key={opt.label}
                      onSelect={() => {
                        applyBlock(opt.action);
                        close();
                      }}
                    >
                      {opt.label}
                    </MenuItem>
                  ))}
                  <MenuSep />
                </>
              )}
              {inOverflow(3) && (
                <>
                  <MenuItem
                    onSelect={() => {
                      insertLinkAtSelection();
                      close();
                    }}
                  >
                    <IconLink className="h-3.5 w-3.5" /> 插入链接
                  </MenuItem>
                  <MenuItem
                    onSelect={() => {
                      fileInputRef.current?.click();
                      close();
                    }}
                  >
                    <IconImage className="h-3.5 w-3.5" /> 插入图片
                  </MenuItem>
                  <MenuItem
                    onSelect={() => {
                      run((v) => insertBlock(v, TABLE_TEMPLATE));
                      close();
                    }}
                  >
                    <IconTable className="h-3.5 w-3.5" /> 插入表格
                  </MenuItem>
                </>
              )}
            </>
          )}
        </Dropdown>
      )}

      {/* Right — status */}
      <div className="ml-1 flex shrink-0 items-center gap-2">
        <div className="flex items-center gap-1.5" title={statusText}>
          <span className={cn("h-1.5 w-1.5 rounded-full", statusDot)} />
          <span className="whitespace-nowrap text-[11px] text-muted-foreground">
            {statusText}
          </span>
          {collaboratorCount > 1 && (
            <span className="text-[11px] text-muted-foreground/60">
              · {collaboratorCount} 人
            </span>
          )}
        </div>
        {tapAvailable && (
          <button
            type="button"
            onClick={onTapToggle}
            title={tapEnabled ? "关闭 TAP 补全" : "开启 TAP 补全"}
            onMouseDown={(e) => e.preventDefault()}
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
        {onAskAgent && (
          <button
            type="button"
            onClick={onAskAgent}
            title="问 agent (⌘⇧I)"
            onMouseDown={(e) => e.preventDefault()}
            className="flex h-7 items-center gap-1 rounded-md border border-border/60 px-2 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            问 agent
            <kbd className="rounded border border-border/60 px-1 text-[9px] text-muted-foreground/70">
              ⌘⇧I
            </kbd>
          </button>
        )}
      </div>

      {/* Hidden file input for image upload */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleImageFile(f);
        }}
      />
    </div>
  );
}
