/**
 * A successful ApiKey resolution is reused for a short while.
 *
 * Why this exists: every request carrying a `cc_` key resolves by calling CatsCo
 * (`GET /api/me`), and any failure there — timeout, reset, one bad gateway — returns
 * null, which the routes report as 403. That made upstream flakiness indistinguishable
 * from a bad key. Observed with the resident responder, which polls twice every 5 s:
 * about one poll in twelve came back 403 with credentials that had just worked.
 *
 * The rule under test: successes are remembered briefly, failures are not.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

process.env.CATSCO_BASE_URL = "https://catsco.example";
delete process.env.CATSCO_SERVICE_TOKEN;
process.env.SUMI_AUTH_CACHE_MS = "30000";

const { introspectToken, resetAuthCacheForTests } = await import("../src/auth/catsco");

const KEY = "cc_0123456789abcdef0123456789abcdef";

/** Minimal /api/me body — enough for the resolver to build an actor. */
const meBody = {
  uid: 574,
  username: "bot-abraxas",
  display_name: "Abraxas",
  account_type: "bot",
};

/** Stub fetch and count upstream calls. `mode` decides the response. */
function stubFetch() {
  const calls: string[] = [];
  const state = { mode: "ok" as "ok" | "500" | "throw" };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(String(url));
      if (state.mode === "throw") throw new Error("upstream reset");
      if (state.mode === "500") return new Response("nope", { status: 500 });
      return Response.json(meBody);
    })
  );

  return { calls, state };
}

let harness: ReturnType<typeof stubFetch>;

beforeEach(() => {
  resetAuthCacheForTests();
  harness = stubFetch();
  vi.useRealTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetAuthCacheForTests();
});

describe("ApiKey resolution cache", () => {
  it("resolves from upstream the first time", async () => {
    const result = await introspectToken(KEY);
    expect(result?.user?.uid).toBe(574);
    expect(harness.calls).toHaveLength(1);
  });

  it("reuses a success instead of asking again", async () => {
    await introspectToken(KEY);
    await introspectToken(KEY);
    await introspectToken(KEY);
    expect(harness.calls).toHaveLength(1);
  });

  it("keeps serving a known-good key when upstream fails", async () => {
    // The defect this fixes: one upstream blip became a 403 for a valid caller.
    await introspectToken(KEY);
    harness.state.mode = "throw";
    const second = await introspectToken(KEY);
    expect(second?.user?.uid).toBe(574);
  });

  it("does not cache a failure", async () => {
    // Caching failures would turn a momentary outage into a permanent-looking
    // authorisation problem, and would delay recovery once upstream returned.
    harness.state.mode = "500";
    expect(await introspectToken(KEY)).toBeNull();

    harness.state.mode = "ok";
    const recovered = await introspectToken(KEY);
    expect(recovered?.user?.uid).toBe(574);
    expect(harness.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("stops trusting the cache once it expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-24T12:00:00Z"));

    await introspectToken(KEY);
    expect(harness.calls).toHaveLength(1);

    // Just inside the window: still served from cache.
    vi.setSystemTime(new Date("2026-10-24T12:00:29Z"));
    await introspectToken(KEY);
    expect(harness.calls).toHaveLength(1);

    // Past it: the key is checked again, so a revocation is not hidden for long.
    vi.setSystemTime(new Date("2026-10-24T12:00:31Z"));
    await introspectToken(KEY);
    expect(harness.calls).toHaveLength(2);
  });

  it("does not confuse two different keys", async () => {
    const other = "cc_fedcba9876543210fedcba9876543210";
    await introspectToken(KEY);
    await introspectToken(other);
    expect(harness.calls).toHaveLength(2);
  });
});
