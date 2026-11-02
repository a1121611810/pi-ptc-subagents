// 程序内任务产出读取（tools.task_output）：归约层——孩子的散文正文
//
// 缺口本体（2026-11-01 真机实测）：wait:false 派发只回 handle，程序内 task_records
// 只给元数据（无 text/output 字段）⇒ 孩子正文取不回来。本文件钉住补上的那条路：
// 程序内 task_output({ taskId }) 拿到**归约后的正文**，而不是原始事件流。
//
// 三条：① 归约语义（正文优先 / 查不到给 error / 没正文退回原始尾部+引导）
//       ② 跨程序取回（程序1 wait:false 派发 → 程序2 取回正文）
//       ③ 接线（绑定真进了绑定表）
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPtcProgram } from "../../packages/entry/dist/ptc/index.js";
import {
  TaskEngine,
  TaskRegistry,
  InMemoryOutputStorage,
} from "../../packages/dispatch/dist/index.js";
import { createTaskOutputBinding } from "../../packages/entry/dist/index.js";

// 假 spawn：孩子起跑后 autoExitMs 交出 stdout 并退出（delivery-trail.test.mjs 同款）
function fakeSpawn({ autoExitMs = 10, stdout = "" } = {}) {
  const spawn = () => {
    let outCb, exitCb;
    const timer = setTimeout(() => {
      outCb?.(stdout);
      exitCb?.(0, "");
    }, autoExitMs);
    timer.unref();
    return {
      pid: 4242,
      onOutput: (cb) => {
        outCb = cb;
      },
      onExit: (cb) => {
        exitCb = cb;
      },
      kill: () => exitCb?.(-1, ""),
    };
  };
  return { spawn };
}

// 一条真实形状的子进程事件流：最后一条 assistant 消息的文本 = 孩子正文
function childStream(text) {
  return [
    JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "read",
      args: { path: "materials/topic.md" },
    }),
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text }] },
    }),
  ].join("\n");
}

const TERMINAL = new Set(["succeeded", "failed", "canceled", "lost"]);

// 一个会话的源：形状同 PtcSession（registry + 三个读产出的方法）
function makeSession(stdout) {
  const registry = new TaskRegistry();
  const engine = new TaskEngine({
    registry,
    output: new InMemoryOutputStorage(),
    spawnChild: fakeSpawn({ stdout }).spawn,
  });
  const source = {
    registry,
    readArchivedRecord: async () => undefined,
    outputSize: (id) => engine.outputSize(id),
    readOutput: (id) => engine.readOutput(id),
    readOutputTail: (id, n) => engine.readOutputTail(id, n),
  };
  return { registry, engine, source, binding: createTaskOutputBinding(source) };
}

async function waitTerminal(registry, taskId) {
  for (let i = 0; i < 200; i++) {
    const record = registry.get(taskId);
    if (record && TERMINAL.has(record.status)) return record;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`任务 ${taskId} 没到终态`);
}

test("① 归约层：拿到的是孩子正文（不是原始事件流）；查不到给 error", async () => {
  const { engine, binding } = makeSession(childStream("F2-1 = 36"));
  const dispatched = await engine.dispatch({ task: "读档案", wait: true });
  assert.equal(dispatched.status, "fulfilled");

  const view = await binding({ taskId: dispatched.taskId });
  assert.equal(view.text, "F2-1 = 36", "应给归约后的正文");
  assert.equal(view.output, undefined, "有正文就不给原始尾部");
  assert.equal(view.guidance, undefined, "有正文就不给分层引导");
  assert.equal(view.status, "succeeded", "status 一起给：程序靠它分辨没跑完与没交正文");

  const missing = await binding({ taskId: "not-a-task" });
  assert.match(missing.error, /unknown task id/, "查不到给 error（绑定契约 never throws）");
  const bad = await binding({ taskId: 42 });
  assert.match(bad.error, /taskId/, "参数不合法也给 error，不抛");
  const alias = await binding({ task_id: dispatched.taskId });
  assert.equal(alias.text, "F2-1 = 36", "task_id（模型面工具的拼法）也收");
});

test("① 归档回落：内存里没有的 id，从压缩归档取回（决策 29）", async () => {
  const stream = childStream("归档正文");
  const registry = new TaskRegistry();
  const archived = { id: "arch-1", task: "读档案", status: "succeeded", archived: true };
  const source = {
    registry,
    readArchivedRecord: async (id) => (id === archived.id ? archived : undefined),
    outputSize: async () => Buffer.byteLength(stream, "utf8"),
    readOutput: async () => stream,
    readOutputTail: async () => stream,
  };
  const binding = createTaskOutputBinding(source);
  const view = await binding({ taskId: "arch-1" });
  assert.equal(view.text, "归档正文", "归档回落：正文取得到");
  assert.equal(view.status, "succeeded");
});

test("① 没正文时退回原始尾部 + 分层引导（与模型面 ptc_task_output 同形）", async () => {
  // 孩子起来了但没交正文：事件流里没有 assistant 文本
  const { engine, binding } = makeSession(
    JSON.stringify({ type: "agent_settled", aborted: false }),
  );
  const dispatched = await engine.dispatch({ task: "什么也不说", wait: true });
  assert.equal(dispatched.status, "fulfilled");

  const view = await binding({ taskId: dispatched.taskId });
  assert.equal(view.text, undefined, "没有正文就不给 text");
  assert.ok(view.output, "应退回原始尾部");
  assert.ok(view.guidance, "应给分层引导");
});

test("① 还在跑：归约层是空的，靠 status 分辨「没跑完」与「跑完但没交正文」", async () => {
  const registry = new TaskRegistry();
  // 孩子不退出 ⇒ 一直在跑（产出未落盘 ⇒ 归约层算不出正文）
  const engine = new TaskEngine({
    registry,
    output: new InMemoryOutputStorage(),
    spawnChild: fakeSpawn({ autoExitMs: 60_000 }).spawn,
  });
  const source = {
    registry,
    readArchivedRecord: async () => undefined,
    outputSize: (id) => engine.outputSize(id),
    readOutput: (id) => engine.readOutput(id),
    readOutputTail: (id, n) => engine.readOutputTail(id, n),
  };
  const binding = createTaskOutputBinding(source);

  const handle = await engine.dispatch({ task: "读档案" });
  for (let i = 0; i < 200; i++) {
    if (registry.get(handle.taskId)?.status === "running") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  const view = await binding({ taskId: handle.taskId });
  assert.equal(view.status, "running", "status 要给 running");
  assert.equal(view.text, undefined, "还没跑完 ⇒ 没有正文");
  assert.equal(view.output, undefined, "还没跑完 ⇒ 也没有原始尾部");
});

test("② 跨程序取回：程序1 wait:false 派发 → 程序2 拿到正文", async () => {
  const { engine, registry, binding } = makeSession(childStream("跨程序正文"));
  // 程序1：wait:false —— 只回 handle，正文不在返回值里
  const first = await runPtcProgram({
    code: `
      const h = await tools.pi_task_ptc({ task: "读档案" });
      return { taskId: h.taskId, status: h.status, hasText: typeof h.text === "string" };
    `,
    bindings: { pi_task_ptc: (args) => engine.dispatch(args) },
    timeoutMs: 20_000,
  });
  assert.equal(first.status, "fulfilled", first.error);
  assert.equal(first.value.hasText, false, "wait:false 的 handle 里没有正文");
  assert.equal(first.value.status, "queued");

  const record = await waitTerminal(registry, first.value.taskId);
  assert.equal(record.status, "succeeded");

  // 程序2：同一会话的另一个程序，取回正文
  const second = await runPtcProgram({
    code: `const v = await tools.task_output({ taskId: ${JSON.stringify(first.value.taskId)} }); return v.text;`,
    bindings: { task_output: binding },
    timeoutMs: 20_000,
  });
  assert.equal(second.status, "fulfilled", second.error);
  assert.equal(second.value, "跨程序正文");
});

test("③ 接线：绑定真进了绑定表（程序内 typeof tools.task_output === 'function'）", async () => {
  const { default: entryDefault } = await import("../../packages/entry/dist/index.js");
  const handlers = {};
  const registered = {};
  const fakePi = {
    on: (ev, cb) => {
      (handlers[ev] ??= []).push(cb);
    },
    registerTool: (def) => {
      registered[def.name] = def;
    },
    registerCommand: () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
    getAllTools: () => [],
    sendMessage: () => {},
  };
  entryDefault(fakePi);
  const original = process.cwd();
  process.chdir(mkdtempSync(join(tmpdir(), "ptc-task-output-")));
  try {
    await handlers.session_start[0]({}, { ui: { notify: () => {} } });
    const result = await registered.ptc_run_code.execute("call-1", {
      code: `return typeof tools.task_output;`,
      description: "绑定接线探针",
    });
    assert.equal(result.isError, false, result.content[0]?.text);
    assert.match(result.content[0].text, /function/, "绑定表里应有 task_output");
  } finally {
    // entry 注册了两个 turn_end：投递通知 + 退役池里的 worker——不排空会拖住进程退出
    handlers.turn_end?.forEach((cb) => cb());
    process.chdir(original);
  }
});
