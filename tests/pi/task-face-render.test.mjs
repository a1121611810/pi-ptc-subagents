// 任务面两个工具的 pi 折叠渲染（packages/tui/src/pi/task-face.ts）
// 假主题把颜色 token 写进文本（同 task-panel.test.mjs 口径）⇒ 断言「哪个状态用了哪个颜色」不依赖真主题
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { excerptForDisplay, renderTaskFaceResult } from "../../packages/tui/dist/pi.js";

// 隔离 agent 目录与工作区：别读用户全局配置、别往仓库里写 .pi/ptc-tasks
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "ptc-task-face-agent-"));
process.chdir(mkdtempSync(join(tmpdir(), "ptc-task-face-ws-")));

const theme = { fg: (color, text) => `<${color}>${text}` };

function render(details, { expanded = false } = {}) {
  const component = renderTaskFaceResult(
    { content: [{ type: "text", text: '{"raw":"json"}' }], details },
    { expanded, isPartial: false },
    theme,
  );
  return component.render(120).join("\n");
}

const list = {
  kind: "list",
  scope: "recent",
  total: 14,
  listed: 14,
  inFlight: 2,
  rows: [
    { id: "t1", status: "running", label: "调研方案" },
    { id: "t2", status: "succeeded" },
  ],
};

test("列表折叠：给计数，不给行", () => {
  const text = render(list);
  assert.match(text, /任务列表 · 14 条 · 2 在飞/);
  assert.doesNotMatch(text, /调研方案/);
});

test("列表折叠：候选比列出的多时说还有多少未列", () => {
  assert.match(render({ ...list, total: 30 }), /还有 16 条未列/);
});

test("列表展开：每行一个任务，字形与颜色走常驻面板那张表", () => {
  const text = render(list, { expanded: true });
  assert.match(text, /<dim>t1/);
  assert.match(text, /<accent>● running/);
  assert.match(text, /<success>✓ succeeded/);
  assert.match(text, /调研方案/);
});

test("列表展开：列出的条数多于显示的行数时明说省略", () => {
  assert.match(render({ ...list, listed: 20 }, { expanded: true }), /…（共 20 条，省略 18 条）/);
});

test("产出折叠：id + 状态；展开：正文摘录", () => {
  const details = {
    kind: "output",
    id: "t9",
    status: "succeeded",
    excerpt: "结论：可以发版",
    totalLines: 1,
  };
  assert.match(render(details), /任务产出 · <dim>t9 · <success>✓ succeeded/);
  assert.match(render(details, { expanded: true }), /结论：可以发版/);
});

test("产出展开：正文为空时说无正文", () => {
  const details = { kind: "output", id: "t9", status: "failed", excerpt: "", totalLines: 0 };
  assert.match(render(details, { expanded: true }), /（无正文）/);
});

test("没有 details：显示原文（别把人看到的字弄丢）", () => {
  assert.match(render(undefined), /"raw":"json"/);
});

test("excerptForDisplay：行数封顶 + 单行截断 + ANSI 清洗", () => {
  const many = Array.from({ length: 30 }, (_, i) => `第 ${i} 行`).join("\n");
  const { excerpt, totalLines } = excerptForDisplay(many);
  assert.equal(totalLines, 30);
  assert.equal(excerpt.split("\n").length, 12);
  assert.equal(excerptForDisplay("x".repeat(200)).excerpt.length, 121);
  assert.equal(excerptForDisplay("\x1b[31m红\x1b[0m").excerpt, "红");
});

test("接线：list 与 output 挂了 renderResult，stop 故意不挂", async () => {
  const { default: entryDefault } = await import("../../packages/entry/dist/index.js");
  const handlers = {};
  const registered = {};
  const pi = {
    on: (event, cb) => {
      (handlers[event] ??= []).push(cb);
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
  entryDefault(pi);
  await handlers.session_start[0]({}, { mode: "print", ui: { notify: () => {} } });
  assert.equal(typeof registered.ptc_task_list.renderResult, "function");
  assert.equal(typeof registered.ptc_task_output.renderResult, "function");
  // stop 的结果是三行 JSON，pi 的默认回退已经够读——故意不挂
  assert.equal(registered.ptc_task_stop.renderResult, undefined);
});
