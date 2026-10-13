"use client";

/**
 * TAP completion — CodeMirror 扩展（Cursor 风格 ghost text）
 *
 * 行为：
 *   - 停顿 300ms 且光标在行尾附近时，向 /api/tap 请求续写
 *   - 灰色斜体内联展示，附 [Tab] 提示
 *   - Tab 接受；Esc / 任意编辑 / 光标移动 >5 字符放弃
 *   - 用户输入与 suggestion 前缀匹配时同步收缩 ghost（live update）
 *   - skip 或请求失败时静默无事
 */

import {
  EditorView,
  Decoration,
  DecorationSet,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
  keymap,
} from "@codemirror/view";
import {
  StateField,
  StateEffect,
  Transaction,
  Prec,
} from "@codemirror/state";
import { ySyncAnnotation } from "y-codemirror.next";
import { getAuthHeaders } from "@/lib/use-session";

// ==================== 类型 ====================

export interface TapCompletion {
  /** 建议展示时的光标位置 */
  cursorPos: number;
  /** ghost 文本（剩余未消费部分） */
  insertedText: string;
  /** 请求发起时的文档长度（用于失效判断） */
  originalDocLength: number;
  /** 暂时隐藏（光标前移），仍保留缓存 */
  hidden?: boolean;
}

/** 发起一次请求所需的上下文标识 —— 用于去重，避免同位置重复触发。 */
interface RequestContext {
  projectId: string;
  fileId: string;
}

// ==================== Effects ====================

export const setTapCompletion = StateEffect.define<TapCompletion | null>();
export const acceptTapCompletion = StateEffect.define<void>();
export const dismissTapCompletion = StateEffect.define<void>();

// ==================== Widget ====================

class GhostTextWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "cm-ghost-wrap";

    const ghost = document.createElement("span");
    ghost.className = "cm-ghost-text";
    ghost.textContent = this.text;
    wrap.appendChild(ghost);

    const hint = document.createElement("span");
    hint.className = "cm-ghost-hint";
    hint.textContent = "Tab";
    wrap.appendChild(hint);

    return wrap;
  }
  eq(other: GhostTextWidget) {
    return this.text === other.text;
  }
  ignoreEvent() {
    return true;
  }
}

// ==================== 本地变更处理 ====================

/** 用户输入与 suggestion 做前缀匹配：匹配则收缩，偏离则丢弃。 */
function handleLocalDocChange(
  tr: Transaction,
  completion: TapCompletion
): TapCompletion | null {
  const { cursorPos, insertedText } = completion;
  const newCursorPos = tr.state.selection.main.head;

  // 光标退到建议点之前 → 放弃
  if (newCursorPos < cursorPos) return null;

  if (newCursorPos > cursorPos) {
    const userInput = tr.state.doc.toString().slice(cursorPos, newCursorPos);

    if (insertedText.startsWith(userInput)) {
      const remaining = insertedText.slice(userInput.length);
      // 用户把整段敲完了 → 结束
      if (remaining.length === 0) return null;
      return { ...completion, cursorPos: newCursorPos, insertedText: remaining };
    }
    // 偏离建议 → 放弃
    return null;
  }

  return completion;
}

/** 远端（Yjs）变更影响建议区域时丢弃；否则仅平移光标位置。 */
function handleRemoteDocChange(
  tr: Transaction,
  completion: TapCompletion
): TapCompletion | null {
  const { cursorPos } = completion;
  let newCursorPos = cursorPos;
  let dismiss = false;

  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    // 建议点附近（前 500 字符）的上下文变了 → 建议可能已过时
    const prefixStart = Math.max(0, cursorPos - 500);
    if (toA <= cursorPos && fromA >= prefixStart) {
      dismiss = true;
      return;
    }
    if (fromA <= cursorPos && toA >= cursorPos) {
      dismiss = true;
      return;
    }
    if (toA <= cursorPos) {
      newCursorPos += inserted.length - (toA - fromA);
    }
  });

  if (dismiss) return null;
  return { ...completion, cursorPos: newCursorPos };
}

// ==================== StateField ====================

export const tapCompletionState = StateField.define<TapCompletion | null>({
  create: () => null,

  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setTapCompletion)) return effect.value;
      if (effect.is(acceptTapCompletion) || effect.is(dismissTapCompletion)) {
        return null;
      }
    }

    if (!value) return null;

    if (tr.docChanged) {
      if (tr.annotation(ySyncAnnotation)) {
        return handleRemoteDocChange(tr, value);
      }
      return handleLocalDocChange(tr, value);
    }

    // 纯光标移动
    if (tr.selection) {
      const pos = tr.state.selection.main.head;
      if (pos < value.cursorPos) return null;
      if (pos > value.cursorPos) {
        // 移出超过 5 字符 → 彻底丢弃（规则要求）
        if (pos - value.cursorPos > 5) return null;
        if (!value.hidden) return { ...value, hidden: true };
      }
      if (pos === value.cursorPos && value.hidden) {
        return { ...value, hidden: false };
      }
    }

    return value;
  },
});

// ==================== 装饰 ====================

const tapDecorationPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }

    update(update: ViewUpdate) {
      const touched = update.transactions.some((tr) =>
        tr.effects.some(
          (e) =>
            e.is(setTapCompletion) ||
            e.is(acceptTapCompletion) ||
            e.is(dismissTapCompletion)
        )
      );
      if (update.docChanged || update.selectionSet || touched) {
        this.decorations = this.build(update.view);
      }
    }

    build(view: EditorView): DecorationSet {
      const completion = view.state.field(tapCompletionState);
      if (!completion || completion.hidden) return Decoration.none;
      if (completion.cursorPos > view.state.doc.length) return Decoration.none;
      if (!completion.insertedText) return Decoration.none;

      return Decoration.set([
        Decoration.widget({
          widget: new GhostTextWidget(completion.insertedText),
          side: 1,
        }).range(completion.cursorPos),
      ]);
    }
  },
  { decorations: (v) => v.decorations }
);

// ==================== 请求触发 ====================

const DEBOUNCE_MS = 300;
const MIN_DOC_LENGTH = 30;
/** 光标距行尾超过该列数则不触发（必须在行尾附近） */
const MAX_CHARS_AFTER_CURSOR = 2;
const PREFIX_CHARS = 2000;
const SUFFIX_CHARS = 1000;

/** 缓存最近一次触发/拒绝的上下文，避免同位置反复请求。 */
interface LastAttempt {
  cursorPos: number;
  /** 光标前 40 字符的指纹 —— 位置相近但内容不同仍会重试 */
  prefixTail: string;
}

class TapRequester {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: AbortController | null = null;
  private lastAttempt: LastAttempt | null = null;
  private destroyed = false;

  constructor(
    private view: EditorView,
    private ctx: RequestContext
  ) {}

  /** 文档或光标变化后调度一次（可能命中去重、条件不满足则直接返回）。 */
  schedule() {
    if (this.destroyed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.maybeFire(), DEBOUNCE_MS);
  }

  cancel() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  destroy() {
    this.destroyed = true;
    this.cancel();
    this.inFlight?.abort();
    this.inFlight = null;
  }

  private maybeFire() {
    if (this.destroyed) return;
    const { state } = this.view;
    const sel = state.selection.main;

    // 条件：光标空选区、文档够长、行尾附近
    if (!sel.empty) return;
    if (state.doc.length < MIN_DOC_LENGTH) return;
    const line = state.doc.lineAt(sel.head);
    if (line.to - sel.head > MAX_CHARS_AFTER_CURSOR) return;

    // 已有建议展示中则不重复请求
    if (state.field(tapCompletionState)) return;

    const docText = state.doc.toString();
    const prefixTail = docText.slice(Math.max(0, sel.head - 40), sel.head);

    // 去重：同位置 + 同上下文 → 跳过（上次已 skip 或被拒）
    if (
      this.lastAttempt &&
      this.lastAttempt.cursorPos === sel.head &&
      this.lastAttempt.prefixTail === prefixTail
    ) {
      return;
    }
    this.lastAttempt = { cursorPos: sel.head, prefixTail };

    void this.fire(sel.head, docText);
  }

  private async fire(cursorPos: number, docText: string) {
    this.inFlight?.abort();
    const controller = new AbortController();
    this.inFlight = controller;

    const prefix = docText.slice(Math.max(0, cursorPos - PREFIX_CHARS), cursorPos);
    const suffix = docText.slice(cursorPos, cursorPos + SUFFIX_CHARS);

    try {
      const res = await fetch("/api/tap", {
        method: "POST",
        headers: {
          ...getAuthHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          projectId: this.ctx.projectId,
          fileId: this.ctx.fileId,
          prefix,
          suffix,
        }),
        signal: controller.signal,
      });
      if (!res.ok) return;
      const data = (await res.json()) as {
        suggestion?: string;
        action?: string;
      };
      if (this.destroyed) return;
      if (data.action === "skip" || !data.suggestion) return;

      // 文档已变 → 丢弃过期建议
      const state = this.view.state;
      if (state.selection.main.head !== cursorPos) return;
      if (state.doc.length !== docText.length) return;

      this.view.dispatch({
        effects: setTapCompletion.of({
          cursorPos,
          insertedText: data.suggestion,
          originalDocLength: docText.length,
        }),
      });
    } catch {
      // 静默失败 —— TAP 永远不该打断输入
    } finally {
      if (this.inFlight === controller) this.inFlight = null;
    }
  }
}

// ==================== 触发插件 ====================

function makeTapPlugin(ctx: RequestContext) {
  return ViewPlugin.fromClass(
    class {
      private requester: TapRequester;

      constructor(view: EditorView) {
        this.requester = new TapRequester(view, ctx);
      }

      update(update: ViewUpdate) {
        // 远端变更也会 docChanged —— 只对本地用户输入调度
        const localEdit = update.transactions.some(
          (tr) =>
            tr.docChanged &&
            !tr.annotation(ySyncAnnotation) &&
            tr.isUserEvent("input")
        );
        const moved = update.selectionSet;

        if (localEdit || moved) {
          this.requester.schedule();
        }
      }

      destroy() {
        this.requester.destroy();
      }
    }
  );
}

// ==================== Keymap ====================

// Prec.highest —— TAP 的 Tab 优先于缩进
export const tapKeymap = Prec.highest(
  keymap.of([
    {
      key: "Tab",
      run: (view: EditorView): boolean => {
        const completion = view.state.field(tapCompletionState);
        if (!completion || completion.hidden || !completion.insertedText) {
          return false;
        }
        const finalPos = completion.cursorPos + completion.insertedText.length;
        view.dispatch({
          changes: {
            from: completion.cursorPos,
            insert: completion.insertedText,
          },
          selection: { anchor: finalPos },
          effects: acceptTapCompletion.of(),
        });
        return true;
      },
    },
    {
      key: "Escape",
      run: (view: EditorView): boolean => {
        if (!view.state.field(tapCompletionState)) return false;
        view.dispatch({ effects: dismissTapCompletion.of() });
        return true;
      },
    },
  ])
);

// ==================== 主题 ====================

export const tapCompletionTheme = EditorView.theme({
  ".cm-ghost-wrap": {
    display: "inline-flex",
    alignItems: "baseline",
    gap: "6px",
    pointerEvents: "none",
    userSelect: "none",
  },
  ".cm-ghost-text": {
    color: "#9ca3af",
    opacity: "0.6",
    fontStyle: "italic",
  },
  ".dark .cm-ghost-text": {
    color: "#6b7280",
  },
  ".cm-ghost-hint": {
    fontSize: "9px",
    fontStyle: "normal",
    color: "#9ca3af",
    opacity: "0.45",
    border: "1px solid currentColor",
    borderRadius: "3px",
    padding: "0 3px",
    lineHeight: "1.4",
  },
});

// ==================== 导出 ====================

/**
 * 创建 TAP 扩展。`enabled=false` 时返回空数组，便于条件装配。
 * projectId/fileId 仅用于请求体（服务端鉴权 + 限流）。
 */
export function tapExtension(
  enabled: boolean,
  ctx?: RequestContext
) {
  if (!enabled) return [];
  const context = ctx ?? { projectId: "", fileId: "" };
  return [
    tapCompletionState,
    tapDecorationPlugin,
    makeTapPlugin(context),
    tapKeymap,
    tapCompletionTheme,
  ];
}
