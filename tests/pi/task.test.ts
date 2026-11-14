// 任务面探针（Slice 4 · 4 条能力 / 4 条 mutant）：
//   task-list      列表封顶 + 精简字段 + total 语义 + scope/status/session 筛 + 归档回落
//   task-output    归约层正文（报告只是摘要）+ 截断契约 + 输出绑定与视图
//   task-stop      stop 语义 + 结果形状
//   trace-capacity 终态留最近 500、最老先出、未终态永不驱逐
//
// 断言来源：搬（旧 node:test 探针，逐条搬）：task-list-view / task-output-binding / task-output-view /
//           task-stop-result-shape / task-trace-evict。
// 探针打产物（仓规）：packages/{dispatch,task,entry}/dist/index.js；引擎本体是源码包 ⇒ packages/ptc/src/index.ts。
// 假孩子：进程级替身（spawnChild 的 DI 注入点）——它没有 stdio 管道，自己 ref 真实定时器拽住事件循环，
//         否则 await 窗口里只剩引擎的 unref 定时器（node 22 判「event loop has already resolved」）。
// 副作用 import：装一份假 pi 到 PATH（见 helpers/pi-harness.ts 的说明）
import "../helpers/pi-harness.ts";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileOutputStorage,
  InMemoryOutputStorage,
  TaskEngine,
  TaskRegistry,
} from "../../packages/dispatch/dist/index.js";
import entryDefault, {
  assemblePtcSession,
  createTaskOutputBinding,
  textResult,
} from "../../packages/entry/dist/index.js";
import { runPtcProgram } from "../../packages/ptc/src/index.ts";
import {
  LIST_MAX_BYTES,
  LIST_MAX_LIMIT,
  compactedTaskReminder,
  readTaskOutput,
  taskListSnapshot,
} from "../../packages/task/dist/index.js";

// ── 夹具 ────────────────────────────────────────────────────────────────────

const realSetInterval = setInterval;
const realClearInterval = clearInterval;
const keepAlives: ReturnType<typeof setInterval>[] = [];

afterEach(() => {
  for (const timer of keepAlives.splice(0)) realClearInterval(timer);
});

/**
 * 假孩子：exitInMs=0 ⇒ 立刻退出（微任务，登记完监听器就触发）；null ⇒ 一直跑
 * （自己 ref 一个真实定时器拽住事件循环，收尾必须停掉它）。
 */
function fakeSpawn(options: { stdout?: string; exitInMs?: number | null } = {}) {
  const stdout = options.stdout ?? "";
  const exitInMs = options.exitInMs === undefined ? 10 : options.exitInMs;
  const spawn = () => {
    let outCb: ((chunk: string) => void) | undefined;
    let exitCb: ((code: number, stderr: string) => void) | undefined;
    let timer: NodeJS.Timeout | undefined;
    const finish = (code: number): void => {
      if (timer) clearTimeout(timer);
      outCb?.(stdout);
      exitCb?.(code, "");
    };
    if (exitInMs === null) {
      keepAlives.push(realSetInterval(() => {}, 60_000)); // ref 定时器：假孩子没有 stdio 管道
    } else if (exitInMs === 0) {
      queueMicrotask(() => finish(0));
    } else {
      timer = setTimeout(() => finish(0), exitInMs);
    }
    return {
      pid: 4242,
      onOutput: (cb: (chunk: string) => void) => {
        outCb = cb;
      },
      onExit: (cb: (code: number, stderr: string) => void) => {
        exitCb = cb;
      },
      kill: () => finish(-1),
    };
  };
  return { spawn };
}

/** 一条真实形状的子进程事件流：最后一条 assistant 消息的文本 = 孩子正文 */
function childStream(text: string): string {
  return [
    JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "read",
      args: { path: "materials/topic.md" },
    }),
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text }] },
    }),
  ].join("\n");
}

const TERMINAL = new Set(["succeeded", "failed", "canceled", "lost"]);

async function waitTerminal(registry: TaskRegistry, taskId: string): Promise<unknown> {
  for (let i = 0; i < 200; i++) {
    const record = registry.get(taskId);
    if (record && TERMINAL.has(record.status)) return record;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`任务 ${taskId} 没到终态`);
}

/** 一个会话的源：形状同 PtcSession（registry + 三个读产出的方法） */
function makeSession(stdout: string, exitInMs: number | null = 10) {
  const registry = new TaskRegistry();
  const engine = new TaskEngine({
    registry,
    output: new InMemoryOutputStorage(),
    spawnChild: fakeSpawn({ stdout, exitInMs }).spawn,
  });
  const source = {
    registry,
    readArchivedRecord: async () => undefined,
    outputSize: (id: string) => engine.outputSize(id),
    readOutput: (id: string) => engine.readOutput(id),
    readOutputTail: (id: string, n: number) => engine.readOutputTail(id, n),
  };
  return { registry, engine, source, binding: createTaskOutputBinding(source) };
}

// ── task-list（搬：task-list-view） ────────────────────────────────────────

async function seed(
  registry: TaskRegistry,
  count: number,
  overrides: Record<string, unknown> = {},
  idBase = 0,
): Promise<void> {
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

describe("task-list", () => {
  it("任务面列表：响应是对象，带候选总数与精简条目", async () => {
    const registry = new TaskRegistry();
    await seed(registry, 30);
    const snap = taskListSnapshot(registry);
    expect(snap.scope).toBe("recent");
    expect(snap.total).toBe(30); // total 是候选总数
    expect(snap.tasks).toHaveLength(30); // 默认 limit 50 > 30 条，全列
    const entry = snap.tasks[0] as Record<string, unknown>;
    expect(Object.keys(entry).sort()).toEqual([
      "finishedAt",
      "id",
      "label",
      "status",
      "summary",
      "task",
    ]);
    expect(entry.status).toBe("succeeded");
    expect(entry.summary).toBe("六个包口径一致");
  });

  it("精简条目：字段各自封顶（一条巨型 task 文本撑不爆上下文）", async () => {
    const registry = new TaskRegistry();
    await seed(registry, 1, { task: "x".repeat(5000), label: "L".repeat(500) });
    const [entry] = taskListSnapshot(registry).tasks as Record<string, string>[];
    expect((entry?.task ?? "").length).toBeLessThanOrEqual(81);
    expect((entry?.label ?? "").length).toBeLessThanOrEqual(121);
  });

  it("字节预算：600 条记录时响应仍然有界，且 JSON 合法", async () => {
    const registry = new TaskRegistry();
    await seed(registry, 600);
    const snap = taskListSnapshot(registry);
    const text = JSON.stringify(snap, null, 2);
    expect(snap.total).toBe(600); // total 是候选总数（600），不止返回的条数
    expect(snap.tasks.length).toBeLessThan(600); // 返回条数该被 limit 砍掉
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(LIST_MAX_BYTES + 2000);
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it("limit 夹取：上限 200，低于 1 归 1", async () => {
    const registry = new TaskRegistry();
    // 瘦身记录：条目小 ⇒ 字节预算不先绑定，测的是条数夹取
    await seed(registry, 260, { task: "t", label: undefined, report: undefined });
    expect(taskListSnapshot(registry, { limit: 9999 }).tasks).toHaveLength(LIST_MAX_LIMIT);
    expect(taskListSnapshot(registry, { limit: 0 }).tasks).toHaveLength(1);
    expect(taskListSnapshot(registry, { limit: 5 }).tasks).toHaveLength(5);
  });

  it("status 过滤：total 只数命中的那些", async () => {
    const registry = new TaskRegistry();
    await seed(registry, 4, { status: "succeeded" });
    await seed(registry, 2, { status: "running", finishedAt: undefined }, 100);
    const snap = taskListSnapshot(registry, { status: "running" });
    expect(snap.total).toBe(2);
    expect(snap.tasks).toHaveLength(2);
    expect(snap.tasks.every((t) => t.status === "running")).toBe(true);
  });

  it("scope=all：连压缩归档一起列，归档条目带 archived 标记", async () => {
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
    const recent = taskListSnapshot(registry, {}, archived as never);
    expect(recent.scope).toBe("recent");
    expect(recent.total).toBe(2); // 默认不碰归档
    expect(recent.tasks.every((t) => t.archived === undefined)).toBe(true);

    const all = taskListSnapshot(registry, { scope: "all" }, archived as never);
    expect(all.scope).toBe("all");
    expect(all.total).toBe(3);
    const hit = all.tasks.find((t) => t.id === "archived-1");
    expect(hit, "归档条目该在列表里").toBeDefined();
    expect(hit?.archived).toBe(true);
  });

  it("session 过滤：只列该会话的；老记录（无 sessionId）不匹配任何会话", async () => {
    const registry = new TaskRegistry();
    await seed(registry, 2, { sessionId: "sess-a" });
    await seed(registry, 3, { sessionId: "sess-b" }, 100);
    await seed(registry, 1, { sessionId: undefined }, 200); // 老记录：没有这个字段

    const a = taskListSnapshot(registry, { session: "sess-a" });
    expect(a.total).toBe(2);
    expect(a.tasks.every((t) => t.sessionId === "sess-a")).toBe(true); // 按会话筛时回显 sessionId

    const b = taskListSnapshot(registry, { session: "sess-b" });
    expect(b.total).toBe(3);

    const none = taskListSnapshot(registry, {});
    expect(none.total).toBe(6); // 不筛时老记录照列（不当归属键）
  });

  it("引擎：记录盖上宿主会话 id（只做标签）", async () => {
    const registry = new TaskRegistry();
    const engine = new TaskEngine({
      registry,
      context: { depth: 0, sessionId: "sess-x" },
      spawnChild: fakeSpawn({ exitInMs: 0 }).spawn,
    });
    const outcome = (await engine.dispatch({ task: "t", wait: true })) as { taskId: string };
    expect(registry.get(outcome.taskId)?.sessionId).toBe("sess-x");
    await engine.shutdown();
  });

  it("压缩后清单：没有任务就不注入；有就给口径 + 在飞 + 最近完成", async () => {
    const empty = new TaskRegistry();
    expect(compactedTaskReminder(empty)).toBeUndefined(); // 没有任务不该注入空清单

    const registry = new TaskRegistry();
    await seed(registry, 8, { status: "succeeded" });
    await seed(registry, 2, { status: "running", finishedAt: undefined }, 100);
    const reminder = compactedTaskReminder(registry) ?? "";
    expect(reminder).toContain("<compacted-tasks>");
    expect(reminder).toContain("对话刚被压缩");
    expect(reminder).toContain("ptc_task_list");
    expect(reminder).toContain("00000000000000000000000000000100"); // 在飞任务该在清单里
    expect(reminder).not.toContain("00000000000000000000000000000000"); // 最近完成只取 5 条
  });
});

// ── task-output（搬：task-output-binding + task-output-view） ───────────────

describe("task-output", () => {
  it("归约层：拿到的是孩子正文（不是原始事件流）；查不到给 error", async () => {
    const { engine, binding } = makeSession(childStream("F2-1 = 36"));
    const dispatched = (await engine.dispatch({ task: "读档案", wait: true })) as {
      status: string;
      taskId: string;
    };
    expect(dispatched.status).toBe("fulfilled");

    const view = (await binding({ taskId: dispatched.taskId })) as Record<string, unknown>;
    expect(view.text).toBe("F2-1 = 36"); // 归约后的正文
    expect(view.output).toBeUndefined(); // 有正文就不给原始尾部
    expect(view.guidance).toBeUndefined(); // 有正文就不给分层引导
    expect(view.status).toBe("succeeded"); // status 一起给：程序靠它分辨没跑完与没交正文

    const missing = (await binding({ taskId: "not-a-task" })) as { error?: string };
    expect(missing.error).toMatch(/unknown task id/); // 查不到给 error（绑定契约 never throws）
    const bad = (await binding({ taskId: 42 })) as { error?: string };
    expect(bad.error).toMatch(/taskId/); // 参数不合法也给 error，不抛
    const alias = (await binding({ task_id: dispatched.taskId })) as { text?: string };
    expect(alias.text).toBe("F2-1 = 36"); // task_id（模型面工具的拼法）也收
  });

  it("归档回落：内存里没有的 id，从压缩归档取回（决策 29）", async () => {
    const stream = childStream("归档正文");
    const registry = new TaskRegistry();
    const archived = { id: "arch-1", task: "读档案", status: "succeeded", archived: true };
    const source = {
      registry,
      readArchivedRecord: async (id: string) => (id === archived.id ? archived : undefined),
      outputSize: async () => Buffer.byteLength(stream, "utf8"),
      readOutput: async () => stream,
      readOutputTail: async () => stream,
    };
    const binding = createTaskOutputBinding(source as never);
    const view = (await binding({ taskId: "arch-1" })) as Record<string, unknown>;
    expect(view.text).toBe("归档正文");
    expect(view.status).toBe("succeeded");
  });

  it("绑定层：没正文时退回原始尾部 + 分层引导", async () => {
    // 孩子起来了但没交正文：事件流里没有 assistant 文本
    const { engine, binding } = makeSession(
      JSON.stringify({ type: "agent_settled", aborted: false }),
    );
    const dispatched = (await engine.dispatch({ task: "什么也不说", wait: true })) as {
      status: string;
      taskId: string;
    };
    expect(dispatched.status).toBe("fulfilled");

    const view = (await binding({ taskId: dispatched.taskId })) as Record<string, unknown>;
    expect(view.text).toBeUndefined();
    expect(view.output).toBeTruthy(); // 退回原始尾部
    expect(view.guidance).toBeTruthy(); // 给分层引导
  });

  it("归约层：还在跑时是空的，靠 status 分辨「没跑完」与「跑完但没交正文」", async () => {
    const { engine, registry, binding } = makeSession("", null);
    const handle = (await engine.dispatch({ task: "读档案" })) as { taskId: string };
    try {
      for (let i = 0; i < 200; i++) {
        if (registry.get(handle.taskId)?.status === "running") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const view = (await binding({ taskId: handle.taskId })) as Record<string, unknown>;
      expect(view.status).toBe("running");
      expect(view.text).toBeUndefined(); // 还没跑完 ⇒ 没有正文
      expect(view.output).toBeUndefined(); // 还没跑完 ⇒ 也没有原始尾部
    } finally {
      // ref 的定时器会拽住进程——收尾必须停掉孩子（顺带验证 stop 路径清理）
      await engine.stop(handle.taskId, "test cleanup");
    }
  });

  it("跨程序取回：程序1 wait:false 派发 → 程序2 拿到正文", async () => {
    const { engine, registry, binding } = makeSession(childStream("跨程序正文"));
    // 程序1：wait:false —— 只回 handle，正文不在返回值里
    const first = await runPtcProgram({
      code: `
        const h = await tools.pi_task_ptc({ task: "读档案" });
        return { taskId: h.taskId, status: h.status, hasText: typeof h.text === "string" };
      `,
      bindings: { pi_task_ptc: (args: unknown) => engine.dispatch(args as never) },
      timeoutMs: 20_000,
    });
    expect(first.status).toBe("fulfilled");
    const firstValue = first.value as { taskId: string; status: string; hasText: boolean };
    expect(firstValue.hasText).toBe(false); // wait:false 的 handle 里没有正文
    expect(firstValue.status).toBe("queued");

    const record = (await waitTerminal(registry, firstValue.taskId)) as { status: string };
    expect(record.status).toBe("succeeded");

    // 程序2：同一会话的另一个程序，取回正文
    const second = await runPtcProgram({
      code: `const v = await tools.task_output({ taskId: ${JSON.stringify(firstValue.taskId)} }); return v.text;`,
      bindings: { task_output: binding },
      timeoutMs: 20_000,
    });
    expect(second.status).toBe("fulfilled");
    expect(second.value).toBe("跨程序正文");
  });

  it("接线：绑定真进了绑定表（程序内 typeof tools.task_output === 'function'）", async () => {
    const handlers: Record<string, ((...a: unknown[]) => unknown)[]> = {};
    const registered: Record<
      string,
      { name: string; description: string; execute?: (...a: unknown[]) => unknown }
    > = {};
    const pi = {
      on: (event: string, cb: (...a: unknown[]) => unknown) => {
        (handlers[event] ??= []).push(cb);
      },
      registerTool: (def: {
        name: string;
        description: string;
        execute?: (...a: unknown[]) => unknown;
      }) => {
        registered[def.name] = def;
      },
      registerCommand: () => {},
      getActiveTools: () => [],
      setActiveTools: () => {},
      getAllTools: () => [],
      sendMessage: () => {},
    };
    const cwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "ptc-task-output-agent-"));
    process.chdir(mkdtempSync(join(tmpdir(), "ptc-task-output-ws-"))); // storageDir 落 tmp，别写仓库
    try {
      entryDefault(pi as never);
      await handlers.session_start?.[0]?.({}, { ui: { notify: () => {} } });
      const result = (await registered.ptc_run_code?.execute?.("call-1", {
        code: "return typeof tools.task_output;",
        description: "绑定接线探针",
      })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBe(false);
      expect(result.content[0]?.text).toMatch(/function/); // 绑定表里应有 task_output
    } finally {
      // entry 注册了两个 turn_end：投递通知 + 退役池里的 worker——不排空会拖住进程退出
      handlers.turn_end?.forEach((cb) => cb());
      process.chdir(cwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });

  it("归约层：有正文时给散文答案，原始事件流不进上下文", async () => {
    const stream = childStream("孩子的最终答案：六个包口径一致。");
    const view = await readTaskOutput(
      {
        outputSize: async () => Buffer.byteLength(stream, "utf8"),
        readOutput: async () => stream,
        readOutputTail: async (_id: string, max: number) => stream.slice(-max),
      },
      { id: "task-1", status: "succeeded", task: "读 AGENTS.md 并汇总" } as never,
    );
    expect(view.text).toBe("孩子的最终答案：六个包口径一致。");
    expect(view.output).toBeUndefined(); // 原始 JSONL 噪音不该进上下文
    expect(view.guidance).toBeUndefined();
  });

  it("归约层：没有正文时退回原始尾部 + 分层引导", async () => {
    const stream = JSON.stringify({
      type: "tool_execution_end",
      isError: false,
      result: { isError: false },
    });
    const view = await readTaskOutput(
      {
        outputSize: async () => Buffer.byteLength(stream, "utf8"),
        readOutput: async () => stream,
        readOutputTail: async (_id: string, max: number) => stream.slice(-max),
      },
      {
        id: "task-1",
        status: "succeeded",
        task: "读 AGENTS.md 并汇总",
        reportChannel: "none",
      } as never,
    );
    expect(view.text).toBeUndefined();
    expect(view.output).toContain("tool_execution_end");
    expect((view.guidance ?? "").length).toBeGreaterThan(0);
  });

  it("归约层：产出不存在时什么都不给", async () => {
    const empty = {
      outputSize: async () => undefined,
      readOutput: async () => undefined,
      readOutputTail: async () => undefined,
    };
    expect(
      await readTaskOutput(empty, { id: "task-1", status: "succeeded", task: "x" } as never),
    ).toEqual({});
  });

  it("截断契约：答案超长被尾部切半时读全文再解析一次", async () => {
    const huge = "答".repeat(40000); // 一行远超 50KB ⇒ 尾部切出来的半行解析不了
    const stream = childStream(huge);
    const view = await readTaskOutput(
      {
        outputSize: async () => Buffer.byteLength(stream, "utf8"),
        readOutput: async () => stream,
        readOutputTail: async (_id: string, max: number) => stream.slice(-max),
      },
      { id: "task-1", status: "succeeded", task: "读 AGENTS.md 并汇总" } as never,
    );
    expect(view.text).toContain("已截断"); // 按截断契约截断并给路径
    expect(view.text).toContain("全文在"); // 截断尾注自带全文路径
  });
});

// ── task-stop（搬：task-stop-result-shape） ────────────────────────────────

describe("task-stop", () => {
  it("形状不变量：textResult 的 text 永远是字符串（pi 下一轮要读 .length）", () => {
    for (const value of [undefined, null, { a: 1 }, [1, 2], () => {}, Symbol("s")]) {
      const result = textResult(value);
      const block = result.content[0] as { type: string; text: string };
      expect(block.type).toBe("text");
      expect(typeof block.text, `value=${String(value)} ⇒ text 不是字符串`).toBe("string");
    }
  });

  it("ptc_task_stop：未知 id 报可读错，不崩；停完回字符串 text", async () => {
    const handlers: Record<string, ((...a: unknown[]) => unknown)[]> = {};
    const registered: Record<
      string,
      { name: string; description: string; execute?: (...a: unknown[]) => unknown }
    > = {};
    const pi = {
      on: (event: string, cb: (...a: unknown[]) => unknown) => {
        (handlers[event] ??= []).push(cb);
      },
      registerTool: (def: {
        name: string;
        description: string;
        execute?: (...a: unknown[]) => unknown;
      }) => {
        registered[def.name] = def;
      },
      registerCommand: () => {},
      getActiveTools: () => [],
      setActiveTools: () => {},
      getAllTools: () => [],
      sendMessage: () => {},
    };
    const cwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "ptc-task-stop-agent-"));
    process.chdir(mkdtempSync(join(tmpdir(), "ptc-task-stop-ws-")));
    try {
      entryDefault(pi as never);
      await handlers.session_start?.[0]?.({}, { mode: "print", ui: { notify: () => {} } });
      const stop = registered.ptc_task_stop;
      expect(stop, "ptc_task_stop 应已注册").toBeDefined();
      // 未知 id：引擎按可读错拒（不是崩）——模型看到的是错，不是白屏
      await expect(stop?.execute?.("call-1", { task_id: "no-such-task" })).rejects.toThrow(
        /unknown task id/,
      );
      // 停一个真实存在的任务：先造一个（假 spawn，不起真 pi），再停
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
      const created = (await session.createTask("做点事", { wait: false })) as { taskId: string };
      expect(created.taskId).toBeTruthy();
      await session.stopTask(created.taskId, "test");
      expect(["canceled", "stopping", "queued"]).toContain(
        session.registry.get(created.taskId)?.status,
      );
      await session.shutdown();
    } finally {
      handlers.turn_end?.forEach((cb) => cb());
      process.chdir(cwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });
});

// ── trace-capacity（搬：task-trace-evict） ─────────────────────────────────

describe("trace-capacity", () => {
  it("600 任务（真实 storageDir）：稳定 500 条，最老 100 条连文件一起消失", async () => {
    const dir = mkdtempSync(join(tmpdir(), "f3-evict-"));
    const registry = new TaskRegistry();
    const engine = new TaskEngine({
      registry,
      storageDir: dir,
      output: new FileOutputStorage(dir),
      spawnChild: fakeSpawn({ exitInMs: 0 }).spawn,
    });
    const ids: string[] = [];
    for (let i = 0; i < 600; i++) {
      const r = (await engine.dispatch({ task: `t${i}`, wait: true })) as { taskId: string };
      ids.push(r.taskId);
    }
    expect(registry.list()).toHaveLength(500);
    // 运行时驱逐走异步归档尾链（决策 29），热文件的删除也在链上——shutdown 排空尾链后再验文件
    await engine.shutdown();
    for (let i = 0; i < 100; i++) {
      expect(registry.get(ids[i] ?? ""), `最老的第 ${i} 条还在内存`).toBeUndefined();
      expect(
        existsSync(join(dir, "records", `${ids[i]}.json`)),
        `最老的第 ${i} 条 json 还在盘上`,
      ).toBe(false);
      expect(existsSync(join(dir, "tasks", ids[i] ?? "")), `最老的第 ${i} 条产出目录还在盘上`).toBe(
        false,
      );
    }
    for (let i = 100; i < 600; i++) {
      expect(registry.get(ids[i] ?? ""), `第 ${i} 条不该被挤掉`).toBeDefined();
    }
    expect(registry.get(ids[599] ?? ""), "最新的一条必须活着").toBeDefined();
    expect(existsSync(join(dir, "records", `${ids[599]}.json`))).toBe(true);
    expect(existsSync(join(dir, "tasks", ids[599] ?? "", "output.log"))).toBe(true);
    const files = readdirSync(join(dir, "records")).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(500);
  });

  it("红线：未终态记录永不参与驱逐", async () => {
    const registry = new TaskRegistry();
    const rec = (id: string, status: string, finishedAt?: number) => ({
      id,
      status,
      task: id,
      ...(finishedAt !== undefined ? { finishedAt } : {}),
    });
    await registry.submit({ kind: "spawn", record: rec("running-1", "running") as never });
    await registry.submit({ kind: "spawn", record: rec("q-1", "queued") as never });
    await registry.submit({ kind: "spawn", record: rec("t1", "succeeded", 1000) as never });
    await registry.submit({ kind: "spawn", record: rec("t2", "failed", 2000) as never });
    await registry.submit({ kind: "spawn", record: rec("t3", "canceled", 3000) as never });
    await registry.submit({ kind: "spawn", record: rec("t4", "lost", 4000) as never });
    const evicted = registry.evictTerminal(2);
    expect(evicted).toEqual(["t1", "t2"]);
    expect(registry.get("running-1")).toBeDefined(); // 红线破了：未终态记录被驱逐
    expect(registry.get("q-1")).toBeDefined();
    expect(registry.get("t3")).toBeDefined(); // 该留的终态没留
    expect(registry.get("t4")).toBeDefined();
  });

  it("平局确定性：同 finishedAt 时按 taskId 字典序成全局全序", async () => {
    const registry = new TaskRegistry();
    const rec = (id: string) => ({ id, status: "succeeded", task: id, finishedAt: 1000 });
    await registry.submit({ kind: "spawn", record: rec("b-id") as never });
    await registry.submit({ kind: "spawn", record: rec("a-id") as never });
    await registry.submit({ kind: "spawn", record: rec("c-id") as never });
    expect(registry.evictTerminal(2)).toEqual(["a-id"]);
  });
});
