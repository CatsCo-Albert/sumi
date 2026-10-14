/**
 * SSE replay — Last-Event-ID resume on /api/ui/events.
 *
 * 覆盖：
 *   - frames carry `id:` lines so clients can resume
 *   - Last-Event-ID present → replay only events after that id
 *   - absent / unknown id → fall back to the last-20 tail
 */

import { describe, it, expect, beforeEach } from "vitest";
import { promises as fs } from "fs";
import * as jose from "jose";
import { getDb, resetDbForTests } from "../src/db";
import { upsertSubject } from "../src/auth/identity";
import {
  publishUiPatch,
  resetUiEventBusForTests,
  type UiEvent,
} from "../src/ui-bus/event-bus";

const TEST_DIR = `/tmp/sumi-sse-test-${process.pid}`;
process.env.SUMI_DATA_DIR = TEST_DIR;
process.env.OC_JWT_SECRET = "test-secret-sse";

// catsco.ts captures OC_JWT_SECRET at module-eval time — import the route
// lazily so the secret above is visible.
const { GET } = await import("../app/api/ui/events/route");

beforeEach(async () => {
  resetDbForTests();
  resetUiEventBusForTests();
  await fs.rm(TEST_DIR, { recursive: true, force: true });
  const db = await getDb();
  upsertSubject(db, { subjectId: "u1", kind: "user", displayName: "Alice" });
});

async function jwt(): Promise<string> {
  return new jose.SignJWT({ userId: 1, username: "alice", token_type: "user" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("catscompany")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(process.env.OC_JWT_SECRET));
}

function req(token: string, lastEventId?: string): Request {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "text/event-stream",
  };
  if (lastEventId) headers["Last-Event-ID"] = lastEventId;
  return new Request("http://localhost/api/ui/events", { headers });
}

interface Frame {
  id?: string;
  event: string;
  data: string;
}

/** Read until `n` frames arrive or the stream times out. */
async function readFrames(res: Response, n: number): Promise<Frame[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let buf = "";
  const deadline = Date.now() + 3000;
  while (frames.length < n && Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value?: undefined; done: true }>((r) =>
        setTimeout(() => r({ done: true }), 400)
      ),
    ]);
    if (done) break;
    if (value) buf += decoder.decode(value);
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const f: Frame = { event: "", data: "" };
      for (const line of raw.split("\n")) {
        if (line.startsWith("id:")) f.id = line.slice(3).trim();
        else if (line.startsWith("event:")) f.event = line.slice(6).trim();
        else if (line.startsWith("data:")) f.data += line.slice(5).trim();
      }
      frames.push(f);
      if (frames.length >= n) break;
    }
  }
  await reader.cancel().catch(() => undefined);
  return frames;
}

async function publish3(userId: string): Promise<UiEvent[]> {
  const out: UiEvent[] = [];
  for (let i = 0; i < 3; i++) {
    out.push(
      await publishUiPatch({
        userId,
        projectId: "p1",
        patch: { type: "show_ai_chat" },
        source: "system",
      })
    );
    // 保证 created_at 严格递增，避免同毫秒 id 游标歧义
    await new Promise((r) => setTimeout(r, 2));
  }
  return out;
}

describe("GET /api/ui/events — Last-Event-ID", () => {
  it("emits id: lines on ui_patch frames", async () => {
    const events = await publish3("u1");
    const res = await GET(req(await jwt()));
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    const frames = await readFrames(res, 4); // ready + 3 patches
    const patches = frames.filter((f) => f.event === "ui_patch");
    expect(patches).toHaveLength(3);
    expect(patches.map((f) => f.id)).toEqual(events.map((e) => e.id));
  });

  it("replays only events after the given Last-Event-ID", async () => {
    const events = await publish3("u1");
    const res = await GET(req(await jwt(), events[0].id));

    // ready + the 2 events after events[0]
    const frames = await readFrames(res, 3);
    const patches = frames.filter((f) => f.event === "ui_patch");
    expect(patches.map((f) => f.id)).toEqual([events[1].id, events[2].id]);
  });

  it("falls back to the last-20 tail when the id is unknown or absent", async () => {
    const events = await publish3("u1");

    // Unknown id → tail replay, same as no header.
    const res = await GET(req(await jwt(), "ui_does_not_exist"));
    const frames = await readFrames(res, 4);
    const patches = frames.filter((f) => f.event === "ui_patch");
    expect(patches.map((f) => f.id)).toEqual(events.map((e) => e.id));
  });
});
