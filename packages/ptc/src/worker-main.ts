import vm from "node:vm";
import { compileProgram } from "./compile.ts";
import type { HostToWorkerFrame, RunOutcome, WorkerToHostFrame } from "./protocol.ts";

export interface WorkerMainDeps {
  post: (frame: WorkerToHostFrame) => void;
  onFrame: (handler: (frame: HostToWorkerFrame) => void) => void;
}

// 决策 30 / ADR-0019：程序每 run 一个 vm 运行格。
// 宿主只往格里放三个桥（__ptcCall / __ptcConsole / __ptcArgsJson），序言 IIFE 在格内（context
// realm）自建 tools/console/args/workflow 并置 undefined 脱手——constructor 链上不再有宿主对象，
// CVE 同款逃逸面（this.constructor.constructor → 宿主 Function → process）闭合。
// 序言必须包 IIFE：脚顶级 var/function 会落到格全局上，__bridge 这类内部名一旦全局可达逃逸即重开。
// 工具结果经 JSON 字符串回格、格内 parse：跨 realm 的宿主 Promise/对象一律不暴露给程序。
const CELL_PREAMBLE = `"use strict";
(function () {
var __bridge = globalThis.__ptcCall;
var __emit = globalThis.__ptcConsole;
var __args = JSON.parse(globalThis.__ptcArgsJson);
// contextified 全局属性不可 delete（vm 限制）但可写——置 undefined 即脱手，桥只剩序言闭包可达
globalThis.__ptcCall = undefined;
globalThis.__ptcConsole = undefined;
globalThis.__ptcArgsJson = undefined;
function __ptcFmt(v) {
  if (typeof v === "string") return v;
  try { var s = JSON.stringify(v); return s === undefined ? String(v) : s; } catch (e) { return String(v); }
}
function __ptcJoin(values) {
  var out = [];
  for (var i = 0; i < values.length; i++) out.push(__ptcFmt(values[i]));
  return out.join(" ");
}
var __ptcTools = {};
__PTC_NAMES__.forEach(function (name) {
  __ptcTools[name] = function (args) {
    return new Promise(function (resolve, reject) {
      __bridge(name, JSON.stringify(args === undefined ? null : args)).then(function (json) {
        var value;
        try { value = JSON.parse(json); } catch (e) { reject(e); return; }
        resolve(value);
      }, reject);
    });
  };
});
globalThis.tools = Object.freeze(__ptcTools);
globalThis.console = Object.freeze({
  log: function () { __emit("log", __ptcJoin(arguments)); },
  info: function () { __emit("info", __ptcJoin(arguments)); },
  warn: function () { __emit("warn", __ptcJoin(arguments)); },
  error: function () { __emit("error", __ptcJoin(arguments)); },
  debug: function () { __emit("debug", __ptcJoin(arguments)); }
});
globalThis.args = Object.freeze(__args);
if (__PTC_WORKFLOW__) {
  globalThis.workflow = Object.freeze({
    log: function () { __emit("log", __ptcJoin(arguments)); },
    phase: function (name) { __emit("log", "— phase: " + name + " —"); },
    parallel: function (items) { return Promise.allSettled(items.map(function (run) { return run(); })); },
    pipeline: function (items, step) {
      var results = [];
      return items.reduce(function (chain, item, index) {
        return chain.then(function () { return Promise.resolve(step(item, index)).then(function (r) { results.push(r); }); });
      }, Promise.resolve()).then(function () { return results; });
    }
  });
}
})();
`;

// worker 侧运行时：跑程序、tools.* 转发宿主、console 上提；reset = 拒残留 pending + 丢格引用
export function workerMain(deps: WorkerMainDeps): void {
  let bindingNames: string[] = [];
  let surface = "run_code";
  let pending = new Map<
    number,
    { resolve: (json: string | null) => void; reject: (error: Error) => void }
  >();
  let nextCallId = 1;
  let currentRunId: string | null = null;
  let logs: string[] = [];

  deps.onFrame((frame) => {
    if (frame.kind === "init") {
      bindingNames = frame.bindingNames;
      surface = frame.surface;
      deps.post({ kind: "ready" });
      return;
    }
    if (frame.kind === "reset") {
      currentRunId = null; // 旧程序的迟到调用一律拒绝（代次边界）
      for (const { reject } of pending.values()) reject(new Error("run reset：worker 被复用"));
      pending = new Map();
      deps.post({ kind: "ready" });
      return;
    }
    if (frame.kind === "result") {
      const entry = pending.get(frame.callId);
      if (!entry) return;
      pending.delete(frame.callId);
      if (frame.ok) {
        // 结果以 JSON 字符串回格（格内 parse 成 context realm 对象，宿主对象不跨 realm 暴露）
        let json: string | undefined;
        try {
          json = JSON.stringify(frame.value ?? null);
        } catch {
          json = undefined;
        }
        if (json === undefined)
          entry.reject(new Error("binding 返回值不可 JSON 序列化（如循环引用）"));
        else entry.resolve(json);
      } else {
        entry.reject(new Error(frame.error));
      }
      return;
    }
    if (frame.kind === "cancel") return; // host 决定终止或复用；cancel 本身不合作
    run(frame.code, frame.id, frame.args);
  });

  function preamble(): string {
    return CELL_PREAMBLE.replace(/__PTC_NAMES__/g, () => JSON.stringify(bindingNames)).replace(
      /__PTC_WORKFLOW__/g,
      () => (surface === "workflow" ? "true" : "false"),
    );
  }

  async function run(code: string, runId: string, args: unknown): Promise<void> {
    currentRunId = runId;
    logs = [];
    const postLog = (level: string, text: string) => {
      logs.push(text);
      deps.post({ kind: "log", runId, level, text });
    };
    // args 以 JSON 字符串进格（格内 parse + freeze；宿主对象不直接注入）
    const context = vm.createContext({
      __ptcArgsJson: JSON.stringify(args ?? {}),
      __ptcCall(name: string, argsJson: string): Promise<string | null> {
        if (currentRunId === null)
          return Promise.reject(new Error("run 已结束：reset 后不再接受工具调用"));
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(argsJson);
        } catch {
          return Promise.reject(new Error("工具参数不是合法 JSON"));
        }
        const call = new Promise<string | null>((resolve, reject) => {
          const callId = nextCallId++;
          pending.set(callId, { resolve, reject });
          deps.post({ kind: "call", runId: currentRunId ?? "", callId, name, args: parsed });
        });
        // 程序没 await 的调用：reset 拒绝时不许变成 unhandledRejection 杀掉 worker
        void call.catch(() => {});
        return call;
      },
      __ptcConsole(level: string, text: string): void {
        postLog(level, String(text));
      },
    });
    const outcome = await execute(code, context);
    deps.post({ kind: "settled", runId, outcome });
  }

  // 跨 realm Error（格内 throw 的 Error 不属于宿主 realm）的 message 提取，instanceof 不可靠
  function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (
      error &&
      typeof error === "object" &&
      typeof (error as { message?: unknown }).message === "string"
    )
      return (error as { message: string }).message;
    return String(error);
  }

  async function execute(code: string, context: vm.Context): Promise<RunOutcome> {
    try {
      vm.runInContext(preamble(), context, { filename: "ptc_preamble.js" });
      vm.runInContext(compileProgram(code), context, { filename: "run_code.js" });
      const program = (context as unknown as Record<string, unknown>)
        .__ptcProgram as () => Promise<unknown>;
      const value = await program.call(context);
      // undefined 不是 JSON 值：单独标记，宿主按「无完成值」处理
      if (value === undefined) return { status: "fulfilled", value: { $void: true }, logs };
      const json = JSON.stringify(value);
      if (json === undefined) return { status: "rejected", error: "程序返回值不可序列化", logs };
      return { status: "fulfilled", value: JSON.parse(json), logs };
    } catch (error) {
      return { status: "rejected", error: errorMessage(error), logs };
    }
  }
}
