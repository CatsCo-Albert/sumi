/**
 * MCP server for Sumi.
 *
 * This replaces the bespoke `/api/agent/call` + `/api/agent/result` pair. Those
 * worked, but they were a private protocol: anything that wanted to drive Sumi
 * had to learn two endpoints and their exact bodies. MCP is the protocol agent
 * runtimes already speak, so a runtime can point its MCP bridge at
 * `…/sumi/mcp` and get the tools as ordinary tools.
 *
 * The tools relay to the browser, and they have to: `@ui-sdk/core/agent` reads
 * live component instances, which exist only in a page. So a tool call publishes
 * a request on the UI event bus, the open page runs it, and the page posts the
 * answer to `/api/agent/result`, which settles the call the tool is waiting on.
 *
 * Addressing follows the read/write split:
 *   - a read with no `clientId` collects from every open page and returns each
 *     answer tagged with its page;
 *   - an `act` must name one page, because pressing a button in three tabs is
 *     three presses.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Actor } from "../../src/auth/actor";
import { listProjectPages } from "../../src/ui-bus/page-registry";
import { listMarks, markSummary } from "../../src/ui-bus/mark-ledger";
import type { AggregateResult } from "../../src/ui-bus/agent-bridge";

export interface McpDeps {
  /** Resolve the caller from the request's own credential. */
  resolveActor: (request: Request) => Promise<Actor | null>;
  /**
   * Resolve the caller *and* check they belong to this project.
   *
   * Identity alone is not enough here: these tools read and press inside other
   * people's pages, so the question is never "who are you" but "are you part of
   * this project's work". Returns null when the caller is not a member, which is
   * reported as forbidden rather than as a failed call.
   */
  authorizeProject: (request: Request, projectId: string) => Promise<Actor | null>;
  /** Relay one ui-sdk agent call to the project's open page(s). */
  callAgent: (input: {
    projectId: string;
    userId: string;
    clientId?: string;
    call: "snapshot" | "query" | "act";
    input: unknown;
  }) => Promise<unknown>;
}

const TOOLS = [
  {
    name: "sumi_pages",
    description:
      "List the workspaces open in a project, whoever is sitting in front of " +
      "them: each page's clientId, the member it belongs to, the document it is " +
      "showing and when it opened. Call this first when more than one page might " +
      "be open, then pass a clientId to the other tools to address one page, or " +
      "omit it to read all of them at once.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "The Sumi project to look at." },
      },
      required: ["projectId"],
    },
  },
  {
    name: "sumi_marks",
    description:
      "What has actually been read and changed in a project, recorded by the " +
      "pages themselves rather than reported by the agent. Answers \"did that " +
      "read really happen, and on whose page\" — which a bare tool success " +
      "cannot. Returns a summary, which members' pages wrote it, and the newest " +
      "entries with clientId, document, ref, kind and time.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        filePath: { type: "string", description: "Only marks for this document." },
        limit: { type: "number", description: "Newest N entries, up to 500." },
      },
    },
  },
  {
    name: "sumi_snapshot",
    description:
      "List every ui-sdk component on a page: ref, kind, label, current state " +
      "and the actions it accepts. Without a clientId it reads every open page " +
      "and returns { pages: [{ clientId, filePath, value }] }; with one it " +
      "returns that page's components directly. Refs are only valid while the " +
      "page stays open, so snapshot before acting.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        clientId: {
          type: "string",
          description: "Read this page only. Omit to read all open pages.",
        },
      },
      required: ["projectId"],
    },
  },
  {
    name: "sumi_query",
    description:
      "Find components without listing the whole page. `text` matches a " +
      "component's label or row text; `kind` keeps one kind such as \"button\"; " +
      "`within` returns the items of one list. Same clientId rule as snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        clientId: { type: "string" },
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
      "Run steps against one page in order, each naming a component by ref (or " +
      "by its label) and one of its actions, e.g. { ref: \"新建文档\", action: " +
      "\"press\" }. Requires clientId when more than one page is open — a press " +
      "in every tab would otherwise fire several times. Run sumi_pages first.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        clientId: {
          type: "string",
          description: "The page to act on. Required when several are open.",
        },
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

function text(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

function failure(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

/** An aggregated read carries page identity; a targeted one is already known. */
function isAggregate(value: unknown): value is AggregateResult {
  return Boolean(value && typeof value === "object" && Array.isArray((value as AggregateResult).pages));
}

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
    const clientId = typeof args.clientId === "string" ? args.clientId.trim() : undefined;

    // Identity first, then membership. A valid token only says who is asking;
    // these tools read and press inside other people's pages, so the caller must
    // also belong to the project they are asking about.
    const identity = await deps.resolveActor(request);
    if (!identity) return failure("unauthenticated");
    if (!projectId) return failure("projectId is required");
    const authorized = await deps.authorizeProject(request, projectId);
    if (!authorized) return failure(`forbidden: not a member of ${projectId}`);

    try {
      if (call.params.name === "sumi_marks") {
        const filePath = typeof args.filePath === "string" ? args.filePath : undefined;
        const limit = typeof args.limit === "number" ? args.limit : 50;
        // No userId: a collaborator's question is about the project, not about
        // their own history. Membership was just checked, so this stays inside
        // the project either way.
        const query = {
          projectId,
          ...(filePath ? { filePath } : {}),
        };
        // An empty list alone is ambiguous: it can mean "never read" or "no page
        // was open to read". Report the pages so the two can be told apart.
        return text({
          summary: markSummary(query),
          pagesOpen: listProjectPages(projectId).length,
          marks: listMarks({ ...query, limit }),
        });
      }

      if (call.params.name === "sumi_pages") {
        const pages = listProjectPages(projectId).map((page) => ({
          clientId: page.clientId,
          userId: page.userId,
          filePath: page.filePath,
          openedAt: page.openedAt,
        }));
        return text({ pages });
      }

      if (call.params.name === "sumi_snapshot") {
        return text(
          await deps.callAgent({ projectId, userId: actor.id, clientId, call: "snapshot", input: {} })
        );
      }

      if (call.params.name === "sumi_query") {
        return text(
          await deps.callAgent({
            projectId,
            userId: actor.id,
            clientId,
            call: "query",
            input: {
              ...(typeof args.text === "string" ? { text: args.text } : {}),
              ...(typeof args.kind === "string" ? { kind: args.kind } : {}),
              ...(typeof args.within === "string" ? { within: args.within } : {}),
            },
          })
        );
      }

      if (call.params.name === "sumi_act") {
        const steps = Array.isArray(args.steps) ? args.steps : [];
        if (steps.length === 0) return failure("steps must not be empty");
        // Pressing buttons changes the document, so a read-only member pressing
        // inside someone else's page is not collaboration — it is a permission
        // the project never granted. Reads stay open to every member.
        if (authorized.projectRole === "viewer") {
          return failure(`forbidden: ${authorized.projectRole} cannot change ${projectId}`);
        }
        const result = await deps.callAgent({
          projectId,
          userId: actor.id,
          clientId,
          call: "act",
          input: { steps },
        });
        // A targeted act answers with the page's own result; an aggregate shape
        // here would mean the relay decided to broadcast, which it must not.
        if (isAggregate(result)) return failure("act_must_target_one_page");
        return text(result);
      }

      return failure(`unknown tool: ${call.params.name}`);
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      // These are the three cases a caller can act on, so they are named rather
      // than returned as a generic failure.
      if (message.includes("no page answered")) return failure(`workspace_not_open: ${message}`);
      if (message.includes("ambiguous_page")) return failure(message);
      if (message.includes("page_not_open")) return failure(message);
      return failure(`sumi_${call.params.name}_failed: ${message}`);
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