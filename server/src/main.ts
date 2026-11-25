/**
 * Hono front door for Sumi.
 *
 * The 23 existing handlers under `app/api/**\/route.ts` are plain
 * `(Request, { params }) => Response` functions with no Next.js imports, so
 * they mount here unchanged: this file only adapts Hono's context to the shape
 * they already expect, plus the static surface and the WebSocket upgrade
 * pass-through that used to live in the gateway.
 *
 * The whole app is mounted twice — bare and under BASE_PATH — because the
 * artifact gateway strips `/<app-id>/` before forwarding while a direct hit on
 * this port still carries it.
 */

import net from "node:net";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Context } from "hono";
import { actorForProject, actorFromRequest } from "../../lib/http-auth";
import { callAgent } from "../../src/ui-bus/agent-bridge";
import { handleMcpRequest } from "./mcp";

const APP_PORT = Number(process.env.APP_PORT || 8794);
const WS_PORT = Number(process.env.WS_PORT || 1234);
const BASE_PATH = (process.env.BASE_PATH || "/sumi").replace(/\/$/, "");
const WEB_DIST = process.env.WEB_DIST || path.resolve(import.meta.dirname, "../../web/dist");

type Params = Record<string, string>;
type RouteHandler = (
  request: Request,
  context?: { params: Promise<Params> }
) => Promise<Response> | Response;
type RouteModule = Record<string, RouteHandler>;

/** What a route needs from Hono: the Request, and the path params. */
const fromHono = (handler: RouteHandler, c: Context) =>
  handler(c.req.raw, { params: Promise.resolve(c.req.param() as Params) });

const routeTable: Array<{ path: string; module: string }> = [
  /* Only the page-facing half of the agent bridge remains a route: the
     agent-facing half is the MCP server below. */
  { path: "/api/agent/result", module: "../../app/api/agent/result/route.ts" },
  { path: "/api/auth/me", module: "../../app/api/auth/me/route.ts" },
  { path: "/api/documents/content", module: "../../app/api/documents/content/route.ts" },
  { path: "/api/edits/apply", module: "../../app/api/edits/apply/route.ts" },
  { path: "/api/friends", module: "../../app/api/friends/route.ts" },
  { path: "/api/intents", module: "../../app/api/intents/route.ts" },
  { path: "/api/invite/redeem", module: "../../app/api/invite/redeem/route.ts" },
  { path: "/api/page-state/:projectId", module: "../../app/api/page-state/[projectId]/route.ts" },
  { path: "/api/pending-edits", module: "../../app/api/pending-edits/route.ts" },
  { path: "/api/pending-edits/bulk-reject", module: "../../app/api/pending-edits/bulk-reject/route.ts" },
  { path: "/api/projects", module: "../../app/api/projects/route.ts" },
  { path: "/api/projects/:id", module: "../../app/api/projects/[id]/route.ts" },
  { path: "/api/projects/:id/agent-setup", module: "../../app/api/projects/[id]/agent-setup/route.ts" },
  { path: "/api/projects/:id/assets", module: "../../app/api/projects/[id]/assets/route.ts" },
  { path: "/api/projects/:id/documents", module: "../../app/api/projects/[id]/documents/route.ts" },
  { path: "/api/projects/:id/invite", module: "../../app/api/projects/[id]/invite/route.ts" },
  { path: "/api/projects/:id/members", module: "../../app/api/projects/[id]/members/route.ts" },
  { path: "/api/projects/:id/versions", module: "../../app/api/projects/[id]/versions/route.ts" },
  { path: "/api/projects/:id/versions/restore", module: "../../app/api/projects/[id]/versions/restore/route.ts" },
  { path: "/api/shadow-docs", module: "../../app/api/shadow-docs/route.ts" },
  { path: "/api/shadow-docs/promote", module: "../../app/api/shadow-docs/promote/route.ts" },
  { path: "/api/tap", module: "../../app/api/tap/route.ts" },
  { path: "/api/ui/events", module: "../../app/api/ui/events/route.ts" },
  { path: "/api/ui/page", module: "../../app/api/ui/page/route.ts" },
  { path: "/api/ui/publish", module: "../../app/api/ui/publish/route.ts" },
];

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

async function readAsset(urlPath: string) {
  const clean = urlPath.replace(/^\/+/, "");
  const resolved = path.resolve(WEB_DIST, clean);
  if (!resolved.startsWith(WEB_DIST)) return null;
  try {
    const info = await stat(resolved);
    if (!info.isFile()) return null;
    const body = await readFile(resolved);
    return {
      body,
      type: MIME[path.extname(resolved).toLowerCase()] || "application/octet-stream",
    };
  } catch {
    return null;
  }
}

async function main() {
  const mounted: string[] = [];

  // The API surface, mounted at the root so its own paths stay literal.
  const api = new Hono();
  for (const entry of routeTable) {
    const mod = (await import(entry.module)) as RouteModule;
    for (const method of METHODS) {
      const handler = mod[method];
      if (!handler) continue;
      api.on(method, entry.path, (c) => fromHono(handler, c));
      mounted.push(`${method} ${entry.path}`);
    }
  }
  api.get("/api/health", (c) =>
    c.json({ ok: true, routes: mounted.length, basePath: BASE_PATH })
  );

  /* The agent-facing surface. A runtime points its MCP bridge here and gets
     snapshot / query / act as ordinary tools, instead of learning a private
     HTTP pair. Mounted with the rest of `api`, so it answers at both `/mcp`
     and `/<base>/mcp`. */
  api.all("/mcp", (c) =>
    handleMcpRequest(c.req.raw, {
      resolveActor: (request) => actorFromRequest(request),
      // Membership, not just identity: these tools read and press inside other
      // members' pages, so being signed in is not enough to ask about a project.
      authorizeProject: (request, projectId) => actorForProject(request, projectId),
      callAgent,
    })
  );

  // One instance serves both spellings.
  const app = new Hono();
  app.route("/", api);
  app.route(BASE_PATH, api);

  app.get("*", async (c) => {
    let urlPath = new URL(c.req.url).pathname;
    if (BASE_PATH && urlPath.startsWith(BASE_PATH)) {
      urlPath = urlPath.slice(BASE_PATH.length) || "/";
    }
    if (urlPath.startsWith("/api/")) {
      return c.json({ error: "not found", path: urlPath }, 404);
    }
    const asset = await readAsset(urlPath === "/" ? "index.html" : urlPath);
    if (asset) {
      return new Response(asset.body, {
        headers: { "content-type": asset.type, "cache-control": "no-cache" },
      });
    }
    // Client-side documents fall back to the shell.
    const shell = await readAsset("index.html");
    if (!shell) {
      return c.text("web/dist not built — run `pnpm --dir web build`", 503);
    }
    return new Response(shell.body, {
      headers: { "content-type": shell.type, "cache-control": "no-cache" },
    });
  });

  const server = serve({ fetch: app.fetch, port: APP_PORT, hostname: "127.0.0.1" });

  // WebSocket upgrades belong to the Yjs server. Keeping the pass-through here
  // means one port faces the gateway, as the old gateway did.
  //
  // y-websocket connects to `${base}/${room}`, and the Yjs server only accepts a
  // room it can parse as `${projectId}-${fileId}`, so the prefix is removed here
  // rather than handed on.
  server.on("upgrade", (req, socket, head) => {
    const upstream = net.connect(WS_PORT, "127.0.0.1", () => {
      let target = req.url || "/";
      if (BASE_PATH && target.startsWith(`${BASE_PATH}/`)) {
        target = target.slice(BASE_PATH.length);
      }
      const lines = [`${req.method} ${target} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });

  server.listen(APP_PORT, "127.0.0.1", () => {
    console.log(`sumi hono → http://127.0.0.1:${APP_PORT}${BASE_PATH}/`);
    console.log(`  routes  ${mounted.length}`);
    console.log(`  static  ${WEB_DIST}`);
    console.log(`  ws      pass-through → 127.0.0.1:${WS_PORT}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
