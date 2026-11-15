// OCR 能力面（pi，ADR-0028）：工作区 jail（字面 + 软链）· 官方坐标标记剥离 · 12k 预算整页丢弃
//                      · 官方 finish_reason:length 告知 · multipart 字段名/文件名 · 记忆免重复计费。
// 探针直接打产物（packages/search/dist）——仓规：验的是发布物形态。
// 假绿纪律：每条断言都对着一个**具体行为**——「失败不耗配额」「空结果不耗配额」「记忆命中不重复计费」
// 这三处是最容易写着写着就假绿的（第一次失败、第二次成功才证明失败没耗配额）。
// 副作用 import：装一份假 pi 到 PATH（见 helpers/pi-harness.ts 的说明）
import "../helpers/pi-harness.ts";
import { createServer } from "node:http";
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  SEARCH_TEXT_BUDGET_CHARS,
  createDeepSeekOcrProvider,
  createSearchMemory,
  createSearchQuota,
  renderOcrText,
  resolveJailed,
  runOcr,
  stripOcrMarkup,
} from "../../packages/search/dist/index.js";

const fakeProvider = (pages: Array<{ index: number; text: string; finishReason?: string }>) => ({
  id: "fake",
  calls: 0,
  async ocr() {
    this.calls += 1;
    return { ok: true as const, value: { pageCount: pages.length, pages } };
  },
});

it("jail：工作区外的路径被拒，软链指向外部也拒", () => {
  const root = mkdtempSync(join(tmpdir(), "ptc-ocr-root-"));
  const outside = mkdtempSync(join(tmpdir(), "ptc-ocr-outside-"));
  writeFileSync(join(root, "in.pdf"), "x");
  writeFileSync(join(outside, "secret.txt"), "s");
  symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));

  expect(resolveJailed(root, "in.pdf")).toBe(realpathSync(join(root, "in.pdf")));
  expect(() => resolveJailed(root, join(outside, "secret.txt"))).toThrow(/越出工作区/);
  expect(() => resolveJailed(root, "link.txt")).toThrow(/越出工作区/);
});

it("官方坐标标记要剥掉（剥标记不剥字：<ref> 包着的是正文）", () => {
  const official = "<｜ref｜>标题<｜ref｜><｜box｜>[[52, 40, 948, 96]]<｜box｜>正文";
  expect(stripOcrMarkup(official)).toBe("标题正文");
  const bare = "标题<｜box｜>[[52, 40, 948, 96]]<｜box｜>正文";
  expect(stripOcrMarkup(bare)).toBe("标题正文");
});

it("归约：预算外整页丢弃并明说省略了哪些；官方按页截断的页也要明说", () => {
  const pages = [
    { index: 0, text: "A".repeat(80), finishReason: "stop" },
    { index: 1, text: "B".repeat(80), finishReason: "stop" },
    { index: 2, text: "C".repeat(80), finishReason: "length" },
  ];
  const text = renderOcrText({ pageCount: 3, pages }, 100, "a.pdf");
  expect(text).toMatch(/文件：a\.pdf（共 3 页）/);
  expect(text).toMatch(/第 1 页/);
  expect(text).not.toMatch(/第 2 页/);
  expect(text).toMatch(/放不下的 2 页已省略：2、3/);
  expect(text).toMatch(/第 3 页被官方按页截断/);
});

it("预算默认 12k 字（SEARCH_TEXT_BUDGET_CHARS），超了整页丢弃不是硬切", () => {
  expect(SEARCH_TEXT_BUDGET_CHARS).toBe(12_000);
  const pages = Array.from({ length: 6 }, (_, i) => ({
    index: i,
    text: "x".repeat(6000),
    finishReason: "stop",
  }));
  const text = renderOcrText({ pageCount: pages.length, pages }, SEARCH_TEXT_BUDGET_CHARS, "b.pdf");
  // 第一页永远给；后面每页约 6013 字，第二页就挤不进 12000 ⇒ 整页丢弃并明说省略了哪些
  expect(text).toMatch(/放不下的 5 页已省略：2、3、4、5、6/);
  expect(text).not.toMatch(/第 2 页/);
});

it("runOcr：同一份文件第二次走记忆（不再发请求、不再占配额）", async () => {
  const root = mkdtempSync(join(tmpdir(), "ptc-ocr-run-"));
  writeFileSync(join(root, "a.pdf"), "x");
  const provider = fakeProvider([{ index: 0, text: "正文" }]);
  const context = {
    provider,
    memory: createSearchMemory(),
    quota: createSearchQuota(10),
    root,
  };

  const first = await runOcr("a.pdf", context);
  expect(first.ok).toBe(true);
  expect(provider.calls).toBe(1);
  expect(first.cached).toBe(false);

  const second = await runOcr("a.pdf", context);
  expect(second.ok).toBe(true);
  expect(provider.calls, "记忆命中不该再打 provider").toBe(1);
  expect(second.cached).toBe(true);
  expect(second.ok && second.text).toMatch(/记忆命中/);
});

it("runOcr：配额用尽就拒（进程级总护栏），越界路径在发请求前就被拒", async () => {
  const root = mkdtempSync(join(tmpdir(), "ptc-ocr-quota-"));
  writeFileSync(join(root, "a.pdf"), "x");
  writeFileSync(join(root, "b.pdf"), "x");
  const provider = fakeProvider([{ index: 0, text: "正文" }]);
  const context = {
    provider,
    memory: createSearchMemory(),
    quota: createSearchQuota(1),
    root,
  };

  expect((await runOcr("a.pdf", context)).ok).toBe(true);
  const exhausted = await runOcr("b.pdf", context);
  expect(exhausted.ok).toBe(false);
  expect(exhausted.ok ? "" : exhausted.error).toMatch(/配额已用尽/);

  const escaped = await runOcr("../escape.pdf", context);
  expect(escaped.ok).toBe(false);
  expect(escaped.ok ? "" : escaped.error).toMatch(/越出工作区/);
});

it("配额口径：provider 失败不耗配额（官方：失败不计费）", async () => {
  const root = mkdtempSync(join(tmpdir(), "ptc-ocr-fail-"));
  writeFileSync(join(root, "a.pdf"), "x");
  writeFileSync(join(root, "b.pdf"), "x");
  // 第一次失败、第二次成功：第二次还能跑到 provider，才证明失败没耗配额
  const provider = {
    id: "fake",
    calls: 0,
    async ocr() {
      this.calls += 1;
      return this.calls === 1
        ? { ok: false as const, status: 500, error: "boom" }
        : { ok: true as const, value: { pageCount: 1, pages: [{ index: 0, text: "正文" }] } };
    },
  };
  const context = {
    provider,
    memory: createSearchMemory(),
    quota: createSearchQuota(1),
    root,
  };

  expect((await runOcr("a.pdf", context)).ok).toBe(false);
  const after = await runOcr("b.pdf", context);
  expect(after.ok, "失败不该耗配额——官方口径是失败不计费").toBe(true);
  expect(provider.calls).toBe(2);
});

it("配额口径：HTTP 200 但无结果不耗配额（官方：200 且有结果才计费）", async () => {
  const root = mkdtempSync(join(tmpdir(), "ptc-ocr-empty-"));
  writeFileSync(join(root, "a.pdf"), "x");
  writeFileSync(join(root, "b.pdf"), "x");
  const provider = fakeProvider([]);
  const context = {
    provider,
    memory: createSearchMemory(),
    quota: createSearchQuota(1),
    root,
  };

  expect((await runOcr("a.pdf", context)).ok).toBe(true);
  const after = await runOcr("b.pdf", context);
  expect(after.ok, "空结果不该耗配额").toBe(true);
  expect(provider.calls).toBe(2);
});

it("空结果不进记忆：一次识别失败不该被固化成「这份文件就是空的」", async () => {
  const root = mkdtempSync(join(tmpdir(), "ptc-ocr-empty-cache-"));
  writeFileSync(join(root, "a.pdf"), "x");
  const provider = fakeProvider([]);
  const context = {
    provider,
    memory: createSearchMemory(),
    quota: createSearchQuota(5),
    root,
  };

  const first = await runOcr("a.pdf", context);
  expect(first.ok).toBe(true);
  expect(provider.calls, "第一次该真的请求了官方").toBe(1);

  // 空结果 ⇒ 不得进记忆（否则第二次命中缓存、永远不再请求官方——一次失败被永久固化）
  const second = await runOcr("a.pdf", context);
  expect(second.ok).toBe(true);
  expect(provider.calls, "空结果不该进记忆 ⇒ 第二次仍该请求官方").toBe(2);
  expect(second.ok && second.cached, "第二次不该是记忆命中").toBe(false);
});

it("provider：真发 multipart（官方要 file 与 purpose 两个字段），响应前的换行保活也能解析", async () => {
  let captured: { contentType: string; body: string } | undefined;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      captured = { contentType: req.headers["content-type"] ?? "", body };
      res.writeHead(200, { "content-type": "application/json" });
      // 官方：识别期间持续发换行保活 ⇒ 整个响应体是 JSON，前面带换行
      res.end(
        "\n\n" +
          JSON.stringify({
            id: "ocr-1",
            page_count: 2,
            pages: [
              { index: 0, text: "第一页", finish_reason: "stop" },
              { index: 1, text: "第二页", finish_reason: "length" },
            ],
          }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const root = mkdtempSync(join(tmpdir(), "ptc-ocr-http-"));
  writeFileSync(join(root, "doc.pdf"), "PDF-BYTES");

  try {
    const provider = createDeepSeekOcrProvider("sk-test", {
      baseUrl: `http://127.0.0.1:${port}/v1/tools/ocr`,
    });
    const outcome = await provider.ocr("doc.pdf", root);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.pageCount).toBe(2);
    expect(outcome.value.pages[0]!.text).toBe("第一页");
    expect(outcome.value.pages[1]!.finishReason).toBe("length");

    expect(captured!.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(captured!.body).toMatch(/name="purpose"/);
    expect(captured!.body).toMatch(/text_recognition/);
    expect(captured!.body).toMatch(/name="file"; filename="doc\.pdf"/);
    expect(captured!.body).toMatch(/PDF-BYTES/);
  } finally {
    server.close();
  }
});

it("provider：HTTP 200 但 body 是错误对象时，按失败返回（官方识别失败的形态）", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "OCR did not finish in time" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const root = mkdtempSync(join(tmpdir(), "ptc-ocr-err-"));
  writeFileSync(join(root, "doc.pdf"), "x");

  try {
    const provider = createDeepSeekOcrProvider("sk-test", {
      baseUrl: `http://127.0.0.1:${port}/v1/tools/ocr`,
    });
    const outcome = await provider.ocr("doc.pdf", root);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.error).toMatch(/OCR did not finish in time/);
  } finally {
    server.close();
  }
});
