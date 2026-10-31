// 会话模型继承 → 测试：
// ①engine context 的 sessionModel = 父会话当前模型的 provider/id（活 getter，用户中途换模型也跟着换）
// ②父会话没模型 / ctx 的 getter 抛 → 不带 --model（旧行为不变；floor 0.86 也有 ctx.model，实测 0.86.0 同为活 getter）
// ③argv 优先级：调用参数 > agent 定义 > 会话模型；都没有就不发 --model
// ④端到端：entry 装配后真派发一次，孩子 argv 带父会话的模型
// 依据：旧 ADR-0044 的解析序（调用参数 → agent 定义 → 会话当前模型）——那条链本来就在，缺的是喂进去的值
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPiArgv } from "../../packages/dispatch/dist/index.js";
import entryDefault, { buildEngineContext } from "../../packages/entry/dist/index.js";

const BASE = { task: "do the thing" };

test("①：sessionModel = 父会话当前模型的 provider/id（pi 的 --model 引用格式）", () => {
  const ctx = { model: { provider: "minimax-cn", id: "MiniMax-M3.1-Flash" } };
  const context = buildEngineContext(ctx, "1.4.0");
  assert.equal(context.sessionModel, "minimax-cn/MiniMax-M3.1-Flash");
  assert.equal(context.depth, 0);
  assert.equal(context.piVersion, "1.4.0");
});

test("①：活 getter——换模型后跟着换（用户在会话中途切模型）", () => {
  const ctx = { model: { provider: "a", id: "m1" } };
  const context = buildEngineContext(ctx, "1.4.0");
  assert.equal(context.sessionModel, "a/m1");
  ctx.model = { provider: "b", id: "m2" };
  assert.equal(context.sessionModel, "b/m2", "getter 应在读取那一刻取当前模型");
});

test("②：父会话没有模型 → 不带 --model（旧行为不变）", () => {
  assert.equal(buildEngineContext({}, "1.4.0").sessionModel, undefined);
});

test("②：ctx 的 getter 抛（扩展被卸载）→ 退回旧行为，不炸", () => {
  const stale = {
    get model() {
      throw new Error("extension unloaded");
    },
  };
  assert.equal(buildEngineContext(stale, "1.4.0").sessionModel, undefined);
});

test("③：argv 优先级——调用参数 > agent 定义 > 会话模型；都没有就不发 --model", () => {
  const context = { depth: 1, sessionModel: "minimax-cn/MiniMax-M3.1-Flash" };
  const argv = buildPiArgv(BASE, context);
  assert.equal(argv[argv.indexOf("--model") + 1], "minimax-cn/MiniMax-M3.1-Flash");

  const agentArgv = buildPiArgv({ ...BASE, agentModel: "anthropic/claude" }, context);
  assert.equal(agentArgv[agentArgv.indexOf("--model") + 1], "anthropic/claude");

  const paramArgv = buildPiArgv(
    { ...BASE, model: "openai/gpt-5", agentModel: "anthropic/claude" },
    context,
  );
  assert.equal(paramArgv[paramArgv.indexOf("--model") + 1], "openai/gpt-5");

  const thinkingArgv = buildPiArgv({ ...BASE, thinkingLevel: "high" }, context);
  assert.equal(
    thinkingArgv[thinkingArgv.indexOf("--model") + 1],
    "minimax-cn/MiniMax-M3.1-Flash:high",
    "思考档位挂 :thinking 后缀",
  );

  assert.ok(!buildPiArgv(BASE, { depth: 1 }).includes("--model"), "没有会话模型就不该发 --model");
});

test("④：端到端——entry 装配后派发一次，孩子 argv 带父会话的模型", async () => {
  // 假 pi 放在 PATH 最前：回显自己的 argv（一个参数一行），--version 报 1.4.0
  const bin = mkdtempSync(join(tmpdir(), "sm-bin-"));
  const fakePi = join(bin, "pi");
  writeFileSync(
    fakePi,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.4.0; exit 0; fi\nfor a in "$@"; do echo "$a"; done\n',
  );
  chmodSync(fakePi, 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
  const savedCwd = process.cwd();
  process.chdir(mkdtempSync(join(tmpdir(), "sm-cwd-"))); // storageDir 落 tmp，别写仓库
  try {
    const handlers = {};
    const registered = {};
    const fakeHost = {
      on: (ev, cb) => {
        (handlers[ev] ??= []).push(cb);
      },
      registerTool: (def) => {
        registered[def.name] = def;
      },
      registerCommand: () => {},
      getActiveTools: () => ["codemode"], // → codemode_ptc 编排入口，建任务工具是 pi_task_codemode
      setActiveTools: () => {},
      getAllTools: () => [],
      sendMessage: () => {},
    };
    entryDefault(fakeHost);
    await handlers.session_start[0](
      {},
      {
        ui: { notify: () => {} },
        model: { provider: "minimax-cn", id: "MiniMax-M3.1-Flash" },
      },
    );
    const result = await registered.pi_task_codemode.execute("t1", {
      task: "echo argv",
      wait: true,
    });
    const text = result.content.map((c) => c.text).join("");
    assert.ok(text.includes("--model"), "孩子 argv 应带 --model：" + text.slice(0, 400));
    assert.ok(
      text.includes("minimax-cn/MiniMax-M3.1-Flash"),
      "孩子应继承父会话的模型：" + text.slice(0, 400),
    );
  } finally {
    process.chdir(savedCwd);
    process.env.PATH = savedPath;
  }
});
