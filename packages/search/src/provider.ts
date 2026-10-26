// 搜索 provider 抽象——DeepSeek 是第一家，后续接入别的只实现这个接口（用户提供方插件化的接缝）
export interface SearchMatch {
  title: string;
  url: string;
  /** DeepSeek 自算的短摘要（概览用这个：便宜 3–10 倍且不丢事实，上下文预算实测结论） */
  snippet?: string;
  /** 长摘录；按需经 open 取，不进概览 */
  summary?: string;
  rank?: number;
  date?: string;
}

export type SearchOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string };

export interface SearchProvider {
  readonly id: string;
  search(query: string, options?: { count?: number }): Promise<SearchOutcome<SearchMatch[]>>;
  /** 整页抓取（open 动作 / 记忆未命中时） */
  open(url: string): Promise<SearchOutcome<string>>;
}

export const SEARCH_COUNT_RANGE = { min: 1, max: 50 } as const;
export const SEARCH_DEFAULT_COUNT = 10;
// 上下文预算实测结论（search-context-budget VERDICT）：概览用 snippet、超预算 top-k 整条丢弃 + 告知
export const SEARCH_TEXT_BUDGET_CHARS = 12_000;
export const SEARCH_MEMORY_MAX_ENTRIES = 5;
export const SEARCH_MEMORY_MAX_CHARS = 400_000;
