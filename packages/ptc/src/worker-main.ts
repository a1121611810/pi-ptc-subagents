import { inspect } from "node:util";
import { compileProgram } from "./compile.ts";
import type { HostToWorkerFrame, RunOutcome, WorkerToHostFrame } from "./protocol.ts";
import { createWorkflowHelpers } from "./workflow-helpers.ts";

export interface WorkerMainDeps {
  post: (frame: WorkerToHostFrame) => void;
  onFrame: (handler: (frame: HostToWorkerFrame) => void) => void;
}

// worker 侧运行时：跑程序、tools.* 转发宿主、console 上提。
// 复用模型：宿主发 reset → 拒掉全部 pending、清场 globalThis（ADR-0017 warm 复用的功能等价物，不照搬十条）
export function workerMain(deps: WorkerMainDeps): void {
  let tools: Readonly<Record<string, (args: unknown) => Promise<unknown>>> = {};
  let pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let nextCallId = 1;
  let currentRunId: string | null = null;
  let logs: string[] = [];

  const globalBaseline = new Set<string>();
  const consoleBaseline = { ...console };

  deps.onFrame((frame) => {
    if (frame.kind === "init") {
      for (const name of Object.getOwnPropertyNames(globalThis)) globalBaseline.add(name);
      // new Function 的程序在全局作用域求值，tools 必须是全局绑定（this 传不进去）
      tools = Object.freeze(
        Object.fromEntries(
          frame.bindingNames.map((name) => [
            name,
            (args: unknown) => {
              if (currentRunId === null)
                return Promise.reject(new Error("run 已结束：reset 后不再接受工具调用"));
              const call = new Promise((resolve, reject) => {
                const callId = nextCallId++;
                pending.set(callId, { resolve, reject });
                deps.post({ kind: "call", runId: currentRunId ?? "", callId, name, args });
              });
              // 程序没 await 的调用：reset 拒绝时不许变成 unhandledRejection 杀掉 worker
              void call.catch(() => {});
              return call;
            },
          ]),
        ),
      );
      defineGlobal("tools", tools);
      if (frame.surface === "workflow") {
        defineGlobal(
          "workflow",
          createWorkflowHelpers((text) => {
            logs.push(text);
            deps.post({ kind: "log", runId: currentRunId ?? "", level: "log", text });
          }),
        );
      }
      deps.post({ kind: "ready" });
      return;
    }
    if (frame.kind === "reset") {
      currentRunId = null; // 旧程序的迟到调用一律拒绝（代次边界）
      for (const { reject } of pending.values()) reject(new Error("run reset：worker 被复用"));
      pending = new Map();
      for (const name of Object.getOwnPropertyNames(globalThis)) {
        if (!globalBaseline.has(name)) delete (globalThis as Record<string, unknown>)[name];
      }
      Object.assign(console, consoleBaseline);
      // shortcut: 只清 globalThis 自有属性；内置原型（Object.prototype 等）的修改会渗到下一个 run，有污染案例再清场
      deps.post({ kind: "ready" });
      return;
    }
    if (frame.kind === "result") {
      const entry = pending.get(frame.callId);
      if (!entry) return;
      pending.delete(frame.callId);
      if (frame.ok) entry.resolve(frame.value);
      else entry.reject(new Error(frame.error));
      return;
    }
    if (frame.kind === "cancel") return; // host 决定终止或复用；cancel 本身不合作
    run(frame.code, frame.id, frame.args);
  });

  function defineGlobal(name: string, value: unknown): void {
    Object.defineProperty(globalThis, name, { value, writable: false, configurable: true });
  }

  async function run(code: string, runId: string, args: unknown): Promise<void> {
    currentRunId = runId;
    logs = [];
    defineGlobal("args", args ?? {}); // workflow 的 args：程序里的同名全局绑定
    installConsole((level, text) => {
      logs.push(text);
      deps.post({ kind: "log", runId, level, text });
    });
    const outcome = await execute(code);
    deps.post({ kind: "settled", runId, outcome });
  }

  async function execute(code: string): Promise<RunOutcome> {
    try {
      const program = compileProgram(code);
      const value = await program.call({ tools });
      // undefined 不是 JSON 值：单独标记，宿主按「无完成值」处理
      if (value === undefined) return { status: "fulfilled", value: { $void: true }, logs };
      const json = JSON.stringify(value);
      if (json === undefined) return { status: "rejected", error: "程序返回值不可序列化", logs };
      return { status: "fulfilled", value: JSON.parse(json), logs };
    } catch (error) {
      return {
        status: "rejected",
        error: error instanceof Error ? error.message : String(error),
        logs,
      };
    }
  }
}

function installConsole(emit: (level: string, text: string) => void): void {
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    console[level] = (...args: unknown[]) =>
      emit(level, args.map((a) => (typeof a === "string" ? a : inspect(a))).join(" "));
  }
}
