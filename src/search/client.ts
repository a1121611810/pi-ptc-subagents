/**
 * The HTTP client for DeepSeek's two raw retrieval endpoints — `POST /v1/tools/search` and
 * `POST /v1/tools/fetch`.
 *
 * ## Why this is a plain HTTP client and not a pi tool
 *
 * DeepSeek's Search and Fetch are two ordinary JSON endpoints with a bearer token, not a model
 * capability and not a tool-calling protocol: the request body has no `model` field, and the
 * response has no citation ids, no streaming and no `finish_reason`
 * (`docs/research/deepseek-search-api-20261020.md` §1.1, §3.2). So the whole client is two POSTs,
 * and everything worth saying about it is what it REFUSES to do.
 *
 * ## The three refusals
 *
 * - **It never throws at its caller.** A search that fails is something a program has to read and
 *   react to — retry, recharge, use another source — not an exception that unwinds the PTC
 *   program that made the call. Every failure therefore comes back as
 *   `{ ok: false, status, text }`, with `text` already carrying the sentence from
 *   `SEARCH_ERROR_TEXT`: one table, quoted by the tool description, the binding contract note and
 *   this error, so a status code cannot mean one thing to a program and another to a model.
 * - **The API key never survives into a result.** The key is used in exactly one place — the
 *   `Authorization` header — and every string this module produces is passed through `redact`
 *   before it leaves. This is not paranoia about our own code: tool results go into the
 *   conversation and from there into pi's session transcript
 *   (`docs/research/pi-credential-surface-20261020.md` §5.5), and an upstream error body that
 *   echoes the key back would otherwise be persisted in plain text. The redaction is applied to
 *   the upstream message too, not only to our own text.
 * - **It does not reshape the results.** `results` is DeepSeek's own array, field for field: no
 *   renaming, no reordering, and no defaulting a missing `site_name` to `null`. The ten result
 *   fields are the contract between this module and whatever thresholds on them
 *   (`authority >= 3`, `rerank_score >= 1.5`), and a normalizer here would quietly change what
 *   those thresholds mean.
 *
 * ## What was rejected
 *
 * - **A retry loop inside the client.** DeepSeek's own rule is "wait and retry on 408, 429 and
 *   5xx" (`docs/research/deepseek-search-api-20261020.md` §4.3), but the retry belongs to the
 *   caller: the PTC program knows whether it can afford to wait, and a client that retries
 *   silently turns a 429 into a multi-second stall the program never asked for.
 * - **Reading the body with `response.json()`.** A body that is not JSON has to fall back to the
 *   raw text, and `json()` consumes the body — a second `text()` on a consumed body throws. So the
 *   body is read once as text and parsed here.
 */
import {
  DEEPSEEK_BASE_URL,
  DEEPSEEK_FETCH_PATH,
  DEEPSEEK_SEARCH_PATH,
  SEARCH_ERROR_MESSAGE_SLOT,
  SEARCH_ERROR_TEXT,
  SEARCH_NETWORK_ERROR_TEXT,
  SEARCH_RETRYABLE_STATUSES,
  type DeepSeekSearchResult,
  type WebDsSearchPayload,
} from "./contract.ts";

/** How much of an upstream message is quoted back into the model-facing text. */
const MAX_QUOTED_MESSAGE_CHARS = 300;

/** The placeholder that replaces the key in any text this module returns. */
const REDACTED = "[redacted]";

export interface DeepSeekClientOptions {
  /** The DeepSeek API key. It goes into one request header and nowhere else. */
  apiKey: string;
  /** The API root. Defaults to `DEEPSEEK_BASE_URL`. */
  baseUrl?: string;
  /** The HTTP implementation. Defaults to `globalThis.fetch`; the tests inject a mock. */
  fetchImpl?: typeof fetch;
}

/** The Search endpoint's request body. Only the fields the caller sets are sent. */
export interface DeepSeekSearchParams {
  /** 1–128 Unicode characters. */
  query: string;
  /** 1–50; the API defaults to 10 when the field is absent. */
  count?: number;
  /** The original question behind the search, 1–128 characters. */
  ori_question?: string;
  /** An IP address used to prefer local results. */
  localization?: string;
  /** Whether the page body comes back in `content`. */
  need_content?: boolean;
}

/** The Fetch endpoint's request body. */
export interface DeepSeekFetchParams {
  /** ≤ 8192 characters, an http(s) URL with a host and no credentials in it. */
  url: string;
}

/**
 * What one call produced.
 *
 * **A discriminated union, not a nullable payload.** A caller has to branch on `ok` before it can
 * read anything, and the failure branch carries the HTTP status *and* the sentence — the status
 * for a program, the sentence for a model.
 */
export type DeepSeekCallResult =
  | { ok: true; payload: WebDsSearchPayload }
  | { ok: false; status: number | "network"; text: string };

export interface DeepSeekClient {
  /** Run a search. */
  search(params: DeepSeekSearchParams): Promise<DeepSeekCallResult>;
  /** Fetch one page as Markdown. */
  fetchPage(params: DeepSeekFetchParams): Promise<DeepSeekCallResult>;
}

/**
 * Build a client.
 *
 * **Invalid options throw here, and only here.** An empty API key or a non-function `fetchImpl`
 * is a wiring bug in the caller, and it has to surface at construction rather than as a silent
 * 401 on the first call. Everything after this point is total: the two methods never reject.
 */
export function createDeepSeekClient(options: DeepSeekClientOptions): DeepSeekClient {
  const apiKey = options.apiKey;
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new TypeError("createDeepSeekClient: apiKey must be a non-empty string");
  }
  const rawBaseUrl = options.baseUrl ?? DEEPSEEK_BASE_URL;
  if (typeof rawBaseUrl !== "string" || rawBaseUrl.trim().length === 0) {
    throw new TypeError("createDeepSeekClient: baseUrl must be a non-empty string");
  }
  if (options.fetchImpl !== undefined && typeof options.fetchImpl !== "function") {
    throw new TypeError("createDeepSeekClient: fetchImpl must be a function");
  }
  // A trailing slash on the root would produce "//v1/tools/search", which is a different URL.
  const baseUrl = rawBaseUrl.replace(/\/+$/, "");
  const doFetch: typeof fetch =
    options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));

  async function search(params: DeepSeekSearchParams): Promise<DeepSeekCallResult> {
    // Only the fields the caller actually set are sent. DeepSeek ignores unknown body fields
    // (docs/research/deepseek-search-api-20261020.md §5.1), so sending a defaulted `count: 10`
    // would be indistinguishable from the caller having asked for 10 — and `need_content: false`
    // is a real instruction, not an absence, so the test is `!== undefined` and not truthiness.
    const body: Record<string, unknown> = { query: params.query };
    if (params.count !== undefined) body.count = params.count;
    if (params.ori_question !== undefined) body.ori_question = params.ori_question;
    if (params.localization !== undefined) body.localization = params.localization;
    if (params.need_content !== undefined) body.need_content = params.need_content;
    return call(DEEPSEEK_SEARCH_PATH, body, "search");
  }

  async function fetchPage(params: DeepSeekFetchParams): Promise<DeepSeekCallResult> {
    return call(DEEPSEEK_FETCH_PATH, { url: params.url }, "fetch");
  }

  async function call(
    path: string,
    body: Record<string, unknown>,
    operation: "search" | "fetch",
  ): Promise<DeepSeekCallResult> {
    try {
      let response: Response;
      try {
        response = await doFetch(`${baseUrl}${path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
      } catch (error) {
        // The request never reached DeepSeek — DNS, TLS, a refused connection, a timeout. That is
        // not one of the HTTP statuses in the contract's table, so it gets its own sentence.
        return {
          ok: false,
          status: "network",
          text: redact(interpolate(SEARCH_NETWORK_ERROR_TEXT, messageOf(error)), apiKey),
        };
      }

      const status = response.status;
      // Read the body once, as text: `json()` would consume it, and a second read of a consumed
      // body throws. A body that cannot be read at all is treated as an empty one — the status
      // is still the server's answer.
      let raw = "";
      try {
        raw = await response.text();
      } catch {
        raw = "";
      }
      let parsed: unknown;
      try {
        parsed = raw.length > 0 ? JSON.parse(raw) : undefined;
      } catch {
        parsed = undefined;
      }

      if (status === 200) {
        return { ok: true, payload: buildPayload(parsed, operation) };
      }

      const known = SEARCH_ERROR_TEXT[status];
      // A status the contract does not list still gets a sentence: the program needs the code and
      // needs to know whether waiting is worthwhile, and "unknown" is not an answer.
      const template = typeof known === "string" ? known : unknownStatusText(status);
      return {
        ok: false,
        status,
        text: redact(interpolate(template, quotedMessage(parsed, raw)), apiKey),
      };
    } catch (error) {
      // Last-resort guard, and it is reachable: `JSON.stringify` throws on a BigInt, and a
      // JavaScript caller can pass one in a query. The client promised never to throw, so this
      // is where that promise is kept.
      return {
        ok: false,
        status: "network",
        text: redact(interpolate(SEARCH_NETWORK_ERROR_TEXT, messageOf(error)), apiKey),
      };
    }
  }

  return { search, fetchPage };
}

/** Turn a parsed 200 body into the one payload shape the contract defines. */
function buildPayload(body: unknown, operation: "search" | "fetch"): WebDsSearchPayload {
  if (operation === "search") {
    const results = isRecord(body) ? body.results : undefined;
    return {
      operation: "search",
      results: Array.isArray(results) ? (results as DeepSeekSearchResult[]) : [],
      page: null,
    };
  }
  const record = isRecord(body) ? body : undefined;
  const title = record?.title;
  const content = record?.content;
  return {
    operation: "fetch",
    results: [],
    page: {
      title: typeof title === "string" ? title : "",
      content: typeof content === "string" ? content : "",
    },
  };
}

/**
 * The message to quote for a failed call.
 *
 * DeepSeek's error body is OpenAI-compatible, so the text lives under `error.message`
 * (`docs/research/deepseek-search-api-20261020.md` §4.3), and its `param` is always `null` — the
 * message is the only place the offending field can be named. A top-level `message` is accepted
 * too, because that is the shape the contract's own wording names. A body that is not JSON falls
 * back to the raw text, and an empty body falls back to `"unknown"` — never to an empty slot.
 */
function quotedMessage(body: unknown, raw: string): string {
  if (isRecord(body)) {
    const direct = body.message;
    if (typeof direct === "string" && direct.trim().length > 0) return cap(direct.trim());
    const nested = body.error;
    if (isRecord(nested)) {
      const inner = nested.message;
      if (typeof inner === "string" && inner.trim().length > 0) return cap(inner.trim());
    }
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? cap(trimmed) : "unknown";
}

/**
 * The sentence for a status the contract does not list.
 *
 * Retryability follows DeepSeek's own rule — "wait and retry on 408, 429 and 5xx; for other 4xx
 * do not retry without changing the request" (`docs/research/deepseek-search-api-20261020.md`
 * §4.3) — so a 5xx the table has never heard of is still retryable, and a 4xx is not.
 */
function unknownStatusText(status: number): string {
  const retryable = SEARCH_RETRYABLE_STATUSES.has(status) || (status >= 500 && status <= 599);
  const tail = retryable
    ? "这是服务端侧的临时错误，稍后重试。"
    : "改一下请求或换个来源再试，不要原样重试。";
  return `DeepSeek 搜索接口返回了 HTTP ${status}（这个状态码不在已收录的错误文案里）：{message}${tail}`;
}

/** Fill the contract's `{message}` slot, if the sentence has one. */
function interpolate(template: string, message: string): string {
  if (!template.includes(SEARCH_ERROR_MESSAGE_SLOT)) return template;
  // A function replacer, so a `$&` inside the upstream message stays a literal `$&`.
  return template.replaceAll(SEARCH_ERROR_MESSAGE_SLOT, () => message);
}

/** The message of a thrown value, or `"unknown"`. */
function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return cap(error.message.trim());
  return "unknown";
}

/** Keep a quoted message from becoming the model-facing text in its entirety. */
function cap(text: string): string {
  return text.length > MAX_QUOTED_MESSAGE_CHARS ? text.slice(0, MAX_QUOTED_MESSAGE_CHARS) : text;
}

/** Replace every occurrence of the API key. */
function redact(text: string, apiKey: string): string {
  if (apiKey.length === 0) return text;
  return text.replaceAll(apiKey, REDACTED);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
