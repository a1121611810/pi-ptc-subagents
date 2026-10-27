// F7/F8/F9 → 测试：值树契约截断 / worker 池复用回归 / 任务面可见性不撤用户固定的工具
// 基准图：docs/prototypes/full-flow-anatomy.html ⑦值树 + ④worker 池 + ⑫任务面可见性（F9）
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderModelValue } from "../packages/tui/dist/index.js";
import { WorkerPool, runPtcProgram, spawnPtcWorker } from "../packages/ptc/dist/index.js";
import entryDefault from "../packages/entry/dist/index.js";

test("F7 值树契约（ADR-0016）：每层子项截 6 + 余量标记；行宽 120；小值形态不变", () => {
  const arr = Array.from({ length: 10 }, (_, i) => `a${i}`);
  const out = renderModelValue(arr);
  assert.ok(out.includes("余 4 项"), "数组超 6 项应有余量标记: " + out);
  assert.ok(!out.includes("a6"), "第 7 项不该渲染: " + out);
  assert.ok(out.includes("a5"), "第 6 项该渲染: " + out);
  const obj = renderModelValue({ k1: 1, k2: 2, k3: 3, k4: 4, k5: 5, k6: 6, k7: 7, k8: 8 });
  assert.ok(obj.includes("余 2 项"), "对象超 6 键应有余量标记: " + obj);
  assert.equal(renderModelValue([1, 2, 3]), "[1, 2, 3]", "小数组形态不该变");
  const long = renderModelValue({ note: "x".repeat(300) });
  const longest = long.split("\n").reduce((m, l) => Math.max(m, l.length), 0);
  assert.ok(longest <= 121, `行宽超契约 120(+…): ${longest}`);
  const nested = renderModelValue(Array.from({ length: 8 }, () => [1, 2]));
  assert.ok(nested.includes("余 2 项"), "嵌套数组外层也该截断: " + nested.slice(0, 80));
});

test("F8 池复用：同一 worker 三连 run（归还时摘除监听后 reset 握手仍正常）", async () => {
  // node --test 会给宿主进程注入 Worker 不认的 execArgv（--stack-trace-limit 等）；
  // 真实宿主只有 eval 系参数（spawnPtcWorker 的 deny list 已剥）——测试进程里清空再跑
  const savedExecArgv = process.execArgv.splice(0, process.execArgv.length);
  try {
    const pool = new WorkerPool(spawnPtcWorker);
    const run = (v) =>
      runPtcProgram({ code: `return ${v}`, bindings: {}, pool, timeoutMs: 20_000 });
    const r1 = await run(1);
    const r2 = await run(2);
    const r3 = await run(3);
    assert.equal(r1.value, 1);
    assert.equal(r2.value, 2);
    assert.equal(r3.value, 3);
    pool.drain();
  } finally {
    process.execArgv.push(...savedExecArgv);
  }
});

test("F9 任务面可见性：零记录清扫不撤用户自己固定的任务面工具", async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "f9-entry-"))); // storageDir 落 tmp，别写仓库
  const handlers = {};
  let active = [];
  const registered = {};
  const fakePi = {
    on: (ev, cb) => {
      (handlers[ev] ??= []).push(cb);
    },
    registerTool: (def) => {
      registered[def.name] = def;
    },
    registerCommand: () => {},
    getActiveTools: () => [...active],
    setActiveTools: (names) => {
      active = [...names];
    },
    getAllTools: () => [],
    sendMessage: () => {},
  };
  entryDefault(fakePi);
  await handlers.session_start[0]({}, { ui: { notify: () => {} } });
  // 用户在 loadout 里自己固定了任务面工具（扩展从没加过它）
  active = ["read", "bash", "ptc_task_list"];
  handlers.before_agent_start[0]({ systemPromptOptions: { sections: {} } });
  assert.ok(active.includes("ptc_task_list"), "F9 失败：用户固定的工具被撤了");
  assert.ok(active.includes("read") && active.includes("bash"), "无关工具被动了");
});
