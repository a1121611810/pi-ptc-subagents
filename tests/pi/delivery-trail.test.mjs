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
    let timer;
    const finish = (code) => {
      clearTimeout(timer);
      outCb?.(stdout);
      exitCb?.(code, "");
    };
    // ref 定时器：真孩子的 stdio 管道会拽住事件循环，假孩子也要——否则 await 窗口里只剩引擎的
    // unref 定时器，node:test 判「event loop has already resolved」（22.23.4 实测踩到）
    if (autoExitMs !== null) timer = setTimeout(() => finish(0), autoExitMs);
    return {
      pid: 4242,
      onOutput: (cb) => {
        outCb = cb;
      },
      onExit: (cb) => {
        exitCb = cb;
      },
      kill: () => finish(-1),
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
  const note = renderDeliveryCheck({
    delivery: r.delivery,
    findings: 0,
    channel: "none",
    filesTouched: ["/tmp/claimed-only.pdf"],
  });
  assert.match(note, /零产出/);
  assert.match(note, /重派/);
  assert.match(note, /别替它补数/);
  // 零产出 + 声称文件：警告要有，且不许拼出双句号（regression：两串都以「。」收尾时直接拼接）
  assert.match(note, /零命中/);
  assert.doesNotMatch(note, /。。/);
  assert.match(note, /别替它补数。警告：/);
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

// ⑤ 声称文件核对（provenance Filter）：每条标注它钉死哪种假绿
test("⑤：报告自报相对路径、轨迹是绝对路径 ⇒ 不警告（防朴素精确匹配回归——bench 实测误伤 67%）", () => {
  const note = renderDeliveryCheck({
    delivery: {
      tools: { read: 1 },
      paths: ["/tmp/piab-ws-x/materials/topic-1.md"],
      errors: 0,
      textChars: 42,
    },
    findings: 1,
    channel: "prompt-json",
    filesTouched: ["./materials/topic-1.md"],
  });
  assert.doesNotMatch(note, /零命中/);
});

test("⑤：声称动了文件但轨迹零命中 ⇒ 警告说没有实测支撑（防「警告永不渲染」假绿）", () => {
  const note = renderDeliveryCheck({
    delivery: { tools: { bash: 6 }, paths: [], errors: 0, textChars: 100 },
    findings: 2,
    channel: "tool",
    filesTouched: ["/tmp/pci401.pdf", "/tmp/changes.pdf"],
  });
  assert.match(note, /声称动了 2 个文件/);
  assert.match(note, /零命中/);
  assert.match(note, /没有实测支撑/);
});

test("⑤：接线要通——withDeliveryNote 把 files_touched 喂进核对行（防「单元绿但 entry 漏传」假绿）", async () => {
  const { withDeliveryNote } = await import("../../packages/entry/dist/index.js");
  const record = {
    status: "succeeded",
    reportChannel: "tool",
    report: {
      summary: "s",
      files_touched: ["src/never-touched.ts"],
    },
    delivery: { tools: { read: 1 }, paths: ["src/a.ts"], errors: 0, textChars: 42 },
  };
  const shaped = withDeliveryNote(record);
  assert.match(shaped.deliveryNote, /零命中/);
  // 文件声称与实测路径重合时（后缀匹配）警告不出——同一次接线反向验证
  const hit = withDeliveryNote({
    ...record,
    report: { summary: "s", files_touched: ["src/a.ts"] },
  });
  assert.doesNotMatch(hit.deliveryNote, /零命中/);
});

test("⑤：files_touched 缺省/为空 ⇒ 无警告词，既有渲染不变（防「无条件追加」假绿）", () => {
  const base = {
    delivery: { tools: { read: 1 }, paths: ["a.md"], errors: 0, textChars: 42 },
    findings: 1,
    channel: "prompt-json",
  };
  assert.doesNotMatch(renderDeliveryCheck(base), /零命中/);
  assert.doesNotMatch(renderDeliveryCheck({ ...base, filesTouched: [] }), /零命中/);
  // "./" strip 后是空串，不能算作一次声称（否则 endsWith("/") 会被目录尾斜杠误判为命中、一票压掉整组警告）
  assert.doesNotMatch(renderDeliveryCheck({ ...base, filesTouched: ["./"] }), /零命中/);
  const mixed = renderDeliveryCheck({
    ...base,
    delivery: { tools: { ls: 1 }, paths: ["/tmp/dir/"], errors: 0, textChars: 42 },
    filesTouched: ["./", "/tmp/fake.pdf"],
  });
  assert.match(mixed, /声称动了 1 个文件/);
  assert.match(mixed, /零命中/);
});
