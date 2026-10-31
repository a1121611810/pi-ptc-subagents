// 子代理运行时契约 → 测试：
// ①引擎默认 spawn 必须把 env 交给子进程（PI_PTC_DEPTH/PI_PTC_TASK_ID）——丢 env = 孩子按 depth=0 完整装配
// ②timeoutMs 开关：给了才计时收尸；不传 = 原行为（不限、不杀）
// ③自报 usage 恒为 0 时要让位给宿主观测值（否则父在任务面看到的永远是 0）
import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskEngine,
  TaskRegistry,
  InMemoryOutputStorage,
} from "../../packages/dispatch/dist/index.js";

test("①：默认 spawn 把 env 交给子进程（孩子看得到 depth 与父任务 id）", async () => {
  const registry = new TaskRegistry();
  const engine = new TaskEngine({
    registry,
    output: new InMemoryOutputStorage(),
    // 用 node 冒充 pi：只验 env 到了子进程，不起真 pi
    buildArgv: () => [
      "node",
      "-e",
      "process.stdout.write(String(process.env.PI_PTC_DEPTH) + ' ' + String(process.env.PI_PTC_TASK_ID))",
    ],
  });
  const r = await engine.dispatch({ task: "x", wait: true });
  assert.equal(r.status, "fulfilled");
  assert.equal(r.text, `1 ${r.taskId}`);
});

function fakeSpawn({ autoExitMs = null, stdout = "" } = {}) {
  const kills = [];
  const spawn = () => {
    let outCb, exitCb;
    if (autoExitMs !== null) {
      const timer = setTimeout(() => {
        outCb?.(stdout);
        exitCb?.(0, "");
      }, autoExitMs);
      timer.unref();
    }
    return {
      pid: 4242,
      onOutput: (cb) => {
        outCb = cb;
      },
      onExit: (cb) => {
        exitCb = cb;
      },
      kill: (signal) => {
        kills.push(signal);
        exitCb?.(-1, "");
      },
    };
  };
  return { spawn, kills };
}

test("②：给了 timeoutMs → 超时收尸（canceled + stopReason 写明超时）", async () => {
  const registry = new TaskRegistry();
  const { spawn, kills } = fakeSpawn({ autoExitMs: 5_000 });
  const engine = new TaskEngine({
    registry,
    output: new InMemoryOutputStorage(),
    spawnChild: spawn,
  });
  const r = await engine.dispatch({ task: "x", wait: true, timeoutMs: 30 });
  assert.equal(r.status, "canceled");
  assert.equal(r.errorMessage, "timeout after 30ms");
  assert.deepEqual(kills, ["SIGTERM"]);
  assert.equal(registry.get(r.taskId).status, "canceled");
});

test("②：不传 timeoutMs → 原行为（不限、不杀）", async () => {
  const registry = new TaskRegistry();
  const { spawn, kills } = fakeSpawn({ autoExitMs: 20 });
  const engine = new TaskEngine({
    registry,
    output: new InMemoryOutputStorage(),
    spawnChild: spawn,
  });
  const r = await engine.dispatch({ task: "x", wait: true });
  assert.equal(r.status, "fulfilled");
  assert.deepEqual(kills, []);
});

test("③：孩子自报 usage 全 0 → 用宿主观测值（父在任务面才看得到真实用量）", async () => {
  const registry = new TaskRegistry();
  // 孩子交了工具通道报告（usage 全 0），并上报了自己的 message_end usage
  const stdout = [
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        usage: { input: 1234, output: 56, cacheRead: 78, cacheWrite: 0, cost: { total: 0.5 } },
      },
    }),
    JSON.stringify({
      type: "message_end",
      message: {
        role: "toolResult",
        toolName: "ptc_child_report",
        structuredContent: { summary: "s", usage: { input: 0, output: 0, cost: 0, turns: 1 } },
      },
    }),
  ].join("\n");
  const { spawn } = fakeSpawn({ autoExitMs: 10, stdout });
  const engine = new TaskEngine({
    registry,
    output: new InMemoryOutputStorage(),
    spawnChild: spawn,
  });
  const r = await engine.dispatch({ task: "x", wait: true });
  assert.equal(r.reportChannel, "tool");
  assert.equal(
    r.report?.usage?.input,
    1234,
    "自报 0 应让位给观测值: " + JSON.stringify(r.report?.usage),
  );
  assert.equal(r.report?.usage?.output, 56);
});
