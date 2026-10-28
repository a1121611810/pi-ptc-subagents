// 减量改动 → 测试：①孩子 argv 的三旗标与 --no-mcp 版本门（floor 0.86 无此旗标，实测 1.1.0 才出现）
// ②jsonl 解析接 pi ≥1.4.0 的 usage.cacheRead/cacheWrite（旧版缺省为 undefined）
// 依据：docs/prototypes/dispatch-doors-flow.html 第七节字段表（usage 对齐）+ gotchas/prompt-cache-dead-for-fork-per-task-children
import test from "node:test";
import assert from "node:assert/strict";
import { buildPiArgv } from "../packages/dispatch/dist/index.js";
import { parseChildStream } from "../packages/dispatch/dist/index.js";

const BASE = { task: "do the thing" };
const CTX = { depth: 1 };

test("argv 恒带 --no-extensions/--no-skills（floor 0.86 已存在，pi help 明示显式 -e 不受影响）", () => {
  const argv = buildPiArgv(BASE, CTX);
  assert.ok(argv.includes("--no-extensions"));
  assert.ok(argv.includes("--no-skills"));
  // 缺省（无版本信息）按 floor 处理：不发 --no-mcp
  assert.ok(!argv.includes("--no-mcp"));
});

test("argv：--no-mcp 按宿主版本门控（1.1.0 起）", () => {
  for (const v of ["1.1.0", "1.4.0", "2.0.0"]) {
    const argv = buildPiArgv(BASE, { ...CTX, piVersion: v });
    assert.ok(argv.includes("--no-mcp"), `${v} 应有 --no-mcp`);
  }
  for (const v of ["0.86.0", "0.99.0", "1.0.2"]) {
    const argv = buildPiArgv(BASE, { ...CTX, piVersion: v });
    assert.ok(!argv.includes("--no-mcp"), `${v} 不应有 --no-mcp`);
  }
  // 解不出版本（探针/异常路径）也按 floor 处理
  for (const v of ["", "garbage", undefined]) {
    const argv = buildPiArgv(BASE, { ...CTX, piVersion: v });
    assert.ok(!argv.includes("--no-mcp"), `${JSON.stringify(v)} 不应有 --no-mcp`);
  }
});

test("argv：既有语义不受旗标影响（strict 白名单 / childReport:false / -e 由引擎追加）", () => {
  const strictArgv = buildPiArgv({ ...BASE, readOnly: "strict" }, CTX);
  const toolsIdx = strictArgv.indexOf("--tools");
  assert.equal(strictArgv[toolsIdx + 1], "read,grep,find,ls");
  const noReportArgv = buildPiArgv({ ...BASE, childReport: false }, CTX);
  const block = noReportArgv[noReportArgv.indexOf("--append-system-prompt") + 1];
  assert.ok(!block.includes("child-report-contract"));
});

test("jsonl：usage 携带 cacheRead/cacheWrite 时进 observedUsage（pi 1.4.0 形状）", () => {
  const line = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      model: "MiniMax-M3.1-Flash",
      content: [{ type: "text", text: "done" }],
      usage: { input: 7354, output: 4, cacheRead: 128, cacheWrite: 0, cost: { total: 0 } },
    },
  });
  const parsed = parseChildStream(line + "\n");
  assert.equal(parsed.observedUsage?.cacheRead, 128);
  assert.equal(parsed.observedUsage?.cacheWrite, 0);
  assert.equal(parsed.observedUsage?.input, 7354);
});

test("jsonl：旧版 usage 无缓存字段时 observedUsage 相应缺省（floor 兼容）", () => {
  const line = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      usage: { input: 100, output: 5 },
    },
  });
  const parsed = parseChildStream(line + "\n");
  assert.equal(parsed.observedUsage?.input, 100);
  assert.equal(parsed.observedUsage?.cacheRead, undefined);
  assert.equal(parsed.observedUsage?.cacheWrite, undefined);
});
