/**
 * End-to-end check for the rebuilt Sumi: Hono backend + Solid 2 frontend.
 *
 * Runs against an isolated data directory and a JWT the script itself signs, so
 * it never touches the production database or needs the deployment's secret.
 *
 *   pnpm --dir server exec tsx ../scripts/e2e-solid.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as jose from "jose";
import { chromium } from "playwright-core";

const APP_PORT = Number(process.env.E2E_APP_PORT || 8891);
const WS_PORT = Number(process.env.E2E_WS_PORT || 12399);
const JWT_SECRET = "e2e-secret-not-the-deployment-one";
const BASE = `http://127.0.0.1:${APP_PORT}/sumi`;
const UID = 424242;
const USERNAME = "e2e-user";

const children: ChildProcess[] = [];
let failures = 0;

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function waitFor(port: number, timeoutMs = 40_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`port ${port} never opened`);
}

/** Group-kill: `tsx` forks, so killing only the shell would orphan the server. */
function stopAll() {
  for (const child of children) {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  }
}

async function main() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sumi-e2e-"));
  const env = {
    ...process.env,
    SUMI_DATA_DIR: dataDir,
    APP_PORT: String(APP_PORT),
    WS_PORT: String(WS_PORT),
    BASE_PATH: "/sumi",
    OC_JWT_SECRET: JWT_SECRET,
    INTERNAL_API_SECRET: "e2e-internal",
    WEB_DIST: path.resolve(import.meta.dirname, "../web/dist"),
  };

  console.log(`data dir ${dataDir}`);

  // --- ws-server -----------------------------------------------------------
  children.push(
    spawn("npx", ["tsx", "src/server/ws-server.ts"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    })
  );

  // --- Hono ----------------------------------------------------------------
  children.push(
    spawn("npx", ["tsx", "src/main.ts"], {
      cwd: path.resolve(import.meta.dirname, "../server"),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    })
  );

  await waitFor(APP_PORT);
  await waitFor(WS_PORT);

  const token = await new jose.SignJWT({ userId: UID, username: USERNAME, token_type: "user" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("catscompany")
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(new TextEncoder().encode(JWT_SECRET));

  const api = async (method: string, endpoint: string, body?: unknown) => {
    const res = await fetch(`${BASE}/api${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null };
  };

  console.log("\nHTTP");
  const me = await api("GET", "/auth/me");
  check("auth/me 认出测试身份", me.status === 200 && me.data.actor.username === USERNAME, me);

  const unauth = await fetch(`${BASE}/api/auth/me`, { headers: { Authorization: "Bearer nope" } });
  check("坏 token 被拒", unauth.status === 401, { status: unauth.status });

  const created = await api("POST", "/projects", { name: "e2e 项目" });
  check("建项目", created.status === 201 && Boolean(created.data?.project?.id), created);
  const projectId = created.data.project.id as string;

  const doc = await api("POST", `/projects/${projectId}/documents`, {
    fileId: "guide/intro.md",
    title: "intro.md",
  });
  check("建文档", doc.status === 201 && doc.data.document.fileId === "guide/intro.md", doc);

  const saved = await api("PUT", "/documents/content", {
    projectId,
    filePath: "guide/intro.md",
    content: "# Sumi\n\nSolid 2 + ui-sdk 重做的外壳。\n",
    baseContentHash: null,
  });
  check("写内容", saved.status === 200, saved);

  const read = await api("GET", `/documents/content?projectId=${projectId}&filePath=guide%2Fintro.md`);
  check("读回内容", read.status === 200 && read.data.content.startsWith("# Sumi"), read);

  const docs = await api("GET", `/projects/${projectId}/documents`);
  check("列文档", docs.status === 200 && docs.data.documents.length === 1, docs);

  const versions = await api("GET", `/projects/${projectId}/versions?fileId=guide%2Fintro.md`);
  check("列版本", versions.status === 200, versions);

  const edits = await api("GET", `/pending-edits?projectId=${projectId}&scope=reviewing`);
  check("列待审编辑", edits.status === 200 && Array.isArray(edits.data.edits), edits);

  const unknown = await fetch(`${BASE}/api/nope`);
  check("未知接口 404", unknown.status === 404, { status: unknown.status });

  const shell = await fetch(`${BASE}/`);
  check("外壳 HTML", shell.status === 200 && (await shell.text()).includes("id=\"root\""));

  console.log("\n浏览器");
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    // A missing favicon is not a defect of the rebuild.
    const text = m.text();
    if (m.type() === "error" && !text.includes("Failed to load resource")) errors.push(text);
  });

  await page.addInitScript((value) => {
    window.sessionStorage.setItem("sumi.token", value);
  }, token);

  // Not `networkidle`: the SSE stream is open for the life of the page, so the
  // network never goes idle and the wait would always time out.
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.locator(".brand").waitFor({ timeout: 20_000 });
  await page.locator(".tree-file").first().waitFor({ timeout: 20_000 });
  await page.locator(".cm-content").waitFor({ timeout: 20_000 });
  await page.waitForTimeout(800);

  check("顶栏渲染", (await page.locator(".brand").count()) === 1);
  // ui-sdk's Select renders a trigger button, not a native <select>, so the
  // project is asserted through the trigger's own text.
  const crumb = await page.locator(".crumb-select").innerText().catch(() => "");
  check("项目出现在选择器", crumb.includes("e2e 项目"), { crumb });
  check("文件树有该文件", (await page.locator(".tree-file").count()) >= 1);
  check("编辑器挂载", (await page.locator(".cm-content").count()) === 1);
  check("正文加载", (await page.locator(".cm-content").innerText()).includes("Sumi"));
  // Four content tabs plus the agent's activity log.
  check("侧栏页签", (await page.locator("[role=tab]").count()) >= 4);
  // Two splitters, each a separator; the count is what matters, not the exact
  // number of draggable handles the panel layout happens to expose.
  check("分栏可拖", (await page.locator("[role=separator]").count()) >= 2);

  // Editing must reach the Yjs room and come back through the API.
  const editable = await page.locator(".cm-content").getAttribute("contenteditable");
  check("编辑器可写", editable === "true" || editable === null, { editable });
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n浏览器里补的一行。");
  await page.waitForTimeout(1500);

  const liveContent = await api("GET", `/documents/content?projectId=${projectId}&filePath=guide%2Fintro.md`);
  check(
    "编辑经 Yjs 同步到服务端",
    String(liveContent.data.content).includes("浏览器里补的一行"),
    { content: liveContent.data.content, source: liveContent.data.source }
  );

  // Tab switching must work, and the outline must read the live document.
  await page.locator("[role=tab]").nth(1).click();
  await page.waitForTimeout(200);
  check("切到成员页签", (await page.locator(".members").count()) === 1);

  await page.locator("[role=tab]").nth(0).click();
  await page.waitForTimeout(200);
  const outline = await page.locator(".outline-row").allInnerTexts();
  check("大纲读到标题", outline.some((line) => line.includes("Sumi")), outline);

  check("没有页面报错", errors.length === 0, errors.slice(0, 3));

  await page.screenshot({ path: "/tmp/sumi-e2e.png", fullPage: false });
  await browser.close();

  // WebMCP: the page publishes its own tools to the browser, and a client that
  // speaks WebMCP can read and call them without knowing anything about Sumi.
  // Chrome only exposes the API behind a flag, so this needs its own browser.
  console.log("\nWebMCP");
  // Both names are listed because the flag was renamed: `WebMCPTesting` is what
  // Chrome 150 knows, `WebMCP` is what 153 and later turn on. Passing both keeps
  // the check about the page rather than about which build happens to be here.
  const mcpBrowser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    args: ["--enable-features=WebMCP,WebMCPTesting"],
  });
  const mcpPage = await mcpBrowser.newPage({ viewport: { width: 1440, height: 900 } });
  const mcpErrors: string[] = [];
  mcpPage.on("pageerror", (e) => mcpErrors.push(e.message));
  await mcpPage.addInitScript((value) => {
    window.sessionStorage.setItem("sumi.token", value);
  }, token);
  await mcpPage.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await mcpPage.locator(".cm-content").waitFor({ timeout: 20_000 });
  // Registration runs in the shell body, but `getTools` resolves asynchronously.
  await mcpPage.waitForTimeout(1200);

  const exposed = await mcpPage.evaluate(async () => {
    const context = (document as unknown as { modelContext?: { getTools(): Promise<unknown> } })
      .modelContext;
    if (!context) return { api: false, names: [] as string[] };
    const tools = (await context.getTools()) as Array<{ name: string }>;
    return { api: true, names: tools.map((tool) => tool.name) };
  });
  check("浏览器暴露 modelContext", exposed.api);
  check(
    "三个工具都注册上",
    exposed.names.length === 3 &&
      exposed.names.includes("snapshot") &&
      exposed.names.includes("query") &&
      exposed.names.includes("act"),
    exposed.names
  );

  // Chrome 158 and later take the arguments as an object, which is what the
  // spec says (`optional object inputObject`). Chrome 150 shipped an earlier
  // shape that wanted a JSON string. Both are tried so this check is about the
  // page's tools, not about which build the machine happens to have.
  const snapshot = await mcpPage.evaluate(async () => {
    const context = (document as unknown as {
      modelContext: {
        getTools(): Promise<Array<{ name: string }>>;
        executeTool(tool: unknown, args: unknown): Promise<unknown>;
      };
    }).modelContext;
    const tool = (await context.getTools()).find((entry) => entry.name === "snapshot");
    if (!tool) return { ok: false, reason: "no snapshot tool" };
    let raw: unknown;
    let shape = "object";
    try {
      raw = await context.executeTool(tool, {});
    } catch {
      shape = "string";
      raw = await context.executeTool(tool, "{}");
    }
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    return { ok: true, shape, components: Array.isArray(value) ? value.length : null };
  });
  check("WebMCP 快照返回组件", snapshot.ok && (snapshot.components ?? 0) > 0, snapshot);

  // The call must be visible on the page: a tool that edits without a trace is
  // exactly what the marks exist to prevent. The outline is what a snapshot
  // paints, so the check is on the outlines themselves rather than the log —
  // the log lives in a sidebar panel that only exists once its tab is open.
  await mcpPage.waitForTimeout(400);
  const painted = await mcpPage.evaluate(
    () => document.querySelectorAll("[data-agent-mark]").length
  );
  check("快照在控件上留下读标记", painted > 0, { painted });
  check("WebMCP 页面无报错", mcpErrors.length === 0, mcpErrors.slice(0, 3));

  await mcpPage.screenshot({ path: "/tmp/sumi-webmcp.png", fullPage: false });
  await mcpBrowser.close();
  await rm(dataDir, { recursive: true, force: true });

  console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}`);
  return failures;
}

main()
  .then(async (code) => {
    stopAll();
    await new Promise((r) => setTimeout(r, 500));
    process.exit(code === 0 ? 0 : 1);
  })
  .catch(async (error) => {
    console.error(error);
    stopAll();
    process.exit(1);
  });
