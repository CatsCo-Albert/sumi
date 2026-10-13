/**
 * Gateway viewer tests.
 *
 * The gateway call is stubbed by swapping global.fetch, so these exercise the
 * decision table — authenticated, guest, error, unusable payload — without a
 * network round trip.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  resolveGatewayViewer,
  gatewayViewerEnabled,
  artifactAppId,
} from "../src/auth/gateway-viewer";

const APP_ID = "sumi-app";
const realFetch = globalThis.fetch;

function stubFetch(response: unknown, ok = true, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok,
      status,
      json: async () => response,
    } as unknown as Response;
  }) as typeof fetch;
  return calls;
}

beforeEach(() => {
  process.env.CATSCO_ARTIFACT_APP_ID = APP_ID;
  process.env.CATSCO_GATEWAY_URL = "https://gateway.example";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.CATSCO_ARTIFACT_APP_ID;
  delete process.env.CATSCO_GATEWAY_URL;
});

describe("configuration", () => {
  it("is disabled without an app id", () => {
    delete process.env.CATSCO_ARTIFACT_APP_ID;
    expect(artifactAppId()).toBe("");
    expect(gatewayViewerEnabled()).toBe(false);
  });

  it("is enabled with an app id", () => {
    expect(gatewayViewerEnabled()).toBe(true);
  });
});

describe("resolveGatewayViewer", () => {
  it("does not call the gateway when disabled", async () => {
    delete process.env.CATSCO_ARTIFACT_APP_ID;
    const calls = stubFetch({});
    expect(await resolveGatewayViewer({ cookie: "x=1" })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns the viewer for an authenticated answer", async () => {
    stubFetch({
      authenticated: true,
      viewer: { id: "ap_abc", uid: 275, username: "pi-dal", kind: "user" },
    });
    const viewer = await resolveGatewayViewer({ cookie: "v=1" });
    expect(viewer).toEqual({
      id: "ap_abc",
      uid: 275,
      username: "pi-dal",
      kind: "user",
    });
  });

  it("forwards the cookie and authorization headers", async () => {
    const calls = stubFetch({ authenticated: false, viewer: null });
    await resolveGatewayViewer({
      cookie: "catsco_viewer=abc",
      authorization: "Bearer t",
    });
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.cookie).toBe("catsco_viewer=abc");
    expect(headers.authorization).toBe("Bearer t");
    expect(calls[0].url).toContain(`/ _gateway/me`.replace(" ", ""));
    expect(calls[0].url).toContain(`app=${APP_ID}`);
  });

  it("joins repeated headers into one cookie string", async () => {
    const calls = stubFetch({ authenticated: false, viewer: null });
    await resolveGatewayViewer({ cookie: ["a=1", "b=2"] });
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.cookie).toBe("a=1; b=2");
  });

  it("treats a guest answer as anonymous, not as an error", async () => {
    stubFetch({ authenticated: false, viewer: null });
    expect(await resolveGatewayViewer({})).toBeNull();
  });

  it("treats an authenticated answer without a viewer as anonymous", async () => {
    stubFetch({ authenticated: true, viewer: null });
    expect(await resolveGatewayViewer({})).toBeNull();
  });

  it("rejects a non-numeric or non-positive uid", async () => {
    stubFetch({ authenticated: true, viewer: { id: "x", uid: "abc" } });
    expect(await resolveGatewayViewer({})).toBeNull();

    stubFetch({ authenticated: true, viewer: { id: "x", uid: 0 } });
    expect(await resolveGatewayViewer({})).toBeNull();
  });

  it("degrades to a guest on an HTTP error", async () => {
    stubFetch({}, false, 500);
    expect(await resolveGatewayViewer({})).toBeNull();
  });

  it("degrades to a guest when the gateway is unreachable", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    expect(await resolveGatewayViewer({})).toBeNull();
  });
});
