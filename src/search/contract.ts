/**
 * The vocabulary of the DeepSeek search module: the names, the payload shape, and the
 * model-facing error text.
 *
 * **This module imports nothing.** That is deliberate: it is the one shape that keeps the wiring
 * acyclic, and `tools/web-ds-search.ts` (the tool) and `mode/ptc-mode.ts` (the switch) both need
 * the names and the text from it. A module that imports nothing can be imported by anyone.
 *
 * ## The two names, and why there are two
 *
 * | what            | name              |
 * | --------------- | ----------------- |
 * | pi tool         | `web_ds_search`   |
 * | config key      | `webDsSearch`     |
 *
 * Both carry `ds` on purpose. The retrieval source is FIXED (no pluggability), so "this is
 * DeepSeek's search" is a permanent fact rather than an implementation detail — and a generic
 * name would collide: DSH ships a tool called `web_search`, pi's tool registry is keyed by tool
 * name (`toolRegistry.set(tool.name, tool)`), and two extensions registering one name overwrite
 * each other. ADR-0047 §命名 has the full argument.
 *
 * ## There is ONE face, and it is the model's
 *
 * The tool is registered **only inside a dispatched child** (`ptcDepth > 0`), and it is
 * **model-facing** there (`exposure: "direct"`): the child's own model calls it directly, one
 * call, no program in between. It is NOT a PTC binding — a binding would be reachable from any
 * program's binding table, which would put the capability back in the parent's hands.
 *
 * The payload is therefore delivered the way pi delivers every tool result: as `details` and as
 * `structuredContent`, one object, two fields.
 */

/** DeepSeek's provider id in pi — the key we reuse, and the name of the config it hangs off. */
export const DEEPSEEK_PROVIDER_ID = "deepseek";

/** The API root. Both endpoints hang off it; neither is model-specific. */
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

/** Search: find pages by query. */
export const DEEPSEEK_SEARCH_PATH = "/v1/tools/search";

/** Fetch: pull one page as Markdown. */
export const DEEPSEEK_FETCH_PATH = "/v1/tools/fetch";

/** The pi tool name — the one face this module has. */
export const WEB_DS_SEARCH_TOOL_NAME = "web_ds_search";

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
  /**
   * Where the text came from — **absent means the API's own fetch.**
   *
   * It is absent on the fetch path because there the text IS the page. It is present when a
   * page is served out of a remembered search result, where the text is either the page body
   * (the search was made with `need_content`) or the API's own long digest of that page.
   */
  source?: "body" | "summary";
};

/** One place a `find` matched inside a page. */
export type SearchMatch = {
  /** The page the match is in. */
  url: string;
  /** The 1-based line number inside that page's text. */
  line: number;
  /** The matching line, as it appears in the page. */
  text: string;
};

/**
 * What one search-module call produces.
 *
 * **One shape, not a union**, so the schema stays a single object and the two channels cannot
 * disagree about it. The unused half is empty rather than absent: `results` is `[]` for a page
 * and `page` is `null` for a search. A program reads `operation` and then the field it expects;
 * it never has to narrow a type to find out which half is live.
 */
export type WebDsSearchPayload = {
  /** Which of the three actions this call was. */
  operation: "search" | "fetch" | "find";
  /** The search results; `[]` for a page or a find. */
  results: DeepSeekSearchResult[];
  /** The fetched page; `null` for a search or a find. */
  page: DeepSeekSearchPage | null;
  /** Where a `find` matched; absent for the other two actions. */
  matches?: SearchMatch[];
  /** How many places matched in total — more than `matches` holds when the answer was capped. */
  matchTotal?: number;
  /** The pattern a `find` looked for; absent for the other two actions. */
  pattern?: string;
};

/**
 * The bounds the DeepSeek Search API puts on its arguments, quoted from the official guide.
 *
 * **They live next to the sentences that quote them**, because a number and the sentence that
 * names it are one fact: a bound that moved and a sentence that did not would put two different
 * limits in the model's hands. The source is
 * <https://api-docs.deepseek.com/zh-cn/guides/search> (2026-10-20 fetch): `query` is
 * "1～128 个 Unicode 字符，不能全为空白"; `count` is "1～50", default 10.
 */
export const SEARCH_QUERY_MAX_LENGTH = 128;

/**
 * The sentence that tells the PARENT that a child can search the web.
 *
 * **The parent has no web tool of its own** — the search module lives in the child (ADR-0049)
 * — so the only route to the web is a task whose child searches. But the parent's model reads
 * neither the child's tool list nor the search tool's description, so without this sentence the
 * parent has no reason to believe a child can search; the live end-to-end run measured it
 * writing a task that said "use bash/curl", and the child duly curled instead of using
 * `web_ds_search`.
 *
 * **It is ONE sentence in ONE place, and that place is the route registry**
 * (`src/routes/registry.ts`) — the module that holds every piece of model-facing prose this
 * package writes. This module re-exports it for the readers that already import it from here,
 * so the claim has one home and no copy. The model-facing surfaces that carry it are the two PTC
 * tool descriptions, the `<ptc>` section, and the mode briefing: those are the places the
 * parent's model reads when it decides what to write, and four copies of one fact are four
 * things that can drift — the `<ptc>` section and the briefing already had their own wording,
 * and the section's had been rewritten while the briefing's had not.
 *
 * **The vocabulary is TASK, not "dispatch"** (ADR-0052). The thing the model creates is a task;
 * "dispatch" is what the task side does with a task afterwards, and it is not the model's word.
 *
 * **It is stated as what this package PROVIDES, not as what the model can reach by any means:**
 * a session that still has `bash` can always curl, so a sentence claiming the model has no way
 * to the web would be false there. "This package gives you no web tool of your own" is the claim
 * that survives that.
 */
export { PTC_CHILD_SEARCH_NOTE } from "../routes/registry.ts";
export const SEARCH_COUNT_MIN = 1;
export const SEARCH_COUNT_MAX = 50;

/**
 * The model-facing text for every failure the search API can produce, keyed by HTTP status.
 *
 * **One table, quoted by every surface.** The pi tool's description, the error a failed call
 * throws, and the quota notice all read these strings, so a status code cannot mean one thing
 * to a program and another to a model. The wording is aimed at a reader that has to DECIDE
 * something: retry, change the source, recharge, or give up.
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
 * Quoted in the pi tool's description AND in the error a call throws, so the model learns the
 * reason **before** it calls, and the call itself returns the same sentence. The capability is
 * registered in this state on purpose: a model that can see that search exists but is
 * unavailable can tell the user what is missing, which a model that cannot see search at all
 * cannot.
 */
export const SEARCH_UNAVAILABLE_NOTICE =
  "本会话未配置 DeepSeek 凭据，调用会失败。请在 pi 的凭据里配置 deepseek 的 API key。";

/**
 * The local refusals: arguments this module refuses BEFORE the request leaves the machine.
 *
 * **Why they exist rather than being left to the API.** DeepSeek's own limits (`query` 1–128
 * Unicode characters, `count` 1–50) are enforced upstream with a 400 — but a 400 costs a round
 * trip and, more importantly, the upstream's message is an API message, not an instruction. A
 * model that passed `count: 500` deserves to be told what the range is and what to do instead,
 * in one sentence, without the request going out at all.
 *
 * **They are refusals, not errors.** The call never happens, so it never spends money and never
 * consumes a quota slot (`search/run.ts` reserves the slot only after the arguments are
 * accepted).
 */
export const SEARCH_QUERY_EMPTY_TEXT =
  "query 不能是空白：给一个真的搜索词，或者改用 `url` 抓取一个已知页面。";

export const SEARCH_QUERY_TOO_LONG_TEXT =
  "query 最多 128 个字符（收到 {length} 个）。缩短搜索词，或者把问题拆成几次搜索。";

export const SEARCH_COUNT_OUT_OF_RANGE_TEXT =
  "count 必须在 1 到 50 之间（收到 {value}）。一次多取不额外计费——要更多结果就调大 count，别多发几次请求。";

/**
 * The overview's character ceiling: past it, the lowest-ranked results are dropped **whole**.
 *
 * **Why there is a ceiling at all when the overview is small by construction.** The overview
 * carries one title, one url, three thresholds and one `snippet` per result — measured at
 * 1,505–4,452 characters for a `count=10` search
 * (`docs/prototypes/search-context-budget-measurements.md` §9.1). But `count` goes up to 50, and
 * 50 results × 414 characters is 20,700 — over the line. The ceiling is the backstop for that
 * case, not the everyday path.
 *
 * **Dropping whole results, never cutting one.** A cut summary is a summary with a fact missing
 * and no sign of it; a dropped result is missing in a way the model can see and act on (the
 * notice says how many, and `open` can still fetch any of them). The measurement that decided
 * this is in `docs/research/agent-search-result-delivery-patterns-20261020.md`: every harness
 * that ships this shape hands the model an overview and a way back to the depth.
 */
export const SEARCH_OVERVIEW_MAX_CHARS = 16000;

/**
 * The notice that says the overview dropped some results.
 *
 * **It names the count and the way back**, because a notice that only says "some results were
 * dropped" leaves the model with two bad options: answer without them, or re-search blindly.
 */
export const SEARCH_OVERVIEW_TRIMMED_TEXT =
  "（还有 {count} 条结果没有列出来：概览有长度上限，排位靠后的那些被省掉了。用 `open` 加上它们的 url 可以单独打开。）";

/**
 * The notice that a page was fetched because it was not among the last search's results.
 *
 * **It is a note, not an error**: the page IS there, it just cost a request (and a quota slot).
 * Saying so is what keeps the model from assuming the cached path was used.
 */
export const SEARCH_PAGE_FETCHED_TEXT =
  "（这一页不在上一次搜索的结果里，这一次是现抓的——它消耗了一次搜索配额。）";

/**
 * The notice that the text is DeepSeek's DIGEST of a page, not the page.
 *
 * **The live end-to-end run found this the hard way.** The child opened a page, got the API's
 * digest, and concluded "the body was truncated at 8192 characters" — the number was the URL's
 * length limit, which the tool's own description used to put next to the word "characters". The
 * child then reached for `curl` to get the rest, and it had read the situation exactly backwards:
 * the digest is short BY CONSTRUCTION (it is the page's summary), not cut short.
 *
 * So the text says what it is, and how to get the page itself.
 */
export const SEARCH_PAGE_DIGEST_TEXT =
  "（这是 DeepSeek 对这一页的摘要，不是整页正文——摘要本来就比页面短。想要整页，在搜索时带上 `need_content: true`。）";

/** The notice that a page WAS among the last search's results (served from memory, free). */
export const SEARCH_PAGE_FROM_RESULTS_TEXT =
  "（这一页来自上一次搜索的结果，没有再发请求，也没有消耗配额。）";

/** The notice that a page has neither a body nor a summary to show. */
export const SEARCH_PAGE_EMPTY_TEXT = "这一页没有可提取的正文，也没有摘要。";

/** The notice that a find matched nothing. */
export const SEARCH_FIND_NO_MATCH_TEXT = "这一页里没有找到「{pattern}」。";

/** The notice that a find matched more places than the answer shows. */
export const SEARCH_FIND_MORE_TEXT = "（还有 {count} 处没有列出。）";
