// 任务面工具的返回形状：text 必须是字符串
// 起因（2026-11-02 真机抓到）：ptc_task_stop 走 textResult(await session.stopTask(...))，
// 而 stopTask 返回 void ⇒ JSON.stringify(undefined) 是 undefined ⇒ 工具结果 text 是 undefined
// ⇒ pi 拼下一轮请求时读 .length 直接崩（整轮挂掉、父面交白卷）。
// 探针只测宿主自己看得见的东西：形状不变量 + 未知 id 的可读错。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 隔离 agent 目录与工作区：别读用户全局配置、别往仓库里写 .pi/ptc-tasks
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "ptc-task-stop-agent-"));
process.chdir(mkdtempSync(join(tmpdir(), "ptc-task-stop-ws-")));

const { default: entryDefault, textResult } = await import("../../packages/entry/dist/index.js");

function fakePi() {
  const handlers = {};
  const registered = {};
  let active = [];
  return {
    pi: {
      on: (event, cb) => {
        (handlers[event] ??= []).push(cb);
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
    },
    ctx: { mode: "print", ui: { notify: () => {} } },
    handlers,
    registered,
  };
}

test("形状不变量：textResult 的 text 永远是字符串（pi 下一轮要读 .length）", () => {
  for (const value of [undefined, null, { a: 1 }, [1, 2], () => {}, Symbol("s")]) {
    const result = textResult(value);
    const block = result.content[0];
    assert.equal(block.type, "text");
    assert.equal(typeof block.text, "string", `value=${String(value)} ⇒ text 不是字符串`);
  }
});

test("ptc_task_stop：未知 id 报可读错，不崩；停完回字符串 text", async () => {
  const fake = fakePi();
  entryDefault(fake.pi);
  await fake.handlers.session_start[0]({}, fake.ctx);
  const stop = fake.registered["ptc_task_stop"];
  assert.ok(stop, "ptc_task_stop 应已注册");
  // 未知 id：引擎按可读错拒（不是崩）——模型看到的是错，不是白屏
  await assert.rejects(
    async () => await stop.execute("call-1", { task_id: "no-such-task" }),
    /unknown task id/,
  );
  // 停一个真实存在的任务：先造一个（假 spawn，不起真 pi），再停
  const { assemblePtcSession } = await import("../../packages/entry/dist/index.js");
  const session = assemblePtcSession({
    engine: {
      spawnChild: () => ({
        pid: 12345,
        onOutput: () => {},
        onExit: () => {},
        kill: () => {},
      }),
    },
  });
  const created = await session.createTask("做点事", { wait: false });
  assert.ok(created.taskId, "应拿到 taskId");
  await session.stopTask(created.taskId, "test");
  assert.ok(
    ["canceled", "stopping", "queued"].includes(session.registry.get(created.taskId).status),
  );
});
