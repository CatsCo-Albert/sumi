/**
 * TAP ghost-text 补全的服务端核心 —— prompt 构造 + OpenAI 兼容调用。
 * 从 app/api/tap/route.ts 拆出以便测试（route 文件不能有额外导出）。
 */

const TAP_MODEL = process.env.TAP_MODEL || "gpt-4o-mini";
const OPENAI_BASE_URL =
  process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

export interface TapRequestBody {
  projectId?: string;
  fileId?: string;
  prefix?: string;
  suffix?: string;
}

export interface TapSuggestion {
  suggestion: string;
  action: "insert" | "complete_word" | "fix" | "skip";
}

const TAP_INSTRUCTION =
  "Continue this markdown naturally. Return ONLY the continuation text " +
  "(≤ 60 chars), or the literal string SKIP if you can't suggest anything " +
  "useful. No explanation, no quotes.";

/** 拼 chat.completions 的 messages —— 上下文截断在服务端做一次兜底。 */
export function buildTapMessages(body: TapRequestBody) {
  const prefix = (body.prefix || "").slice(-2000);
  const suffix = (body.suffix || "").slice(0, 1000);
  return [
    { role: "system" as const, content: TAP_INSTRUCTION },
    {
      role: "user" as const,
      content: `${prefix}<CURSOR>${suffix}`,
    },
  ];
}

/** 调 OpenAI 兼容端点；任何失败都降级为 skip（静默，不打断输入）。 */
export async function requestTapSuggestion(
  body: TapRequestBody
): Promise<TapSuggestion> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { suggestion: "", action: "skip" };

  try {
    const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: TAP_MODEL,
        messages: buildTapMessages(body),
        temperature: 0.3,
        max_tokens: 40,
        stop: ["\n\n", "```"],
      }),
    });
    if (!res.ok) return { suggestion: "", action: "skip" };

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = (data.choices?.[0]?.message?.content || "").trim();
    if (!raw || raw === "SKIP" || raw.startsWith("SKIP")) {
      return { suggestion: "", action: "skip" };
    }

    // 取第一行、限长 60 —— 模型偶尔不守规矩
    const suggestion = raw.split("\n")[0].slice(0, 60);
    if (!suggestion) return { suggestion: "", action: "skip" };

    // 补全当前词的残部 vs 全新插入：光标前的最后一个词是 suggestion 的
    // 前缀时视作 complete_word，否则 insert。
    const tail = (body.prefix || "").match(/[\w-]*$/)?.[0] || "";
    const action =
      tail && suggestion.toLowerCase().startsWith(tail.toLowerCase())
        ? ("complete_word" as const)
        : ("insert" as const);

    return { suggestion, action };
  } catch {
    return { suggestion: "", action: "skip" };
  }
}
