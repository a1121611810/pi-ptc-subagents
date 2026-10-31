// 交付核对 → 测试：父能看到的「孩子实际干了什么」必须来自引擎抽的事件流，不来自模型自述
// ①轨迹抽取：工具调用/路径/报错来自 tool_execution_* 事件（floor 0.86 与 1.4.0 同构）
// ②轨迹随记录存活（父经任务面读得到）
// ③零产出要说出口：没调工具、无报告块、正文 0 字 ⇒ 渲染行明说「重派，别替它补数」
import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryOutputStorage,
  TaskEngine,
  TaskRegistry,
  parseChildStream,
} from "../../packages/dispatch/dist/index.js";
import { renderDeliveryCheck } from "../../packages/routes/dist/index.js";

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

// 一条真实形状的子进程事件流（取自 bench 产物 output.log）
function childStream({ path = "materials/topic-2.md", text = "F2-1 = 36", error = false } = {}) {
  return [
    JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "read",
      args: { path, offset: null, limit: null },
    }),
    JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "read",
      result: { content: [{ type: "text", text: "档案内容" }], isError: error },
    }),
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        usage: { input: 10, output: 5 },
      },
    }),
  ].join("\n");
}

test("①：工具轨迹来自事件流（工具/路径/报错），不靠模型自述", () => {
  const parsed = parseChildStream(childStream());
  assert.deepEqual(parsed.delivery.tools, { read: 1 });
  assert.deepEqual(parsed.delivery.paths, ["materials/topic-2.md"]);
  assert.equal(parsed.delivery.errors, 0);
  assert.equal(parsed.delivery.textChars, "F2-1 = 36".length);
});

test("①：工具报错算进轨迹（isError 在事件顶层与 result 里两种形状都认）", () => {
  const top = parseChildStream(
    JSON.stringify({ type: "tool_execution_end", toolName: "read", isError: true }),
  );
  assert.equal(top.delivery.errors, 1);
  const nested = parseChildStream(childStream({ error: true }));
  assert.equal(nested.delivery.errors, 1);
});

test("②：轨迹随记录存活（父经任务面读得到），并进 DispatchResult", async () => {
  const registry = new TaskRegistry();
  const { spawn } = fakeSpawn({ stdout: childStream() });
  const engine = new TaskEngine({
    registry,
    output: new InMemoryOutputStorage(),
    spawnChild: spawn,
  });
  const r = await engine.dispatch({ task: "x", wait: true });
  assert.equal(r.delivery.tools.read, 1);
  assert.deepEqual(r.delivery.paths, ["materials/topic-2.md"]);
  const record = registry.get(r.taskId);
  assert.deepEqual(record.delivery.paths, ["materials/topic-2.md"]);
});

test("③：零产出要说出口（重派 / 别替它补数），不能只给一堆零", async () => {
  const registry = new TaskRegistry();
  // 孩子起来了但什么都没交：没调工具、无报告块、正文 0 字
  const { spawn } = fakeSpawn({
    stdout: JSON.stringify({ type: "agent_settled", aborted: false }),
  });
  const engine = new TaskEngine({
    registry,
    output: new InMemoryOutputStorage(),
    spawnChild: spawn,
  });
  const r = await engine.dispatch({ task: "x", wait: true });
  assert.equal(r.delivery.tools.read, undefined);
  assert.equal(r.delivery.textChars, 0);
  const note = renderDeliveryCheck({ delivery: r.delivery, findings: 0, channel: "none" });
  assert.match(note, /零产出/);
  assert.match(note, /重派/);
  assert.match(note, /别替它补数/);
});

test("③：有交付时渲染行给出实测轨迹 + 报告条数（父据此核对）", () => {
  const note = renderDeliveryCheck({
    delivery: { tools: { read: 2, grep: 1 }, paths: ["a.md", "b.md"], errors: 1, textChars: 120 },
    findings: 3,
    channel: "prompt-json",
  });
  assert.match(note, /read×2/);
  assert.match(note, /a\.md/);
  assert.match(note, /报错 1/);
  assert.match(note, /报告 3 条/);
  assert.doesNotMatch(note, /零产出/);
});

test("④：父面把核对行挂到任务结果/记录上（非记录形状原样透传）", async () => {
  const { withDeliveryNote } = await import("../../packages/entry/dist/index.js");
  const record = {
    status: "succeeded",
    reportChannel: "prompt-json",
    report: { summary: "s", findings: [{ what: "a" }, { what: "b" }] },
    delivery: { tools: { read: 1 }, paths: ["materials/topic-2.md"], errors: 0, textChars: 42 },
  };
  const shaped = withDeliveryNote(record);
  assert.match(shaped.deliveryNote, /交付核对/);
  assert.match(shaped.deliveryNote, /materials\/topic-2\.md/);
  assert.match(shaped.deliveryNote, /报告 2 条/);
  // 任务 handle / 拒绝这类形状没有 reportChannel —— 不许被塞进核对行
  const handle = withDeliveryNote({ taskId: "t1", status: "queued" });
  assert.equal(handle.deliveryNote, undefined);
});
