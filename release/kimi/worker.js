import { stripTypeScriptTypes } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
import vm from "node:vm";
// ../ptc/src/compile.ts
function compileProgram(source) {
	return `"use strict";\n${stripTypeScriptTypes(`async function __ptcProgram() {\n${source}\n}`, { mode: "strip" })}\n;globalThis.__ptcProgram = __ptcProgram;`;
}
// ../ptc/src/worker-main.ts
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
function workerMain(deps) {
	let bindingNames = [];
	let surface = "run_code";
	let pending = /* @__PURE__ */ new Map();
	let nextCallId = 1;
	let currentRunId = null;
	let logs = [];
	deps.onFrame((frame) => {
		if (frame.kind === "init") {
			bindingNames = frame.bindingNames;
			surface = frame.surface;
			deps.post({ kind: "ready" });
			return;
		}
		if (frame.kind === "reset") {
			currentRunId = null;
			for (const { reject } of pending.values()) reject(/* @__PURE__ */ new Error("run reset：worker 被复用"));
			pending = /* @__PURE__ */ new Map();
			deps.post({ kind: "ready" });
			return;
		}
		if (frame.kind === "result") {
			const entry = pending.get(frame.callId);
			if (!entry) return;
			pending.delete(frame.callId);
			if (frame.ok) {
				let json;
				try {
					json = JSON.stringify(frame.value ?? null);
				} catch {
					json = void 0;
				}
				if (json === void 0) entry.reject(/* @__PURE__ */ new Error("binding 返回值不可 JSON 序列化（如循环引用）"));
				else entry.resolve(json);
			} else entry.reject(new Error(frame.error));
			return;
		}
		if (frame.kind === "cancel") return;
		run(frame.code, frame.id, frame.args);
	});
	function preamble() {
		return CELL_PREAMBLE.replace(/__PTC_NAMES__/g, () => JSON.stringify(bindingNames)).replace(/__PTC_WORKFLOW__/g, () => surface === "workflow" ? "true" : "false");
	}
	async function run(code, runId, args) {
		currentRunId = runId;
		logs = [];
		const postLog = (level, text) => {
			logs.push(text);
			deps.post({
				kind: "log",
				runId,
				level,
				text
			});
		};
		const outcome = await execute(code, vm.createContext({
			__ptcArgsJson: JSON.stringify(args ?? {}),
			__ptcCall(name, argsJson) {
				if (currentRunId === null) return Promise.reject(/* @__PURE__ */ new Error("run 已结束：reset 后不再接受工具调用"));
				let parsed = null;
				try {
					parsed = JSON.parse(argsJson);
				} catch {
					return Promise.reject(/* @__PURE__ */ new Error("工具参数不是合法 JSON"));
				}
				const call = new Promise((resolve, reject) => {
					const callId = nextCallId++;
					pending.set(callId, {
						resolve,
						reject
					});
					deps.post({
						kind: "call",
						runId: currentRunId ?? "",
						callId,
						name,
						args: parsed
					});
				});
				call.catch(() => {});
				return call;
			},
			__ptcConsole(level, text) {
				postLog(level, String(text));
			}
		}));
		deps.post({
			kind: "settled",
			runId,
			outcome
		});
	}
	function errorMessage(error) {
		if (error instanceof Error) return error.message;
		if (error && typeof error === "object" && typeof error.message === "string") return error.message;
		return String(error);
	}
	async function execute(code, context) {
		try {
			vm.runInContext(preamble(), context, { filename: "ptc_preamble.js" });
			vm.runInContext(compileProgram(code), context, { filename: "run_code.js" });
			const value = await context.__ptcProgram.call(context);
			if (value === void 0) return {
				status: "fulfilled",
				value: { $void: true },
				logs
			};
			const json = JSON.stringify(value);
			if (json === void 0) return {
				status: "rejected",
				error: "程序返回值不可序列化",
				logs
			};
			return {
				status: "fulfilled",
				value: JSON.parse(json),
				logs
			};
		} catch (error) {
			return {
				status: "rejected",
				error: errorMessage(error),
				logs
			};
		}
	}
}
// ../ptc/src/worker-entry.ts
if (!parentPort) throw new Error("worker-entry 只能在 worker 线程里加载");
Object.freeze(workerData);
workerMain({
	post: (frame) => parentPort.postMessage(frame),
	onFrame: (handler) => parentPort.on("message", (frame) => handler(frame))
});
export {};
