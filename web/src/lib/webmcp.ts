/**
 * Publishes this page's ui-sdk tools to the browser's own agent API.
 *
 * Where the MCP bridge makes the page reachable from a server, WebMCP makes it
 * reachable from an agent running in the browser: the page registers its tools
 * with `document.modelContext`, and any client that speaks WebMCP finds them
 * without being told about Sumi. The tool definitions come from
 * `@ui-sdk/core/agent` — this file writes none, only the wiring.
 *
 * Two deliberate choices:
 *
 *   - `registerTool` is called directly rather than through the library's
 *     `registerTools`. Chrome returns nothing from that call, while the helper
 *     calls `.catch()` on the return value: the first tool registers and the
 *     rest never do, behind a TypeError. Calling it here keeps the page from
 *     depending on that, and avoids patching a browser API for the whole app.
 *   - Nothing here replaces the server bridge. It is an additional way in, so a
 *     browser without the API simply registers nothing and behaves as before.
 *
 * Tools run on the live page, through the same call path as every other agent
 * request, so a WebMCP-driven change is marked and logged like any other.
 */

import { agentTools } from "@ui-sdk/core/agent";
import { executeAgentCall, type AgentCallName } from "./agent-bridge";

/** The subset of the WebMCP global this page relies on. */
interface ModelContextLike {
  registerTool: (tool: unknown, options?: unknown) => unknown;
}

export interface WebMcpStatus {
  /** The browser exposes the API, which today means the testing flag is on. */
  available: boolean;
  registered: string[];
  failures: Array<{ name: string; message: string }>;
}

const status: WebMcpStatus = { available: false, registered: [], failures: [] };

export function webMcpStatus(): WebMcpStatus {
  return { ...status, registered: [...status.registered], failures: [...status.failures] };
}

/**
 * Register this page's tools, if the browser has somewhere to put them.
 *
 * Returns a function that withdraws the registration, so a caller that tears the
 * workspace down does not leave tools pointing at components that are gone.
 */
export function installWebMcp(): () => void {
  const context = (globalThis.document as { modelContext?: ModelContextLike } | undefined)
    ?.modelContext;

  if (!context || typeof context.registerTool !== "function") {
    // Expected on any browser without the flag: the page works, with one fewer
    // way in. No error, because it is not a failure.
    status.available = false;
    return () => {};
  }

  status.available = true;
  const controller = new AbortController();

  for (const definition of agentTools) {
    const name = definition.name as AgentCallName;
    const tool = {
      ...definition,
      // What a client needs to know before calling: `act` changes the page and
      // can press anything, including a control that deletes. Labels and text
      // come from the page and may hold what its users wrote.
      annotations: {
        readOnlyHint: name !== "act",
        untrustedContentHint: true,
        consequentialHint: name === "act",
      },
      execute: async (input: unknown) => {
        const { value } = await executeAgentCall(name, input);
        // Chrome serialises what comes back, so the raw value is what a caller
        // should see, not a pre-stringified copy of it.
        return value;
      },
    };

    try {
      // Chrome resolves registration asynchronously but returns nothing, so the
      // result is only ever a thenable by accident: treat both shapes the same.
      void Promise.resolve(context.registerTool(tool, { signal: controller.signal })).catch(
        (error: unknown) => {
          status.failures.push({
            name,
            message: (error as Error)?.message ?? String(error),
          });
        }
      );
      status.registered.push(name);
    } catch (error) {
      status.failures.push({ name, message: (error as Error)?.message ?? String(error) });
    }
  }

  return () => {
    controller.abort();
    status.registered = [];
  };
}
