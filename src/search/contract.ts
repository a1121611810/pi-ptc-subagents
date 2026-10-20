/**
 * The vocabulary of the DeepSeek search module: the names, the payload shape, and the
 * model-facing error text.
 *
 * **This module imports nothing.** That is deliberate, and it is the only shape that keeps the
 * wiring acyclic: `runtime/bindings.ts` needs the binding NAME, `tools/binding-contract.ts`
 * needs the contract NOTE, and `tools/web-ds-search.ts` needs the payload type and the text.
 * `tools/common.ts` imports `runtime/bindings.ts` as a value, so a `runtime/bindings.ts` that
 * imported anything from `tools/` would close a cycle — the one that already cost
 * `tools/ptc-task.ts` seven integration tests (ADR-0024's note on `binding-contract.ts`).
 * A module that imports nothing can be imported by all three.
 *
 * ## The three names, and why there are three
 *
 * | what            | name              |
 * | --------------- | ----------------- |
 * | pi tool         | `web_ds_search`   |
 * | PTC binding     | `web.ds.search`   |
 * | config key      | `webDsSearch`     |
 *
 * All three carry `ds` on purpose. The retrieval source is FIXED (no pluggability), so "this is
 * DeepSeek's search" is a permanent fact rather than an implementation detail — and a generic
 * name would collide: DSH ships a tool called `web_search`, pi's tool registry is keyed by tool
 * name (`toolRegistry.set(tool.name, tool)`), and two extensions registering one name overwrite
 * each other. ADR-0047 §命名 has the full argument.
 *
 * ## The payload is one shape for both channels
 *
 * The codemode face receives it as `structuredContent`; the PTC binding face receives it as
 * `details`. Same object, two wrappers — so a program that learned the shape on one face reads it
 * the same way on the other, and the error text below is quoted verbatim in both.
 */

/** DeepSeek's provider id in pi — the key we reuse, and the name of the config it hangs off. */
export const DEEPSEEK_PROVIDER_ID = "deepseek";

/** The API root. Both endpoints hang off it; neither is model-specific. */
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

/** Search: find pages by query. */
export const DEEPSEEK_SEARCH_PATH = "/v1/tools/search";

/** Fetch: pull one page as Markdown. */
export const DEEPSEEK_FETCH_PATH = "/v1/tools/fetch";

/** The pi tool name — the codemode face. */
export const WEB_DS_SEARCH_TOOL_NAME = "web_ds_search";

/** The PTC binding name — the program face. */
export const WEB_DS_SEARCH_BINDING_NAME = "web.ds.search";

/** The `ptc.json` key that carries the switch and the quota. */
export const WEB_DS_SEARCH_CONFIG_KEY = "webDsSearch";

/**
 * One search result, in DeepSeek's own ten fields, unchanged.
 *
 * `authority` and `rerank_score` are the only signals a program can threshold on, so they are
 * part of the pass-through rather than something this module decides. `site_name`, `site_icon`
 * and `date` are nullable because the API says so (`date` is `null` when the publication time
 * is unknown), and `content` is empty when `need_content` was false.
 */
/**
 * A TYPE alias and not an interface — on purpose, and for the reason ADR-0024's child-report
 * note gives: `structuredContent` has to satisfy `JsonValue`'s `[key: string]: JsonValue` index
 * signature, and only an object TYPE gets the implicit one an interface never has.
 */
export type DeepSeekSearchResult = {
  /** Relevance score 0–3; ≥ 1.5 counts as a high-quality result. */
  rerank_score: number;
  title: string;
  url: string;
  /** Short summary, 100–200 characters — the API says this one is for UI display. */
  snippet: string;
  /** Long summary, 600–800 characters — the API says this one is for a model to read. */
  summary: string;
  /** Page body; empty unless `need_content` was requested. */
  content: string;
  site_name: string | null;
  site_icon: string | null;
  /** Publication time, RFC 3339 in UTC; `null` when unknown. */
  date: string | null;
  /** Authority tier 0–4 (-1 unknown); ≥ 3 is highly authoritative. */
  authority: number;
};

/** One fetched page. */
export type DeepSeekSearchPage = {
  title: string;
  /** The page as Markdown. Note: DeepSeek escapes punctuation in this field (ADR-0048 / spec D8). */
  content: string;
};

/**
 * What one search-module call produces.
 *
 * **One shape, not a union**, so the schema stays a single object and the two channels cannot
 * disagree about it. The unused half is empty rather than absent: `results` is `[]` for a fetch
 * and `page` is `null` for a search. A program reads `operation` and then the field it expects;
 * it never has to narrow a type to find out which half is live.
 */
export type WebDsSearchPayload = {
  /** Which of the two endpoints this call hit. */
  operation: "search" | "fetch";
  /** The search results; `[]` for a fetch. */
  results: DeepSeekSearchResult[];
  /** The fetched page; `null` for a search. */
  page: DeepSeekSearchPage | null;
};

/**
 * The model-facing text for every failure the search API can produce, keyed by HTTP status.
 *
 * **One table, quoted by every surface.** The pi tool's description, the binding contract's
 * note, and the error a failed call returns all read these strings, so a status code cannot
 * mean one thing to a program and another to a model. The wording is aimed at a program that
 * has to DECIDE something: retry, change the source, recharge, or give up.
 *
 * The official retry contract is the reason the wording is shaped this way — DeepSeek's own
 * rule is "wait and retry on 408, 429 and 5xx; recharge before retrying on 402; do not retry
 * other 4xx without changing the request" — so each line tells the reader what to do next.
 */
export const SEARCH_ERROR_TEXT: Readonly<Record<number, string>> = Object.freeze({
  400: "搜索请求不合法（查询词超长或字段无效）：{message}",
  401: "DeepSeek API key 无效或已失效。请在 pi 的凭据里更新后重试。",
  402: "DeepSeek 账号余额不足，充值后才能继续搜索。",
  403: "该网页被安全策略拒绝抓取。换个来源，或改用搜索结果里的其它链接。",
  404: "这个网址抓不到可用内容（不可用、被站点拦截、内容类型不支持、或没有可提取的正文）。换个来源。",
  408: "读取请求体超时，稍后重试。",
  413: "请求体过大。缩短查询，或减少一次请求带的内容。",
  429: "搜索接口超过 QPS 限制（Search 100 次/秒、Fetch 25 次/秒）。稍等后重试。",
  500: "搜索服务内部错误，稍后重试。",
  504: "搜索服务下游超时，稍后重试。",
});

/**
 * The statuses a caller may retry unchanged, per DeepSeek's own rule: 408, 429 and 5xx.
 *
 * 402 is deliberately NOT here — it needs a balance top-up, not a retry, and its line says so.
 */
export const SEARCH_RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 504]);

/**
 * The 400 line is the only one that interpolates: DeepSeek's error body carries a `message`,
 * and its `param` is ALWAYS `null` (the format is OpenAI-compatible but the field is unused),
 * so `message` is the only place the offending field can be named. `{message}` is the slot.
 */
export const SEARCH_ERROR_MESSAGE_SLOT = "{message}";

/**
 * The request never reached DeepSeek — DNS, TLS, a refused connection, a timeout.
 *
 * **Not one of the HTTP statuses above**, and deliberately worded differently: none of those is
 * the server's answer, so none of them tells the reader whether the request was ever seen. This
 * line says the request did not land, which is the fact a program needs to decide between
 * retrying and giving up.
 */
export const SEARCH_NETWORK_ERROR_TEXT = "无法连接 DeepSeek 搜索服务（网络错误）：{message}";

/**
 * A search that matched nothing is NOT an error — it is HTTP 200 with an empty `results` array.
 *
 * It still needs a line, because a program that gets an empty array has to decide whether to
 * rephrase, drop a filter, or give up, and "empty array" does not say which.
 */
export const SEARCH_NO_RESULTS_TEXT =
  "没有匹配到结果。换个说法，或去掉 site: / lang: / after: 之类的限定再试。";

/**
 * The local per-session quota is spent.
 *
 * **Not an error** — it is this package's own policy, and the right response is to finish the
 * task with what has already been gathered. Claude Code's cap behaves the same way: it returns
 * a notice telling the model to continue with the information it already has and to say so in
 * its answer.
 */
export const SEARCH_QUOTA_EXHAUSTED_TEXT =
  "本会话的搜索配额已用完（{limit} 次）。请基于已经收集到的信息继续作答，并在答案里说明这一限制。";

/**
 * The switch is on but no DeepSeek credential resolved.
 *
 * Quoted in the pi tool's description AND in the binding contract's note, so the model learns
 * the reason **before** it calls, and the call itself returns the same sentence. The capability
 * is registered in this state on purpose: a model that can see that search exists but is
 * unavailable can tell the user what is missing, which a model that cannot see search at all
 * cannot.
 */
export const SEARCH_UNAVAILABLE_NOTICE =
  "本会话未配置 DeepSeek 凭据，调用会失败。请在 pi 的凭据里配置 deepseek 的 API key。";
