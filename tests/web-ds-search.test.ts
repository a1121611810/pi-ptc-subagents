/**
 * The DeepSeek search module's ONE face: a model-facing tool that exists only inside a
 * dispatched child.
 *
 * **What each claim worth pinning is about:**
 *
 *   1. **A parent session has no search capability AT ALL** — not "registered but hidden",
 *      absent from the registry, and the parent does not even resolve a credential.
 *   2. **Inside a child it is the MODEL's tool**, and what it hands back is an **overview**:
 *      one title, one url, three thresholds and DeepSeek's own `snippet` per result — not
 *      every page's full text. The measurement behind that is in
 *      `docs/prototypes/search-context-budget-measurements.md` §9.
 *   3. **The depth is one action away and it is free**: `open` hands over a page's full
 *      `summary` out of the last search, with no request and no quota slot — the API already
 *      computed that text and already billed for it.
 *   4. **The error text is one source**, so a status code cannot mean two different things.
 *
 * The HTTP client and the quota are stubbed here; their own behaviour is covered by
 * `tests/search-client.test.ts` and `tests/search-quota.test.ts`.
 */
import { describe, expect, test } from "vitest";
import type { AgentToolResult, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";

import {
  SEARCH_COUNT_OUT_OF_RANGE_TEXT,
  SEARCH_PAGE_DIGEST_TEXT,
  SEARCH_PAGE_EMPTY_TEXT,
  SEARCH_ERROR_TEXT,
  SEARCH_FIND_MORE_TEXT,
  SEARCH_FIND_NO_MATCH_TEXT,
  SEARCH_NO_RESULTS_TEXT,
  SEARCH_OVERVIEW_TRIMMED_TEXT,
  SEARCH_PAGE_FROM_RESULTS_TEXT,
  SEARCH_QUERY_EMPTY_TEXT,
  SEARCH_QUERY_TOO_LONG_TEXT,
  SEARCH_QUOTA_EXHAUSTED_TEXT,
  SEARCH_UNAVAILABLE_NOTICE,
  WEB_DS_SEARCH_TOOL_NAME,
  type WebDsSearchPayload,
} from "../src/search/contract.ts";
import {
  createSearchResultMemory,
  runWebDsSearch,
  type WebDsSearchDeps,
} from "../src/search/run.ts";
import { createWebDsSearchTool } from "../src/tools/web-ds-search.ts";
import { makeStubInAgentDir, removeTempDir, toolContext } from "./helpers/ptc.ts";

/** The theme stub: identity colouring, so the row text is what the test reads. */
const THEME = {
  fg: (_slot: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

/**
 * One search result in DeepSeek's own shape, copied from a real response.
 *
 * **The `snippet` and the `summary` are deliberately NOT substrings of each other.** The whole
 * point of the overview is that it carries the snippet and not the summary, and an assertion
 * cannot tell those two apart when the one is a piece of the other.
 */
const SAMPLE: WebDsSearchPayload = {
  operation: "search",
  results: [
    {
      rerank_score: 2.4,
      title: "DeepSeek 搜索 API 正式开放：每千次请求 $0.75",
      url: "https://example.com/a",
      snippet: "定价为每千次成功请求 $0.75，按请求次数计费。",
      summary:
        "（整页摘录）# DeepSeek 搜索 API 正式开放\n\n2026-10-19 | 话题：DeepSeek 搜索 API / RAG 开发\n\n官方公告：每 1000 次成功请求 5 元人民币，只有 HTTP 200 且产生结果才计费。",
      content: "",
      site_name: "Example News",
      site_icon: "https://example.com/favicon.ico",
      date: "2026-10-18T16:00:00+00:00",
      authority: 3,
    },
  ],
  page: null,
};

/** A client that always answers the same way, and counts the calls it was asked for. */
function stubClient(result: unknown): NonNullable<WebDsSearchDeps["client"]> & { calls: number } {
  const client = {
    calls: 0,
    search: async () => {
      client.calls += 1;
      return result as never;
    },
    fetchPage: async () => {
      client.calls += 1;
      return result as never;
    },
  };
  return client as unknown as NonNullable<WebDsSearchDeps["client"]> & { calls: number };
}

/** A quota that always has room, and counts the slots it handed out. */
function stubQuota(): NonNullable<WebDsSearchDeps["quota"]> & { reserved: number } {
  const quota = {
    reserved: 0,
    available: () => true,
    used: () => 0,
    reserve: () => {
      quota.reserved += 1;
      return { commit: () => {}, release: () => {} };
    },
  };
  return quota as unknown as NonNullable<WebDsSearchDeps["quota"]> & { reserved: number };
}

function depsWith(
  client: WebDsSearchDeps["client"],
  maxCallsPerSession = 100,
): WebDsSearchDeps & { quota: ReturnType<typeof stubQuota> } {
  return {
    ...(client === undefined ? {} : { client }),
    quota: stubQuota(),
    maxCallsPerSession,
    memory: createSearchResultMemory(),
  };
}

/** The tool, built the way the entrypoint builds it. */
function toolWith(deps: WebDsSearchDeps): ToolDefinition<any, any, any> {
  return createWebDsSearchTool({ deps, unavailable: false });
}

/**
 * Call the tool exactly as pi's agent loop does.
 *
 * The result is narrowed to the payload shape: `defineTool` returns an intersection whose
 * call signature widens `details` back to `unknown`.
 */
function call(
  tool: ToolDefinition<any, any, any>,
  params: Record<string, unknown>,
): Promise<AgentToolResult<WebDsSearchPayload>> {
  return tool.execute(
    "call-1",
    params,
    undefined,
    undefined,
    toolContext(process.cwd()),
  ) as Promise<AgentToolResult<WebDsSearchPayload>>;
}

/** The text blocks of a result — the part the MODEL reads. */
function textOf(result: AgentToolResult<WebDsSearchPayload>): string {
  return result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

describe("the parent session has no search capability at all", () => {
  test("the tool is not registered in a parent, even with the switch on", async () => {
    // The switch is ON, so the only reason the tool is missing is the depth. That is the claim:
    // the capability is ABSENT from a parent, not merely inactive.
    await withEnv({ PI_PTC_DEPTH: undefined, DEEPSEEK_API_KEY: undefined }, async () => {
      const { stub, dir } = await makeStubInAgentDir({ ptc: { webDsSearch: { enabled: true } } });
      try {
        expect(stub.tools.has(WEB_DS_SEARCH_TOOL_NAME)).toBe(false);
      } finally {
        await removeTempDir(dir);
      }
    });
  });

  test("and the parent does not even look for a credential", async () => {
    // The missing-key notice is the observable of "we tried to resolve a credential". A parent
    // must not resolve one: it holds no network capability at all, so there is nothing for a
    // key to unlock. The child's notice is the control that makes this assertion meaningful.
    await withEnv({ PI_PTC_DEPTH: undefined, DEEPSEEK_API_KEY: undefined }, async () => {
      const { stub, dir } = await makeStubInAgentDir({ ptc: { webDsSearch: { enabled: true } } });
      try {
        expect(credentialNotices(stub.notifications)).toEqual([]);
      } finally {
        await removeTempDir(dir);
      }
    });
  });
});

describe("a dispatched child has the tool, and the model is its caller", () => {
  test("it is registered in a child when the switch is on", async () => {
    await withEnv({ PI_PTC_DEPTH: "1", DEEPSEEK_API_KEY: undefined }, async () => {
      const { stub, dir } = await makeStubInAgentDir({ ptc: { webDsSearch: { enabled: true } } });
      try {
        expect(stub.tools.has(WEB_DS_SEARCH_TOOL_NAME)).toBe(true);
      } finally {
        await removeTempDir(dir);
      }
    });
  });

  test("it is absent in a child when the switch is off", async () => {
    // The switch fails CLOSED: no key means no tool, not "a tool that always fails".
    await withEnv({ PI_PTC_DEPTH: "1", DEEPSEEK_API_KEY: undefined }, async () => {
      const { stub, dir } = await makeStubInAgentDir({});
      try {
        expect(stub.tools.has(WEB_DS_SEARCH_TOOL_NAME)).toBe(false);
      } finally {
        await removeTempDir(dir);
      }
    });
  });

  test("it is model-facing, and it declares the shape of its result", async () => {
    await withEnv({ PI_PTC_DEPTH: "1", DEEPSEEK_API_KEY: undefined }, async () => {
      const { stub, dir } = await makeStubInAgentDir({ ptc: { webDsSearch: { enabled: true } } });
      try {
        const tool = stub.tools.get(WEB_DS_SEARCH_TOOL_NAME);
        if (!tool) throw new Error("the search tool must be registered in a child");
        const declared = tool as unknown as {
          exposure?: string;
          outputSchema?: { properties?: Record<string, unknown> };
        };
        expect(declared.exposure).toBe("direct");
        expect(Object.keys(declared.outputSchema?.properties ?? {}).sort()).toEqual([
          "matchTotal",
          "matches",
          "operation",
          "page",
          "pattern",
          "results",
        ]);
      } finally {
        await removeTempDir(dir);
      }
    });
  });

  test("a child without a credential says so, and the tool is still there", async () => {
    await withEnv({ PI_PTC_DEPTH: "1", DEEPSEEK_API_KEY: undefined }, async () => {
      const { stub, dir } = await makeStubInAgentDir({ ptc: { webDsSearch: { enabled: true } } });
      try {
        const tool = stub.tools.get(WEB_DS_SEARCH_TOOL_NAME);
        if (!tool) throw new Error("the search tool must be registered in a child");
        expect(tool.description ?? "").toContain(SEARCH_UNAVAILABLE_NOTICE);
        expect(credentialNotices(stub.notifications).length).toBeGreaterThan(0);
      } finally {
        await removeTempDir(dir);
      }
    });
  });
});

describe("a search hands the model an OVERVIEW", () => {
  test("the payload lands in details and structuredContent", async () => {
    const tool = toolWith(depsWith(stubClient({ ok: true, payload: SAMPLE })));
    const result = await call(tool, { query: "x" });
    expect(result.details).toEqual(SAMPLE);
    // `structuredContent` is a post-0.99.0 field on the result type, so it is read through a
    // cast: the declared floor (0.86.0) does not carry it, and the compat gate type-checks
    // this file against that tree.
    expect((result as { structuredContent?: unknown }).structuredContent).toEqual(SAMPLE);
  });

  test("the text carries the snippet and NOT the summary", async () => {
    // **The claim the live end-to-end run turned up.** pi sends a tool result to the model as
    // its `content` blocks and nothing else — `details` and `structuredContent` stay host-side.
    // A text that carried only title and url would hand the model a list of links and none of
    // the substance; a text that carried the whole `summary` (191-4757 characters each, measured)
    // would eat the context instead.
    const tool = toolWith(depsWith(stubClient({ ok: true, payload: SAMPLE })));
    const text = textOf(await call(tool, { query: "x" }));
    expect(text).toContain("DeepSeek 搜索 API 正式开放");
    expect(text).toContain("https://example.com/a");
    expect(text, "the snippet is in the model's text").toContain(
      SAMPLE.results[0]?.snippet ?? "NO-SNIPPET",
    );
    expect(text, "and the summary is not").not.toContain(
      SAMPLE.results[0]?.summary ?? "NO-SUMMARY",
    );
    expect(text, "the thresholds the model filters on").toContain("authority 3");
    expect(text).toContain("rerank 2.40");
  });

  test("a fetched page's body is in the text the model reads", async () => {
    const page: WebDsSearchPayload = {
      operation: "fetch",
      results: [],
      page: { title: "Example article", content: "# Example article\n\nArticle content." },
    };
    const tool = toolWith(depsWith(stubClient({ ok: true, payload: page })));
    const text = textOf(await call(tool, { open: "https://example.com/article" }));
    expect(text).toContain("Article content.");
    expect(text).toContain("Example article");
  });

  test("a page with no body says so, instead of returning nothing", async () => {
    const page: WebDsSearchPayload = {
      operation: "fetch",
      results: [],
      page: { title: "Example article", content: "" },
    };
    const tool = toolWith(depsWith(stubClient({ ok: true, payload: page })));
    expect(textOf(await call(tool, { open: "https://example.com/article" }))).toContain(
      SEARCH_PAGE_EMPTY_TEXT,
    );
  });

  test("the tool ROW is a count, not the model's text", async () => {
    // The row is one line of a terminal; the model's text is the whole result. Rendering the
    // model's text into the row would put ten overviews into one line.
    const tool = toolWith(depsWith(stubClient({ ok: true, payload: SAMPLE })));
    const result = await call(tool, { query: "x" });
    const render = tool.renderResult;
    if (render === undefined) throw new Error("the tool must render a result row");
    const row = render(
      { content: result.content, details: result.details },
      { expanded: false, isPartial: false },
      THEME,
      { args: {}, isError: false } as never,
    ) as { render(width: number): string[] };
    const text = row.render(200).join("\n");
    expect(text).toContain("1 result");
    expect(text, "the snippet is not in the row").not.toContain("按请求次数计费");
  });
});

describe("the depth is one action away, and it is free", () => {
  test("open hands over the remembered summary, without a request and without a quota slot", async () => {
    // **The whole point of the memory.** The API already computed that summary and already
    // billed for it; handing it over later costs nothing.
    const client = stubClient({ ok: true, payload: SAMPLE });
    const deps = depsWith(client);
    const tool = toolWith(deps);
    await call(tool, { query: "x" });
    const callsAfterSearch = client.calls;
    const slotsAfterSearch = deps.quota.reserved;

    const text = textOf(await call(tool, { open: "https://example.com/a" }));

    expect(text).toContain(SAMPLE.results[0]?.summary ?? "NO-SUMMARY");
    expect(text).toContain(SEARCH_PAGE_FROM_RESULTS_TEXT);
    // The text is DeepSeek's DIGEST of that page, and the model has to be told so: the live run
    // showed a child reading the short digest as a body that had been cut short.
    expect(text).toContain(SEARCH_PAGE_DIGEST_TEXT);
    expect(client.calls, "the API was not asked again").toBe(callsAfterSearch);
    expect(deps.quota.reserved, "and no quota slot was taken").toBe(slotsAfterSearch);
  });

  test("open finds a page from an EARLIER search, not just the latest one", async () => {
    // **This is the bug the live end-to-end run found.** The child searched three times before
    // it opened a page — and it opened a page it had found in the FIRST search. A memory that
    // held only the latest search would have missed it, and the open would have fallen back to
    // a fetch: the model would have paid for a request to get a page the API had already billed
    // for and handed over.
    const first: WebDsSearchPayload = {
      operation: "search",
      results: [
        {
          ...(SAMPLE.results[0] as NonNullable<WebDsSearchPayload["results"][number]>),
          url: "https://example.com/first",
        },
      ],
      page: null,
    };
    const second: WebDsSearchPayload = {
      operation: "search",
      results: [
        {
          ...(SAMPLE.results[0] as NonNullable<WebDsSearchPayload["results"][number]>),
          url: "https://example.com/second",
        },
      ],
      page: null,
    };
    let searchCount = 0;
    const client = {
      calls: 0,
      search: async () => {
        client.calls += 1;
        return { ok: true, payload: searchCount++ === 0 ? first : second } as never;
      },
      fetchPage: async () => {
        client.calls += 1;
        return { ok: true, payload: SAMPLE } as never;
      },
    } as unknown as NonNullable<WebDsSearchDeps["client"]> & { calls: number };
    const deps = depsWith(client);
    const tool = toolWith(deps);
    await call(tool, { query: "first" });
    await call(tool, { query: "second" });
    const callsAfterSearches = client.calls;

    const text = textOf(await call(tool, { open: "https://example.com/first" }));

    expect(text).toContain(SEARCH_PAGE_FROM_RESULTS_TEXT);
    expect(client.calls, "the page was already known").toBe(callsAfterSearches);
  });

  test("open matches a url the model wrote a little differently", async () => {
    // A model does not copy urls byte for byte: it drops a trailing slash, keeps a fragment,
    // carries a tracking query. The live run opened `…/guides/search/` while the search had
    // returned `…/guides/search/` — and in another search `…/guides/search/#1` for the same page.
    const client = stubClient({ ok: true, payload: SAMPLE });
    const deps = depsWith(client);
    const tool = toolWith(deps);
    await call(tool, { query: "x" });
    const callsAfterSearch = client.calls;

    const text = textOf(await call(tool, { open: "https://example.com/a#1" }));

    expect(text).toContain(SEARCH_PAGE_FROM_RESULTS_TEXT);
    expect(client.calls, "the page was already known").toBe(callsAfterSearch);
  });

  test("open on a url that was never searched fetches it, and says so", async () => {
    // The fetch path is the only one that costs: a request, a quota slot, and a body that
    // carries the API's own punctuation escapes.
    const client = stubClient({ ok: true, payload: SAMPLE });
    const deps = depsWith(client);
    const tool = toolWith(deps);
    await call(tool, { query: "x" });
    const callsAfterSearch = client.calls;
    const slotsAfterSearch = deps.quota.reserved;

    const text = textOf(await call(tool, { open: "https://example.com/never-searched" }));

    expect(client.calls, "the page had to be fetched").toBe(callsAfterSearch + 1);
    expect(deps.quota.reserved, "and a quota slot was taken").toBe(slotsAfterSearch + 1);
    expect(text).not.toContain(SEARCH_PAGE_FROM_RESULTS_TEXT);
  });

  test("find reports the lines where the pattern appears", async () => {
    const client = stubClient({ ok: true, payload: SAMPLE });
    const deps = depsWith(client);
    const tool = toolWith(deps);
    await call(tool, { query: "x" });
    const callsAfterSearch = client.calls;

    const text = textOf(
      await call(tool, { find: { url: "https://example.com/a", pattern: "5 元" } }),
    );

    expect(text).toContain("5 元人民币");
    expect(text).toMatch(/^\s+\d+: /m);
    expect(client.calls, "the page was already known").toBe(callsAfterSearch);
  });

  test("find says how many places matched when the answer is capped", async () => {
    // The first version capped the matches while collecting them, so the "there are N more"
    // notice could never fire — it was dead text. The count is now taken over every line.
    const long: WebDsSearchPayload = {
      operation: "search",
      results: [
        {
          ...(SAMPLE.results[0] as NonNullable<WebDsSearchPayload["results"][number]>),
          summary: Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行写着 目标词`).join("\n"),
        },
      ],
      page: null,
    };
    const client = stubClient({ ok: true, payload: long });
    const deps = depsWith(client);
    const tool = toolWith(deps);
    await call(tool, { query: "x" });

    const text = textOf(
      await call(tool, { find: { url: "https://example.com/a", pattern: "目标词" } }),
    );

    expect(text).toContain(SEARCH_FIND_MORE_TEXT.replace("{count}", "20"));
  });

  test("find that matches nothing says so, and names the pattern", async () => {
    const client = stubClient({ ok: true, payload: SAMPLE });
    const deps = depsWith(client);
    const tool = toolWith(deps);
    await call(tool, { query: "x" });

    const text = textOf(
      await call(tool, { find: { url: "https://example.com/a", pattern: "不存在的词" } }),
    );

    expect(text).toContain(SEARCH_FIND_NO_MATCH_TEXT.replace("{pattern}", "不存在的词"));
  });
});

describe("the error text is one source", () => {
  test("a failed call throws the shared constant", async () => {
    const tool = toolWith(
      depsWith(stubClient({ ok: false, status: 401, text: SEARCH_ERROR_TEXT[401] })),
    );
    await expect(call(tool, { query: "x" })).rejects.toThrow(SEARCH_ERROR_TEXT[401]);
  });

  test("a missing credential throws the shared notice", async () => {
    const tool = toolWith(depsWith(undefined));
    await expect(call(tool, { query: "x" })).rejects.toThrow(SEARCH_UNAVAILABLE_NOTICE);
  });

  test("the unavailable notice is in the description AND in the failure", async () => {
    // The model has to learn the reason BEFORE it calls, and the call has to say the same
    // thing — two copies of the sentence would be two facts.
    const tool = createWebDsSearchTool({ deps: depsWith(undefined), unavailable: true });
    expect(tool.description ?? "").toContain(SEARCH_UNAVAILABLE_NOTICE);
    await expect(call(tool, { query: "x" })).rejects.toThrow(SEARCH_UNAVAILABLE_NOTICE);
  });
});

describe("the signals that are not errors", () => {
  test("a search that matched nothing says so in a sentence", async () => {
    const empty: WebDsSearchPayload = { operation: "search", results: [], page: null };
    const tool = toolWith(depsWith(stubClient({ ok: true, payload: empty })));
    const result = await call(tool, { query: "x" });
    expect(result.details?.results).toEqual([]);
    expect(textOf(result)).toBe(SEARCH_NO_RESULTS_TEXT);
  });

  test("an exhausted quota degrades instead of failing", async () => {
    const exhausted: WebDsSearchDeps = {
      client: stubClient({ ok: true, payload: SAMPLE }),
      quota: {
        available: () => false,
        used: () => 30,
        reserve: () => undefined,
      },
      maxCallsPerSession: 30,
    };
    const outcome = await runWebDsSearch(exhausted, { query: "x" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.text).toBe(SEARCH_QUOTA_EXHAUSTED_TEXT.replace("{limit}", "30"));
  });
});

describe("the arguments are discriminated", () => {
  test("two actions at once is refused with a sentence", async () => {
    const tool = toolWith(depsWith(stubClient({ ok: true, payload: SAMPLE })));
    await expect(call(tool, { query: "x", open: "https://y" })).rejects.toThrow(/一次只做一件事/);
  });

  test("no action at all is refused with a sentence", async () => {
    const tool = toolWith(depsWith(stubClient({ ok: true, payload: SAMPLE })));
    await expect(call(tool, {})).rejects.toThrow(/query/);
  });

  test("a find without a url or a pattern is refused", async () => {
    const tool = toolWith(depsWith(stubClient({ ok: true, payload: SAMPLE })));
    await expect(call(tool, { find: { url: "https://y" } })).rejects.toThrow(/pattern/);
    await expect(call(tool, { find: { pattern: "x" } })).rejects.toThrow(/url/);
  });
});

describe("the API's own limits are checked before the request leaves the machine", () => {
  test("a count outside 1-50 is refused with a sentence that names the range", async () => {
    // The bounds are DeepSeek's, quoted in the official guide: `count` is "1～50".
    for (const bad of [0, 51, -1, 3.5]) {
      const tool = toolWith(depsWith(stubClient({ ok: true, payload: SAMPLE })));
      await expect(
        call(tool, { query: "x", count: bad }),
        `count: ${String(bad)} is outside the API's range`,
      ).rejects.toThrow(SEARCH_COUNT_OUT_OF_RANGE_TEXT.replace("{value}", String(bad)));
    }
  });

  test("a query longer than 128 characters is refused with a sentence", async () => {
    const tool = toolWith(depsWith(stubClient({ ok: true, payload: SAMPLE })));
    await expect(call(tool, { query: "x".repeat(129) })).rejects.toThrow(
      SEARCH_QUERY_TOO_LONG_TEXT.replace("{length}", "129"),
    );
  });

  test("a blank query is refused, because the API refuses one too", async () => {
    const tool = toolWith(depsWith(stubClient({ ok: true, payload: SAMPLE })));
    await expect(call(tool, { query: "   " })).rejects.toThrow(SEARCH_QUERY_EMPTY_TEXT);
  });

  test("the length is counted in Unicode characters, not UTF-16 units", async () => {
    // 64 emoji are 64 Unicode characters and 128 UTF-16 units. The API counts characters, so
    // this query is inside the limit; a `String.length` check would measure 256 and refuse it.
    const tool = toolWith(depsWith(stubClient({ ok: true, payload: SAMPLE })));
    const result = await call(tool, { query: "😀".repeat(64) });
    expect(result.details).toEqual(SAMPLE);
  });

  test("a refused call never reaches the API and never spends quota", async () => {
    // The point of checking locally: the request does not go out, so it costs nothing and it
    // does not consume a slot. A client that was asked and a quota that was charged are the two
    // halves of "the check actually happened before the call".
    const client = stubClient({ ok: true, payload: SAMPLE });
    const deps = depsWith(client);
    const tool = toolWith(deps);
    await expect(call(tool, { query: "x", count: 500 })).rejects.toThrow(
      SEARCH_COUNT_OUT_OF_RANGE_TEXT.replace("{value}", "500"),
    );
    expect(client.calls, "the API was never asked").toBe(0);
    expect(deps.quota.reserved, "no quota slot was taken").toBe(0);
  });
});

describe("the overview is bounded", () => {
  test("past the ceiling the lowest-ranked results are dropped WHOLE, and it says how many", async () => {
    // A cut result is one with a fact missing and no sign of it; a dropped result is missing in
    // a way the model can see and answer. That is why this drops and does not cut.
    const many: WebDsSearchPayload = {
      operation: "search",
      results: Array.from({ length: 50 }, (_, index) => ({
        ...(SAMPLE.results[0] as NonNullable<WebDsSearchPayload["results"][number]>),
        title: `结果 ${index + 1}`,
        url: `https://example.com/${index + 1}`,
        snippet: "x".repeat(400),
      })),
      page: null,
    };
    const tool = toolWith(depsWith(stubClient({ ok: true, payload: many })));
    const text = textOf(await call(tool, { query: "x" }));
    expect(text).toMatch(/还有 \d+ 条结果没有列出来/);
    expect(text).toContain(SEARCH_OVERVIEW_TRIMMED_TEXT.split("{count}")[0] ?? "");
    expect(text).toContain("结果 1");
    expect(text, "the lowest-ranked one is gone").not.toContain("结果 50");
  });
});

/**
 * Run a body with process-wide environment under the test's control.
 *
 * Both variables change what the extension does at LOAD time — `PI_PTC_DEPTH` decides whether
 * the search tool is registered at all, and `DEEPSEEK_API_KEY` decides whether the credential
 * resolves — so a test that leaves either alone reads the DEVELOPER'S OWN machine. Vitest gives
 * each test FILE its own worker, but the cases in a file share it, so both are restored here
 * rather than left to the next case.
 */
async function withEnv(
  env: Record<string, string | undefined>,
  body: () => Promise<void>,
): Promise<void> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await body();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** The notices a session raised that talk about the DeepSeek key. */
function credentialNotices(notifications: readonly { message: string }[]): string[] {
  return notifications
    .map((notice) => notice.message)
    .filter((message) => message.includes("DeepSeek"));
}
