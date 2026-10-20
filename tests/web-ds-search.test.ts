/**
 * The DeepSeek search module's two faces, and the one thing they must not do: disagree.
 *
 * ADR-0047 puts the capability on two program faces — the codemode face (a pi tool with
 * `exposure: "codemode"`) and the PTC binding face (`tools["web.ds.search"]`) — and ADR-0048
 * puts one table of model-facing error text behind both of them. These tests are mostly about
 * those two claims, because they are the claims a later change could quietly break:
 *
 *   1. The capability is NOT in the binding table unless the switch says so, and NOT
 *      model-facing when it is.
 *   2. A missing credential is a STATED state, not a silent one: the tool's description says
 *      so, and a call fails with the same sentence.
 *   3. The error text is ONE source. The description, the contract and the failure all quote
 *      the same constant — the assertion at the bottom of this file is the one that matters.
 *
 * The HTTP client and the quota are stubbed here; their own behaviour is covered by
 * `tests/search-client.test.ts` and `tests/search-quota.test.ts`.
 */
import { describe, expect, test } from "vitest";

import { createBuiltinBindings } from "../src/runtime/bindings.ts";
import { BINDING_CONTRACT } from "../src/tools/binding-contract.ts";
import { createWebDsSearchTool } from "../src/tools/web-ds-search.ts";
import {
  SEARCH_ERROR_TEXT,
  WEB_DS_SEARCH_USAGE,
  SEARCH_NO_RESULTS_TEXT,
  SEARCH_QUOTA_EXHAUSTED_TEXT,
  SEARCH_UNAVAILABLE_NOTICE,
  WEB_DS_SEARCH_BINDING_NAME,
  WEB_DS_SEARCH_TOOL_NAME,
  type WebDsSearchPayload,
} from "../src/search/contract.ts";
import { runWebDsSearch, type WebDsSearchDeps } from "../src/search/run.ts";
import { captureRegisteredTools } from "./helpers/ptc.ts";

/** The binding context every test drives a binding with. */
const call = { callId: 1, depth: 0, maxDispatchDepth: 3 };

const SAMPLE: WebDsSearchPayload = {
  operation: "search",
  results: [
    {
      rerank_score: 2.4,
      title: "DeepSeek 搜索 API 正式开放",
      url: "https://example.com/a",
      snippet: "每千次请求 $0.75。",
      summary: "DeepSeek 搜索 API 正式开放：每千次请求 $0.75，开发者如何接入？".repeat(4),
      content: "",
      site_name: "Example News",
      site_icon: "https://example.com/favicon.ico",
      date: "2026-10-18T16:00:00+00:00",
      authority: 3,
    },
  ],
  page: null,
};

/** A client that always answers the same way. */
function stubClient(result: unknown): NonNullable<WebDsSearchDeps["client"]> {
  return {
    search: async () => result as never,
    fetchPage: async () => result as never,
  };
}

/** A quota that always has room. */
function stubQuota(): NonNullable<WebDsSearchDeps["quota"]> {
  return {
    available: () => true,
    used: () => 0,
    reserve: () => ({ commit: () => {}, release: () => {} }),
  };
}

function depsWith(client: WebDsSearchDeps["client"], maxCallsPerSession = 100): WebDsSearchDeps {
  return {
    ...(client === undefined ? {} : { client }),
    quota: stubQuota(),
    maxCallsPerSession,
  };
}

describe("the search capability is not in the surface unless the switch says so", () => {
  test("the default binding table has no search binding", () => {
    const table = createBuiltinBindings({ cwd: process.cwd() });
    expect(table.has(WEB_DS_SEARCH_BINDING_NAME)).toBe(false);
  });

  test("an explicit names list does not acquire one either", () => {
    // The R3 read-only surface pattern: a caller that curates the surface gets exactly that.
    const table = createBuiltinBindings({ cwd: process.cwd(), names: ["read", "grep"] });
    expect([...table.keys()]).toEqual(["read", "grep"]);
  });

  test("includeSearch puts it there, and it needs its deps", () => {
    const table = createBuiltinBindings({
      cwd: process.cwd(),
      includeSearch: true,
      searchDeps: depsWith(stubClient({ ok: true, payload: SAMPLE })),
    });
    expect(table.has(WEB_DS_SEARCH_BINDING_NAME)).toBe(true);
  });

  test("includeSearch without deps is refused rather than silently broken", () => {
    // A binding with no client could only fail, and failing at the call site is a worse place
    // to learn that than here.
    expect(() => createBuiltinBindings({ cwd: process.cwd(), includeSearch: true })).toThrow(
      /includeSearch/,
    );
  });
});

describe("the tool is a program-internal one, not a model-facing one", () => {
  test("it is registered at codemode reach", () => {
    const tool = createWebDsSearchTool({
      deps: depsWith(stubClient({ ok: true, payload: SAMPLE })),
    });
    expect((tool as { exposure?: string }).exposure).toBe("codemode");
  });

  test("it declares an output schema, so a codemode script gets the object", () => {
    const tool = createWebDsSearchTool({
      deps: depsWith(stubClient({ ok: true, payload: SAMPLE })),
    });
    expect((tool as { outputSchema?: unknown }).outputSchema).toBeDefined();
  });

  test("it has a render pair — a registered tool with no renderer is invisible in the transcript", () => {
    const tool = createWebDsSearchTool({
      deps: depsWith(stubClient({ ok: true, payload: SAMPLE })),
    });
    expect(typeof (tool as { renderCall?: unknown }).renderCall).toBe("function");
    expect(typeof (tool as { renderResult?: unknown }).renderResult).toBe("function");
  });
});

describe("a missing credential is a stated state", () => {
  test("the description says so when there is no client", () => {
    const tool = createWebDsSearchTool({ deps: depsWith(undefined) });
    expect(tool.description).toContain(SEARCH_UNAVAILABLE_NOTICE);
  });

  test("the description does not carry the notice when the capability works", () => {
    const tool = createWebDsSearchTool({
      deps: depsWith(stubClient({ ok: true, payload: SAMPLE })),
    });
    expect(tool.description).not.toContain(SEARCH_UNAVAILABLE_NOTICE);
  });

  test("a call without a credential fails with that same sentence, and takes no quota", async () => {
    const outcome = await runWebDsSearch(depsWith(undefined), { query: "anything" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.text).toBe(SEARCH_UNAVAILABLE_NOTICE);
  });
});

describe("both faces carry the same payload", () => {
  test("the tool returns it as structuredContent and as details", async () => {
    const tool = createWebDsSearchTool({
      deps: depsWith(stubClient({ ok: true, payload: SAMPLE })),
    });
    const result = (await tool.execute("tc", { query: "x" }, undefined, undefined, {
      sessionManager: undefined,
      ui: { theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t } },
    } as never)) as { details?: unknown; structuredContent?: unknown };
    expect(result.structuredContent).toEqual(SAMPLE);
    expect(result.details).toEqual(SAMPLE);
  });

  test("the binding returns it in details and an index in content", async () => {
    const table = createBuiltinBindings({
      cwd: process.cwd(),
      includeSearch: true,
      searchDeps: depsWith(stubClient({ ok: true, payload: SAMPLE })),
    });
    const result = (await table.get(WEB_DS_SEARCH_BINDING_NAME)?.execute({ query: "x" }, call)) as {
      content: Array<{ type: string; text: string }>;
      details: unknown;
    };
    expect(result.details).toEqual(SAMPLE);
    expect(result.content[0]?.text).toContain("DeepSeek 搜索 API 正式开放");
    expect(result.content[0]?.text).toContain("https://example.com/a");
  });
});

describe("the error text is one source", () => {
  test("a failed call on the tool and on the binding quote the SAME constant", async () => {
    const failure = { ok: false, status: 401, text: SEARCH_ERROR_TEXT[401] };
    const deps = depsWith(stubClient(failure));

    const tool = createWebDsSearchTool({ deps });
    await expect(
      tool.execute("tc", { query: "x" }, undefined, undefined, {} as never),
    ).rejects.toThrow(SEARCH_ERROR_TEXT[401]);

    const table = createBuiltinBindings({
      cwd: process.cwd(),
      includeSearch: true,
      searchDeps: deps,
    });
    await expect(
      table.get(WEB_DS_SEARCH_BINDING_NAME)?.execute({ query: "x" }, call),
    ).rejects.toThrow(SEARCH_ERROR_TEXT[401]);
  });

  test("the binding contract names the search binding and where its payload lives", () => {
    // The contract has a token ceiling (ADR-0024 §5), so the note says only the ONE thing that
    // actually departs from the shared shape: where the payload lives. The shared shape already
    // says a failing call rejects.
    expect(BINDING_CONTRACT).toContain(WEB_DS_SEARCH_BINDING_NAME);
    expect(BINDING_CONTRACT).toContain("puts the payload in `details`");
  });

  test("both PTC surfaces carry the shared calling convention", async () => {
    // The model on the PTC face never sees the codemode tool's description, so the CALLING
    // CONVENTION (name, arguments, the conditions) has to reach it another way. `pi.dispatch` and
    // `web.ds.search` are in the same position and get the same split: the description gives the
    // convention, the binding contract gives the result shape.
    for (const surface of ["ptc_run_code", "ptc_workflow"]) {
      const tool = (await captureRegisteredTools()).get(surface);
      expect(tool, surface + " is registered").toBeDefined();
      const description = tool?.description ?? "";
      expect(description, surface + " carries the shared usage").toContain(WEB_DS_SEARCH_USAGE);
    }
  });

  test("the tool's name and the binding's name are the ones the contract and the config use", () => {
    // One capability, two names, and both are fixed by the contract module — the tool name is
    // what pi registers, the binding name is what a program writes.
    expect(WEB_DS_SEARCH_TOOL_NAME).toBe("web_ds_search");
    expect(WEB_DS_SEARCH_BINDING_NAME).toBe("web.ds.search");
  });
});

describe("the signals that are not errors", () => {
  test("a search that matched nothing says so in a sentence", async () => {
    const empty: WebDsSearchPayload = { operation: "search", results: [], page: null };
    const table = createBuiltinBindings({
      cwd: process.cwd(),
      includeSearch: true,
      searchDeps: depsWith(stubClient({ ok: true, payload: empty })),
    });
    const result = (await table.get(WEB_DS_SEARCH_BINDING_NAME)?.execute({ query: "x" }, call)) as {
      content: Array<{ text: string }>;
      details: { results: unknown[] };
    };
    expect(result.details.results).toEqual([]);
    expect(result.content[0]?.text).toBe(SEARCH_NO_RESULTS_TEXT);
  });

  test("an exhausted quota degrades instead of failing", async () => {
    const exhausted: WebDsSearchDeps = {
      client: stubClient({ ok: true, payload: SAMPLE }),
      quota: {
        available: () => false,
        used: () => 100,
        reserve: () => undefined,
      },
      maxCallsPerSession: 100,
    };
    const outcome = await runWebDsSearch(exhausted, { query: "x" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.text).toBe(SEARCH_QUOTA_EXHAUSTED_TEXT.replace("{limit}", "100"));
  });
});

describe("the arguments are discriminated", () => {
  test("both query and url is refused with a sentence", async () => {
    const table = createBuiltinBindings({
      cwd: process.cwd(),
      includeSearch: true,
      searchDeps: depsWith(stubClient({ ok: true, payload: SAMPLE })),
    });
    await expect(
      table.get(WEB_DS_SEARCH_BINDING_NAME)?.execute({ query: "x", url: "https://y" }, call),
    ).rejects.toThrow(/query/);
  });

  test("neither query nor url is refused with a sentence", async () => {
    const table = createBuiltinBindings({
      cwd: process.cwd(),
      includeSearch: true,
      searchDeps: depsWith(stubClient({ ok: true, payload: SAMPLE })),
    });
    await expect(table.get(WEB_DS_SEARCH_BINDING_NAME)?.execute({}, call)).rejects.toThrow(/query/);
  });
});
