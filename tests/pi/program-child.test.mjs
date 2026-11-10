// 程序型子代理（issue #293）→ 测试：子进程 = ptc CLI，stdout 只有 JSON 信封。
// ① 信封进→记录形状出（reportChannel=program、delivery 从 subCalls 推导、usage.turns=0、argv 形状）
// ② 失败可见：rejected 信封透出 errorMessage；垃圾 stdout = 信封解析失败，不静默
// ③ 三道闸（program 互斥 / 空 program / 载体缺失）在铸 id 前拒，registry 不留痕
// ④ readTaskOutput 的 program 分支：交付物 = 信封 value
import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryOutputStorage,
  TaskEngine,
  TaskRegistry,
  parseProgramEnvelope,
  deliveryFromSubCalls,
  programGate,
} from "../../packages/dispatch/dist/index.js";
import { readTaskOutput } from "../../packages/task/dist/index.js";

const CLI_PATH = "/fake/dist/ptc/cli.js";

// 假 CLI：把信封打到 stdout（真实 CLI --json 的 stdout 只有信封），exitCode 可配。
// hang = true 模拟不自己退出的孩子（stop 路径探针用）：kill 时以 -15 结算，像真 SIGTERM
function fakeCli({ envelope, exitCode = 0, delayMs = 5, hang = false } = {}) {
  const calls = { argv: undefined, env: undefined };
  const spawn = (argv, env) => {
    calls.argv = argv;
    calls.env = env;
    let outCb, exitCb;
    let timer;
    if (!hang) {
      timer = setTimeout(() => {
        outCb?.(typeof envelope === "string" ? envelope : JSON.stringify(envelope));
        exitCb?.(exitCode, "");
      }, delayMs);
    }
    return {
      pid: 4243,
      onOutput: (cb) => {
        outCb = cb;
      },
      onExit: (cb) => {
        exitCb = cb;
      },
      kill: () => {
        clearTimeout(timer);
        exitCb?.(-15, "");
      },
    };
  };
  return { spawn, calls };
}

function makeEngine(spawn, output = new InMemoryOutputStorage()) {
  const registry = new TaskRegistry();
  const engine = new TaskEngine({
    registry,
    output,
    spawnChild: spawn,
    programCliPath: CLI_PATH,
    gates: [programGate], // 镜像 entry 装配（假引擎不带默认六道闸）
  });
  return { registry, engine };
}

const FULFILLED_ENVELOPE = {
  status: "fulfilled",
  value: { f2: 36 },
  logs: [],
  subCalls: [
    {
      callId: 1,
      name: "read",
      args: { path: "materials/topic-2.md" },
      status: "ok",
      startedAt: 1,
      durationMs: 2,
    },
    { callId: 2, name: "grep", args: { pattern: "F2" }, status: "ok", startedAt: 3, durationMs: 1 },
    {
      callId: 3,
      name: "read",
      args: { path: "missing.md" },
      status: "error",
      startedAt: 4,
      durationMs: 1,
    },
  ],
};

test("①：fulfilled 信封 ⇒ 记录形状（program 通道 + delivery 推导 + turns 0 + argv 是 CLI）", async () => {
  const { spawn, calls } = fakeCli({ envelope: FULFILLED_ENVELOPE });
  const { registry, engine } = makeEngine(spawn);
  const r = await engine.dispatch({
    task: "读 topic-2 抽 F2",
    program: "return (await tools.read({ path: 'materials/topic-2.md' })).length",
    wait: true,
  });
  assert.equal(r.status, "fulfilled");
  assert.equal(r.reportChannel, "program");
  assert.equal(r.agentName, "program");
  assert.deepEqual(r.usage, { turns: 0 });
  // delivery 从信封 subCalls 推导：tools 计数 / args.path 收路径 / 非 ok 算 error
  assert.deepEqual(r.delivery.tools, { read: 2, grep: 1 });
  assert.deepEqual(r.delivery.paths, ["materials/topic-2.md", "missing.md"]);
  assert.equal(r.delivery.errors, 1);
  assert.equal(r.delivery.textChars, JSON.stringify({ f2: 36 }).length);
  // argv 形状：node + cli + program 文件 + --workdir + --json（pi argv 一件没有）
  assert.equal(calls.argv[0], process.execPath);
  assert.equal(calls.argv[1], CLI_PATH);
  assert.match(calls.argv[2], /program\.ts$/);
  assert.ok(calls.argv.includes("--json"));
  assert.ok(calls.argv.includes("--workdir"));
  // 记录随 registry 存活，任务面读得到
  const record = registry.get(r.taskId);
  assert.equal(record.reportChannel, "program");
  assert.deepEqual(record.delivery.paths, ["materials/topic-2.md", "missing.md"]);
});

test("②：rejected 信封 ⇒ errorMessage 透出信封错误，不丢在 exit code 里", async () => {
  const { spawn } = fakeCli({
    envelope: { status: "rejected", error: "path escapes workdir: ../etc/passwd", logs: [] },
    exitCode: 1,
  });
  const { engine } = makeEngine(spawn);
  const r = await engine.dispatch({ task: "x", program: "return 1", wait: true });
  assert.equal(r.status, "rejected");
  assert.match(r.errorMessage, /escapes workdir/);
});

test("②：垃圾 stdout ⇒ 信封解析失败可见（防「孩子不是 CLI / 产出被截断」静默成功）", async () => {
  const { spawn } = fakeCli({ envelope: "not-json-at-all", exitCode: 1 });
  const { engine } = makeEngine(spawn);
  const r = await engine.dispatch({ task: "x", program: "return 1", wait: true });
  assert.equal(r.status, "rejected");
  assert.match(r.errorMessage, /program envelope/);
});

test("③：program 与 agent 不并用 / 空 program / 载体缺失——闸前拒，registry 不留痕", async () => {
  const { spawn } = fakeCli({ envelope: FULFILLED_ENVELOPE });
  const { registry, engine } = makeEngine(spawn);
  const r1 = await engine.dispatch({ task: "x", program: "return 1", agent: "reader", wait: true });
  assert.equal(r1.status, "rejected");
  assert.match(r1.errorMessage, /不并用/);
  const r2 = await engine.dispatch({ task: "x", program: "   ", wait: true });
  assert.equal(r2.status, "rejected");
  // 载体缺失：不配 programCliPath 的引擎
  const bare = new TaskEngine({ registry: new TaskRegistry(), spawnChild: spawn });
  const r3 = await bare.dispatch({ task: "x", program: "return 1", wait: true });
  assert.equal(r3.status, "rejected");
  assert.match(r3.errorMessage, /programCliPath/);
  assert.equal(registry.list().length, 0); // 三个拒绝都没铸 id
});

test("④：readTaskOutput 的 program 分支——交付物是信封 value，不再剥事件流", async () => {
  const output = new InMemoryOutputStorage();
  const { spawn } = fakeCli({ envelope: FULFILLED_ENVELOPE });
  const { registry, engine } = makeEngine(spawn, output);
  const r = await engine.dispatch({ task: "x", program: "return 1", wait: true });
  const record = registry.get(r.taskId);
  const view = await readTaskOutput(
    {
      outputSize: (id) => output.size(id),
      readOutput: (id) => output.read(id),
      readOutputTail: (id, max) => output.readTail(id, max),
    },
    record,
  );
  assert.match(view.text, /"f2": 36/);
  assert.equal(view.output, undefined); // 有正文就不给原始尾部
});

test("④：信封坏了 ⇒ 退回原始尾部路径，不抛", async () => {
  const output = new InMemoryOutputStorage();
  const { spawn } = fakeCli({ envelope: "garbage", exitCode: 1 });
  const { registry, engine } = makeEngine(spawn, output);
  const r = await engine.dispatch({ task: "x", program: "return 1", wait: true });
  const view = await readTaskOutput(
    {
      outputSize: (id) => output.size(id),
      readOutput: (id) => output.read(id),
      readOutputTail: (id, max) => output.readTail(id, max),
    },
    registry.get(r.taskId),
  );
  assert.equal(view.text, undefined);
  assert.ok(view.output !== undefined);
});

test("⑤：program-carrier 纯函数——解析校验与 delivery 推导的形状钉", () => {
  assert.throws(() => parseProgramEnvelope("{bad"), /program envelope/);
  assert.throws(() => parseProgramEnvelope('{"status":"weird","logs":[]}'), /program envelope/);
  const d = deliveryFromSubCalls(FULFILLED_ENVELOPE.subCalls);
  assert.deepEqual(d.tools, { read: 2, grep: 1 });
  assert.equal(d.errors, 1);
  assert.deepEqual(deliveryFromSubCalls(undefined).tools, {});
});

test("⑥：stop 路径——挂起的孩子被 stop ⇒ canceled，stopReason 透传（pi 孩子共享链路的 program 侧钉）", async () => {
  const { spawn } = fakeCli({ hang: true });
  const { registry, engine } = makeEngine(spawn);
  const pending = engine.dispatch({ task: "x", program: "while(true){}", wait: true });
  // 等 transition 到 running（写 program 文件 + spawn 是同步链路，tick 即达）
  await new Promise((resolve) => setTimeout(resolve, 20));
  const taskId = registry.list()[0].id;
  await engine.stop(taskId, "manual stop reason");
  const r = await pending;
  assert.equal(r.status, "canceled");
  assert.match(r.errorMessage ?? "", /manual stop reason/);
  assert.equal(registry.get(taskId).status, "canceled");
});
