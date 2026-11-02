// 程序内任务记录检索（tools.task_records）：机械扫描在宿主，筛选/归约在程序里
// 性质（真机实测 2026-10-31）：正则跑在 worker（有 terminate 兜底），宿主没有隔离
import test from "node:test";
import assert from "node:assert/strict";
import { runPtcProgram } from "../../packages/entry/dist/ptc/index.js";

const RECORDS = [
  { id: "a", task: "读 AGENTS.md 汇总口径", status: "succeeded" },
  { id: "b", task: "跑三制测试", status: "succeeded" },
  { id: "c", task: "查归档 gz 形状", status: "succeeded" },
];

test("程序内：正则筛 + 只回几条 ⇒ 进上下文的只有归约结果", async () => {
  const seen = [];
  const out = await runPtcProgram({
    code: `
      const all = await tools.task_records({ scope: "all" });
      const hits = all.filter((r) => /口径|测试/.test(r.task)).map((r) => r.id);
      return { total: all.length, hits };
    `,
    bindings: {
      task_records: async (args) => {
        seen.push(args ?? null);
        return RECORDS;
      },
    },
    timeoutMs: 20_000,
  });
  assert.equal(out.status, "fulfilled", out.error);
  assert.deepEqual(out.value, { total: 3, hits: ["a", "b"] });
  assert.deepEqual(seen, [{ scope: "all" }], "scope 该原样传到宿主");
});

test("病态正则：worker 被超时收尸，宿主不死（随后还能再跑程序）", async () => {
  const out = await runPtcProgram({
    code: `
      const all = await tools.task_records({ scope: "all" });
      return all.filter((r) => /^(a+)+$/.test(r.task)).length;
    `,
    bindings: {
      // 样本必须让正则「匹配失败」才触发回溯爆炸：纯 a 串第一把就匹配成功
      task_records: async () => [{ id: "x", task: "a".repeat(40) + "b" }],
    },
    timeoutMs: 1_000,
  });
  assert.equal(out.status, "canceled", "病态正则该被超时收尸");
  assert.match(out.reason, /timeout after 1000ms/);

  const after = await runPtcProgram({ code: "return 1 + 1;", bindings: {}, timeoutMs: 20_000 });
  assert.equal(after.status, "fulfilled", "宿主该活着");
  assert.equal(after.value, 2);
});
