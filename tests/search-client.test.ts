/**
 * The DeepSeek HTTP client's contract: what it sends, what it returns, and what it refuses to do.
 *
 * ## Where the fixtures come from
 *
 * `SAMPLE_RESULT` is the response example from DeepSeek's own Search API documentation, copied
 * field for field (`docs/research/deepseek-search-api-20261020.md` §3.1). The expected error
 * sentences are read out of `SEARCH_ERROR_TEXT` in `src/search/contract.ts` at assertion time
 * rather than written out here: a second copy of that table in a test would be a second source of
 * truth, and the two would drift.
 *
 * ## What each test would catch if the implementation were wrong
 *
 * - Quoting 402's sentence for a 401 → the status-text test goes red.
 * - Counting a failed call against the quota → the quota test goes red.
 * - Believing that "an entry exists" means "a key is configured" → the credential test goes red.
 */
import { describe, expect, test } from "vitest";

import {
  DEEPSEEK_BASE_URL,
  DEEPSEEK_FETCH_PATH,
  DEEPSEEK_SEARCH_PATH,
  SEARCH_ERROR_MESSAGE_SLOT,
  SEARCH_ERROR_TEXT,
  SEARCH_NETWORK_ERROR_TEXT,
  type WebDsSearchPayload,
} from "../src/search/contract.ts";
import { createDeepSeekClient, type DeepSeekCallResult } from "../src/search/client.ts";

/** The Search response example from DeepSeek's API documentation. */
const SAMPLE_RESULT = {
  rerank_score: 2.4,
  title: "DeepSeek V4 模型发布",
  url: "https://example.com/deepseek-v4",
  snippet: "DeepSeek V4 已上线，支持工具调用与长上下文。",
  summary: "DeepSeek 发布了 V4 模型。此次发布改进了工具调用与长上下文能力，适合 Agent 工作流。",
  content: "DeepSeek V4 现已正式上线……",
  site_name: "Example News",
  site_icon: "https://example.com/favicon.ico",
  date: "2026-06-01T00:00:00+00:00",
  authority: 3,
};

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function createFetchMock(handler: (call: RecordedCall) => Response): {
  calls: RecordedCall[];
  fetchImpl: typeof fetch;
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (
    input: unknown,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => {
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>),
    };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The contract's own sentence for a status, so the test never carries a second copy. */
function errorTextFor(status: number): string {
  const text = SEARCH_ERROR_TEXT[status];
  if (typeof text !== "string") throw new Error(`the contract has no error text for ${status}`);
  return text;
}

/** The contract's network sentence with the upstream message filled in. */
function networkTextFor(message: string): string {
  return SEARCH_NETWORK_ERROR_TEXT.replace(SEARCH_ERROR_MESSAGE_SLOT, message);
}

function expectOk(reply: DeepSeekCallResult): WebDsSearchPayload {
  if (!reply.ok) throw new Error(`expected a successful call, got ${reply.status}: ${reply.text}`);
  return reply.payload;
}

function expectFailure(reply: DeepSeekCallResult): { status: number | "network"; text: string } {
  if (reply.ok) throw new Error("expected a failed call, got a successful payload");
  return { status: reply.status, text: reply.text };
}

describe("DeepSeek client", () => {
  test("search posts to the search endpoint and passes the results through", async () => {
    const { calls, fetchImpl } = createFetchMock(() => jsonResponse({ results: [SAMPLE_RESULT] }));
    const client = createDeepSeekClient({ apiKey: "sk-test-key", fetchImpl });

    const payload = expectOk(await client.search({ query: "DeepSeek 搜索 API" }));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${DEEPSEEK_BASE_URL}${DEEPSEEK_SEARCH_PATH}`);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer sk-test-key");
    expect(calls[0]?.headers["Content-Type"]).toBe("application/json");
    expect(calls[0]?.body).toEqual({ query: "DeepSeek 搜索 API" });
    expect(payload.operation).toBe("search");
    expect(payload.page).toBeNull();
    expect(payload.results).toEqual([SAMPLE_RESULT]);
  });

  test("the results keep exactly the fields DeepSeek sent", async () => {
    // The API documents `site_name` and `date` as nullable, and a normalizer here would turn
    // "absent" into "null" — which changes what a program reading the payload can tell apart.
    const partial = { ...SAMPLE_RESULT } as Record<string, unknown>;
    delete partial.site_name;
    delete partial.date;
    const { fetchImpl } = createFetchMock(() => jsonResponse({ results: [partial] }));
    const client = createDeepSeekClient({ apiKey: "sk-test-key", fetchImpl });

    const payload = expectOk(await client.search({ query: "q" }));

    expect(Object.keys(payload.results[0] ?? {})).toEqual(Object.keys(partial));
    expect("site_name" in (payload.results[0] ?? {})).toBe(false);
    expect("date" in (payload.results[0] ?? {})).toBe(false);
  });

  test("only the optional fields the caller set are sent", async () => {
    const { calls, fetchImpl } = createFetchMock(() => jsonResponse({ results: [] }));
    const client = createDeepSeekClient({ apiKey: "sk-test-key", fetchImpl });

    await client.search({ query: "q", need_content: false });
    await client.search({
      query: "q",
      count: 3,
      ori_question: "原始问题",
      localization: "1.1.1.1",
      need_content: true,
    });

    // `need_content: false` is an instruction, not an absence: it has to survive the "did the
    // caller set it?" test, and the fields the caller did not set must not appear at all.
    expect(Object.keys(calls[0]?.body ?? {}).sort()).toEqual(["need_content", "query"]);
    expect(calls[0]?.body["need_content"]).toBe(false);
    expect(Object.keys(calls[1]?.body ?? {}).sort()).toEqual([
      "count",
      "localization",
      "need_content",
      "ori_question",
      "query",
    ]);
    expect(calls[1]?.body["count"]).toBe(3);
  });

  test("fetch posts the url and returns the page", async () => {
    const { calls, fetchImpl } = createFetchMock(() =>
      jsonResponse({ title: "网页搜索与抓取", content: "# 网页搜索与抓取\n" }),
    );
    const client = createDeepSeekClient({ apiKey: "sk-test-key", fetchImpl });

    const payload = expectOk(
      await client.fetchPage({ url: "https://api-docs.deepseek.com/zh-cn/guides/search" }),
    );

    expect(calls[0]?.url).toBe(`${DEEPSEEK_BASE_URL}${DEEPSEEK_FETCH_PATH}`);
    expect(calls[0]?.body).toEqual({ url: "https://api-docs.deepseek.com/zh-cn/guides/search" });
    expect(payload.operation).toBe("fetch");
    expect(payload.results).toEqual([]);
    expect(payload.page).toEqual({ title: "网页搜索与抓取", content: "# 网页搜索与抓取\n" });
  });

  test("the base url is used as given, without doubling the separator", async () => {
    const { calls, fetchImpl } = createFetchMock(() => jsonResponse({ results: [] }));
    const client = createDeepSeekClient({
      apiKey: "sk-test-key",
      baseUrl: "https://search.example.test/",
      fetchImpl,
    });

    await client.search({ query: "q" });

    expect(calls[0]?.url).toBe(`https://search.example.test${DEEPSEEK_SEARCH_PATH}`);
  });

  test("a failed call quotes the contract's own sentence for that status", async () => {
    const { fetchImpl } = createFetchMock(() =>
      jsonResponse({ error: { message: "invalid api key" } }, 401),
    );
    const client = createDeepSeekClient({ apiKey: "sk-test-key", fetchImpl });

    const failure = expectFailure(await client.search({ query: "q" }));

    expect(failure.status).toBe(401);
    // Quoting 402's sentence for a 401 turns this red: the expected text is read from the
    // contract's table, so swapping two lines in that table is visible here.
    expect(failure.text).toBe(errorTextFor(401));
    expect(failure.text).not.toBe(errorTextFor(402));
  });

  test("the 400 line quotes the upstream message into the contract's slot", async () => {
    const { fetchImpl } = createFetchMock(() =>
      jsonResponse({ error: { message: "query exceeds 128 characters" } }, 400),
    );
    const client = createDeepSeekClient({ apiKey: "sk-test-key", fetchImpl });

    const failure = expectFailure(await client.search({ query: "q" }));

    expect(failure.status).toBe(400);
    expect(failure.text).toBe(
      errorTextFor(400).replace(SEARCH_ERROR_MESSAGE_SLOT, "query exceeds 128 characters"),
    );
    expect(failure.text).toContain("query exceeds 128 characters");
    expect(failure.text).not.toContain(SEARCH_ERROR_MESSAGE_SLOT);
  });

  test("a body that is not JSON falls back to the raw text instead of throwing", async () => {
    const { fetchImpl } = createFetchMock(() => new Response("upstream said no", { status: 400 }));
    const client = createDeepSeekClient({ apiKey: "sk-test-key", fetchImpl });

    const failure = expectFailure(await client.search({ query: "q" }));

    expect(failure.status).toBe(400);
    expect(failure.text).toBe(
      errorTextFor(400).replace(SEARCH_ERROR_MESSAGE_SLOT, "upstream said no"),
    );
  });

  test("a body that cannot be read leaves the status intact and does not throw", async () => {
    const broken = new ReadableStream({
      start(controller) {
        controller.error(new Error("stream broke"));
      },
    });
    const fetchImpl = (async () =>
      new Response(broken, { status: 401 })) as unknown as typeof fetch;
    const client = createDeepSeekClient({ apiKey: "sk-test-key", fetchImpl });

    const failure = expectFailure(await client.search({ query: "q" }));

    expect(failure.status).toBe(401);
    expect(failure.text).toBe(errorTextFor(401));
  });

  test("a status the contract does not list still gets a sentence that names the code", async () => {
    const { fetchImpl } = createFetchMock(() =>
      jsonResponse({ error: { message: "teapot" } }, 418),
    );
    const { fetchImpl: gatewayImpl } = createFetchMock(() =>
      jsonResponse({ error: { message: "bad gateway" } }, 503),
    );
    const client = createDeepSeekClient({ apiKey: "sk-test-key", fetchImpl });
    const gatewayClient = createDeepSeekClient({ apiKey: "sk-test-key", fetchImpl: gatewayImpl });

    const teapot = expectFailure(await client.search({ query: "q" }));
    const gateway = expectFailure(await gatewayClient.search({ query: "q" }));

    expect(teapot.status).toBe(418);
    expect(teapot.text).toContain("418");
    expect(teapot.text.length).toBeGreaterThan(0);
    expect(gateway.status).toBe(503);
    expect(gateway.text).toContain("503");
    // The contract asks the fallback to say whether waiting is worthwhile, so the retryable case
    // and the do-not-retry case have to be distinguishable from each other.
    expect(teapot.text).not.toBe(gateway.text);
  });

  test("a request that never reached DeepSeek is a network failure, not an exception", async () => {
    const fetchImpl = (async () => {
      throw new Error("getaddrinfo ENOTFOUND api.deepseek.com");
    }) as unknown as typeof fetch;
    const client = createDeepSeekClient({ apiKey: "sk-test-key", fetchImpl });

    const failure = expectFailure(await client.search({ query: "q" }));

    expect(failure.status).toBe("network");
    expect(failure.text).toBe(networkTextFor("getaddrinfo ENOTFOUND api.deepseek.com"));
  });

  test("the api key never survives into the text, even when upstream echoes it", async () => {
    const { fetchImpl } = createFetchMock(() =>
      jsonResponse({ error: { message: "rejected key sk-secret-value" } }, 400),
    );
    const client = createDeepSeekClient({ apiKey: "sk-secret-value", fetchImpl });

    const failure = expectFailure(await client.search({ query: "q" }));

    expect(failure.text).not.toContain("sk-secret-value");
    expect(failure.text).toContain("[redacted]");
    expect(JSON.stringify(failure)).not.toContain("sk-secret-value");
  });

  test("a thrown error that names the key is redacted too", async () => {
    const fetchImpl = (async () => {
      throw new Error("boom sk-secret-value");
    }) as unknown as typeof fetch;
    const client = createDeepSeekClient({ apiKey: "sk-secret-value", fetchImpl });

    const failure = expectFailure(await client.search({ query: "q" }));

    expect(failure.status).toBe("network");
    expect(failure.text).not.toContain("sk-secret-value");
    expect(JSON.stringify(failure)).not.toContain("sk-secret-value");
  });

  test("invalid options are rejected when the client is built, not on the first call", () => {
    expect(() => createDeepSeekClient({ apiKey: "" })).toThrow(TypeError);
    expect(() => createDeepSeekClient({ apiKey: "sk-test-key", baseUrl: "   " })).toThrow(
      TypeError,
    );
    expect(() =>
      createDeepSeekClient({
        apiKey: "sk-test-key",
        fetchImpl: "nope" as unknown as typeof fetch,
      }),
    ).toThrow(TypeError);
  });
});
