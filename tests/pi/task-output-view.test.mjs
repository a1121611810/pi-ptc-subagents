// 任务产出读法（归约层）→ 测试：孩子的散文答案进上下文，原始事件流不进
import test from "node:test";
import assert from "node:assert/strict";
import { readTaskOutput } from "../../packages/task/dist/index.js";

const jsonl = (answer) =>
  [
    JSON.stringify({
      type: "tool_execution_start",
      toolName: "read",
      args: { path: "a.ts" },
    }),
    JSON.stringify({ type: "tool_execution_end", isError: false, result: { isError: false } }),
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: answer }],
        model: "m",
        provider: "p",
      },
    }),
  ].join("\n");

const record = (over = {}) => ({
  id: "task-1",
  status: "succeeded",
  task: "读 AGENTS.md 并汇总",
  ...over,
});

function source(text) {
  return {
    outputSize: async () => Buffer.byteLength(text, "utf8"),
    readOutput: async () => text,
    readOutputTail: async (_id, max) => text.slice(-max),
  };
}

test("有正文：给归约后的散文答案，原始事件流不进上下文", async () => {
  const stream = jsonl("孩子的最终答案：六个包口径一致。");
  const view = await readTaskOutput(source(stream), record());
  assert.equal(view.text, "孩子的最终答案：六个包口径一致。");
  assert.equal(view.output, undefined, "原始 JSONL 噪音不该进上下文");
  assert.equal(view.guidance, undefined);
});

test("没有正文：退回原始尾部 + 分层引导", async () => {
  const stream = JSON.stringify({
    type: "tool_execution_end",
    isError: false,
    result: { isError: false },
  });
  const view = await readTaskOutput(source(stream), record({ reportChannel: "none" }));
  assert.equal(view.text, undefined);
  assert.ok(view.output.includes("tool_execution_end"), "该给原始尾部");
  assert.ok(view.guidance.length > 0, "该给分层引导");
});

test("产出不存在：什么都不给", async () => {
  const empty = {
    outputSize: async () => undefined,
    readOutput: async () => undefined,
    readOutputTail: async () => undefined,
  };
  assert.deepEqual(await readTaskOutput(empty, record()), {});
});

test("答案超长被尾部切半：读全文再解析一次（截断尾注自带全文路径）", async () => {
  const huge = "答".repeat(40000); // 一行远超 50KB ⇒ 尾部切出来的半行解析不了
  const stream = jsonl(huge);
  const view = await readTaskOutput(source(stream), record());
  assert.ok(view.text.includes("已截断"), "该按截断契约截断并给路径");
  assert.ok(view.text.includes("全文在"), "截断尾注该带全文路径");
});
