/**
 * /api/tap —— TAP ghost-text 补全的服务端路径。
 *
 * 覆盖：
 *   - 未配置 OPENAI_API_KEY 时静默 skip（不鉴权、不报错）
 *   - prompt 构造：指令 + <CURSOR> 拼接 + 上下文截断
 *   - requestTapSuggestion：SKIP 响应、action 判定、限长、失败降级
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { POST } from "../app/api/tap/route";
import { buildTapMessages, requestTapSuggestion } from "../src/tap";

const ORIGINAL_ENV = { ...process.env };

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/tap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function chatResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("POST /api/tap — no API key", () => {
  it("returns action=skip without auth when OPENAI_API_KEY is unset", async () => {
    const res = await POST(
      makeRequest({ projectId: "p1", fileId: "a.md", prefix: "hello" })
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ suggestion: "", action: "skip" });
  });

  it("returns skip even for malformed bodies (no key → short-circuit)", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.action).toBe("skip");
  });
});

describe("buildTapMessages", () => {
  it("includes the continuation instruction and <CURSOR> marker", () => {
    const messages = buildTapMessages({
      prefix: "# Title\n\nSome text",
      suffix: "\n\nNext para",
    });
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain(
      "Continue this markdown naturally"
    );
    expect(messages[0].content).toContain("SKIP");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toBe(
      "# Title\n\nSome text<CURSOR>\n\nNext para"
    );
  });

  it("truncates oversized prefix/suffix", () => {
    const messages = buildTapMessages({
      prefix: "x".repeat(5000),
      suffix: "y".repeat(5000),
    });
    const user = messages[1].content;
    const [pre, post] = user.split("<CURSOR>");
    expect(pre.length).toBe(2000);
    expect(post.length).toBe(1000);
  });

  it("handles missing prefix/suffix", () => {
    const messages = buildTapMessages({});
    expect(messages[1].content).toBe("<CURSOR>");
  });
});

describe("requestTapSuggestion", () => {
  it("skips without calling fetch when no API key", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await requestTapSuggestion({ prefix: "hi" });
    expect(result).toEqual({ suggestion: "", action: "skip" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns skip when the model answers SKIP", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(chatResponse("SKIP"))
    );
    const result = await requestTapSuggestion({ prefix: "x".repeat(100) });
    expect(result.action).toBe("skip");
    expect(result.suggestion).toBe("");
  });

  it("maps word-tail completions to complete_word", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(chatResponse("mentation"))
    );
    const result = await requestTapSuggestion({
      prefix: "writing docu", // tail word "docu"? no — tail is "docu" vs suggestion
    });
    // tail "docu" is not a prefix of "mentation" → insert
    expect(result.action).toBe("insert");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(chatResponse("documentation is key"))
    );
    const wordResult = await requestTapSuggestion({ prefix: "writing doc" });
    expect(wordResult.action).toBe("complete_word");
    expect(wordResult.suggestion).toBe("documentation is key");
  });

  it("takes the first line and caps at 60 chars", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        chatResponse(`${"a".repeat(80)}\nsecond line`)
      )
    );
    const result = await requestTapSuggestion({ prefix: "start " });
    expect(result.suggestion).toBe("a".repeat(60));
    expect(result.action).toBe("insert");
  });

  it("sends the expected model parameters", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const fetchSpy = vi.fn().mockResolvedValue(chatResponse(" more"));
    vi.stubGlobal("fetch", fetchSpy);
    await requestTapSuggestion({ prefix: "hello", suffix: "" });
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const payload = JSON.parse(init.body as string);
    expect(payload.temperature).toBe(0.3);
    expect(payload.max_tokens).toBe(40);
    expect(payload.stop).toEqual(["\n\n", "```"]);
    expect(payload.messages[1].content).toContain("<CURSOR>");
  });

  it("degrades to skip on network failure", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("boom"))
    );
    const result = await requestTapSuggestion({ prefix: "x" });
    expect(result).toEqual({ suggestion: "", action: "skip" });
  });
});
