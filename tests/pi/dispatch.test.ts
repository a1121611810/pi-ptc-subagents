// pi 面·派发链探针（Slice 2）：16 条能力 / 28 条 mutant。
//
// 断言来源：
//   搬（旧 node:test 探针，逐条搬）：dispatch-child-runtime / child-stall-guard / child-context-shrink /
//   stdout-tail-cap / delivery-trail / program-carrier-path / program-child / task-trace-archive / no-skimp-flags。
//   新写（旧探针里没有独立文件的那几项，照 packages/dispatch 源码 + spec 决策 29 写）：gates / report /
//   usage / registry-persist / notifications / agent-discovery / slots / task-record —— 文件里标「新写」。
//
// 探针打产物（仓规）：packages/{dispatch,routes,task,entry}/dist/index.js。
// 假时钟：timeout / stall 两组用 vi.useFakeTimers() 驱动（引擎的定时器在生产语义里是 unref 的，探针不改它）。
// 假孩子：进程级替身（spawnChild 的 DI 注入点）——自己 ref 真实定时器拽住事件循环，否则 await 窗口里
// 只剩引擎的 unref 定时器（node 22 判「event loop has already resolved」，CI 22 腿连红两轮的老坑）。
// 副作用 import：装一份假 pi 到 PATH（见 helpers/pi-harness.ts 的说明）
import "../helpers/pi-harness.ts";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChildActivityTracker,
  DispatchSlotCounter,
  FileOutputStorage,
  InMemoryOutputStorage,
  NO_SKIMP_SUB_NOTE,
  NOTIFICATION_BATCH_MAX_BYTES,
  NotificationCenter,
  REPORT_CONTRACT_BLOCK,
  TaskEngine,
  TaskRegistry,
  agentNameGate,
  agentResolveGate,
  buildPiArgv,
  createTaskId,
  deliveryFromSubCalls,
  depthGate,
  dispatchEnabledGate,
  findAgent,
  parseAgentMarkdown,
  parseChildStream,
  parseProgramEnvelope,
  programGate,
  readOnlyGate,
  sessionEndingGate,
  taskTextGate,
} from "../../packages/dispatch/dist/index.js";
import { renderDeliveryCheck } from "../../packages/routes/dist/index.js";
import { readTaskOutput } from "../../packages/task/dist/index.js";

// ── 形状垫片（产物没有 .d.ts，探针只声明用到的字段） ─────────────────────────
type Outcome = {
  status: string;
  taskId?: string;
  errorMessage?: string;
  text?: string;
  exitCode?: number;
  started?: boolean;
  agentName?: string;
  usage?: { input?: number; output?: number; cost?: number; turns?: number };
  report?: {
    summary?: string;
    usage?: { input?: number; output?: number; cost?: number; turns?: number };
  };
  reportChannel?: string;
  delivery?: { tools: Record<string, number>; paths: string[]; errors: number; textChars: number };
  outputTruncated?: boolean;
};

function errorOf(outcome: { status: string }): string {
  return String((outcome as { errorMessage?: string }).errorMessage ?? "");
}

// ── 假孩子（引擎 spawnChild 的 DI 注入点） ────────────────────────────────
const realSetInterval = setInterval;
const realClearInterval = clearInterval;
const keepAlives: ReturnType<typeof setInterval>[] = [];

afterEach(() => {
  for (const timer of keepAlives.splice(0)) realClearInterval(timer);
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

type FakeChildState = {
  pid: number;
  argv: string[];
  env: NodeJS.ProcessEnv;
  kills: string[];
  hooked: number;
  emit(chunk: string): void;
  finish(code: number): void;
};

function fakeSpawn(options: { pid?: number } = {}) {
  let outCb: ((chunk: string) => void) | undefined;
  let exitCb: ((code: number, stderr: string) => void) | undefined;
  const state: FakeChildState = {
    pid: options.pid ?? 4242,
    argv: [],
    env: {},
    kills: [],
    hooked: 0,
    emit: (chunk) => outCb?.(chunk),
    finish: (code) => exitCb?.(code, ""),
  };
  const spawn = (argv: string[], env: NodeJS.ProcessEnv) => {
    state.argv = argv;
    state.env = env;
    outCb = undefined;
    exitCb = undefined;
    keepAlives.push(realSetInterval(() => {}, 60_000)); // ref 定时器：假孩子没有 stdio 管道，自己拽住事件循环
    return {
      pid: state.pid,
      onOutput: (cb: (chunk: string) => void) => {
        outCb = cb;
      },
      onExit: (cb: (code: number, stderr: string) => void) => {
        exitCb = cb;
        state.hooked += 1;
      },
      kill: (signal: NodeJS.Signals) => {
        state.kills.push(signal);
        exitCb?.(-1, "");
      },
    };
  };
  return { state, spawn };
}

/** 等假孩子的回调挂上（引擎 spawn 之后才挂监听器） */
async function untilFake(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await vi.advanceTimersByTimeAsync(0);
  }
  throw new Error(`until 超时：${label}`);
}

async function untilReal(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`until 超时：${label}`);
}

/** 一条真实形状的子进程事件流（取自 bench 产物 output.log） */
function childStream(options: { path?: string; text?: string; error?: boolean } = {}): string {
  const path = options.path ?? "materials/topic-2.md";
  const text = options.text ?? "F2-1 = 36";
  const error = options.error ?? false;
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

// ── gates（新写：六道闸 + programGate + agentResolveGate + 闸序） ─────────
describe("gates", () => {
  it("闸门·task 以 - 开头被拒（pi 会把它当命令行选项）", async () => {
    const registry = new TaskRegistry();
    // 假 spawn：闸一旦被变异放行，也不会真起 pi
    const engine = new TaskEngine({
      registry,
      gates: [taskTextGate],
      spawnChild: fakeSpawn().spawn,
    });
    const outcome = await engine.dispatch({ task: "--help" });
    expect(outcome.status).toBe("rejected");
    expect(errorOf(outcome)).toContain("不能以 - 开头");
    expect(registry.list()).toHaveLength(0); // 闸在铸 id 前：被拒不留痕迹
  });

  it("闸门·未知 agent 被拒（解析不出就不入队）", async () => {
    const registry = new TaskRegistry();
    const engine = new TaskEngine({
      registry,
      gates: [agentResolveGate(() => false)],
      spawnChild: fakeSpawn().spawn,
    });
    const outcome = await engine.dispatch({ task: "x", agent: "ghost" });
    expect(outcome.status).toBe("rejected");
    expect(errorOf(outcome)).toContain("unknown agent");
    expect(registry.list()).toHaveLength(0);
  });

  it("闸门·program 与 agent/model/thinkingLevel 不并用被拒", async () => {
    const registry = new TaskRegistry();
    const engine = new TaskEngine({
      registry,
      gates: [programGate],
      spawnChild: fakeSpawn().spawn,
    });
    const outcome = await engine.dispatch({ task: "x", program: "return 1", agent: "reader" });
    expect(outcome.status).toBe("rejected");
    expect(errorOf(outcome)).toContain("不并用");
    expect(registry.list()).toHaveLength(0);
  });

  it("闸门·其余口径：readOnly 非法值不 coerce / 会话结束 / 派发关闭 / 深度超限 / agent 名非法", async () => {
    const fake = fakeSpawn().spawn;
    const readOnly = new TaskEngine({
      registry: new TaskRegistry(),
      gates: [readOnlyGate],
      spawnChild: fake,
    });
    expect(errorOf(await readOnly.dispatch({ task: "x", readOnly: "weird" as never }))).toContain(
      "invalid readOnly value",
    );
    const ending = new TaskEngine({
      registry: new TaskRegistry(),
      gates: [sessionEndingGate(() => true)],
      spawnChild: fake,
    });
    expect(errorOf(await ending.dispatch({ task: "x" }))).toContain("session is ending");
    const disabled = new TaskEngine({
      registry: new TaskRegistry(),
      gates: [dispatchEnabledGate(() => false)],
      spawnChild: fake,
    });
    expect(errorOf(await disabled.dispatch({ task: "x" }))).toContain("dispatch is disabled");
    const deep = new TaskEngine({
      registry: new TaskRegistry(),
      gates: [depthGate(() => 3, 3)],
      spawnChild: fake,
    });
    expect(errorOf(await deep.dispatch({ task: "x" }))).toContain("depth limit reached");
    const badName = new TaskEngine({
      registry: new TaskRegistry(),
      gates: [agentNameGate],
      spawnChild: fake,
    });
    expect(errorOf(await badName.dispatch({ task: "x", agent: "../evil" }))).toContain(
      "agent name must match",
    );
  });

  it("闸门·闸序：先到先拒（前一闸拒了，后面的闸不再跑）", async () => {
    const ran: string[] = [];
    const first = () => ({ status: "rejected" as const, errorMessage: "第一道闸" });
    const second = () => {
      ran.push("second");
      return { status: "rejected" as const, errorMessage: "第二道闸" };
    };
    const engine = new TaskEngine({
      registry: new TaskRegistry(),
      gates: [first, second],
      spawnChild: fakeSpawn().spawn,
    });
    const outcome = await engine.dispatch({ task: "x" });
    expect(errorOf(outcome)).toBe("第一道闸");
    expect(ran).toEqual([]);
  });
});

// ── argv（搬：no-skimp-flags / child-context-shrink 的旗标部分） ─────────
describe("argv", () => {
  const BASE = { task: "do the thing" };
  const CTX = { depth: 1 };

  it("argv·旗标序：pi 基本旗标固定在前，task 收尾", () => {
    const argv = buildPiArgv(BASE, CTX);
    expect(argv.slice(0, 6)).toEqual([
      "pi",
      "-p",
      "--no-session",
      "--mode",
      "json",
      "--append-system-prompt",
    ]);
    expect(argv[6]).toContain("<pi-ptc-context>");
    expect(argv.at(-1)).toBe("do the thing");
  });

  it("argv·模型继承序：调用参数 → agent 定义 → 会话模型", () => {
    const picked = buildPiArgv({ ...BASE, model: "m-call", agentModel: "m-agent" }, CTX);
    expect(picked[picked.indexOf("--model") + 1]).toBe("m-call");
    const fromAgent = buildPiArgv({ ...BASE, agentModel: "m-agent" }, CTX);
    expect(fromAgent[fromAgent.indexOf("--model") + 1]).toBe("m-agent");
    const fromSession = buildPiArgv(BASE, { ...CTX, sessionModel: "m-session" });
    expect(fromSession[fromSession.indexOf("--model") + 1]).toBe("m-session");
    const thinking = buildPiArgv({ ...BASE, model: "m-call", thinkingLevel: "high" }, CTX);
    expect(thinking[thinking.indexOf("--model") + 1]).toBe("m-call:high");
  });

  it("argv·strict 读集随能力开关派生（strict 压过一切，能力开着不许被滤掉）", () => {
    const plain = buildPiArgv({ ...BASE, readOnly: "strict" }, CTX);
    expect(plain[plain.indexOf("--tools") + 1]).toBe("read,grep,find,ls");
    const withSearch = buildPiArgv({ ...BASE, readOnly: "strict", searchEnabled: true }, CTX);
    expect(withSearch[withSearch.indexOf("--tools") + 1]).toBe("read,grep,find,ls,web_ds_search");
    const withOcr = buildPiArgv({ ...BASE, readOnly: "strict", ocrEnabled: true }, CTX);
    expect(withOcr[withOcr.indexOf("--tools") + 1]).toBe("read,grep,find,ls,doc_ds_ocr");
    const narrowed = buildPiArgv({ ...BASE, agentTools: ["read", "ls"] }, CTX);
    expect(narrowed[narrowed.indexOf("--tools") + 1]).toBe("read,ls");
  });

  it("argv·no-skimp 追加块进 <pi-ptc-context> 块内（默认不带）", () => {
    const off = buildPiArgv(BASE, CTX);
    expect(off[off.indexOf("--append-system-prompt") + 1]).not.toContain(
      "Do not skimp on the real run",
    );
    const on = buildPiArgv({ ...BASE, noSkimpSub: true }, CTX);
    const block = on[on.indexOf("--append-system-prompt") + 1];
    expect(block).toContain(NO_SKIMP_SUB_NOTE);
    expect(block).toContain("<pi-ptc-context>");
  });
});

// ── timeout（搬：dispatch-child-runtime 的 timeoutMs 两条 + 新写零值边界） ─
describe("timeout", () => {
  it("timeout·pi 孩子：超时收尸，终态 canceled", async () => {
    vi.useFakeTimers();
    const registry = new TaskRegistry();
    const { state, spawn } = fakeSpawn();
    const engine = new TaskEngine({
      registry,
      output: new InMemoryOutputStorage(),
      spawnChild: spawn,
      stallMs: 0,
    });
    const pending = engine.dispatch({ task: "x", wait: true, timeoutMs: 30 });
    await untilFake(() => state.hooked > 0, "孩子起来");
    await vi.advanceTimersByTimeAsync(30);
    const r = (await pending) as Outcome;
    expect(r.status).toBe("canceled");
    expect(registry.get(r.taskId ?? "")?.status).toBe("canceled");
  });

  it("timeout·pi 孩子：stopReason 写明超时毫秒数", async () => {
    vi.useFakeTimers();
    const { state, spawn } = fakeSpawn();
    const engine = new TaskEngine({
      registry: new TaskRegistry(),
      output: new InMemoryOutputStorage(),
      spawnChild: spawn,
      stallMs: 0,
    });
    const pending = engine.dispatch({ task: "x", wait: true, timeoutMs: 30 });
    await untilFake(() => state.hooked > 0, "孩子起来");
    await vi.advanceTimersByTimeAsync(30);
    const r = (await pending) as Outcome;
    expect(r.errorMessage).toBe("timeout after 30ms");
  });

  it("timeout·不传 timeoutMs ⇒ 不计时也不杀（假时钟推进十分钟仍无信号）", async () => {
    vi.useFakeTimers();
    const { state, spawn } = fakeSpawn();
    const engine = new TaskEngine({
      registry: new TaskRegistry(),
      output: new InMemoryOutputStorage(),
      spawnChild: spawn,
      stallMs: 0,
    });
    const pending = engine.dispatch({ task: "x", wait: true });
    await untilFake(() => state.hooked > 0, "孩子起来");
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(state.kills).toEqual([]);
    state.finish(0);
    const r = (await pending) as Outcome;
    expect(r.status).toBe("fulfilled");
  });

  it("timeout·timeoutMs=0 ⇒ 不计时（零值不当预算）", async () => {
    vi.useFakeTimers();
    const { state, spawn } = fakeSpawn();
    const engine = new TaskEngine({
      registry: new TaskRegistry(),
      output: new InMemoryOutputStorage(),
      spawnChild: spawn,
      stallMs: 0,
    });
    const pending = engine.dispatch({ task: "x", wait: true, timeoutMs: 0 });
    await untilFake(() => state.hooked > 0, "孩子起来");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.kills).toEqual([]);
    state.finish(0);
    const r = (await pending) as Outcome;
    expect(r.status).toBe("fulfilled");
  });
});

// ── stall（搬：child-stall-guard 全部 + 新写阈值边界） ───────────────────
describe("stall", () => {
  it("stall·口径一：没动静 ⇒ 停滞（刚起步不算）", () => {
    let now = 1_000;
    const tracker = new ChildActivityTracker(() => now);
    expect(tracker.isStalled(now, 5_000)).toBe(false);
    now += 5_001;
    expect(tracker.isStalled(now, 5_000)).toBe(true);
  });

  it("stall·口径二：在飞的工具 ⇒ 不停滞（工具结束后又没动静 ⇒ 停滞）", () => {
    let now = 1_000;
    const tracker = new ChildActivityTracker(() => now);
    tracker.push(JSON.stringify({ type: "tool_execution_start", toolName: "bash" }) + "\n");
    now += 60_000;
    expect(tracker.isStalled(now, 5_000)).toBe(false);
    tracker.push(JSON.stringify({ type: "tool_execution_end", toolName: "bash" }) + "\n");
    now += 60_000;
    expect(tracker.isStalled(now, 5_000)).toBe(true);
  });

  it("stall·阈值：恰好到阈值即算停滞", () => {
    let now = 1_000;
    const tracker = new ChildActivityTracker(() => now);
    now += 5_000;
    expect(tracker.isStalled(now, 5_000)).toBe(true);
  });

  it("stall·新动静重置计时", () => {
    let now = 1_000;
    const tracker = new ChildActivityTracker(() => now);
    now += 4_000;
    tracker.push('{"type":"message_update"}\n');
    now += 4_000;
    expect(tracker.isStalled(now, 5_000)).toBe(false);
    now += 1_001;
    expect(tracker.isStalled(now, 5_000)).toBe(true);
  });

  it("stall·护栏收尸：完全没动静的孩子被收尸，stopReason 写明 stalled", async () => {
    vi.useFakeTimers();
    const registry = new TaskRegistry();
    const { state, spawn } = fakeSpawn();
    const engine = new TaskEngine({
      registry,
      output: new InMemoryOutputStorage(),
      spawnChild: spawn,
      stallMs: 50,
      stopGraceMs: 10,
    });
    const pending = engine.dispatch({ task: "hang", wait: true });
    await untilFake(() => state.hooked > 0, "孩子起来");
    await vi.advanceTimersByTimeAsync(55);
    const r = (await pending) as Outcome;
    expect(r.status).toBe("canceled");
    expect(r.errorMessage).toContain("stalled");
    expect(registry.get(r.taskId ?? "")?.status).toBe("canceled");
  });

  it("stall·信号阶梯：收尸先 SIGTERM", async () => {
    vi.useFakeTimers();
    const { state, spawn } = fakeSpawn();
    const engine = new TaskEngine({
      registry: new TaskRegistry(),
      output: new InMemoryOutputStorage(),
      spawnChild: spawn,
      stallMs: 50,
      stopGraceMs: 10,
    });
    const pending = engine.dispatch({ task: "hang", wait: true });
    await untilFake(() => state.hooked > 0, "孩子起来");
    await vi.advanceTimersByTimeAsync(55);
    await pending;
    expect(state.kills).toEqual(["SIGTERM"]);
  });

  it("stall·在飞工具的孩子不被收尸", async () => {
    vi.useFakeTimers();
    const registry = new TaskRegistry();
    const { state, spawn } = fakeSpawn();
    const engine = new TaskEngine({
      registry,
      output: new InMemoryOutputStorage(),
      spawnChild: spawn,
      stallMs: 200,
      stopGraceMs: 10,
    });
    const handle = (await engine.dispatch({ task: "long tool" })) as Outcome;
    await untilFake(() => state.hooked > 0, "孩子起来");
    state.emit(JSON.stringify({ type: "session" }) + "\n");
    state.emit(JSON.stringify({ type: "tool_execution_start", toolName: "bash" }) + "\n");
    await vi.advanceTimersByTimeAsync(600);
    expect(state.kills).toEqual([]);
    expect(registry.get(handle.taskId ?? "")?.status).toBe("running");
    await engine.stop(handle.taskId ?? "", "test cleanup");
  });

  it("stall·stallMs=0 ⇒ 护栏关掉（挂死的孩子照旧挂着）", async () => {
    vi.useFakeTimers();
    const registry = new TaskRegistry();
    const { state, spawn } = fakeSpawn();
    const engine = new TaskEngine({
      registry,
      output: new InMemoryOutputStorage(),
      spawnChild: spawn,
      stallMs: 0,
      stopGraceMs: 10,
    });
    const handle = (await engine.dispatch({ task: "hang" })) as Outcome;
    await untilFake(() => state.hooked > 0, "孩子起来");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(state.kills).toEqual([]);
    expect(registry.get(handle.taskId ?? "")?.status).toBe("running");
    await engine.stop(handle.taskId ?? "", "test cleanup");
  });
});

// ── report（新写：报告两通道 + 契约块） ────────────────────────────────
describe("report", () => {
  it("report·工具通道优先：toolResult 里的 ptc_child_report 被抠出，通道标 tool", async () => {
    const { state, spawn } = fakeSpawn();
    const engine = new TaskEngine({
      registry: new TaskRegistry(),
      output: new InMemoryOutputStorage(),
      spawnChild: spawn,
    });
    const pending = engine.dispatch({ task: "x", wait: true });
    await untilReal(() => state.hooked > 0, "孩子起来");
    state.emit(
      [
        JSON.stringify({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        }),
        JSON.stringify({
          type: "message_end",
          message: {
            role: "toolResult",
            toolName: "ptc_child_report",
            structuredContent: { summary: "工具通道的报告", findings: [{ what: "a" }] },
          },
        }),
      ].join("\n"),
    );
    state.finish(0);
    const r = (await pending) as Outcome;
    expect(r.reportChannel).toBe("tool");
    expect(r.report?.summary).toBe("工具通道的报告");
  });

  it("report·prompt 通道：正文末尾的 fenced JSON 块被抠出，通道标 prompt-json", async () => {
    const { state, spawn } = fakeSpawn();
    const engine = new TaskEngine({
      registry: new TaskRegistry(),
      output: new InMemoryOutputStorage(),
      spawnChild: spawn,
    });
    const pending = engine.dispatch({ task: "x", wait: true });
    await untilReal(() => state.hooked > 0, "孩子起来");
    state.emit(
      ["这是交付正文。", "```json", '{"summary":"prompt 通道的报告"}', "```", ""].join("\n"),
    );
    state.finish(0);
    const r = (await pending) as Outcome;
    expect(r.reportChannel).toBe("prompt-json");
    expect(r.report?.summary).toBe("prompt 通道的报告");
  });

  it("report·opted-out：agent frontmatter childReport=false ⇒ 通道 opted-out、报告不抠", async () => {
    const { state, spawn } = fakeSpawn();
    const engine = new TaskEngine({
      registry: new TaskRegistry(),
      output: new InMemoryOutputStorage(),
      spawnChild: spawn,
      resolveAgent: () => ({ name: "quiet", path: "/tmp/quiet.md", childReport: false }),
    });
    const pending = engine.dispatch({ task: "x", agent: "quiet", wait: true });
    await untilReal(() => state.hooked > 0, "孩子起来");
    state.emit(["```json", '{"summary":"不该被抠"}', "```", ""].join("\n"));
    state.finish(0);
    const r = (await pending) as Outcome;
    expect(r.reportChannel).toBe("opted-out");
    expect(r.report).toBeUndefined();
  });

  it("report·契约块：报告不是交付物，且优先引导工具通道", () => {
    expect(REPORT_CONTRACT_BLOCK).toContain("NOT the deliverable");
    expect(REPORT_CONTRACT_BLOCK).not.toContain("is your deliverable");
    expect(REPORT_CONTRACT_BLOCK).toContain("ptc_child_report");
  });
});

// ── usage（搬：dispatch-child-runtime 的 usage 兜底） ────────────────────
describe("usage", () => {
  it("usage·孩子自报全 0 ⇒ 让位给宿主观测值（父在任务面才看得到真实用量）", async () => {
    const { state, spawn } = fakeSpawn();
    const engine = new TaskEngine({
      registry: new TaskRegistry(),
      output: new InMemoryOutputStorage(),
      spawnChild: spawn,
    });
    const pending = engine.dispatch({ task: "x", wait: true });
    await untilReal(() => state.hooked > 0, "孩子起来");
    state.emit(
      [
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            usage: { input: 1234, output: 56, cacheRead: 78, cacheWrite: 0, cost: { total: 0.5 } },
          },
        }),
        JSON.stringify({
          type: "message_end",
          message: {
            role: "toolResult",
            toolName: "ptc_child_report",
            structuredContent: { summary: "s", usage: { input: 0, output: 0, cost: 0, turns: 1 } },
          },
        }),
      ].join("\n"),
    );
    state.finish(0);
    const r = (await pending) as Outcome;
    expect(r.reportChannel).toBe("tool");
    expect(r.report?.usage?.input).toBe(1234);
    expect(r.report?.usage?.output).toBe(56);
  });
});

// ── registry-persist（新写：落盘 + 重启恢复 + 会话血缘过滤 + 变迁回调） ──
describe("registry-persist", () => {
  it("registry·落盘：终态记录写穿到 records/<id>.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ptc-reg-"));
    const { state, spawn } = fakeSpawn();
    const engine = new TaskEngine({
      registry: new TaskRegistry(),
      storageDir: dir,
      output: new FileOutputStorage(dir),
      spawnChild: spawn,
    });
    const pending = engine.dispatch({ task: "落盘", wait: true });
    await untilReal(() => state.hooked > 0, "孩子起来");
    state.finish(0);
    const r = (await pending) as Outcome;
    const file = join(dir, "records", `${r.taskId}.json`);
    expect(existsSync(file)).toBe(true);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.status).toBe("succeeded");
    expect(saved.task).toBe("落盘");
    await engine.shutdown();
  });

  it("registry·重启恢复：上次会话的未终态记录（owner 已死）标 lost", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ptc-reg-"));
    mkdirSync(join(dir, "records"), { recursive: true });
    writeFileSync(
      join(dir, "records", "orphan.json"),
      JSON.stringify({ id: "orphan", status: "running", task: "上次会话的活" }),
    );
    const registry = new TaskRegistry();
    const engine = new TaskEngine({
      registry,
      storageDir: dir,
      output: new FileOutputStorage(dir),
      spawnChild: fakeSpawn().spawn,
    });
    await engine.dispatch({ task: "boot" }); // dispatch 会等 #ready（restore 在里面做）
    expect(registry.get("orphan")?.status).toBe("lost");
    expect(registry.get("orphan")?.stopReason).toBe("lost_on_session_restart");
  });

  it("registry·会话血缘过滤：owner 还活着的在飞任务不装载（不标 lost）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ptc-reg-"));
    mkdirSync(join(dir, "records"), { recursive: true });
    writeFileSync(
      join(dir, "records", "live.json"),
      JSON.stringify({
        id: "live",
        status: "running",
        task: "别的会话在飞",
        ownerPid: process.pid,
      }),
    );
    const registry = new TaskRegistry();
    const engine = new TaskEngine({
      registry,
      storageDir: dir,
      output: new FileOutputStorage(dir),
      spawnChild: fakeSpawn().spawn,
    });
    await engine.dispatch({ task: "boot" });
    expect(registry.get("live")?.status).toBe("running");
  });

  it("registry·变迁回调：订阅者收到终态记录（next/prev 成对）", async () => {
    const seen: { status: string; prev: string | null }[] = [];
    const registry = new TaskRegistry();
    registry.subscribe((next, prev) =>
      seen.push({ status: next.status, prev: prev?.status ?? null }),
    );
    const { state, spawn } = fakeSpawn();
    const engine = new TaskEngine({
      registry,
      output: new InMemoryOutputStorage(),
      spawnChild: spawn,
    });
    const pending = engine.dispatch({ task: "x", wait: true });
    await untilReal(() => state.hooked > 0, "孩子起来");
    state.finish(0);
    await pending;
    expect(seen.map((s) => s.status)).toContain("succeeded");
    expect(seen.some((s) => s.status === "running" && s.prev === "queued")).toBe(true);
  });
});

// ── archive（搬：task-trace-archive 的归档/TTL 两条 + 新写批量上限） ─────
describe("archive", () => {
  it("archive·归档 gz 往返：热存挤掉后归档可读回（记录 + 产出）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ptc-arch-"));
    const registry = new TaskRegistry();
    const { state, spawn } = fakeSpawn();
    const engine = new TaskEngine({
      registry,
      storageDir: dir,
      output: new FileOutputStorage(dir),
      spawnChild: spawn,
      terminalRecordKeep: 2,
    });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const mark = state.hooked;
      const pending = engine.dispatch({ task: `t${i}`, wait: true });
      await untilReal(() => state.hooked > mark, "孩子起来");
      state.emit("hello\n");
      state.finish(0);
      ids.push(((await pending) as Outcome).taskId ?? "");
    }
    expect(registry.list()).toHaveLength(2);
    // 归档链：先写 gz、再删热文件 ⇒ 等热文件消失（gz 落位在前）
    await untilReal(
      () => !existsSync(join(dir, "records", `${ids[0]}.json`)),
      "归档落位（主线不等，尾链自己在 event loop 上推进）",
    );
    expect(existsSync(join(dir, "archive", `${ids[0]}.json.gz`))).toBe(true);
    const back = await engine.readArchivedRecord(ids[0] ?? "");
    expect(back?.archived).toBe(true);
    expect(back?.task).toBe("t0");
    expect(await engine.readOutput(ids[0] ?? "")).toBe("hello\n");
    expect(await engine.outputSize(ids[0] ?? "")).toBe(6);
    await engine.shutdown();
  });

  it("archive·TTL：31 天前的归档被 boot 清掉，刚归档的留", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ptc-arch-"));
    mkdirSync(join(dir, "archive"), { recursive: true });
    writeFileSync(
      join(dir, "archive", "old-1.json.gz"),
      gzipSync(
        Buffer.from(
          JSON.stringify({
            id: "old-1",
            status: "succeeded",
            task: "old",
            archivedAt: Date.now() - 31 * 86_400_000,
          }),
        ),
      ),
    );
    writeFileSync(
      join(dir, "archive", "fresh-1.json.gz"),
      gzipSync(Buffer.from(JSON.stringify({ id: "fresh-1", status: "succeeded", task: "f" }))),
    );
    const past = new Date(Date.now() - 31 * 86_400_000);
    utimesSync(join(dir, "archive", "old-1.json.gz"), past, past);
    const engine = new TaskEngine({
      registry: new TaskRegistry(),
      storageDir: dir,
      output: new FileOutputStorage(dir),
      spawnChild: fakeSpawn().spawn,
    });
    await engine.dispatch({ task: "boot" });
    expect(existsSync(join(dir, "archive", "old-1.json.gz"))).toBe(false);
    expect(existsSync(join(dir, "archive", "fresh-1.json.gz"))).toBe(true);
  });

  it("archive·purge 批量上限：单次 boot 最多清 500 个过期归档", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ptc-arch-"));
    mkdirSync(join(dir, "archive"), { recursive: true });
    const past = new Date(Date.now() - 31 * 86_400_000);
    for (let i = 0; i < 501; i++) {
      const file = join(dir, "archive", `stale-${i}.json.gz`);
      writeFileSync(
        file,
        gzipSync(Buffer.from(JSON.stringify({ id: `stale-${i}`, status: "succeeded", task: "s" }))),
      );
      utimesSync(file, past, past);
    }
    const engine = new TaskEngine({
      registry: new TaskRegistry(),
      storageDir: dir,
      output: new FileOutputStorage(dir),
      spawnChild: fakeSpawn().spawn,
    });
    await engine.dispatch({ task: "boot" });
    const left = readdirSync(join(dir, "archive")).filter((f) => f.endsWith(".json.gz"));
    expect(left).toHaveLength(1); // 501 个过期归档里只清 500 个，剩下的下轮收
  });
});

// ── delivery（搬：delivery-trail + stdout-tail-cap） ────────────────────
describe("delivery", () => {
  it("delivery·轨迹来自事件流：工具/路径/报错/正文长度（不靠模型自述）", () => {
    const parsed = parseChildStream(childStream());
    expect(parsed.delivery.tools).toEqual({ read: 1 });
    expect(parsed.delivery.paths).toEqual(["materials/topic-2.md"]);
    expect(parsed.delivery.errors).toBe(0);
    expect(parsed.delivery.textChars).toBe("F2-1 = 36".length);
  });

  it("delivery·工具报错算进轨迹（isError 在事件顶层与 result 里两种形状都认）", () => {
    const top = parseChildStream(
      JSON.stringify({ type: "tool_execution_end", toolName: "read", isError: true }),
    );
    expect(top.delivery.errors).toBe(1);
    const nested = parseChildStream(childStream({ error: true }));
    expect(nested.delivery.errors).toBe(1);
  });

  it("delivery·轨迹随记录存活（父经任务面读得到）", async () => {
    const registry = new TaskRegistry();
    const { state, spawn } = fakeSpawn();
    const engine = new TaskEngine({
      registry,
      output: new InMemoryOutputStorage(),
      spawnChild: spawn,
    });
    const pending = engine.dispatch({ task: "x", wait: true });
    await untilReal(() => state.hooked > 0, "孩子起来");
    state.emit(childStream());
    state.finish(0);
    const r = (await pending) as Outcome;
    expect(r.delivery?.tools.read).toBe(1);
    expect(r.delivery?.paths).toEqual(["materials/topic-2.md"]);
    expect(registry.get(r.taskId ?? "")?.delivery?.paths).toEqual(["materials/topic-2.md"]);
  });

  it("delivery·后缀匹配：报告自报相对路径、实测绝对路径 ⇒ 不出零命中警告", () => {
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
    expect(note).not.toContain("零命中");
  });

  it("delivery·零产出要说出口（重派 / 别替它补数），声称动了文件要说没有实测支撑", () => {
    const nothing = renderDeliveryCheck({
      delivery: { tools: {}, paths: [], errors: 0, textChars: 0 },
      findings: 0,
      channel: "none",
    });
    expect(nothing).toContain("零产出");
    expect(nothing).toContain("重派");
    expect(nothing).toContain("别替它补数");
    const unsupported = renderDeliveryCheck({
      delivery: { tools: { bash: 6 }, paths: [], errors: 0, textChars: 100 },
      findings: 2,
      channel: "tool",
      filesTouched: ["/tmp/pci401.pdf", "/tmp/changes.pdf"],
    });
    expect(unsupported).toContain("声称动了 2 个文件");
    expect(unsupported).toContain("零命中");
    expect(unsupported).toContain("没有实测支撑");
  });

  it("delivery·stdout 尾部截断：超上限砍头留尾并标 outputTruncated", async () => {
    const cap = 16 * 1024 * 1024;
    const big =
      "A".repeat(17 * 1024 * 1024) + "\n```json\n" + '{"summary":"ok-report"}' + "\n```\n";
    const { state, spawn } = fakeSpawn();
    const registry = new TaskRegistry();
    const engine = new TaskEngine({
      registry,
      output: new InMemoryOutputStorage(),
      spawnChild: spawn,
    });
    const pending = engine.dispatch({ task: "x", wait: true });
    await untilReal(() => state.hooked > 0, "孩子起来");
    state.emit(big);
    state.finish(0);
    const r = (await pending) as Outcome;
    expect(r.outputTruncated).toBe(true);
    expect((r.text ?? "").length).toBeLessThanOrEqual(cap);
    expect(r.report?.summary).toBe("ok-report");
    expect(r.status).toBe("fulfilled");
  });
});

// ── notifications（新写：通知中心批投递 + 槽位语义） ────────────────────
describe("notifications", () => {
  it("notifications·批投递：终态变迁进队列，drain 按字节上限分批", async () => {
    const registry = new TaskRegistry();
    const center = new NotificationCenter();
    center.attach(registry);
    for (let i = 0; i < 1_200; i++) {
      await registry.submit({
        kind: "spawn",
        record: {
          id: `n${i}`,
          status: "succeeded",
          task: `t${i}`,
          label: "x".repeat(200),
          finishedAt: 1_000 + i,
        },
      });
    }
    expect(center.pendingCount()).toBe(1_200);
    const batches = center.drain();
    expect(batches.flat()).toHaveLength(1_200);
    expect(batches.length).toBeGreaterThan(1); // 字节上限切批
    expect(NOTIFICATION_BATCH_MAX_BYTES).toBe(100 * 1024);
    expect(center.pendingCount()).toBe(0);
  });

  it("notifications·槽位语义：前台等待（wait）的任务终态不投递通知", async () => {
    const registry = new TaskRegistry();
    const center = new NotificationCenter();
    center.attach(registry);
    const { state, spawn } = fakeSpawn();
    const engine = new TaskEngine({
      registry,
      output: new InMemoryOutputStorage(),
      spawnChild: spawn,
      notifications: { markAwaited: (id: string) => center.markAwaited(id) },
    });
    const pending = engine.dispatch({ task: "x", wait: true });
    await untilReal(() => state.hooked > 0, "孩子起来");
    state.finish(0);
    await pending;
    expect(center.pendingCount()).toBe(0);
  });

  it("notifications·后台任务终态进待投递队列", async () => {
    const registry = new TaskRegistry();
    const center = new NotificationCenter();
    center.attach(registry);
    const { state, spawn } = fakeSpawn();
    const engine = new TaskEngine({
      registry,
      output: new InMemoryOutputStorage(),
      spawnChild: spawn,
    });
    const handle = (await engine.dispatch({ task: "x" })) as Outcome;
    await untilReal(() => state.hooked > 0, "孩子起来");
    state.finish(0);
    await untilReal(() => center.pendingCount() > 0, "终态进队列");
    expect(center.drain().flat()[0]?.taskId).toBe(handle.taskId);
  });
});

// ── program-carrier（搬：program-carrier-path + program-child） ─────────
describe("program-carrier", () => {
  const CLI_PATH = "/fake/dist/ptc/cli.js";
  const FULFILLED = {
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
      {
        callId: 2,
        name: "grep",
        args: { pattern: "F2" },
        status: "ok",
        startedAt: 3,
        durationMs: 1,
      },
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

  it("program·载体路径解析：<index 所在目录>/ptc/cli.js 命中（老坑：差一节 dist）", async () => {
    const { resolveProgramCliPath } = await import("../../packages/entry/dist/index.js");
    const entryIndex = fileURLToPath(
      new URL("../../packages/entry/dist/index.js", import.meta.url),
    );
    const resolved = resolveProgramCliPath(pathToFileURL(entryIndex).href);
    expect(resolved).toBe(join(dirname(entryIndex), "ptc", "cli.js"));
    expect(existsSync(resolved as string)).toBe(true);
  });

  it("program·发布布局同形：<root>/dist/index.js ⇒ <root>/dist/ptc/cli.js", async () => {
    const { resolveProgramCliPath } = await import("../../packages/entry/dist/index.js");
    const root = mkdtempSync(join(tmpdir(), "ptc-pub-"));
    mkdirSync(join(root, "dist", "ptc"), { recursive: true });
    writeFileSync(join(root, "dist", "index.js"), "// entry");
    writeFileSync(join(root, "dist", "ptc", "cli.js"), "// cli");
    expect(resolveProgramCliPath(pathToFileURL(join(root, "dist", "index.js")).href)).toBe(
      join(root, "dist", "ptc", "cli.js"),
    );
  });

  it("program·载体缺失 ⇒ 闸前拒（registry 不留痕）", async () => {
    const registry = new TaskRegistry();
    const engine = new TaskEngine({
      registry,
      spawnChild: fakeSpawn().spawn,
    });
    const outcome = await engine.dispatch({ task: "x", program: "return 1" });
    expect(outcome.status).toBe("rejected");
    expect(errorOf(outcome)).toContain("programCliPath");
    expect(registry.list()).toHaveLength(0);
  });

  it("program·信封三态：fulfilled/rejected/canceled 都认（形状不对才报错）", () => {
    expect(
      parseProgramEnvelope(JSON.stringify({ status: "fulfilled", value: 1, logs: [] })).status,
    ).toBe("fulfilled");
    expect(
      parseProgramEnvelope(JSON.stringify({ status: "rejected", error: "x", logs: [] })).status,
    ).toBe("rejected");
    expect(
      parseProgramEnvelope(JSON.stringify({ status: "canceled", reason: "x", logs: [] })).status,
    ).toBe("canceled");
    expect(() => parseProgramEnvelope("{bad")).toThrow(/program envelope/);
    expect(() => parseProgramEnvelope('{"status":"weird","logs":[]}')).toThrow(/program envelope/);
  });

  it("program·fulfilled 信封 ⇒ 记录形状（program 通道 + delivery 推导 + turns 0 + argv 是 CLI）", async () => {
    const registry = new TaskRegistry();
    const { state, spawn } = fakeSpawn();
    const engine = new TaskEngine({
      registry,
      output: new InMemoryOutputStorage(),
      spawnChild: spawn,
      programCliPath: CLI_PATH,
      gates: [programGate],
    });
    const pending = engine.dispatch({
      task: "读 topic-2 抽 F2",
      program: "return 1",
      wait: true,
    });
    await untilReal(() => state.hooked > 0, "孩子起来");
    state.emit(JSON.stringify(FULFILLED));
    state.finish(0);
    const r = (await pending) as Outcome;
    expect(r.status).toBe("fulfilled");
    expect(r.reportChannel).toBe("program");
    expect(r.agentName).toBe("program");
    expect(r.usage).toEqual({ turns: 0 });
    expect(r.delivery?.tools).toEqual({ read: 2, grep: 1 });
    expect(r.delivery?.paths).toEqual(["materials/topic-2.md", "missing.md"]);
    expect(r.delivery?.errors).toBe(1);
    expect(state.argv[0]).toBe(process.execPath);
    expect(state.argv[1]).toBe(CLI_PATH);
    expect(state.argv[2]).toMatch(/program\.ts$/);
    expect(state.argv).toContain("--json");
    expect(state.argv).toContain("--workdir");
    expect(registry.get(r.taskId ?? "")?.reportChannel).toBe("program");
  });

  it("program·rejected 信封 ⇒ errorMessage 透出信封错误；垃圾 stdout ⇒ 可见失败", async () => {
    const rejected = fakeSpawn();
    const engine = new TaskEngine({
      registry: new TaskRegistry(),
      output: new InMemoryOutputStorage(),
      spawnChild: rejected.spawn,
      programCliPath: CLI_PATH,
    });
    const pending = engine.dispatch({ task: "x", program: "return 1", wait: true });
    await untilReal(() => rejected.state.hooked > 0, "孩子起来");
    rejected.state.emit(
      JSON.stringify({
        status: "rejected",
        error: "path escapes workdir: ../etc/passwd",
        logs: [],
      }),
    );
    rejected.state.finish(1);
    const r = (await pending) as Outcome;
    expect(r.status).toBe("rejected");
    expect(r.errorMessage).toContain("escapes workdir");

    const garbage = fakeSpawn();
    const engine2 = new TaskEngine({
      registry: new TaskRegistry(),
      output: new InMemoryOutputStorage(),
      spawnChild: garbage.spawn,
      programCliPath: CLI_PATH,
    });
    const pending2 = engine2.dispatch({ task: "x", program: "return 1", wait: true });
    await untilReal(() => garbage.state.hooked > 0, "孩子起来");
    garbage.state.emit("not-json-at-all");
    garbage.state.finish(1);
    const r2 = (await pending2) as Outcome;
    expect(r2.status).toBe("rejected");
    expect(r2.errorMessage).toContain("program envelope");
  });

  it("program·readTaskOutput 的 program 分支：交付物是信封 value", async () => {
    const output = new InMemoryOutputStorage();
    const registry = new TaskRegistry();
    const { state, spawn } = fakeSpawn();
    const engine = new TaskEngine({
      registry,
      output,
      spawnChild: spawn,
      programCliPath: CLI_PATH,
    });
    const pending = engine.dispatch({ task: "x", program: "return 1", wait: true });
    await untilReal(() => state.hooked > 0, "孩子起来");
    state.emit(JSON.stringify(FULFILLED));
    state.finish(0);
    const r = (await pending) as Outcome;
    const view = await readTaskOutput(
      {
        outputSize: (id) => output.size(id),
        readOutput: (id) => output.read(id),
        readOutputTail: (id, max) => output.readTail(id, max),
      },
      registry.get(r.taskId ?? "")!,
    );
    expect(view.text).toContain('"f2": 36');
    expect(view.output).toBeUndefined();
  });

  it("program·deliveryFromSubCalls 的形状钉（tools 计数 / args.path 收路径 / 非 ok 算 error）", () => {
    const d = deliveryFromSubCalls(FULFILLED.subCalls);
    expect(d.tools).toEqual({ read: 2, grep: 1 });
    expect(d.errors).toBe(1);
    expect(deliveryFromSubCalls(undefined).tools).toEqual({});
  });
});

// ── agent-discovery（新写：agent markdown 解析 + scope 查找） ───────────
describe("agent-discovery", () => {
  it("agent·frontmatter 解析：childReport/tools/model/thinkingLevel", () => {
    const dir = mkdtempSync(join(tmpdir(), "ptc-agent-"));
    const file = join(dir, "reader.md");
    writeFileSync(
      file,
      "---\nchildReport: false\ntools: read, ls\nmodel: m-agent\nthinkingLevel: high\n---\n\n正文\n",
    );
    const def = parseAgentMarkdown(file, "reader");
    expect(def?.childReport).toBe(false);
    expect(def?.tools).toEqual(["read", "ls"]);
    expect(def?.model).toBe("m-agent");
    expect(def?.thinkingLevel).toBe("high");
    expect(parseAgentMarkdown(join(dir, "missing.md"), "missing")).toBeNull();
  });

  it("agent·scope 查找：project 定义覆盖 user 定义（层级覆盖）", () => {
    const userDir = mkdtempSync(join(tmpdir(), "ptc-agent-user-"));
    const projectDir = mkdtempSync(join(tmpdir(), "ptc-agent-proj-"));
    writeFileSync(join(userDir, "a.md"), "---\nmodel: from-user\n---\n");
    writeFileSync(join(projectDir, "a.md"), "---\nmodel: from-project\n---\n");
    expect(findAgent("a", { userDir, projectDir })?.model).toBe("from-project");
    expect(findAgent("a", { userDir, projectDir })?.path).toBe(join(projectDir, "a.md"));
    expect(findAgent("a", { userDir, projectDir }, "user")?.model).toBe("from-user");
    expect(findAgent("a", { userDir, projectDir }, "project")?.model).toBe("from-project");
  });
});

// ── slots（新写：并发槽计数） ───────────────────────────────────────────
describe("slots", () => {
  it("slots·容量上限：满了排队，释放提拔最老等待者", async () => {
    const slots = new DispatchSlotCounter(2);
    expect(await slots.acquire("a")).toBe("granted");
    expect(await slots.acquire("b")).toBe("granted");
    const third = slots.acquire("c");
    expect(slots.queuedCount).toBe(1);
    expect(slots.holders()).toEqual(["a", "b"]);
    expect(slots.release("a")).toBe("c");
    expect(await third).toBe("granted");
    expect(slots.queuedCount).toBe(0);
    expect(slots.holders()).toEqual(["b", "c"]);
  });

  it("slots·抽队：cancelQueued 抽掉排队中的，已起的返回 false", async () => {
    const slots = new DispatchSlotCounter(1);
    expect(await slots.acquire("a")).toBe("granted");
    const queued = slots.acquire("b");
    expect(slots.cancelQueued("b")).toBe(true);
    expect(await queued).toBe("withdrawn");
    expect(slots.cancelQueued("a")).toBe(false);
  });
});

// ── task-record（新写：记录形状 + id 生成） ─────────────────────────────
describe("task-record", () => {
  it("task·id 生成：uuid 形状且互不相同", () => {
    const id = createTaskId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(createTaskId()).not.toBe(id);
  });

  it("task·记录形状：终态记录带齐字段（id/status/task/startedAt/finishedAt/reportChannel/outputPath）", async () => {
    const registry = new TaskRegistry();
    const { state, spawn } = fakeSpawn();
    const engine = new TaskEngine({
      registry,
      output: new InMemoryOutputStorage(),
      spawnChild: spawn,
    });
    const pending = engine.dispatch({ task: "记形状", label: "标签", wait: true });
    await untilReal(() => state.hooked > 0, "孩子起来");
    state.emit(childStream());
    state.finish(0);
    const r = (await pending) as Outcome;
    const record = registry.get(r.taskId ?? "");
    expect(record?.id).toBe(r.taskId);
    expect(record?.status).toBe("succeeded");
    expect(record?.task).toBe("记形状");
    expect(record?.label).toBe("标签");
    expect(typeof record?.startedAt).toBe("number");
    expect(typeof record?.finishedAt).toBe("number");
    expect(record?.outputPath).toBeTruthy();
    expect(record?.reportChannel).toBeDefined();
    expect(record?.delivery?.paths).toEqual(["materials/topic-2.md"]);
  });

  it("task·状态机：queued → running → succeeded，终态无出边", async () => {
    const registry = new TaskRegistry();
    await registry.submit({
      kind: "spawn",
      record: { id: "s1", status: "queued", task: "x" },
    });
    const moved = await registry.submit({ kind: "transition", id: "s1", to: "running" });
    expect(moved.fromStatus).toBe("queued");
    expect(moved.record.status).toBe("running");
    const done = await registry.submit({ kind: "resolve-exit", id: "s1", exitCode: 0 });
    expect(done.record.status).toBe("succeeded");
    const after = await registry.submit({ kind: "transition", id: "s1", to: "running" });
    expect(after.changed).toBe(false); // 终态没有出边
    expect(after.record.status).toBe("succeeded");
  });
});

// ── child-runtime（搬：dispatch-child-runtime 的 env 腿 + 新写真子进程） ─
describe("child-runtime", () => {
  it("child-runtime·真子进程：env 透传（PI_PTC_DEPTH/PI_PTC_TASK_ID + 父 env 保留）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ptc-rt-"));
    const probe = join(dir, "env.txt");
    vi.stubEnv("PTC_PROBE_MARK", "keep-me");
    const engine = new TaskEngine({
      registry: new TaskRegistry(),
      output: new InMemoryOutputStorage(),
      buildArgv: () => [
        process.execPath,
        "-e",
        `require("fs").writeFileSync(${JSON.stringify(probe)}, String(process.env.PI_PTC_DEPTH) + "|" + String(process.env.PI_PTC_TASK_ID) + "|" + String(process.env.PTC_PROBE_MARK))`,
      ],
    });
    const r = (await engine.dispatch({ task: "x", wait: true })) as Outcome;
    const written = readFileSync(probe, "utf8");
    expect(written.startsWith("1|")).toBe(true); // 孩子知道自己 depth=1
    expect(written).toContain(`|${r.taskId}|`);
    expect(written).toContain("|keep-me"); // 父 env 透传
  });

  it("child-runtime·真子进程：退出码与报告管道（stdout 的报告仍解析得出）", async () => {
    const engine = new TaskEngine({
      registry: new TaskRegistry(),
      output: new InMemoryOutputStorage(),
      buildArgv: () => [
        process.execPath,
        "-e",
        "process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}],usage:{input:7,output:3}}}) + '\\n' + JSON.stringify({type:'message_end',message:{role:'toolResult',toolName:'ptc_child_report',structuredContent:{summary:'真子进程的报告'}}}) + '\\n'); process.exitCode = 3;",
      ],
    });
    const r = (await engine.dispatch({ task: "x", wait: true })) as Outcome;
    expect(r.exitCode).toBe(3);
    expect(r.status).toBe("rejected");
    expect(r.report?.summary).toBe("真子进程的报告");
    expect(r.usage?.input).toBe(7);
  });

  it("child-runtime·真子进程：stdout 是管道（引擎抓得到孩子的输出）", async () => {
    const engine = new TaskEngine({
      registry: new TaskRegistry(),
      output: new InMemoryOutputStorage(),
      buildArgv: () => [process.execPath, "-e", "process.stdout.write('hello-from-child')"],
    });
    const r = (await engine.dispatch({ task: "x", wait: true })) as Outcome;
    expect(r.text).toContain("hello-from-child");
  });
});

// ── context-shrink（搬：child-context-shrink 全部） ─────────────────────
describe("context-shrink", () => {
  const BASE = { task: "do the thing" };
  const CTX = { depth: 1 };

  it("context·孩子 argv 恒带 --no-extensions/--no-skills（减量，显式 -e 不受影响）", () => {
    const argv = buildPiArgv(BASE, CTX);
    expect(argv).toContain("--no-extensions");
    expect(argv).toContain("--no-skills");
  });

  it("context·--no-mcp 按宿主版本门控（1.1.0 起才有）", () => {
    for (const version of ["1.1.0", "1.4.0", "2.0.0"]) {
      expect(buildPiArgv(BASE, { ...CTX, piVersion: version })).toContain("--no-mcp");
    }
    for (const version of ["0.86.0", "0.99.0", "1.0.2"]) {
      expect(buildPiArgv(BASE, { ...CTX, piVersion: version })).not.toContain("--no-mcp");
    }
    for (const version of ["", "garbage", undefined]) {
      expect(buildPiArgv(BASE, { ...CTX, piVersion: version })).not.toContain("--no-mcp");
    }
  });

  it("context·projectContext=none 关掉孩子的项目上下文（auto/缺省照常加载）", () => {
    expect(buildPiArgv(BASE, CTX)).not.toContain("--no-context-files");
    expect(buildPiArgv({ ...BASE, projectContext: "auto" }, CTX)).not.toContain(
      "--no-context-files",
    );
    expect(buildPiArgv({ ...BASE, projectContext: "none" }, CTX)).toContain("--no-context-files");
  });

  it("context·jsonl usage 带 cacheRead/cacheWrite（pi ≥1.4.0 形状），旧版缺省", () => {
    const line = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        model: "MiniMax-M3.1-Flash",
        content: [{ type: "text", text: "done" }],
        usage: { input: 7354, output: 4, cacheRead: 128, cacheWrite: 0, cost: { total: 0 } },
      },
    });
    const parsed = parseChildStream(line + "\n");
    expect(parsed.observedUsage?.cacheRead).toBe(128);
    expect(parsed.observedUsage?.cacheWrite).toBe(0);
    expect(parsed.observedUsage?.input).toBe(7354);
    const old = parseChildStream(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          usage: { input: 100, output: 5 },
        },
      }) + "\n",
    );
    expect(old.observedUsage?.input).toBe(100);
    expect(old.observedUsage?.cacheRead).toBeUndefined();
    expect(old.observedUsage?.cacheWrite).toBeUndefined();
  });
});
