import { sanitizeText } from "@pi-ptc/tui";
import type { SearchMatch, SearchProvider } from "./provider.ts";
import { SEARCH_COUNT_RANGE, SEARCH_DEFAULT_COUNT, SEARCH_TEXT_BUDGET_CHARS } from "./provider.ts";
import type { SearchMemory } from "./memory.ts";
import type { SearchQuota } from "./quota.ts";

export type SearchAction =
  | { kind: "search"; query: string; count?: number }
  | { kind: "open"; url: string }
  | { kind: "find"; url: string; pattern: string };

export interface SearchRunContext {
  provider: SearchProvider;
  memory: SearchMemory;
  quota: SearchQuota;
  /** 模型可见文本预算；告知语不占预算（实测结论） */
  textBudgetChars?: number;
}

export type SearchRunResult = { ok: true; text: string } | { ok: false; error: string };

// 官方限速：Fetch 每目标域名 QPS 25——同域名请求按 50ms 间隔串行（简单闸，防批量 open 吃 429）
const DOMAIN_INTERVAL_MS = 50;
const domainTails = new Map<string, Promise<void>>();

function domainGate(url: string): Promise<void> {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // 非法 url 也串行，错误在请求处暴露
  }
  const tail = domainTails.get(host) ?? Promise.resolve();
  const next = tail.then(
    () => new Promise<void>((resolve) => setTimeout(resolve, DOMAIN_INTERVAL_MS)),
  );
  domainTails.set(host, next);
  return next;
}

function describeMatch(match: SearchMatch): string {
  const parts = [
    `- ${match.title || "(no title)"}`,
    `  url: ${match.url}`,
    match.snippet ? `  snippet: ${match.snippet}` : "",
    match.date ? `  date: ${match.date}` : "",
  ].filter(Boolean);
  return parts.join("\n");
}

// 概览渲染：逐条累加，超出预算的按 DeepSeek 排名整条丢弃（第一条永远给）+ 告知丢了哪些（可经 open 补抓）
export function renderSearchOverview(matches: SearchMatch[], budgetChars: number): string {
  const kept: SearchMatch[] = [];
  const dropped: SearchMatch[] = [];
  let used = 0;
  for (const match of matches) {
    const block = describeMatch(match);
    if (kept.length > 0 && used + block.length > budgetChars) {
      dropped.push(match);
    } else {
      kept.push(match);
      used += block.length + 1;
    }
  }
  const lines = kept.map(describeMatch);
  if (dropped.length > 0) {
    lines.push(
      `（预算内放不下的 ${dropped.length} 条按排名整条丢弃：${dropped
        .map((m) => m.url)
        .join("、")}——要哪个用 open 按 url 抓）`,
    );
  }
  return lines.join("\n");
}

export async function runWebSearch(
  action: SearchAction,
  context: SearchRunContext,
): Promise<SearchRunResult> {
  const budget = context.textBudgetChars ?? SEARCH_TEXT_BUDGET_CHARS;

  if (action.kind === "search") {
    const count = Math.min(
      SEARCH_COUNT_RANGE.max,
      Math.max(SEARCH_COUNT_RANGE.min, action.count ?? SEARCH_DEFAULT_COUNT),
    );
    if (!context.quota.tryAcquire()) {
      return { ok: false, error: `搜索配额已用尽（每会话配额，0 = 不限）` };
    }
    const outcome = await context.provider.search(action.query, { count });
    if (!outcome.ok) {
      context.quota.release(false);
      return { ok: false, error: `search 失败（HTTP ${outcome.status}）：${outcome.error}` };
    }
    // 官方计费：HTTP 200 但 results 为空不计费——配额同步不耗
    context.quota.release(outcome.value.length > 0);
    context.memory.remember(action.query, outcome.value);
    if (outcome.value.length === 0) return { ok: true, text: `「${action.query}」没有命中。` };
    return { ok: true, text: sanitizeText(renderSearchOverview(outcome.value, budget)) };
  }

  if (action.kind === "open") {
    const cached = context.memory.lookup(action.url);
    if (cached !== undefined) {
      return { ok: true, text: sanitizeText(`（记忆命中，未发请求）\n${cached.slice(0, budget)}`) };
    }
    if (!context.quota.tryAcquire()) {
      return { ok: false, error: `搜索配额已用尽（每会话配额，0 = 不限）` };
    }
    await domainGate(action.url);
    const outcome = await context.provider.open(action.url);
    if (!outcome.ok) {
      context.quota.release(false);
      return { ok: false, error: `open 失败（HTTP ${outcome.status}）：${outcome.error}` };
    }
    context.memory.storeText(action.url, outcome.value);
    return { ok: true, text: sanitizeText(outcome.value.slice(0, budget)) };
  }

  // find：页内行匹配（页文优先记忆免费 serve）
  let regex: RegExp;
  try {
    regex = new RegExp(action.pattern, "i");
  } catch {
    return { ok: false, error: `非法正则：${action.pattern}` };
  }
  const pageText = await ensurePageText(action.url, context);
  if (!pageText.ok) return pageText;
  const lines = pageText.text
    .split("\n")
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => regex.test(line));
  return {
    ok: true,
    text:
      lines.length > 0
        ? lines
            .slice(0, 50)
            .map(({ line, index }) => `${index + 1}: ${line}`)
            .join("\n")
        : "（页内无匹配行）",
  };
}

/** 页文获取：记忆命中免费；否则占额抓取并回存记忆 */
async function ensurePageText(
  url: string,
  context: SearchRunContext,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const cached = context.memory.lookup(url);
  if (cached !== undefined) return { ok: true, text: cached };
  if (!context.quota.tryAcquire()) {
    return { ok: false, error: `搜索配额已用尽（每会话配额，0 = 不限）` };
  }
  await domainGate(url);
  const outcome = await context.provider.open(url);
  if (!outcome.ok) {
    context.quota.release(false);
    return { ok: false, error: `open 失败（HTTP ${outcome.status}）：${outcome.error}` };
  }
  context.quota.release(outcome.value.length > 0);
  context.memory.storeText(url, outcome.value);
  return { ok: true, text: outcome.value };
}
