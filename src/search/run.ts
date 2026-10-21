/**
 * The one implementation the search tool calls.
 *
 * ## Three actions, one implementation
 *
 * The tool is **model-facing** (ADR-0049): the child's own model calls it, and the text that
 * comes back is what enters the model's context. That last fact decides the whole design, and
 * the measurement behind it is in
 * `docs/prototypes/search-context-budget-measurements.md`: one `count=10` search carried
 * **6,414–31,020 characters** of `summary` (DeepSeek's own digest of each page, up to 4,757
 * characters each), which is 16–19 searches to fill a 128k context.
 *
 * So the tool has three actions:
 *
 * | action   | arguments               | what the model gets                                                         |
 * | -------- | ----------------------- | -------------------------------------------------------------------------- |
 * | `search` | `query` (+ count, …)     | an **overview**: title, url, three thresholds and DeepSeek's own `snippet`   |
 * | `open`   | `open: "<url>"`          | that result's **full `summary`** (and its body, when the search asked for it) |
 * | `find`   | `find: {url, pattern}`   | the places inside that page's text that match                               |
 *
 * **`open` and `find` are served out of the last search when they can be.** The API already
 * computed that text and already billed for it, so handing it over later costs **nothing** —
 * no request, no quota slot, no latency. That is the local equivalent of what Anthropic's
 * web-search server tool does with its citations: the model gets an overview, and the depth
 * arrives only where it is actually used
 * (`docs/research/agent-search-result-delivery-patterns-20261020.md`).
 *
 * ## The quota is reserved, not counted
 *
 * A call that FAILS must not consume the quota — DeepSeek does not bill a failed request, and
 * charging a program for a timeout it could not avoid would make the cap a tax on bad luck.
 * But a call that is still in flight must hold a slot, or ten concurrent calls would all pass
 * the limit check before any of them had counted. So a call **reserves** a slot before it
 * starts and either commits it (success) or releases it (failure), and the limit is therefore
 * a hard ceiling on concurrent usage while the counter only ever grows on success.
 *
 * **A call served from the remembered results takes no slot at all** — nothing left the
 * machine, so there is nothing to charge for.
 */
import type { DeepSeekClient } from "./client.ts";
import type { SearchQuota } from "./quota.ts";
import {
  SEARCH_COUNT_MAX,
  SEARCH_COUNT_MIN,
  SEARCH_COUNT_OUT_OF_RANGE_TEXT,
  SEARCH_FIND_MORE_TEXT,
  SEARCH_FIND_NO_MATCH_TEXT,
  SEARCH_NO_RESULTS_TEXT,
  SEARCH_OVERVIEW_MAX_CHARS,
  SEARCH_OVERVIEW_TRIMMED_TEXT,
  SEARCH_PAGE_DIGEST_TEXT,
  SEARCH_PAGE_EMPTY_TEXT,
  SEARCH_PAGE_FETCHED_TEXT,
  SEARCH_PAGE_FROM_RESULTS_TEXT,
  SEARCH_QUERY_EMPTY_TEXT,
  SEARCH_QUERY_MAX_LENGTH,
  SEARCH_QUERY_TOO_LONG_TEXT,
  SEARCH_QUOTA_EXHAUSTED_TEXT,
  SEARCH_UNAVAILABLE_NOTICE,
  type DeepSeekSearchResult,
  type SearchMatch,
  type WebDsSearchPayload,
} from "./contract.ts";

/** What the module accepts: a search, an open of one page, or a find inside one page. */
export type WebDsSearchParams =
  | {
      query: string;
      count?: number;
      ori_question?: string;
      localization?: string;
      need_content?: boolean;
    }
  | { open: string }
  | { find: { url: string; pattern: string } };

/** The result of one call: the payload, or the model-facing sentence that says why there is none. */
export type WebDsSearchOutcome =
  | { ok: true; payload: WebDsSearchPayload }
  | { ok: false; text: string };

/** Everything a call needs that is not the request itself. */
export interface WebDsSearchDeps {
  /**
   * The HTTP client — **absent when no credential resolved.**
   *
   * That absence is the ONE source of truth for "the capability is registered but unusable":
   * the tool's description, the binding contract and the failure a call returns all read it
   * from here, so they cannot disagree about whether search is available. A call made without
   * a client is refused with the unavailable notice and **consumes no quota** — no request
   * left the machine, so there is nothing to charge for.
   */
  client?: DeepSeekClient;
  /** The session's quota. Shared by both faces, because the quota is per SESSION. */
  quota: SearchQuota;
  /**
   * The quota's ceiling, quoted in the exhausted message so the model can say how many it had.
   * `0` means unlimited, and the message is not used in that case.
   */
  maxCallsPerSession: number;
  /**
   * The session's memory of the last search's results.
   *
   * **This is what makes `open` and `find` free.** The API already computed every result's
   * `summary` (and its body, when `need_content` was asked for) and already billed for it; the
   * memory is where that text waits until the model asks for it. Absent means there is no
   * memory, and `open` falls back to fetching the page.
   */
  memory?: SearchResultMemory;
}

/**
 * How many searches the memory spans.
 *
 * **Five, and the number is measured, not guessed.** The live end-to-end run searched three
 * times before it opened a page — and it opened a page it had found in the FIRST search. A memory
 * that only held the latest search would have missed it, and the open would have fallen back to
 * a fetch: the model would have paid for a request to get a page the API had already billed for
 * and handed over. A model refines its query before it commits to a page, and it may open any
 * result it saw along the way.
 */
export const MEMORY_MAX_SEARCHES = 5;

/**
 * How much text the memory may hold.
 *
 * **A cap, because the memory grows with the searches and the sessions do not end.** The oldest
 * results are dropped first: a page the model opened five searches ago is less likely than one
 * from the last search.
 */
export const MEMORY_MAX_CHARS = 400_000;

/**
 * The session's memory of the last searches' results.
 *
 * **It exists so that `open` and `find` cost nothing.** The API computed every result's
 * `summary` and billed for it; the memory is where that text waits until the model asks for it.
 */
export interface SearchResultMemory {
  /** Remember a search's results, keeping the ones from the searches before it. */
  remember(results: readonly DeepSeekSearchResult[]): void;
  /** The remembered result for this url, or `undefined`. */
  find(url: string): DeepSeekSearchResult | undefined;
}

/**
 * A memory over the last few searches' results.
 *
 * **Merged by url, newest wins** — the same page can come back in two searches, and the newer
 * copy is the fresher one.
 */
export function createSearchResultMemory(): SearchResultMemory {
  const searches: DeepSeekSearchResult[][] = [];
  return {
    remember(results) {
      searches.push([...results]);
      while (searches.length > MEMORY_MAX_SEARCHES) searches.shift();
      const merged = new Map<string, DeepSeekSearchResult>();
      for (const search of searches) {
        for (const result of search) merged.set(result.url, result);
      }
      // The character cap drops the OLDEST results first, which is the order `merged` lost, so
      // they are re-inserted oldest-first and taken off the front.
      const ordered = [...merged.values()].reverse();
      let total = 0;
      const kept: DeepSeekSearchResult[] = [];
      for (const result of ordered) {
        const size = result.summary.length + result.content.length;
        if (total + size > MEMORY_MAX_CHARS && kept.length > 0) break;
        total += size;
        kept.push(result);
      }
      const final = new Map<string, DeepSeekSearchResult>();
      for (const result of kept) final.set(result.url, result);
      searches.length = 0;
      searches.push([...final.values()]);
    },
    find(url) {
      for (const search of searches) {
        for (const result of search) {
          if (result.url === url) return result;
        }
      }
      return findLoose(searches, url);
    },
  };
}

/**
 * The loose match: the same page, written a little differently.
 *
 * **A model does not copy urls byte for byte.** It drops a trailing slash, it keeps a `#1`
 * fragment, it carries a tracking query along. The live run opened
 * `…/guides/search/` while the search had returned `…/guides/search/` — and in another search
 * `…/guides/search/#1` for the same page.
 *
 * **The rule is tight on purpose**: the scheme and the host must match, the path must match
 * after dropping a trailing "/", the fragment never counts, and a query only matches when the
 * remembered url has none (tracking noise on a clean url). Two urls that differ in their query
 * are different pages, and a page that differs only by its query must not be answered with the
 * wrong content.
 */
function findLoose(
  searches: readonly (readonly DeepSeekSearchResult[])[],
  url: string,
): DeepSeekSearchResult | undefined {
  const wanted = parsePageUrl(url);
  if (wanted === undefined) return undefined;
  for (const search of searches) {
    for (const result of search) {
      const candidate = parsePageUrl(result.url);
      if (candidate === undefined) continue;
      if (
        candidate.scheme === wanted.scheme &&
        candidate.host === wanted.host &&
        candidate.path === wanted.path &&
        (candidate.query === wanted.query || candidate.query === "")
      ) {
        return result;
      }
    }
  }
  return undefined;
}

/** A url broken into the parts the loose match compares. */
function parsePageUrl(
  url: string,
): { scheme: string; host: string; path: string; query: string } | undefined {
  try {
    const parsed = new URL(url);
    return {
      scheme: parsed.protocol.toLowerCase(),
      host: parsed.host.toLowerCase(),
      path: parsed.pathname.replace(/\/+$/, ""),
      query: parsed.search.replace(/^\?/, ""),
    };
  } catch {
    return undefined;
  }
}

/**
 * Run one search-module call: reserve a quota slot, hit the API, and settle the slot honestly.
 *
 * The failure channel carries a SENTENCE, never a status code: the program that reads it has to
 * decide between retrying, changing the source, recharging and giving up, and only a sentence
 * says which. The sentences are the shared constants in `contract.ts`, so the same status code
 * cannot mean one thing on the codemode face and another on the binding face.
 */
export async function runWebDsSearch(
  deps: WebDsSearchDeps,
  params: WebDsSearchParams,
): Promise<WebDsSearchOutcome> {
  if (deps.client === undefined) {
    // No credential: the call never leaves the machine, so it takes no quota slot either.
    return { ok: false, text: SEARCH_UNAVAILABLE_NOTICE };
  }
  if ("query" in params) return await runSearch(deps, params);
  if ("open" in params) return await runOpen(deps, params.open);
  return await runFind(deps, params.find);
}

/**
 * The `search` action: ask the API, and remember what it answered.
 *
 * **The results are remembered because they are the depth the model will ask for next.** The
 * API computed every result's `summary` and billed for it; holding onto that text is what lets
 * `open` hand it over later without another request.
 */
async function runSearch(
  deps: WebDsSearchDeps,
  params: {
    query: string;
    count?: number;
    ori_question?: string;
    localization?: string;
    need_content?: boolean;
  },
): Promise<WebDsSearchOutcome> {
  const client = deps.client;
  if (client === undefined) return { ok: false, text: SEARCH_UNAVAILABLE_NOTICE };
  const reservation = deps.quota.reserve();
  if (reservation === undefined) {
    return {
      ok: false,
      text: SEARCH_QUOTA_EXHAUSTED_TEXT.replace("{limit}", String(deps.maxCallsPerSession)),
    };
  }
  let result: Awaited<ReturnType<DeepSeekClient["search"]>>;
  try {
    result = await client.search({
      query: params.query,
      ...(params.count === undefined ? {} : { count: params.count }),
      ...(params.ori_question === undefined ? {} : { ori_question: params.ori_question }),
      ...(params.localization === undefined ? {} : { localization: params.localization }),
      ...(params.need_content === undefined ? {} : { need_content: params.need_content }),
    });
  } catch (error) {
    // A client that REJECTS is not the production client (it never throws), but the deps
    // interface is public and a caller may supply one that does. The reserved slot goes back
    // here — without it a single throw would silently eat the session's quota for good.
    reservation.release();
    throw error;
  }
  if (!result.ok) {
    // A failed call is not a used call: the slot goes back, so a transient 429 does not eat the
    // program's budget.
    reservation.release();
    return { ok: false, text: result.text };
  }
  reservation.commit();
  deps.memory?.remember(result.payload.results);
  return { ok: true, payload: result.payload };
}

/**
 * The `open` action: the depth of one page.
 *
 * **Served from the remembered results when it can be** — no request, no quota slot, no
 * latency, and the text is the API's own clean digest of that page. Only a page that was never
 * in a search we remember is fetched, and that fetch is a real request: it takes a quota slot
 * and it costs.
 */
async function runOpen(deps: WebDsSearchDeps, url: string): Promise<WebDsSearchOutcome> {
  const remembered = deps.memory?.find(url);
  if (remembered !== undefined) {
    return {
      ok: true,
      payload: {
        operation: "fetch",
        results: [],
        page: {
          title: remembered.title,
          content: remembered.content !== "" ? remembered.content : remembered.summary,
          source: remembered.content !== "" ? "body" : "summary",
        },
      },
    };
  }
  const fetched = await fetchPage(deps, url);
  if (!fetched.ok) return fetched;
  return {
    ok: true,
    payload: {
      operation: "fetch",
      results: [],
      page: { title: fetched.title, content: fetched.content },
    },
  };
}

/**
 * The `find` action: the places inside one page that match.
 *
 * **It is a filter over the text, not a search of the web** — the page has to be one we know
 * (a remembered result) or one we fetch. The point is that the model can locate a passage
 * without pulling the whole page into its context, which is the same move Anthropic's dynamic
 * filtering makes with the search results themselves.
 */
async function runFind(
  deps: WebDsSearchDeps,
  target: { url: string; pattern: string },
): Promise<WebDsSearchOutcome> {
  const remembered = deps.memory?.find(target.url);
  let text: string;
  if (remembered !== undefined) {
    text = remembered.content !== "" ? remembered.content : remembered.summary;
  } else {
    const fetched = await fetchPage(deps, target.url);
    if (!fetched.ok) return fetched;
    text = fetched.content;
  }
  const found = findInText(text, target.pattern, target.url);
  return {
    ok: true,
    payload: {
      operation: "find",
      results: [],
      page: null,
      matches: found.matches,
      matchTotal: found.total,
      pattern: target.pattern,
    },
  };
}

/** The matches inside a text, at most {@link MAX_FIND_MATCHES} of them. */
const MAX_FIND_MATCHES = 20;

/**
 * The lines of a text that contain a pattern.
 *
 * **Case-insensitive, and the pattern is a plain substring** — a regular expression would let a
 * pattern from the model blow up on a pathological input, and the pages are Markdown, not code.
 * The line number is the one a `read` with an offset can use, so a model that wants the
 * neighbourhood can ask for exactly it.
 */
export function findInText(
  text: string,
  pattern: string,
  url: string,
): { matches: SearchMatch[]; total: number } {
  const needle = pattern.toLowerCase();
  if (needle === "") return { matches: [], total: 0 };
  const found: SearchMatch[] = [];
  let total = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? "").toLowerCase().includes(needle)) {
      total += 1;
      if (found.length < MAX_FIND_MATCHES) {
        found.push({ url, line: i + 1, text: lines[i] ?? "" });
      }
    }
  }
  return { matches: found, total };
}

/**
 * A real request to the Fetch endpoint, with the quota accounted the same way a search is.
 *
 * **It is the only path that costs.** Everything else this module hands the model comes out of
 * a search the API already billed for.
 */
async function fetchPage(
  deps: WebDsSearchDeps,
  url: string,
): Promise<{ ok: true; title: string; content: string } | { ok: false; text: string }> {
  const client = deps.client;
  if (client === undefined) return { ok: false, text: SEARCH_UNAVAILABLE_NOTICE };
  const reservation = deps.quota.reserve();
  if (reservation === undefined) {
    return {
      ok: false,
      text: SEARCH_QUOTA_EXHAUSTED_TEXT.replace("{limit}", String(deps.maxCallsPerSession)),
    };
  }
  let result: Awaited<ReturnType<DeepSeekClient["fetchPage"]>>;
  try {
    result = await client.fetchPage({ url });
  } catch (error) {
    reservation.release();
    throw error;
  }
  if (!result.ok) {
    reservation.release();
    return { ok: false, text: result.text };
  }
  reservation.commit();
  return {
    ok: true,
    title: result.payload.page?.title ?? "",
    content: result.payload.page?.content ?? "",
  };
}

/**
 * The COMPACT description of a payload — what a tool ROW shows a human.
 *
 * **A different rendering for a different reader.** {@link describeSearchPayload} is what the
 * model reads, and it carries the data; a TUI row is one line of a transcript, so it carries a
 * count. Rendering the model's text into the row would put ten summaries into one line of a
 * terminal.
 *
 * The row is built from the payload, not from the model-facing text, so the two can never drift:
 * the row says how much came back, the model gets what came back.
 */
export function describePayloadCompactly(payload: WebDsSearchPayload): string {
  if (payload.operation === "find") {
    const count = payload.matches?.length ?? 0;
    return count === 1 ? "1 match" : `${count} matches`;
  }
  if (payload.operation === "fetch") {
    const title = payload.page?.title ?? "";
    const length = payload.page?.content?.length ?? 0;
    return title === ""
      ? `fetched ${length} characters`
      : `fetched "${title}" (${length} characters)`;
  }
  const count = payload.results.length;
  return count === 1 ? "1 result" : `${count} results`;
}

/**
 * The model-facing text for a call that SUCCEEDED.
 *
 * ## The search text is an OVERVIEW, and the depth is one action away
 *
 * **The overview carries one title, one url, three thresholds and DeepSeek's own `snippet` per
 * result** — measured at 1,505–4,452 characters for a `count=10` search, against 8,078–33,692
 * for the whole `summary` of every result
 * (`docs/prototypes/search-context-budget-measurements.md` §9.1).
 *
 * **The `summary` is not in the overview on purpose.** It is DeepSeek's own digest of a whole
 * page, and it reaches 4,757 characters; the `snippet` is the same engine's short,
 * query-related digest (105–414 characters) and it is what actually tells the model whether a
 * page is worth opening. The `summary` is still one `open` away, and it costs nothing to hand
 * over then.
 *
 * **Every harness that ships this shape hands over an overview and a way back to the depth**
 * — Anthropic's web-search server tool (title + url, content injected at the citation),
 * OpenAI's `web_search` (`open_page` / `find_in_page`), MCP's `resource_link`. See
 * `docs/research/agent-search-result-delivery-patterns-20261020.md`.
 */
export function describeSearchPayload(payload: WebDsSearchPayload): string {
  if (payload.operation === "find") return describeFind(payload);
  if (payload.operation === "fetch") return describePage(payload);
  return describeOverview(payload);
}

/**
 * The search overview.
 *
 * **One block per result, four lines each**, and the whole thing is bounded: past
 * {@link SEARCH_OVERVIEW_MAX_CHARS} the lowest-ranked results are dropped **whole** and the
 * notice says how many. Dropping whole is the point — a cut result is one with a fact missing
 * and no sign of it, while a dropped result is missing in a way the model can see and answer.
 */
function describeOverview(payload: WebDsSearchPayload): string {
  if (payload.results.length === 0) return SEARCH_NO_RESULTS_TEXT;
  const blocks = payload.results.map(overviewBlock);
  let kept = blocks.length;
  let chars = blocks.reduce((sum, block) => sum + block.length, 0);
  while (chars > SEARCH_OVERVIEW_MAX_CHARS && kept > 1) {
    kept -= 1;
    chars = blocks.slice(0, kept).reduce((sum, block) => sum + block.length, 0);
  }
  const dropped = blocks.length - kept;
  const text = blocks.slice(0, kept).join("\n");
  return dropped === 0
    ? text
    : `${text}\n\n${SEARCH_OVERVIEW_TRIMMED_TEXT.replace("{count}", String(dropped))}`;
}

/** One result's four lines. */
function overviewBlock(result: DeepSeekSearchResult, index: number): string {
  const lines = [
    `[${index + 1}] ${result.title}`,
    `    ${result.url}`,
    `    authority ${result.authority} · rerank ${result.rerank_score.toFixed(2)}` +
      (result.date === null ? "" : ` · ${result.date}`),
  ];
  if (result.snippet !== "") lines.push(`    ${result.snippet}`);
  return lines.join("\n");
}

/**
 * The depth of one page: its text, and where that text came from.
 *
 * **The source is said out loud.** A page served out of the remembered results cost nothing;
 * one that had to be fetched cost a request and a quota slot. The model can act on the
 * difference, and it must not believe the cheap path was taken when it was not.
 */
function describePage(payload: WebDsSearchPayload): string {
  const page = payload.page;
  if (page === null) return SEARCH_PAGE_EMPTY_TEXT;
  // Two facts, and they are orthogonal: WHERE the text came from, and WHETHER it is the whole
  // page. A page served out of a remembered result is free, and — when the search did not ask
  // for bodies — it is also DeepSeek's digest of that page rather than the page itself.
  const notices: string[] = [
    page.source === undefined ? SEARCH_PAGE_FETCHED_TEXT : SEARCH_PAGE_FROM_RESULTS_TEXT,
  ];
  if (page.source === "summary") notices.push(SEARCH_PAGE_DIGEST_TEXT);
  const heading = page.title === "" ? "" : `# ${page.title}\n\n`;
  if (page.content === "") return heading + SEARCH_PAGE_EMPTY_TEXT;
  return `${notices.join("\n")}\n\n${heading}${page.content}`;
}

/**
 * The places a `find` matched.
 *
 * **The line numbers are the point.** A match says "line 12 of that page", so a model that
 * wants the neighbourhood can ask for exactly it instead of pulling the whole page in.
 */
function describeFind(payload: WebDsSearchPayload): string {
  const matches = payload.matches ?? [];
  if (matches.length === 0) {
    return SEARCH_FIND_NO_MATCH_TEXT.replace("{pattern}", payload.pattern ?? "");
  }
  const shown = matches.slice(0, MAX_FIND_MATCHES);
  const lines = shown.map((match) => `   ${match.line}: ${match.text}`);
  const more = (payload.matchTotal ?? matches.length) - shown.length;
  const text = lines.join("\n");
  return more <= 0 ? text : `${text}\n${SEARCH_FIND_MORE_TEXT.replace("{count}", String(more))}`;
}

/**
 * The arguments, discriminated.
 *
 * **The schema cannot say "exactly one of", so the check is here** — and here rather than in
 * either face, because a call with both `query` and `url` (or with neither) is the same mistake
 * whichever face the program reached it through, and the refusal should read the same either way.
 *
 * The refusals are SENTENCES, not schema errors: they name the two alternatives and say which
 * one was given.
 */
export function toSearchParams(params: unknown): WebDsSearchParams {
  const record = (params ?? {}) as {
    query?: unknown;
    count?: unknown;
    ori_question?: unknown;
    localization?: unknown;
    need_content?: unknown;
    open?: unknown;
    find?: unknown;
  };
  const hasQuery = typeof record.query === "string" && record.query.length > 0;
  const hasOpen = typeof record.open === "string" && record.open.length > 0;
  const hasFind =
    record.find !== undefined &&
    record.find !== null &&
    typeof record.find === "object" &&
    !Array.isArray(record.find);
  const given = [
    ...(hasQuery ? ["query"] : []),
    ...(hasOpen ? ["open"] : []),
    ...(hasFind ? ["find"] : []),
  ];
  if (given.length > 1) {
    throw new Error(
      "搜索一次只做一件事：给 `query` 是搜索，给 `open` 是打开一页，给 `find` 是在一页里找。",
    );
  }
  if (given.length === 0) {
    throw new Error("搜索需要 `query`（搜）、`open`（打开一页）或 `find`（在一页里找）其中之一。");
  }
  if (hasOpen) {
    return { open: record.open as string };
  }
  if (hasFind) {
    const target = record.find as { url?: unknown; pattern?: unknown };
    if (typeof target.url !== "string" || target.url.length === 0) {
      throw new Error("`find` 需要一个 `url`：要在哪一页里找。");
    }
    if (typeof target.pattern !== "string" || target.pattern.length === 0) {
      throw new Error("`find` 需要一个 `pattern`：要找什么。");
    }
    return { find: { url: target.url, pattern: target.pattern } };
  }
  const query = record.query as string;
  assertQueryAccepted(query);
  const count = readCount(record.count);
  return {
    query,
    ...(count === undefined ? {} : { count }),
    ...(typeof record.ori_question === "string" ? { ori_question: record.ori_question } : {}),
    ...(typeof record.localization === "string" ? { localization: record.localization } : {}),
    ...(typeof record.need_content === "boolean" ? { need_content: record.need_content } : {}),
  };
}

/**
 * The local check on `query`, refused before the request leaves the machine.
 *
 * **Two rules, both from the official guide** (<https://api-docs.deepseek.com/zh-cn/guides/search>):
 * `query` is "1～128 个 Unicode 字符，不能全为空白".
 *
 * **The length is counted in code points, not UTF-16 units.** `String.length` counts a surrogate
 * pair as two, so an emoji-heavy query would be measured at twice its real character count and
 * refused early. The API counts Unicode characters, and so does this.
 */
function assertQueryAccepted(query: string): void {
  if (query.trim().length === 0) {
    throw new Error(SEARCH_QUERY_EMPTY_TEXT);
  }
  // `Array.from` rather than `String.length`: the API counts Unicode CHARACTERS (code points),
  // and `String.length` counts UTF-16 units, so an emoji-heavy query would be measured at twice
  // its real length and refused early.
  const length = Array.from(query).length;
  if (length > SEARCH_QUERY_MAX_LENGTH) {
    throw new Error(SEARCH_QUERY_TOO_LONG_TEXT.replace("{length}", String(length)));
  }
}

/**
 * The local check on `count`: an integer in 1..50, or absent.
 *
 * **`undefined` means "not given"** — the API's own default (10) applies, and the module does not
 * substitute one of its own. A value that is present but wrong is refused: `0`, `51`, `3.5` and
 * `"10"` are all outside the API's "1～50" and all of them would come back as a 400 whose
 * message names an internal field rather than the range.
 */
function readCount(count: unknown): number | undefined {
  if (count === undefined) return undefined;
  if (
    typeof count !== "number" ||
    !Number.isInteger(count) ||
    count < SEARCH_COUNT_MIN ||
    count > SEARCH_COUNT_MAX
  ) {
    throw new Error(SEARCH_COUNT_OUT_OF_RANGE_TEXT.replace("{value}", describeValue(count)));
  }
  return count;
}

/**
 * How a refused value is shown to the reader.
 *
 * **A number or a string is shown as itself; anything else is named by its type.** The default
 * `String()` of an object is `"[object Object]"`, which tells the reader nothing about what they
 * passed — and the point of the sentence is to let them recognise their own value.
 */
function describeValue(value: unknown): string {
  if (typeof value === "number" || typeof value === "string") return String(value);
  if (value === null) return "null";
  return Array.isArray(value) ? "an array" : `a ${typeof value}`;
}

/**
 * What the search tool needs in order to run: the client, the session's quota, and the ceiling.
 *
 * **The client is ABSENT when no credential resolved**, and that is not an error state — the tool
 * is still registered, its description says it is unavailable, and a call returns a sentence
 * naming what is missing (ADR-0048's second state).
 */
