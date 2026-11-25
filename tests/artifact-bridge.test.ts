/**
 * The loopback hop from Sumi to the XiaoBa dashboard.
 *
 * These tests pin the part that decides what a caller can tell a person:
 * whether a failure was a closed gate, a dashboard that was not there, or a
 * payload it refused. Those three need different answers, and collapsing them
 * into a thrown error is how "the bot cannot see you" turns into a stack trace.
 *
 * The retry rules matter just as much: a closed gate must not be hammered (the
 * environment is not going to change by retrying) and an unreachable dashboard
 * must be, because a dashboard restarting after a config change looks identical.
 */

import { describe, it, expect, vi } from "vitest";
import { ArtifactBridgeClient, type BridgeFailure } from "../src/artifacts/bridge";

const ARTIFACT = "prj_test";
const SESSION = "ses_test";
const MCP_URL = "http://127.0.0.1:8794/sumi/mcp";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch that answers from a queue, recording what it was asked. */
function stubFetch(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  let index = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function client(impl: typeof fetch, sleep = vi.fn(async () => {})) {
  return {
    client: new ArtifactBridgeClient({
      baseUrl: "http://127.0.0.1:3800",
      fetchImpl: impl,
      sleep,
      timeoutMs: 1000,
    }),
    sleep,
  };
}

describe("attach", () => {
  it("reports a closed gate as disabled, with the dashboard's own code", async () => {
    const { impl } = stubFetch([
      jsonResponse(403, {
        ok: false,
        code: "mcp_attach_requires_auth",
        error: "MCP bridge management requires DASHBOARD_API_KEY (or XIAOBA_ALLOW_LOCAL_MCP_ATTACH=1)",
      }),
    ]);
    const result = await client(impl).client.attach({
      artifactId: ARTIFACT,
      sessionKey: SESSION,
      url: MCP_URL,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe<BridgeFailure>("disabled");
    expect(result.status).toBe(403);
    // The code is what tells an operator which knob to turn; losing it turns a
    // one-line fix into a search.
    expect(result.code).toBe("mcp_attach_requires_auth");
  });

  it("reports a refused connection as unreachable and retries it", async () => {
    const refused = new Error("connect ECONNREFUSED 127.0.0.1:3800");
    const { impl, calls } = stubFetch([refused, refused, jsonResponse(200, {
      ok: true,
      artifactId: ARTIFACT,
      serverId: "srv_1",
      url: MCP_URL,
      attachedManagers: 1,
      sessionBound: true,
    })]);

    const { client: bridge } = client(impl);
    const result = await bridge.ensureAttached(
      { artifactId: ARTIFACT, sessionKey: SESSION, url: MCP_URL },
      { attempts: 3, delayMs: 0 }
    );

    expect(result.ok).toBe(true);
    // A dashboard restarting after a config change looks exactly like this, so
    // the second attempt is what makes the feature usable without a human.
    expect(calls).toHaveLength(3);
    if (!result.ok) return;
    expect(result.value.sessionBound).toBe(true);
    expect(result.value.serverId).toBe("srv_1");
  });

  it("does not retry a closed gate", async () => {
    const { impl, calls } = stubFetch([
      jsonResponse(403, { ok: false, code: "mcp_attach_requires_auth", error: "nope" }),
    ]);
    const { client: bridge, sleep } = client(impl);

    const result = await bridge.ensureAttached(
      { artifactId: ARTIFACT, sessionKey: SESSION, url: MCP_URL },
      { attempts: 5, delayMs: 10 }
    );

    expect(result.ok).toBe(false);
    // The gate stays shut until someone edits the environment. Retrying fills
    // the log with one fact repeated and still fails.
    expect(calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("sends the url and sessionKey the dashboard binds on", async () => {
    const { impl, calls } = stubFetch([
      jsonResponse(200, {
        ok: true,
        artifactId: ARTIFACT,
        serverId: "srv_1",
        url: MCP_URL,
        attachedManagers: 1,
        sessionBound: true,
      }),
    ]);
    await client(impl).client.attach({ artifactId: ARTIFACT, sessionKey: SESSION, url: MCP_URL });

    expect(calls[0].url).toBe(
      `http://127.0.0.1:3800/api/artifacts/${ARTIFACT}/mcp/attach`
    );
    expect(calls[0].body).toEqual({ url: MCP_URL, sessionKey: SESSION });
  });

  it("sends a Bearer token only when one is configured", async () => {
    const { impl, calls } = stubFetch([
      jsonResponse(200, { ok: true, artifactId: ARTIFACT, serverId: "s", url: MCP_URL }),
    ]);
    const bridge = new ArtifactBridgeClient({
      baseUrl: "http://127.0.0.1:3800",
      apiKey: "dash_key",
      fetchImpl: impl,
      sleep: async () => {},
    });
    await bridge.attach({ artifactId: ARTIFACT, sessionKey: SESSION, url: MCP_URL });

    expect(calls[0].headers.authorization).toBe("Bearer dash_key");
  });
});

describe("events", () => {
  it("forwards each interaction as the dashboard's envelope", async () => {
    const { impl, calls } = stubFetch([
      jsonResponse(202, {
        ok: true,
        results: [
          { eventId: "e1", accepted: true },
          { eventId: "e2", accepted: true, deduplicated: true },
        ],
      }),
    ]);

    const result = await client(impl).client.emit({
      artifactId: ARTIFACT,
      sessionKey: SESSION,
      interactions: [
        {
          kind: "a2ui_action",
          componentId: "c1",
          actionName: "toggle",
          params: { watched: true },
          clientEventId: "evt_1",
        },
        {
          kind: "a2ui_state_change",
          componentId: "c1",
          state: { watched: true },
          previousState: { watched: false },
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A deduplicated event was still accepted; counting it as dropped would make
    // a working replay look like a loss.
    expect(result.value.accepted).toBe(2);
    expect(result.value.deduplicated).toBe(1);

    const body = calls[0].body as { events: Array<Record<string, unknown>> };
    expect(body.events).toHaveLength(2);
    expect(body.events[0]).toMatchObject({
      kind: "a2ui_action",
      artifactId: ARTIFACT,
      sessionKey: SESSION,
      componentId: "c1",
      actionName: "toggle",
      params: { watched: true },
      clientEventId: "evt_1",
    });
    // Fields that belong to another kind must not ride along: the dashboard
    // validates per kind and would reject the batch.
    expect(body.events[0]).not.toHaveProperty("state");
    expect(body.events[1]).toMatchObject({
      kind: "a2ui_state_change",
      state: { watched: true },
      previousState: { watched: false },
    });
    expect(body.events[1]).not.toHaveProperty("actionName");
  });

  it("does not call the dashboard when there is nothing to send", async () => {
    const { impl, calls } = stubFetch([jsonResponse(202, { ok: true, results: [] })]);
    const result = await client(impl).client.emit({
      artifactId: ARTIFACT,
      sessionKey: SESSION,
      interactions: [],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ accepted: 0, deduplicated: 0 });
    }
    expect(calls).toHaveLength(0);
  });

  it("reports the dashboard's refusal on the events path too", async () => {
    const { impl } = stubFetch([
      jsonResponse(403, {
        ok: false,
        code: "artifact_events_requires_auth",
        error: "Artifact event intake requires DASHBOARD_API_KEY",
      }),
    ]);
    const result = await client(impl).client.emit({
      artifactId: ARTIFACT,
      sessionKey: SESSION,
      interactions: [{ kind: "a2ui_action", componentId: "c1", actionName: "press" }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("disabled");
    expect(result.code).toBe("artifact_events_requires_auth");
  });
});

describe("detach", () => {
  it("asks for the session unbind only when told to", async () => {
    const { impl, calls } = stubFetch([
      jsonResponse(200, { ok: true, artifactId: ARTIFACT, serverId: "s", existed: true, sessionUnbound: false }),
      jsonResponse(200, { ok: true, artifactId: ARTIFACT, serverId: "s", existed: true, sessionUnbound: true }),
    ]);
    const bridge = client(impl).client;

    await bridge.detach(ARTIFACT);
    await bridge.detach(ARTIFACT, { unbindSession: true });

    expect(calls[0].body).toEqual({});
    expect(calls[1].body).toEqual({ unbindSession: true });
  });
});