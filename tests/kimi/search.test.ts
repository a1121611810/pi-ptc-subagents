// Kimi 面搜索核（宿主中立）：DeepSeek HTTP 契约 / 记忆桶 / 配额 / 三动作。
// 探针直接打产物（packages/search/dist/index.js）——仓规：验的是发布物形态。
// fetch 在产物里是自由变量（全局）⇒ 用 vi.stubGlobal 换掉，不碰网络。
import { afterEach, expect, it, vi } from "vitest";
import {
  SEARCH_COUNT_RANGE,
  SEARCH_DEFAULT_COUNT,
  SEARCH_MEMORY_MAX_CHARS,
  SEARCH_MEMORY_MAX_ENTRIES,
  createDeepSeekProvider,
  createSearchMemory,
  createSearchQuota,
  renderSearchOverview,
  retryHint,
  runWebSearch,
  urlsLooselyEqual,
} from "../../packages/search/dist/index.js";

interface Match {
  title: string;
  url: string;
  snippet?: string;
}

// 假 provider：记调用次数（记忆命中免重复计费靠它验）
function fakeProvider(
  opts: { matches?: Match[]; page?: string; searchError?: { status: number; error: string } } = {},
) {
  const calls = { search: 0, open: 0 };
  return {
    calls,
    provider: {
      id: "fake",
      async search(query: string, options?: { count?: number }) {
        calls.search += 1;
        void query;
        void options;
        if (opts.searchError)
          return {
            ok: false as const,
            status: opts.searchError.status,
            error: opts.searchError.error,
          };
        return { ok: true as const, value: opts.matches ?? [] };
      },
      async open(url: string) {
        calls.open += 1;
        void url;
        return { ok: true as const, value: opts.page ?? "" };
      },
    },
  };
}

function stubFetch(status: number, body: string) {
  const mock = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it("search-provider：200 的 results 解析成条目（title/url/snippet）", async () => {
  stubFetch(
    200,
    JSON.stringify({
      results: [
        { title: "T1", url: "https://a.test/1", snippet: "S1" },
        { title: "T2", link: "https://a.test/2" },
      ],
    }),
  );
  const outcome = await createDeepSeekProvider("sk-x").search("q");
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return;
  expect(outcome.value).toEqual([
    {
      title: "T1",
      url: "https://a.test/1",
      snippet: "S1",
      summary: undefined,
      rank: undefined,
      date: undefined,
    },
    {
      title: "T2",
      url: "https://a.test/2",
      snippet: undefined,
      summary: undefined,
      rank: undefined,
      date: undefined,
    },
  ]);
});

it("search-provider：请求契约——POST /search 带 Bearer key 与 count", async () => {
  const mock = stubFetch(200, JSON.stringify({ results: [] }));
  await createDeepSeekProvider("sk-contract").search("query-1", { count: 5 });
  const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://api.deepseek.com/v1/tools/search");
  expect(init.method).toBe("POST");
  expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-contract");
  expect(JSON.parse(String(init.body))).toEqual({ query: "query-1", count: 5 });
});

it("search-provider：HTTP 非 2xx 落失败形状（status + 重试指引）", async () => {
  stubFetch(500, "upstream exploded");
  const outcome = await createDeepSeekProvider("sk-x").search("q");
  expect(outcome.ok).toBe(false);
  if (outcome.ok) return;
  expect(outcome.status).toBe(500);
  expect(outcome.error).toContain("临时性失败");
});

it("search-provider：200 也可能是错误对象——不得变成命中条目", async () => {
  stubFetch(200, JSON.stringify({ error: { message: "rate limited", code: 429 } }));
  const provider = createDeepSeekProvider("sk-x");
  const outcome = await provider.search("q");
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return;
  expect(outcome.value).toEqual([]); // 错误对象没有 results/data ⇒ 零命中，不是假命中
  // 端到端：这一路落「没有命中」，且不耗配额（官方口径：200 空结果不计费）
  const quota = createSearchQuota(5);
  const result = await runWebSearch(
    { kind: "search", query: "q" },
    { provider, memory: createSearchMemory(), quota },
  );
  expect(result.ok).toBe(true);
  expect(result.ok && result.text).toBe("「q」没有命中。");
  expect(quota.remaining()).toBe(5);
});

it("search-provider：redact 把 key 从错误文本里抹掉", async () => {
  stubFetch(500, "key sk-secret leaked");
  const outcome = await createDeepSeekProvider("sk-secret").search("q");
  expect(outcome.ok).toBe(false);
  if (outcome.ok) return;
  expect(outcome.error).not.toContain("sk-secret");
  expect(outcome.error).toContain("[REDACTED]");
});

it("search-provider：retryHint 按官方错误表给指引", () => {
  expect(retryHint(402)).toContain("充值");
  expect(retryHint(408)).toContain("稍后重试");
  expect(retryHint(429)).toContain("稍后重试");
  expect(retryHint(503)).toContain("稍后重试");
  expect(retryHint(400)).toContain("请求不合法");
  expect(retryHint(0)).toContain("网络不可达");
  expect(retryHint(200)).toBe("");
});

it("search-memory：open 命中记忆不发请求也不耗配额", async () => {
  const { provider, calls } = fakeProvider({ page: "page body" });
  const memory = createSearchMemory();
  const quota = createSearchQuota(5);
  const context = { provider, memory, quota };

  const first = await runWebSearch({ kind: "open", url: "https://a.test/page" }, context);
  expect(first.ok).toBe(true);
  expect(calls.open).toBe(1);
  expect(quota.remaining()).toBe(4);

  const second = await runWebSearch({ kind: "open", url: "https://a.test/page" }, context);
  expect(second.ok).toBe(true);
  expect(second.ok && second.text).toContain("记忆命中，未发请求");
  expect(calls.open).toBe(1); // 命中不再打 provider
  expect(quota.remaining()).toBe(4); // 命中不再耗配额
});

it("search-memory：字符预算超限的正文不入桶", async () => {
  const memory = createSearchMemory();
  memory.storeText("https://a.test/big", "x".repeat(SEARCH_MEMORY_MAX_CHARS + 1));
  expect(memory.lookup("https://a.test/big")).toBeUndefined();
  expect(SEARCH_MEMORY_MAX_CHARS).toBe(400_000);
});

it("search-memory：条目桶容量 5——最老条目连正文一起淘汰", async () => {
  expect(SEARCH_MEMORY_MAX_ENTRIES).toBe(5);
  const memory = createSearchMemory();
  memory.remember("q1", [{ title: "T1", url: "https://a.test/1" }]);
  memory.storeText("https://a.test/1", "body-1");
  expect(memory.lookup("https://a.test/1")).toBe("body-1");
  for (let i = 2; i <= SEARCH_MEMORY_MAX_ENTRIES + 1; i++) {
    memory.remember(`q${i}`, [{ title: `T${i}`, url: `https://a.test/${i}` }]);
  }
  expect(memory.lookup("https://a.test/1")).toBeUndefined(); // 最老条目被淘汰（正文随它走）
  expect(memory.lookup(`https://a.test/${SEARCH_MEMORY_MAX_ENTRIES + 1}`)).toBeUndefined(); // 那是条搜索结果，本来就没正文
});

it("search-memory：url 宽松匹配（尾斜杠/fragment/空 query）", () => {
  expect(urlsLooselyEqual("https://a.test/x", "https://a.test/x/")).toBe(true);
  expect(urlsLooselyEqual("https://a.test/x#frag", "https://a.test/x")).toBe(true);
  expect(urlsLooselyEqual("https://a.test/x?q=1", "https://a.test/x")).toBe(true);
  expect(urlsLooselyEqual("http://a.test/x", "https://a.test/x")).toBe(false);
  expect(urlsLooselyEqual("https://a.test/x", "https://b.test/x")).toBe(false);
  expect(urlsLooselyEqual("https://a.test/x", "https://a.test/y")).toBe(false);
});

it("search-quota：成功一次耗一次", () => {
  const quota = createSearchQuota(2);
  expect(quota.remaining()).toBe(2);
  expect(quota.tryAcquire()).toBe(true);
  quota.release(true);
  expect(quota.remaining()).toBe(1);
});

it("search-quota：失败不耗配额", () => {
  const quota = createSearchQuota(2);
  expect(quota.tryAcquire()).toBe(true);
  quota.release(false);
  expect(quota.remaining()).toBe(2);
});

it("search-quota：空结果不耗配额（200 但 0 条不计费）", async () => {
  const { provider } = fakeProvider({ matches: [] });
  const quota = createSearchQuota(3);
  const result = await runWebSearch(
    { kind: "search", query: "q" },
    { provider, memory: createSearchMemory(), quota },
  );
  expect(result.ok).toBe(true);
  expect(quota.remaining()).toBe(3);
});

it("search-quota：进程级护栏——超上限即拒", async () => {
  const { provider } = fakeProvider({ matches: [{ title: "T", url: "https://a.test/1" }] });
  const quota = createSearchQuota(1);
  const context = { provider, memory: createSearchMemory(), quota };
  const first = await runWebSearch({ kind: "search", query: "q" }, context);
  expect(first.ok).toBe(true);
  const second = await runWebSearch({ kind: "search", query: "q" }, context);
  expect(second.ok).toBe(false);
  expect(!second.ok && second.error).toContain("搜索配额已用尽");
});

it("search-quota：0 表示不限", () => {
  const quota = createSearchQuota(0);
  expect(quota.remaining()).toBe(Infinity);
  for (let i = 0; i < 50; i++) {
    expect(quota.tryAcquire()).toBe(true);
    quota.release(true);
  }
  expect(quota.remaining()).toBe(Infinity);
});

it("search-run：search 动作渲染 title/url/snippet 概览", async () => {
  const { provider } = fakeProvider({
    matches: [{ title: "标题一", url: "https://a.test/1", snippet: "摘要一" }],
  });
  const result = await runWebSearch(
    { kind: "search", query: "q" },
    {
      provider,
      memory: createSearchMemory(),
      quota: createSearchQuota(5),
    },
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.text).toContain("标题一");
  expect(result.text).toContain("url: https://a.test/1");
  expect(result.text).toContain("snippet: 摘要一");
});

it("search-run：open 动作抓整页并按预算截断", async () => {
  const { provider } = fakeProvider({ page: "0123456789ABCDEF" });
  const result = await runWebSearch(
    { kind: "open", url: "https://a.test/page" },
    {
      provider,
      memory: createSearchMemory(),
      quota: createSearchQuota(5),
      textBudgetChars: 10,
    },
  );
  expect(result.ok).toBe(true);
  expect(result.ok && result.text).toBe("0123456789");
});

it("search-run：find 动作页内行匹配（大小写不敏感）", async () => {
  const { provider } = fakeProvider({ page: "Alpha\nbeta\nGAMMA" });
  const context = { provider, memory: createSearchMemory(), quota: createSearchQuota(5) };
  const hit = await runWebSearch(
    { kind: "find", url: "https://a.test/page", pattern: "alpha" },
    context,
  );
  expect(hit.ok).toBe(true);
  expect(hit.ok && hit.text).toBe("1: Alpha");
  const miss = await runWebSearch(
    { kind: "find", url: "https://a.test/page", pattern: "nothing" },
    context,
  );
  expect(miss.ok).toBe(true);
  expect(miss.ok && miss.text).toBe("（页内无匹配行）");
});

it("search-run：find 动作非法正则落失败形状", async () => {
  const { provider } = fakeProvider({ page: "x" });
  const result = await runWebSearch(
    { kind: "find", url: "https://a.test/page", pattern: "(" },
    {
      provider,
      memory: createSearchMemory(),
      quota: createSearchQuota(5),
    },
  );
  expect(result.ok).toBe(false);
  expect(!result.ok && result.error).toContain("非法正则");
});

it("search-run：概览超预算按排名整条丢弃并告知", () => {
  const matches: Match[] = [
    { title: "T1", url: "https://a.test/1" },
    { title: "T2", url: "https://a.test/2" },
    { title: "T3", url: "https://a.test/3" },
  ];
  const text = renderSearchOverview(matches, 30);
  expect(text).toContain("T1");
  expect(text).not.toContain("T3");
  expect(text).toContain("按排名整条丢弃");
});

it("search-run：count 越界被夹回 1–50（默认 10）", () => {
  expect(SEARCH_COUNT_RANGE).toEqual({ min: 1, max: 50 });
  expect(SEARCH_DEFAULT_COUNT).toBe(10);
});
