// 停滞护栏 → 测试：
// ①tracker 口径：没动静 + 没有在飞的工具 = 停滞；在飞的工具 = 不停滞；新动静重置计时
// ②引擎级：完全没动静的孩子被收尸（canceled + stopReason 写明 stalled）
// ③引擎级：在飞工具的孩子不被收尸（护栏只杀「什么都没在做」的）
// ④stallMs=0 ⇒ 护栏关掉
// 依据：packages/dispatch/src/activity.ts 的两条口径
import test from "node:test";
import assert from "node:assert/strict";
import {
  ChildActivityTracker,
  InMemoryOutputStorage,
  TaskEngine,
  TaskRegistry,
} from "../../packages/dispatch/dist/index.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 等某个回调变成有值（假 spawn 的监听器是引擎 spawn 之后才挂的） */
async function waitFor(value, timeoutMs = 1_000) {
  const start = Date.now();
  while (value() === undefined && Date.now() - start < timeoutMs) await sleep(10);
  return value();
}

test("①：没动静且没有在飞的工具 = 停滞", () => {
  let now = 1_000;
  const tracker = new ChildActivityTracker(() => now);
  assert.equal(tracker.isStalled(now, 5_000), false, "刚开始不算停滞");
  now += 4_999;
  assert.equal(tracker.isStalled(now, 5_000), false);
  now += 1;
  assert.equal(tracker.isStalled(now, 5_000), true);
});

test("①：工具在飞 ⇒ 不停滞（哪怕一直没动静）", () => {
  let now = 1_000;
  const tracker = new ChildActivityTracker(() => now);
  tracker.push(JSON.stringify({ type: "tool_execution_start", toolName: "bash" }) + "\n");
  now += 60_000;
  assert.equal(tracker.isStalled(now, 5_000), false, "工具在飞不算停滞");
  tracker.push(JSON.stringify({ type: "tool_execution_end", toolName: "bash" }) + "\n");
  now += 60_000;
  assert.equal(tracker.isStalled(now, 5_000), true, "工具结束后又没动静 ⇒ 停滞");
});

test("①：新动静重置计时", () => {
  let now = 1_000;
  const tracker = new ChildActivityTracker(() => now);
  now += 4_000;
  tracker.push('{"type":"message_update"}\n');
  now += 4_000;
  assert.equal(tracker.isStalled(now, 5_000), false, "距上次动静 4 秒，不算停滞");
  now += 1_001;
  assert.equal(tracker.isStalled(now, 5_000), true);
});

/** 假 spawn：孩子一直活着不出声（挂死），只有 kill 才退出 */
function hangingSpawn(kills) {
  return () => {
    let exitCb;
    return {
      pid: 4243,
      onOutput: () => {},
      onExit: (cb) => {
        exitCb = cb;
      },
      kill: (signal) => {
        kills.push(signal);
        exitCb?.(-1, "");
      },
    };
  };
}

test("②：完全没动静的孩子被护栏收尸（stopReason 写明 stalled）", async (t) => {
  // 真实挂死的孩子靠 stdio 管道拽住事件循环；假 spawn 没有管道——补一个 ref 定时器。
  // 否则护栏的 unref 定时器是唯一句柄，循环先 drain（node:test 报「event loop has already resolved」，CI 22 腿实测踩到）
  const keepAlive = setInterval(() => {}, 60_000);
  t.after(() => clearInterval(keepAlive));
  const registry = new TaskRegistry();
  const kills = [];
  const engine = new TaskEngine({
    registry,
    output: new InMemoryOutputStorage(),
    spawnChild: hangingSpawn(kills),
    stallMs: 50, // 阈值调小——测试不真等 5 分钟
    stopGraceMs: 10,
  });
  const r = await engine.dispatch({ task: "hang", wait: true });
  assert.equal(r.status, "canceled");
  assert.match(r.errorMessage ?? "", /stalled/, "stopReason 要写明是停滞");
  assert.deepEqual(kills, ["SIGTERM"], "走既有收尸阶梯（SIGTERM → SIGKILL）");
  assert.equal(registry.get(r.taskId).status, "canceled");
});

test("③：在飞工具的孩子不被护栏收尸", async () => {
  const registry = new TaskRegistry();
  const state = { out: undefined, exit: undefined };
  const engine = new TaskEngine({
    registry,
    output: new InMemoryOutputStorage(),
    spawnChild: () => ({
      pid: 4244,
      onOutput: (cb) => {
        state.out = cb;
      },
      onExit: (cb) => {
        state.exit = cb;
      },
      kill: () => {
        state.exit?.(-1, "");
      },
    }),
    stallMs: 200,
    stopGraceMs: 10,
  });
  const handle = await engine.dispatch({ task: "long tool" });
  assert.ok(handle.status === "queued" || handle.status === "running", "不等路径先拿 handle");
  await waitFor(() => state.out);
  assert.equal(registry.get(handle.taskId).status, "running", "孩子已经起来了");
  // 真孩子先发 session 事件，再报工具开始，然后一直不出声
  state.out(JSON.stringify({ type: "session" }) + "\n");
  state.out(JSON.stringify({ type: "tool_execution_start", toolName: "bash" }) + "\n");
  await sleep(600);
  assert.equal(registry.get(handle.taskId).status, "running", "工具在飞的孩子不该被护栏收尸");
  await engine.stop(handle.taskId, "test cleanup");
});

test("④：stallMs=0 ⇒ 护栏关掉（挂死的孩子照旧挂着）", async () => {
  const registry = new TaskRegistry();
  const engine = new TaskEngine({
    registry,
    output: new InMemoryOutputStorage(),
    spawnChild: hangingSpawn([]),
    stallMs: 0,
    stopGraceMs: 10,
  });
  const handle = await engine.dispatch({ task: "hang" });
  await sleep(300);
  assert.equal(registry.get(handle.taskId).status, "running", "护栏关掉就不该收尸");
  await engine.stop(handle.taskId, "test cleanup");
});
