// 常驻子代理状态面板（ADR-0022）：进行中的子代理逐条 + 计数标题，纯函数 → 字符串数组
// 面板文案默认英文（跟 pi 宿主界面同一语言）；基准：宿主 widget 的 10 行上限
// （pi InteractiveMode.MAX_WIDGET_LINES）；冻结上限见 ADR-0022 §8
import test from "node:test";
import assert from "node:assert/strict";
import { TaskRegistry } from "../../packages/dispatch/dist/index.js";
import {
  createTaskPanel,
  MAX_PANEL_LABEL_CHARS,
  MAX_PANEL_ROWS,
  renderTaskPanel,
  TASK_PANEL_KEY,
} from "../../packages/tui/dist/pi.js";

// 假主题：把颜色 token 写进文本，断言「哪个状态用了哪个颜色」而不必依赖真主题
const theme = { fg: (color, text) => `<${color}>${text}` };

function record(overrides = {}) {
  return {
    id: "t1",
    status: "running",
    task: "调研子代理方案",
    label: "调研方案",
    startedAt: Date.now(),
    ...overrides,
  };
}

test("没有进行中的任务 ⇒ 空数组（宿主据此卸载面板）", () => {
  assert.deepEqual(renderTaskPanel([], theme), []);
  assert.deepEqual(renderTaskPanel([record({ status: "succeeded" })], theme), []);
  assert.deepEqual(renderTaskPanel([record({ status: "failed" })], theme), []);
});

test("标题给出 running/succeeded/failed 三个计数", () => {
  const lines = renderTaskPanel(
    [
      record(),
      record({ id: "t2" }),
      record({ id: "t3", status: "succeeded" }),
      record({ id: "t4", status: "failed" }),
    ],
    theme,
  );
  assert.equal(lines.length, 3);
  assert.match(lines[0], /2 running/);
  assert.match(lines[0], /1 succeeded/);
  assert.match(lines[0], /1 failed/);
});

test("进行中的任务逐条列出，字形与颜色按状态走", () => {
  const lines = renderTaskPanel(
    [
      record(),
      record({ id: "t2", status: "queued", label: "排队中" }),
      record({ id: "t3", status: "stopping" }),
    ],
    theme,
  );
  assert.match(lines[1], /<accent>● 调研方案/);
  assert.match(lines[2], /<muted>○ 排队中/);
  assert.match(lines[3], /<warning>◐ /);
});

test("label 缺省退回 task 文本，且按冻结上限截断", () => {
  const long = "x".repeat(200);
  const lines = renderTaskPanel([record({ label: undefined, task: long })], theme);
  assert.ok(lines[1].includes(`${"x".repeat(MAX_PANEL_LABEL_CHARS)}…`));
  assert.ok(!lines[1].includes("x".repeat(MAX_PANEL_LABEL_CHARS + 1)));
});

test("空 label 也退回 task 文本（空串不是 nullish）", () => {
  const lines = renderTaskPanel([record({ label: "", task: "写测试" })], theme);
  assert.match(lines[1], /写测试/);
});

test("任务正文里的 ANSI 与换行不进终端", () => {
  // 正文是模型写的、常照抄用户的话：ANSI 会被终端执行，换行会被 pi-tui 拆成多行
  const lines = renderTaskPanel(
    [record({ label: undefined, task: "读 \x1b[2J 文件\n第二行" })],
    theme,
  );
  assert.ok(!lines[1].includes("\x1b"), "ANSI 不该进面板");
  assert.ok(!lines[1].includes("\n"), "正文里的换行不该把一行拆成两行");
  assert.match(lines[1], /读 文件 第二行/);
});

test("超过面板行上限 ⇒ 收尾一行报还剩多少", () => {
  const many = Array.from({ length: MAX_PANEL_ROWS + 3 }, (_, i) => record({ id: `t${i}` }));
  const lines = renderTaskPanel(many, theme);
  assert.equal(lines.length, MAX_PANEL_ROWS + 2); // 标题 + 行 + 溢出行
  assert.match(lines[lines.length - 1], /3 more/);
  assert.ok(lines.length <= 8, "面板自限 8 行（宿主上限 10 行）");
});

test("widget key 是常量——同 key 覆盖才能保证 /reload 幂等", () => {
  assert.equal(TASK_PANEL_KEY, "ptc-tasks");
});

test("只算本会话的记录——历史会话的成功不进计数", () => {
  // 真机实测：registry 启动会恢复磁盘上的历史记录，标题一度写「succeeded 180」
  const lines = renderTaskPanel(
    [
      record({ status: "succeeded", sessionId: "old-session" }),
      record({ sessionId: "new-session" }),
    ],
    theme,
    "new-session",
  );
  assert.match(lines[0], /1 running/);
  assert.match(lines[0], /0 succeeded/);
});

// ── 接线（createTaskPanel）：registry 变迁 → 面板出现/消失 ──

function fakeUi() {
  const calls = [];
  return { calls, ui: { theme, setWidget: (key, value) => calls.push([key, value]) } };
}

test("接线：派一条任务 ⇒ 面板出现；任务落终态 ⇒ 面板消失", async () => {
  const { calls, ui } = fakeUi();
  const registry = new TaskRegistry();
  const panel = createTaskPanel({ ui, source: registry, sessionId: "s1" });
  await registry.submit({
    kind: "spawn",
    record: { id: "t1", status: "running", task: "写测试", sessionId: "s1" },
  });
  assert.equal(calls.at(-1)[0], TASK_PANEL_KEY);
  assert.match(calls.at(-1)[1][0], /1 running/);
  await registry.submit({ kind: "transition", id: "t1", to: "succeeded" });
  assert.equal(calls.at(-1)[1], undefined, "没有在飞任务 ⇒ 面板该被卸载");
  panel.dispose();
});

test("接线：没有 ui（print/json 模式）⇒ 什么都不画", async () => {
  const registry = new TaskRegistry();
  const panel = createTaskPanel({ source: registry, sessionId: "s1" });
  await registry.submit({
    kind: "spawn",
    record: { id: "t1", status: "running", task: "写测试", sessionId: "s1" },
  });
  panel.dispose(); // 不抛就算过
});

test("接线：dispose 之后再来变迁 ⇒ 面板不再回来", async () => {
  const { calls, ui } = fakeUi();
  const registry = new TaskRegistry();
  const panel = createTaskPanel({ ui, source: registry, sessionId: "s1" });
  panel.dispose();
  const before = calls.length;
  await registry.submit({
    kind: "spawn",
    record: { id: "t1", status: "running", task: "写测试", sessionId: "s1" },
  });
  assert.equal(calls.length, before, "卸载后不该再设 widget");
});
