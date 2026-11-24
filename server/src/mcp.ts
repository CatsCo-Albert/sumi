/**
 * MCP server for Sumi.
 *
 * This replaces the bespoke `/api/agent/call` + `/api/agent/result` pair. Those
 * worked, but they were a private protocol: anything that wanted to drive Sumi
 * had to learn two endpoints and their exact bodies. MCP is the protocol agent
 * runtimes already speak, so a runtime can point its MCP bridge at
 * `…/sumi/mcp` and get snapshot / query / act as ordinary tools.
 *
 * The tools still relay to the browser, and they have to: `@ui-sdk/core/agent`
 * reads live component instances, which exist only in a page. So a tool call
 * publishes a request on the UI event bus, the open page runs it, and the page
 * posts the answer to `/api/agent/result`, which settles the call the tool is
 * waiting on.
 *
 * Stateless transport, one instance per request: the Sumi session that matters
 * is the browser's Yjs room, not an MCP session id, and keeping the transport
 * stateless means a restarted Hono does not strand a client.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Actor } from "../../src/auth/actor";

export interface McpDeps {
  /** Resolve the caller from the request's own credential. */
  resolveActor: (request: Request) => Promise<Actor | null>;
  /** Relay one ui-sdk agent call to the caller's open page. */
  callAgent: (input: {
    projectId: string;
    userId: string;
    call: "snapshot" | "query" | "act";
    input: unknown;
  }) => Promise<unknown>;
}

const TOOLS = [
  {
    name: "sumi_snapshot",
    description:
      "List every ui-sdk component on the caller's open Sumi page: its ref, " +
      "kind, label, current state and the actions it accepts. Take a snapshot " +
      "before acting — refs are only valid while the page stays open.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "The Sumi project to read." },
      },
      required: ["projectId"],
    },
  },
  {
    name: "sumi_query",
    description:
      "Find components without listing the whole page. `text` matches a " +
      "component's label or row text; `kind` keeps one kind such as " +
      "\"button\"; `within` returns the items of one list.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        text: { type: "string" },
        kind: { type: "string" },
        within: { type: "string" },
      },
      required: ["projectId"],
    },
  },
  {
    name: "sumi_act",
    description:
      "Run steps against the page in order, each naming a component by ref " +
      "(or by its label) and one of its actions, e.g. " +
      "{ ref: \"新建文档\", action: \"press\" }. Stops at the first failure and " +
      "reports what each step changed. Use sumi_snapshot first to learn the refs.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ref: { type: "string" },
              action: { type: "string" },
              args: { type: "array", items: {} },
            },
            required: ["ref", "action"],
          },
        },
      },
      required: ["projectId", "steps"],
    },
  },
] as const;

function buildServer(deps: McpDeps, actor: Actor, request: Request) {
  const server = new Server(
    { name: "sumi", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((tool) => ({ ...tool })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (call) => {
    const args = (call.params.arguments ?? {}) as Record<string, unknown>;
    const projectId = typeof args.projectId === "string" ? args.projectId : "";
    if (!projectId) {
      return {
        isError: true,
        content: [{ type: "text", text: "projectId is required" }],
      };
    }

    // Authorization is per project, not just per identity.
    const authorized = await deps.resolveActor(request);
    if (!authorized) {
      return {
        isError: true,
        content: [{ type: "text", text: "unauthenticated" }],
      };
    }

    try {
      if (call.params.name === "sumi_snapshot") {
        const value = await deps.callAgent({
          projectId,
          userId: actor.id,
          call: "snapshot",
          input: {},
        });
        return { content: [{ type: "text", text: JSON.stringify(value) }] };
      }

      if (call.params.name === "sumi_query") {
        const value = await deps.callAgent({
          projectId,
          userId: actor.id,
          call: "query",
          input: {
            ...(typeof args.text === "string" ? { text: args.text } : {}),
            ...(typeof args.kind === "string" ? { kind: args.kind } : {}),
            ...(typeof args.within === "string" ? { within: args.within } : {}),
          },
        });
        return { content: [{ type: "text", text: JSON.stringify(value) }] };
      }

      if (call.params.name === "sumi_act") {
        const steps = Array.isArray(args.steps) ? args.steps : [];
        if (steps.length === 0) {
          return {
            isError: true,
            content: [{ type: "text", text: "steps must not be empty" }],
          };
        }
        const value = await deps.callAgent({
          projectId,
          userId: actor.id,
          call: "act",
          input: { steps },
        });
        return { content: [{ type: "text", text: JSON.stringify(value) }] };
      }

      return {
        isError: true,
        content: [{ type: "text", text: `unknown tool: ${call.params.name}` }],
      };
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      // A closed page is the common case, so say which one it is rather than
      // returning a stack the model cannot act on.
      const noPage = message.includes("no page answered");
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: noPage
              ? `workspace_not_open: ${message}`
              : `sumi_${call.params.name}_failed: ${message}`,
          },
        ],
      };
    }
  });

  return server;
}

/**
 * Handle one MCP request. Returns a Response Hono can hand back directly.
 *
 * Authentication happens before the transport sees the message: an MCP session
 * with no Sumi identity could only answer "unauthenticated" per tool call, and
 * failing once at the door is both clearer and cheaper.
 */
export async function handleMcpRequest(
  request: Request,
  deps: McpDeps
): Promise<Response> {
  const actor = await deps.resolveActor(request);
  if (!actor) {
    return Response.json(
      {
        jsonrpc: "2.0",
        error: { code: -32001, message: "unauthenticated" },
        id: null,
      },
      { status: 401 }
    );
  }

  const server = buildServer(deps, actor, request);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);
  return transport.handleRequest(request);
}