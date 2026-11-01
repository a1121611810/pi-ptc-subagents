// 任务面列表（模型面形状）→ 测试：精简条目 + 候选总数 + 字节预算
// 基准图：docs/prototypes/full-flow-anatomy.html ⑫任务面
import test from "node:test";
import assert from "node:assert/strict";
import { TaskEngine, TaskRegistry } from "../../packages/dispatch/dist/index.js";
import {
  compactedTaskReminder,
  taskListSnapshot,
  LIST_MAX_BYTES,
  LIST_MAX_LIMIT,
} from "../../packages/task/dist/index.js";

async function seed(registry, count, overrides = {}, idBase = 0) {
  for (let i = 0; i < count; i++) {
    await registry.submit({
      kind: "spawn",
      record: {
        id: String(idBase + i).padStart(32, "0"),
        status: "succeeded",
        task: "读 AGENTS.md 并汇总六个包的对外口径".repeat(3),
        label: `口径汇总 ${i}`,
        ownerPid: 1,
        ownerBootMs: 2,
        startedAt: 1758000000000 + i,
        finishedAt: 1758000123456 + i,
        reportChannel: "tool",
        report: { summary: "六个包口径一致", findings: [{ what: "x", evidence: "y" }] },
        delivery: { tools: { read: 12 }, paths: ["a/b.ts"], errors: 0, textChars: 842 },
        outputPath: "/tmp/x/output.log",
        outputTruncated: false,
        ...overrides,
      },
    });
  }
}

test("任务面列表：响应是对象，带候选总数与精简条目", async () => {
  const registry = new TaskRegistry();
  await seed(registry, 30);
  const snap = taskListSnapshot(registry);
  assert.equal(snap.scope, "recent");
  assert.equal(snap.total, 30, "total 应该是候选总数");
  assert.equal(snap.tasks.length, 30, "默认 limit 50 > 30 条，全列");
  const entry = snap.tasks[0];
  assert.deepEqual(Object.keys(entry).sort(), [
    "finishedAt",
    "id",
    "label",
    "status",
    "summary",
    "task",
  ]);
  assert.equal(entry.status, "succeeded");
  assert.equal(entry.summary, "六个包口径一致");
});

test("精简条目：字段各自封顶（一条巨型 task 文本撑不爆上下文）", async () => {
  const registry = new TaskRegistry();
  await seed(registry, 1, { task: "x".repeat(5000), label: "L".repeat(500) });
  const [entry] = taskListSnapshot(registry).tasks;
  assert.ok(entry.task.length <= 81, `task 该被截顶，实际 ${entry.task.length}`);
  assert.ok(entry.label.length <= 121, `label 该被截顶，实际 ${entry.label.length}`);
});

test("字节预算：600 条记录时响应仍然有界，且 JSON 合法", async () => {
  const registry = new TaskRegistry();
  await seed(registry, 600);
  const snap = taskListSnapshot(registry);
  const text = JSON.stringify(snap, null, 2);
  assert.equal(snap.total, 600, "total 是候选总数（600），不止返回的条数");
  assert.ok(snap.tasks.length < 600, "返回条数该被 limit 砍掉");
  assert.ok(
    Buffer.byteLength(text, "utf8") <= LIST_MAX_BYTES + 2000,
    `响应该有界，实际 ${Buffer.byteLength(text, "utf8")} 字节`,
  );
  assert.doesNotThrow(() => JSON.parse(text), "响应必须是合法 JSON");
});

test("limit 夹取：上限 200，低于 1 归 1", async () => {
  const registry = new TaskRegistry();
  // 瘦身记录：条目小 ⇒ 字节预算不先绑定，测的是条数夹取
  await seed(registry, 260, { task: "t", label: undefined, report: undefined });
  assert.equal(taskListSnapshot(registry, { limit: 9999 }).tasks.length, LIST_MAX_LIMIT);
  assert.equal(taskListSnapshot(registry, { limit: 0 }).tasks.length, 1);
  assert.equal(taskListSnapshot(registry, { limit: 5 }).tasks.length, 5);
});

test("status 过滤：total 只数命中的那些", async () => {
  const registry = new TaskRegistry();
  await seed(registry, 4, { status: "succeeded" });
  await seed(registry, 2, { status: "running", finishedAt: undefined }, 100);
  const snap = taskListSnapshot(registry, { status: "running" });
  assert.equal(snap.total, 2);
  assert.equal(snap.tasks.length, 2);
  assert.ok(snap.tasks.every((t) => t.status === "running"));
});

test("scope=all：连压缩归档一起列，归档条目带 archived 标记", async () => {
  const registry = new TaskRegistry();
  await seed(registry, 2);
  const archived = [
    {
      id: "archived-1",
      status: "succeeded",
      task: "上周那个跑测试的任务",
      finishedAt: 1,
      archived: true,
    },
  ];
  const recent = taskListSnapshot(registry, {}, archived);
  assert.equal(recent.scope, "recent");
  assert.equal(recent.total, 2, "默认不碰归档");
  assert.ok(recent.tasks.every((t) => t.archived === undefined));

  const all = taskListSnapshot(registry, { scope: "all" }, archived);
  assert.equal(all.scope, "all");
  assert.equal(all.total, 3);
  const hit = all.tasks.find((t) => t.id === "archived-1");
  assert.ok(hit, "归档条目该在列表里");
  assert.equal(hit.archived, true, "归档条目该标 archived");
});

test("session 过滤：只列该会话的；老记录（无 sessionId）不匹配任何会话", async () => {
  const registry = new TaskRegistry();
  await seed(registry, 2, { sessionId: "sess-a" });
  await seed(registry, 3, { sessionId: "sess-b" }, 100);
  await seed(registry, 1, { sessionId: undefined }, 200); // 老记录：没有这个字段

  const a = taskListSnapshot(registry, { session: "sess-a" });
  assert.equal(a.total, 2);
  assert.ok(
    a.tasks.every((t) => t.sessionId === "sess-a"),
    "按会话筛时该回显 sessionId",
  );

  const b = taskListSnapshot(registry, { session: "sess-b" });
  assert.equal(b.total, 3);

  const none = taskListSnapshot(registry, {});
  assert.equal(none.total, 6, "不筛时老记录照列（不当归属键）");
});

test("引擎：记录盖上宿主会话 id（只做标签）", async () => {
  const registry = new TaskRegistry();
  const engine = new TaskEngine({
    registry,
    context: { depth: 0, sessionId: "sess-x" },
    spawnChild: () => {
      let outCb, exitCb;
      queueMicrotask(() => {
        outCb?.("done\n");
        exitCb?.(0, "");
      });
      return {
        pid: 1,
        onOutput: (cb) => {
          outCb = cb;
        },
        onExit: (cb) => {
          exitCb = cb;
        },
        kill: () => {},
      };
    },
  });
  const outcome = await engine.dispatch({ task: "t", wait: true });
  assert.equal(registry.get(outcome.taskId).sessionId, "sess-x");
  await engine.shutdown();
});

test("压缩后清单：没有任务就不注入；有就给口径 + 在飞 + 最近完成", async () => {
  const empty = new TaskRegistry();
  assert.equal(compactedTaskReminder(empty), undefined, "没有任务不该注入空清单");

  const registry = new TaskRegistry();
  await seed(registry, 8, { status: "succeeded" });
  await seed(registry, 2, { status: "running", finishedAt: undefined }, 100);
  const reminder = compactedTaskReminder(registry);
  assert.ok(reminder.includes("<compacted-tasks>"), "该带块标记");
  assert.ok(reminder.includes("对话刚被压缩"), "该带口径");
  assert.ok(reminder.includes("ptc_task_list"), "口径该指出怎么找");
  assert.ok(reminder.includes("00000000000000000000000000000100"), "在飞任务该在清单里");
  assert.ok(!reminder.includes("00000000000000000000000000000000"), "最近完成只取 5 条");
});
