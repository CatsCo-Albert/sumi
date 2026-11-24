import { For, Show, createMemo, createSignal, createEffect, onCleanup } from "solid-js";
import type { EditorView } from "@codemirror/view";
import { Button } from "@ui-sdk/solid/button";
import { Input } from "@ui-sdk/solid/input";
import { Resizable, ResizableHandle, ResizablePanel } from "@ui-sdk/solid/resizable";
import { ScrollArea, ScrollAreaViewport } from "@ui-sdk/solid/scroll-area";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@ui-sdk/solid/tabs";
import { Toolbar, ToolbarButton, ToolbarSeparator } from "@ui-sdk/solid/toolbar";
import { Editor } from "./editor";
import { NameDialog } from "./shell";
import { workspace } from "../lib/workspace";
import { navigateTo, currentRoute } from "../lib/route";
import { connectUiEvents } from "../lib/ui-events";
import { server, readToken, BASE_PATH, type PendingEdit, type VersionSummary } from "../lib/api";
import { buildFileTree, filterTree, type TreeNode } from "../lib/file-tree";
import { extractHeadings } from "../lib/outline";

/**
 * y-websocket appends `/<room>` to this, so the base must be the deployment
 * prefix and nothing else: the gateway strips it and the Yjs server receives
 * exactly the room name it expects.
 */
const WS_URL = (import.meta.env.VITE_WS_URL || "").trim() || defaultWsUrl();

function defaultWsUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}${BASE_PATH}`;
}

function colorFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  const palette = ["#6ea8fe", "#f3a33c", "#7bd88f", "#c792ea", "#f2709c", "#4dd0c1"];
  return palette[hash % palette.length];
}

function nodeMatches(node: TreeNode, query: string): boolean {
  if (!query) return true;
  if (node.kind === "file") return (node.doc?.fileId ?? "").toLowerCase().includes(query.toLowerCase());
  return node.children.some((child) => nodeMatches(child, query));
}

function TreeRows(props: {
  nodes: TreeNode[];
  depth: number;
  query: string;
  activeId: string | null;
  onOpen: (fileId: string) => void;
}) {
  return (
    <For each={props.nodes}>
      {(node) => (
        <Show when={nodeMatches(node, props.query)}>
          <div class="tree-row" style={{ "padding-left": `${8 + props.depth * 14}px` }}>
            <Show
              when={node.kind === "file"}
              fallback={
                <span class="tree-folder">
                  <span class="tree-caret">▾</span>
                  {node.name}
                </span>
              }
            >
              <button
                class="tree-file"
                aria-current={node.doc?.fileId === props.activeId ? "true" : undefined}
                onClick={() => props.onOpen(node.doc!.fileId)}
              >
                {node.name}
              </button>
            </Show>
          </div>
          <Show when={node.children.length > 0}>
            <TreeRows
              nodes={node.children}
              depth={props.depth + 1}
              query={props.query}
              activeId={props.activeId}
              onOpen={props.onOpen}
            />
          </Show>
        </Show>
      )}
    </For>
  );
}

export function WorkspaceView() {
  const [filter, setFilter] = createSignal("");
  const [content, setContent] = createSignal<string | null>(null);
  const [synced, setSynced] = createSignal(false);
  const [presence, setPresence] = createSignal(1);
  const [docText, setDocText] = createSignal("");
  const [live, setLive] = createSignal(false);
  const [dialog, setDialog] = createSignal<"project" | "document" | null>(null);
  const [question, setQuestion] = createSignal("");
  const [asking, setAsking] = createSignal(false);
  const [sidebarTab, setSidebarTab] = createSignal("outline");
  const [view, setView] = createSignal<EditorView | null>(null);

  /** The outline is navigation, not decoration: it moves the cursor. */
  const jumpToLine = (line: number) => {
    const editor = view();
    if (!editor) return;
    const target = Math.min(Math.max(line, 1), editor.state.doc.lines);
    const pos = editor.state.doc.line(target).from;
    editor.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    editor.focus();
  };

  const actor = () => workspace.actor();
  const project = () => workspace.currentProject();
  const fileId = () => workspace.fileId();
  const document = () => workspace.currentDocument();

  const tree = createMemo(() =>
    buildFileTree(
      workspace.documents().map((doc) => ({
        id: doc.id,
        fileId: doc.fileId,
        title: doc.title,
        updatedAt: doc.updatedAt,
      }))
    )
  );

  const headings = createMemo(() => extractHeadings(docText()).slice(0, 200));
  const wordCount = createMemo(() => docText().trim().split(/\s+/).filter(Boolean).length);

  /**
   * Load the persisted content for whichever document is open.
   *
   * Solid 2 wants an effect in two parts — what to watch, then what to do — so
   * the fetch cannot sit in the watched half and re-run on every write it makes.
   */
  let loadTicket = 0;
  createEffect(
    () => [workspace.projectId(), fileId()] as const,
    ([projectId, target]) => {
      const ticket = ++loadTicket;
      setContent(null);
      setSynced(false);
      setDocText("");
      if (!projectId || !target) return;
      server
        .content(projectId, target)
        .then((doc) => {
          if (ticket !== loadTicket) return;
          setContent(doc.content ?? "");
        })
        .catch(() => {
          if (ticket === loadTicket) setContent("");
        });
    }
  );

  /** The URL follows the selection, so a document stays linkable. */
  createEffect(
    () => [workspace.projectId(), fileId()] as const,
    ([projectId, target]) => {
      if (!projectId) return;
      const route = currentRoute();
      if (route.projectId === projectId && route.fileId === target) return;
      navigateTo(projectId, target);
    }
  );

  /** Live patch stream: pending edits and agent-driven navigation. */
  let stopStream: (() => void) | null = null;
  createEffect(
    () => workspace.projectId(),
    (projectId) => {
      stopStream?.();
      stopStream = null;
      if (!projectId) return;
      stopStream = connectUiEvents(projectId, {
        onStatus: (state) => setLive(state === "open"),
        onPatch: (patch) => {
          if (patch.type === "open_document" && typeof patch.documentId === "string") {
            workspace.selectDocument(patch.documentId);
          }
          if (patch.type === "set_sidebar_tab" && typeof patch.tab === "string") {
            setSidebarTab(patch.tab);
          }
        },
        onPendingEdit: (edit: PendingEdit | null) => {
          if (edit) void workspace.loadEdits();
        },
      });
    }
  );
  onCleanup(() => stopStream?.());

  const save = async () => {
    const projectId = workspace.projectId();
    const target = fileId();
    if (!projectId || !target) return;
    try {
      await server.saveContent(projectId, target, docText(), null);
      workspace.tell("已保存");
      await workspace.refreshDocuments();
    } catch (err) {
      workspace.tell(`保存失败：${(err as Error).message}`);
    }
  };

  const ask = async () => {
    const projectId = workspace.projectId();
    const prompt = question().trim();
    if (!projectId || !prompt) return;
    setAsking(true);
    try {
      await server.askAgent({ projectId, fileId: fileId() ?? undefined, question: prompt });
      setQuestion("");
      workspace.tell("问题已发出");
    } catch (err) {
      workspace.tell(`提问失败：${(err as Error).message}`);
    } finally {
      setAsking(false);
    }
  };

  const openDocument = (id: string) => {
    workspace.selectDocument(id);
    void workspace.loadEdits();
  };

  return (
    <div class="app">
      <a class="skip-link" href="#main">
        跳到正文
      </a>
      <header class="topbar">
        <span class="brand">Sumi</span>

        <select
          class="project-select"
          aria-label="选择项目"
          value={workspace.projectId() ?? ""}
          onChange={(event) => void workspace.selectProject(event.currentTarget.value)}
        >
          <For each={workspace.projects()}>
            {(item) => <option value={item.id}>{item.name}</option>}
          </For>
        </select>

        <Toolbar aria-label="工作区操作">
          <ToolbarButton onClick={() => setDialog("project")}>新建项目</ToolbarButton>
          <ToolbarSeparator />
          <ToolbarButton
            disabled={!workspace.projectId() || !workspace.canEdit()}
            onClick={() => setDialog("document")}
          >
            新建文档
          </ToolbarButton>
          <ToolbarSeparator />
          <ToolbarButton disabled={!fileId()} onClick={() => void save()}>
            保存
          </ToolbarButton>
        </Toolbar>

        <span class="spacer" />
        <span class="status" data-live={live()}>
          {live() ? "实时已连接" : "实时断开"}
        </span>
        <Show when={fileId()}>
          <span class="presence">{presence()} 人在线</span>
        </Show>
        <span class="who">
          {actor()?.name}
          <span class="role">{actor()?.kind === "agent" ? "agent" : "user"}</span>
        </span>
      </header>

      <Show when={workspace.notice()}>
        <div class="notice">{workspace.notice()}</div>
      </Show>

      <div class="workspace">
        <Resizable>
          <ResizablePanel defaultSize={20} minSize={12}>
            <nav class="pane pane-docs" aria-label="文档">
              <div class="pane-head">
                <Input
                  aria-label="筛选文档"
                  placeholder="筛选文件…"
                  value={filter()}
                  onInput={(event: Event) =>
                    setFilter((event.target as HTMLInputElement).value)
                  }
                />
              </div>
              <ScrollArea>
                <ScrollAreaViewport>
                  <div class="file-tree">
                    <Show
                      when={workspace.documents().length > 0}
                      fallback={<div class="empty">还没有文档</div>}
                    >
                      <TreeRows
                        nodes={tree().children}
                        depth={0}
                        query={filter()}
                        activeId={fileId()}
                        onOpen={openDocument}
                      />
                    </Show>
                  </div>
                </ScrollAreaViewport>
              </ScrollArea>
            </nav>
          </ResizablePanel>

          <ResizableHandle aria-label="调整文档列表宽度" />

          <ResizablePanel defaultSize={56} minSize={30}>
            <div class="pane pane-main">
              <Show
                when={fileId()}
                fallback={<div class="empty-center">选择或新建一个文档开始</div>}
              >
                <div class="doc-head">
                  <h1 class="doc-title" translate="no">
                    {document()?.title || fileId()}
                  </h1>
                  <div class="doc-meta">
                    <span translate="no">{fileId()}</span>
                    <Show when={document()?.updatedAt}>
                      <span class="dot">·</span>
                      {new Intl.DateTimeFormat("zh-CN", {
                        month: "numeric",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      }).format(document()!.updatedAt)}
                    </Show>
                  </div>
                </div>

                <Show
                  when={content() !== null && actor()}
                  fallback={<div class="empty-center">加载中…</div>}
                >
                  <Editor
                    room={`${workspace.projectId()}-${fileId()}`}
                    wsUrl={WS_URL}
                    token={readToken()}
                    initialContent={content() ?? ""}
                    mode={fileId()?.endsWith(".html") ? "html" : "markdown"}
                    readOnly={!workspace.canEdit()}
                    user={{
                      id: actor()!.id,
                      name: actor()!.name,
                      color: colorFor(actor()!.id),
                      image: actor()!.avatarUrl,
                    }}
                    onSynced={() => setSynced(true)}
                    onPresence={setPresence}
                    onText={setDocText}
                    onReady={setView}
                  />
                  <div class="editor-foot">
                    <span class="foot-state" data-synced={synced()}>
                      {synced() ? "已同步" : "同步中…"}
                    </span>
                    <span class="foot-sep" aria-hidden="true" />
                    <span>{wordCount()} 词</span>
                    <span class="foot-sep" aria-hidden="true" />
                    <span>{docText().length} 字</span>
                    <span class="spacer" />
                    <span class="foot-hint">⌘S 保存</span>
                  </div>
                </Show>
              </Show>
            </div>
          </ResizablePanel>

          <ResizableHandle aria-label="调整侧栏宽度" />

          <ResizablePanel defaultSize={24} minSize={16}>
            <aside class="pane pane-side" aria-label="侧栏">
              <Tabs
                value={sidebarTab()}
                onValueChange={(value: string | null) => setSidebarTab(value ?? "outline")}
              >
                <TabsList aria-label="侧栏视图">
                  <TabsTab value="outline">大纲</TabsTab>
                  <TabsTab value="members">成员</TabsTab>
                  <TabsTab value="edits">待审</TabsTab>
                  <TabsTab value="history">历史</TabsTab>
                </TabsList>

                <TabsPanel value="outline">
                  <ScrollArea>
                    <ScrollAreaViewport>
                      <div class="outline">
                        <Show
                          when={headings().length > 0}
                          fallback={<div class="empty">没有标题</div>}
                        >
                          <For each={headings()}>
                            {(heading) => (
                              <button
                                class="outline-row"
                                data-level={heading.level}
                                style={{
                                  "padding-left": `${0.5 + (heading.level - 1) * 0.75}rem`,
                                }}
                                onClick={() => jumpToLine(heading.line)}
                              >
                                <span class="outline-text">{heading.text}</span>
                                <span class="outline-line">{heading.line}</span>
                              </button>
                            )}
                          </For>
                        </Show>
                      </div>
                    </ScrollAreaViewport>
                  </ScrollArea>
                </TabsPanel>

                <TabsPanel value="members">
                  <ScrollArea>
                    <ScrollAreaViewport>
                      <div class="members">
                        <For each={workspace.members()}>
                          {(member) => (
                            <div class="member">
                              <span
                                class="avatar"
                                style={{ background: colorFor(member.subjectId) }}
                              >
                                {(member.displayName || member.subjectId).slice(0, 1)}
                              </span>
                              <span class="member-name">
                                {member.displayName || member.subjectId}
                              </span>
                              <span class="member-role">{member.role}</span>
                            </div>
                          )}
                        </For>
                        <Show when={workspace.members().length === 0}>
                          <div class="empty">没有成员</div>
                        </Show>
                      </div>
                    </ScrollAreaViewport>
                  </ScrollArea>
                </TabsPanel>

                <TabsPanel value="edits">
                  <div class="side-actions">
                    <Button
                      onClick={() => void workspace.loadEdits()}
                      aria-label="刷新待审编辑"
                    >
                      刷新
                    </Button>
                  </div>
                  <ScrollArea>
                    <ScrollAreaViewport>
                      <div class="edits">
                        <For each={workspace.edits()}>
                          {(edit) => (
                            <div class="edit-card">
                              <div class="edit-head">
                                {edit.description || edit.filePath}
                              </div>
                              <div class="edit-meta">
                                {edit.authorName || edit.authorId || "未知"} ·{" "}
                                {edit.blocks.length} 处改动
                              </div>
                              <div class="edit-actions">
                                <Button onClick={() => void workspace.resolveEdit(edit, "apply")}>
                                  应用
                                </Button>
                                <button
                                  class="ghost"
                                  onClick={() => void workspace.resolveEdit(edit, "reject")}
                                >
                                  驳回
                                </button>
                              </div>
                            </div>
                          )}
                        </For>
                        <Show when={workspace.edits().length === 0}>
                          <div class="empty">没有待审编辑</div>
                        </Show>
                      </div>
                    </ScrollAreaViewport>
                  </ScrollArea>
                </TabsPanel>

                <TabsPanel value="history">
                  <div class="side-actions">
                    <Button onClick={() => void workspace.loadVersions()}>刷新</Button>
                  </div>
                  <ScrollArea>
                    <ScrollAreaViewport>
                      <div class="versions">
                        <For each={workspace.versions()}>
                          {(version: VersionSummary) => (
                            <div class="version">
                              <div class="version-head">
                                {version.label || new Date(version.createdAt).toLocaleString()}
                              </div>
                              <div class="edit-meta">
                                {version.authorName || "系统"} · {version.source} ·{" "}
                                {Math.round(version.sizeBytes / 1024)} KB
                              </div>
                              <button
                                class="ghost"
                                onClick={async () => {
                                  await server.restoreVersion(
                                    workspace.projectId()!,
                                    version.id
                                  );
                                  workspace.tell("已恢复该版本");
                                  await workspace.loadVersions();
                                }}
                              >
                                恢复
                              </button>
                            </div>
                          )}
                        </For>
                        <Show when={workspace.versions().length === 0}>
                          <div class="empty">没有版本记录</div>
                        </Show>
                      </div>
                    </ScrollAreaViewport>
                  </ScrollArea>
                </TabsPanel>
              </Tabs>
            </aside>
          </ResizablePanel>
        </Resizable>
      </div>

      <footer class="dock">
        <Input
          aria-label="问 Agent"
          placeholder="问 Agent：这段怎么改？"
          value={question()}
          onInput={(event: Event) => setQuestion((event.target as HTMLInputElement).value)}
          onKeyDown={(event: KeyboardEvent) => {
            if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) void ask();
          }}
        />
        <Button disabled={asking() || !question().trim()} onClick={() => void ask()}>
          {asking() ? "…" : "提问"}
        </Button>
      </footer>

      <NameDialog
        open={dialog() === "project"}
        title="新建项目"
        label="项目名称"
        placeholder="例如：设计稿"
        onOpenChange={(open) => setDialog(open ? "project" : null)}
        onSubmit={(name) => workspace.createProject(name)}
      />
      <NameDialog
        open={dialog() === "document"}
        title="新建文档"
        label="文件名（可含 / 分目录）"
        placeholder="notes/intro.md"
        onOpenChange={(open) => setDialog(open ? "document" : null)}
        onSubmit={(name) => workspace.createDocument(name, name.split("/").pop())}
      />
    </div>
  );
}
