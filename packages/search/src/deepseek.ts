import type { SearchMatch, SearchOutcome, SearchProvider } from "./provider.ts";

const API_BASE = "https://api.deepseek.com/v1/tools";

// 官方错误表的重试指引：408/429/5xx 等后重试；402 充值；其它 4xx 不改请求勿重试
export function retryHint(status: number): string {
  if (status === 402) return "账号余额不足：充值后再试";
  if (status === 408 || status === 429 || status >= 500) return "临时性失败：稍后重试";
  if (status >= 400) return "请求不合法：修改请求后再试（原样重试无益）";
  if (status === 0) return "网络不可达：检查连接后重试";
  return "";
}

// ADR-0048：永不 throw、key 只进 Authorization 头、产出文本过 redact（deepseek.ts 旧实现的三条纪律）
export function redact(text: string, apiKey: string): string {
  return apiKey ? text.split(apiKey).join("[REDACTED]") : text;
}

async function postJson(
  path: string,
  body: unknown,
  apiKey: string,
): Promise<SearchOutcome<unknown>> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: `network: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const text = await response.text();
  if (!response.ok) {
    const base = redact(text.slice(0, 300), apiKey);
    const hint = retryHint(response.status);
    return { ok: false, status: response.status, error: hint ? `${base}（${hint}）` : base };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return {
      ok: false,
      status: response.status,
      error: `bad json: ${redact(text.slice(0, 200), apiKey)}`,
    };
  }
}

function asMatches(payload: unknown): SearchMatch[] {
  const list =
    (payload as { results?: unknown[] })?.results ?? (payload as { data?: unknown[] })?.data ?? [];
  if (!Array.isArray(list)) return [];
  return list
    .map((item): SearchMatch => {
      const r = item as Record<string, unknown>;
      return {
        title: String(r.title ?? ""),
        url: String(r.url ?? r.link ?? ""),
        snippet: r.snippet !== undefined ? String(r.snippet) : undefined,
        summary: r.summary !== undefined ? String(r.summary) : undefined,
        rank:
          typeof r.rank === "number" ? r.rank : typeof r.rerank === "number" ? r.rerank : undefined,
        date: r.date !== undefined ? String(r.date) : undefined,
      };
    })
    .filter((m) => m.url.length > 0);
}

export function createDeepSeekProvider(apiKey: string): SearchProvider {
  return {
    id: "deepseek",
    async search(query, options) {
      const outcome = await postJson("/search", { query, count: options?.count ?? 10 }, apiKey);
      if (!outcome.ok) return outcome;
      return { ok: true, value: asMatches(outcome.value) };
    },
    async open(url) {
      const outcome = await postJson("/fetch", { url }, apiKey);
      if (!outcome.ok) return outcome;
      const payload = outcome.value as { content?: unknown; text?: unknown; markdown?: unknown };
      const text = String(payload.content ?? payload.text ?? payload.markdown ?? "");
      return { ok: true, value: redact(text, apiKey) };
    },
  };
}
