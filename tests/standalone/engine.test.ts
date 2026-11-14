// standalone 面（脱离 pi 与模型自跑）：PTC 引擎的运行格 / 编译 / 文件绑定 / 池 / 限额 / 子调用轨迹。
// 探针直接打源码包 packages/ptc/src/**——该包没有 build script、exports 指向 src/index.ts（发布形态由 entry 打包）。
// 断言逐条搬自旧探针（tests/pi/vm-cell-runtime.test.mjs、tests/pi/lifecycle-face-pool-value-tree.test.mjs、
// tests/standalone/*.test.mjs）；旧探针没覆盖面的（workdir 越界、限额、编译剥类型、池回收）按产品源码补写。
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import {
  DEFAULT_LIMITS,
  WorkerPool,
  createFsBindings,
  runPtcProgram,
  spawnPtcWorker,
  type RunProgramRequest,
} from "../../packages/ptc/src/index.ts";
import { effectiveTimeoutMs } from "../../packages/ptc/src/limits.ts";
import { buildWorkerUrl } from "../../packages/ptc/src/worker-source.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// 假绑定：跑格面只看得见这些名字（worker 按 bindingNames 建 tools 表）
const fakeBindings: Record<string, (args: unknown) => Promise<unknown>> = {
  read: async (args) => {
    const path = (args as { path?: string } | null)?.path;
    const text = "content-" + path;
    return { text, len: text.length };
  },
  fail: async () => {
    throw new Error("binding-boom");
  },
  nothing: async () => undefined,
  circular: async () => {
    const o: { self: unknown } = { self: null };
    o.self = o;
    return o;
  },
};

const run = (code: string, extra: Partial<RunProgramRequest> = {}) =>
  runPtcProgram({ code, bindings: fakeBindings, timeoutMs: 20_000, ...extra });

async function runOk(code: string, extra?: Partial<RunProgramRequest>): Promise<unknown> {
  const out = await run(code, extra);
  if (out.status !== "fulfilled") {
    throw new Error("程序应 fulfilled，实际 " + out.status + ": " + out.error);
  }
  return out.value;
}

const runWith = (bindings: RunProgramRequest["bindings"], code: string) =>
  runPtcProgram({ code, bindings, timeoutMs: 20_000 });

// ── 引擎零依赖（engine.zero-dep）─────────────────────────────────

it("零宿主导入：引擎源码不引兄弟包 / 宿主包，manifest 无依赖", () => {
  const srcDir = join(repoRoot, "packages", "ptc", "src");
  const files = readdirSync(srcDir).filter((name) => name.endsWith(".ts"));
  expect(files.length).toBeGreaterThan(0);
  for (const name of files) {
    const text = readFileSync(join(srcDir, name), "utf8");
    expect(text, name + " 引了宿主包——引擎必须零宿主依赖").not.toMatch(
      /from\s*["']@earendil-works\//,
    );
    expect(text, name + " 引了兄弟包——引擎必须零依赖").not.toMatch(/from\s*["']@pi-ptc\//);
  }
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, "packages", "ptc", "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  expect(Object.keys(manifest.dependencies ?? {})).toEqual([]);
});

// ── A. 可见性 ─────────────────────────────────────────────────────

it("A1 宿主能力不可见：process / fetch / require / setTimeout", async () => {
  expect(
    await runOk("return [typeof process, typeof fetch, typeof require, typeof setTimeout];"),
  ).toEqual(["undefined", "undefined", "undefined", "undefined"]);
});

it("A2 动态 import() 被阻断（格内 reject，程序可捕获）", async () => {
  expect(
    await runOk('try { await import("node:fs"); return "leaked"; } catch { return "blocked"; }'),
  ).toBe("blocked");
});

it("A3 ES 标准内置齐全（curated 而非剥光 realm）：Map/Set/Promise/JSON/Date/Math", async () => {
  expect(
    await runOk(
      'return new Map([["a",1]]).get("a") + (new Set([1,2]).size) + (typeof Promise) + (JSON.stringify({x:1})) + (Date.now() > 0) + (Math.floor(1.5));',
    ),
  ).toBe('3function{"x":1}true1');
});

// ── B. 逃逸面（CVE 同款 constructor 链；软格版此处全红）────────────

it("B1 函数原型链两段都拿不到宿主 Function：(fn).constructor.constructor", async () => {
  expect(await runOk('return (function(){}).constructor("return typeof process")();')).toBe(
    "undefined",
  );
});

it("B2 对象原型链两段：({}).constructor.constructor", async () => {
  expect(await runOk('return ({}).constructor.constructor("return typeof process")();')).toBe(
    "undefined",
  );
});

it("B3 tools 表是格内对象：tools.read.constructor.constructor", async () => {
  expect(await runOk('return tools.read.constructor.constructor("return typeof process")();')).toBe(
    "undefined",
  );
});

it("B4 console 是格内对象：console.log.constructor.constructor", async () => {
  expect(
    await runOk('return console.log.constructor.constructor("return typeof process")();'),
  ).toBe("undefined");
});

it("B5 args 是格内对象：args.constructor.constructor（workflow 面）", async () => {
  expect(
    await runOk('return args.constructor.constructor("return typeof process")();', {
      surface: "workflow",
      args: { tag: "t" },
    }),
  ).toBe("undefined");
});

it("B6 workflow 辅助是格内对象：workflow.parallel.constructor.constructor", async () => {
  expect(
    await runOk('return workflow.parallel.constructor.constructor("return typeof process")();', {
      surface: "workflow",
    }),
  ).toBe("undefined");
});

it("B7 桥已脱手：__ptcCall / __ptcConsole / __ptcArgsJson 均为 undefined", async () => {
  expect(
    await runOk('return [typeof __ptcCall, typeof __ptcConsole, typeof __ptcArgsJson].join(",");'),
  ).toBe("undefined,undefined,undefined");
});

it("B8 全局枚举：桥名仍在（vm 禁 delete）但值为 undefined；无 process/fetch", async () => {
  expect(
    await runOk(
      'var names = Object.getOwnPropertyNames(globalThis); return [names.includes("process"), names.includes("fetch"), globalThis.__ptcCall === undefined, names.includes("tools"), names.includes("console"), names.includes("args")].join(",");',
    ),
  ).toBe("false,false,true,true,true,true");
});

it("B9 eval 与全局同视界：eval 看不到 process、看得到 tools", async () => {
  expect(await runOk('return eval("typeof process") + "|" + eval("typeof tools");')).toBe(
    "undefined|object",
  );
});

it("B10 格内 new Function 编译对着格全局：看不到 process", async () => {
  expect(await runOk('return new Function("return typeof process")();')).toBe("undefined");
});

it("B11 错误栈首帧指向格内脚本 run_code.js", async () => {
  const stack = String(await runOk('return new Error("probe").stack;'));
  expect(stack.split("\n")[1]).toMatch(/run_code\.js/);
});

it("B12 直取桥逃逸：__ptcCall 若可达则 constructor 链通宿主", async () => {
  expect(
    await runOk(
      'if (typeof __ptcCall === "function") return __ptcCall.constructor.constructor("return typeof process")(); return "closed";',
    ),
  ).toBe("closed");
  expect(
    await runOk(
      'if (typeof __ptcConsole === "function") return __ptcConsole.constructor.constructor("return typeof process")(); return "closed";',
    ),
  ).toBe("closed");
});

it("B13 序言内部名不可见：__bridge/__emit/__ptcFmt/__ptcJoin/__ptcTools/__args 全 undefined", async () => {
  expect(
    await runOk(
      'var names = ["__bridge", "__emit", "__ptcFmt", "__ptcJoin", "__ptcTools", "__args"]; var vis = names.map(function (n) { return typeof globalThis[n]; }).join(","); var esc = "closed"; if (typeof globalThis.__bridge === "function") { esc = globalThis.__bridge.constructor.constructor("return typeof process")(); } return vis + "|" + esc;',
    ),
  ).toBe("undefined,undefined,undefined,undefined,undefined,undefined|closed");
});

// ── C. 语义 / 跨 realm ───────────────────────────────────────────

it("C1 tools 结果在格内是普通对象（JSON 字符串回格再 parse）", async () => {
  expect(
    await runOk(
      'const r = await tools.read({ path: "a" }); return r.constructor === Object && r.len;',
    ),
  ).toBe(9);
});

it("C2 binding 返回 undefined → 程序拿到 null", async () => {
  expect(await runOk("return (await tools.nothing()) === null;")).toBe(true);
});

it("C3 binding 抛错 → 程序 catch 到 message（错误跨格传播）", async () => {
  expect(
    await runOk('try { await tools.fail(); return "no"; } catch (e) { return e.message; }'),
  ).toBe("binding-boom");
});

it("C4 binding 返回循环引用 → 调用 reject（返回值 JSON 门卫）", async () => {
  const out = await run(
    'try { await tools.circular(); return "leaked"; } catch (e) { return "rejected:" + (e.message.length > 0); }',
  );
  expect(out.status).toBe("fulfilled");
  expect(out.value).toBe("rejected:true");
});

it("C5 console 对象走 JSON 形态上提", async () => {
  const out = await run('console.log("s"); console.log({ a: 1 }); console.warn(42);');
  expect(out.status).toBe("fulfilled");
  expect(out.logs).toContain("s");
  expect(out.logs).toContain('{"a":1}');
  expect(out.logs.some((line) => line.includes("42"))).toBe(true);
});

it("C6 workflow 全套：phase 日志 + parallel allSettled + pipeline 顺序", async () => {
  const out = await run(
    'workflow.phase("p1"); const rs = await workflow.parallel([1,2].map((i) => async () => i * 10)); const pipe = await workflow.pipeline(["a","b"], async (x) => x + "!"); workflow.log("tail", pipe.length); return { rs: rs.map((s) => s.status + ":" + s.value), pipe };',
    { surface: "workflow" },
  );
  expect(out.status).toBe("fulfilled");
  expect(out.value).toEqual({ rs: ["fulfilled:10", "fulfilled:20"], pipe: ["a!", "b!"] });
  expect(out.logs.some((line) => line.includes("— phase: p1 —"))).toBe(true);
});

it("C7 args 浅冻结：顶层写入 TypeError；嵌套对象可改（文档语义）", async () => {
  const frozen = await run('args.tag = "x"; return args.tag;', {
    surface: "workflow",
    args: { tag: "t" },
  });
  expect(frozen.status).toBe("rejected");
  expect(frozen.error).toMatch(/Cannot assign to read only|read.only|not extensible/i);
  expect(
    await runOk("args.nested.v = 99; return args.nested.v;", {
      surface: "workflow",
      args: { nested: { v: 1 } },
    }),
  ).toBe(99);
});

it("C8 严格模式保持（ADR-0014）：隐式全局赋值 ReferenceError", async () => {
  const out = await run("implicitGlobal = 1; return implicitGlobal;");
  expect(out.status).toBe("rejected");
  expect(out.error).toMatch(/implicitGlobal is not defined|ReferenceError/);
});

it("C9 程序 throw 的 message 不丢（跨 realm Error）", async () => {
  const out = await run('throw new Error("boom-cell");');
  expect(out.status).toBe("rejected");
  expect(out.error).toMatch(/boom-cell/);
});

it("C10a 返回值语义：undefined → $void 信封", async () => {
  expect(await runOk("return undefined;")).toEqual({ $void: true });
});

it("C10b 返回值语义：不可序列化 → rejected", async () => {
  const bad = await run("return function() {};");
  expect(bad.status).toBe("rejected");
  expect(bad.error).toMatch(/不可序列化/);
});

// ── D. 隔离 / 生命周期 ───────────────────────────────────────────

it("D1 跨 run 隔离：run1 写的 globalThis 污染不进 run2（池复用）", async () => {
  const pool = new WorkerPool(spawnPtcWorker);
  try {
    const r1 = await runPtcProgram({
      code: "globalThis.leaked = 42; return 1;",
      bindings: {},
      pool,
      timeoutMs: 20_000,
    });
    const r2 = await runPtcProgram({
      code: "return typeof globalThis.leaked;",
      bindings: {},
      pool,
      timeoutMs: 20_000,
    });
    expect(r1.status).toBe("fulfilled");
    expect(r2.status).toBe("fulfilled");
    expect(r2.value).toBe("undefined");
  } finally {
    pool.drain();
  }
});

it("D2 tools 表冻结：增删绑定不可行", async () => {
  expect(await runOk('return Object.isFrozen(tools) && (typeof tools.read) === "function";')).toBe(
    true,
  );
  const out = await run("tools.fake = 1; return 1;");
  expect(out.status).toBe("rejected");
  expect(out.error).toMatch(/Cannot assign|read.only|not extensible|extensible/i);
});

it("D3 面差异：run_code 面无 workflow；workflow 面有", async () => {
  expect(await runOk("return typeof workflow;")).toBe("undefined");
  expect(await runOk("return typeof workflow;", { surface: "workflow" })).toBe("object");
});

it("D4 args 常注入（run_code 面也是冻结空对象）", async () => {
  expect(await runOk('return typeof args === "object" && Object.isFrozen(args);')).toBe(true);
});

// ── E. 协议边界 ──────────────────────────────────────────────────

it("E1 未知绑定不可达：tools.nonexistent 是 undefined（调用即 TypeError，可捕获）", async () => {
  expect(
    await runOk(
      'try { await tools.nonexistent({}); return "called"; } catch (e) { return "TypeError"; }',
    ),
  ).toBe("TypeError");
});

it("E2 无参调用：binding 收到 null（undefined 的 JSON 形态）", async () => {
  let received = "unset";
  const out = await runWith(
    {
      probe: async (args) => {
        received = args === null ? "null" : typeof args;
        return 1;
      },
    },
    "await tools.probe(); return 1;",
  );
  expect(out.status).toBe("fulfilled");
  expect(received).toBe("null");
});

it("E3 binding 收到的是解析后的 JSON 值（深对象往返不丢形状）", async () => {
  let receivedShape = "";
  const out = await runWith(
    {
      probe: async (args) => {
        receivedShape = JSON.stringify(args);
        return 1;
      },
    },
    'await tools.probe({ a: [1, { b: "x" }], c: null }); return 1;',
  );
  expect(out.status).toBe("fulfilled");
  expect(receivedShape).toBe('{"a":[1,{"b":"x"}],"c":null}');
});

it("E4 参数 JSON 契约：undefined 值被丢弃（旧 structuredClone 语义不同，钉住新契约）", async () => {
  let received = "";
  const out = await runWith(
    {
      probe: async (args) => {
        received = JSON.stringify(args);
        return 1;
      },
    },
    "await tools.probe({ a: 1, b: undefined }); return 1;",
  );
  expect(out.status).toBe("fulfilled");
  expect(received).toBe('{"a":1}');
});

it("E5 参数 JSON 契约：BigInt 让调用同步抛错（程序可捕获）", async () => {
  expect(
    await runOk(
      'try { await tools.read({ path: 10n }); return "called"; } catch { return "rejected"; }',
    ),
  ).toBe("rejected");
});

// ── worker 源码三分支（buildWorkerUrl）───────────────────────────

const workerSourceFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "ptc-worker-source-"));
  mkdirSync(join(root, "lib"), { recursive: true });
  return { root, from: pathToFileURL(join(root, "lib", "engine.js")).href };
};

it("worker 源码三分支：旁边有 worker.js ⇒ 用它", () => {
  const { root, from } = workerSourceFixture();
  writeFileSync(join(root, "lib", "worker.js"), "");
  expect(buildWorkerUrl(from).pathname).toBe(join(root, "lib", "worker.js"));
});

it("worker 源码三分支：旁边没有、源码入口在 ⇒ 退回源码直跑", () => {
  const { root, from } = workerSourceFixture();
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "worker-entry.ts"), "");
  expect(buildWorkerUrl(from).pathname).toBe(join(root, "src", "worker-entry.ts"));
});

it("worker 源码三分支：两边都没有 ⇒ 报错点名期望的 worker.js", () => {
  const { from } = workerSourceFixture();
  expect(() => buildWorkerUrl(from)).toThrow(/PTC worker 缺失/);
  expect(() => buildWorkerUrl(from)).toThrow(/worker\.js/);
  expect(() => buildWorkerUrl(from)).not.toThrow(/worker-entry\.ts/);
});

// ── 程序编译（compile）───────────────────────────────────────────

it("编译：程序里的 TS 类型标注被剥掉（带标注的程序能跑）", async () => {
  const outcome = await run("const x: number = 1; return x;");
  expect(outcome.status).toBe("fulfilled");
  expect(outcome.value).toBe(1);
});

it("编译：strict 模式禁项（delete 变量）被拒", async () => {
  const outcome = await run("var x = 1; delete x; return 1;");
  expect(outcome.status).toBe("rejected");
  expect(outcome.error).toMatch(/strict mode/);
});

// ── 文件四件套 + workdir 牢笼（fs-bindings）───────────────────────

const fixture = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ptc-standalone-"));
  writeFileSync(join(dir, "a.txt"), "hello ptc\n");
  writeFileSync(join(dir, "b.ts"), "export const x = 1;\n");
  return dir;
};

const runFs = (code: string, dir: string) =>
  runPtcProgram({ code, bindings: createFsBindings(dir), cwd: dir, timeoutMs: 20_000 });

it("文件四件套真操作：glob / read / grep / edit", async () => {
  const dir = fixture();
  const outcome = await runFs(
    'const files = await tools.glob({ pattern: "*.txt" });\n' +
      'const hits = await tools.grep({ pattern: "ptc", path: "." });\n' +
      'const edited = await tools.edit({ path: "a.txt", old_string: "hello", new_string: "bye" });\n' +
      "return { files, hits, edited };",
    dir,
  );
  expect(outcome.status).toBe("fulfilled");
  const value = outcome.value as { files: string[]; hits: string[] };
  expect(value.files).toEqual(["a.txt"]);
  expect(value.hits.length).toBe(1);
  expect(value.hits[0]).toMatch(/a\.txt:1: hello ptc/);
  expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("bye ptc\n");
});

it("workdir 越界：字面 ../ 与 realpath 符号链接都被拒", async () => {
  const dir = fixture();
  const outside = join(dirname(dir), basename(dir) + ".outside.txt");
  writeFileSync(outside, "secret\n");
  symlinkSync(outside, join(dir, "link.txt"));

  const literal = await runFs(
    'await tools.read({ path: "../' + basename(outside) + '" }); return 1;',
    dir,
  );
  expect(literal.status).toBe("rejected");
  expect(literal.error).toMatch(/escapes workdir/);

  const linked = await runFs('await tools.read({ path: "link.txt" }); return 1;', dir);
  expect(linked.status).toBe("rejected");
  expect(linked.error).toMatch(/escapes workdir/);
});

it("write：父目录不存在 ⇒ 拒（不隐式建目录）", async () => {
  const dir = fixture();
  const outcome = await runFs(
    'await tools.write({ path: "sub/x.txt", content: "hi" }); return 1;',
    dir,
  );
  expect(outcome.status).toBe("rejected");
  expect(outcome.error).toMatch(/parent dir does not exist/);
});

it("write：全量替换不追加，返回 workdir 相对路径", async () => {
  const dir = fixture();
  const first = await runFs(
    'await tools.write({ path: "a.txt", content: "second" }); return 1;',
    dir,
  );
  expect(first.status).toBe("fulfilled");
  expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("second");

  const second = await runFs('return await tools.write({ path: "a.txt", content: "third" });', dir);
  expect((second.value as { written?: string })?.written).toBe("a.txt");
  expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("third");
});

it("write：原子落盘不留临时文件残留", async () => {
  const dir = fixture();
  const outcome = await runFs('await tools.write({ path: "a.txt", content: "x" }); return 1;', dir);
  expect(outcome.status).toBe("fulfilled");
  expect(readdirSync(dir).filter((name) => name.includes(".ptc-"))).toEqual([]);
});

it("edit：old_string 不存在 ⇒ 拒", async () => {
  const dir = fixture();
  const outcome = await runFs(
    'await tools.edit({ path: "a.txt", old_string: "nope", new_string: "x" }); return 1;',
    dir,
  );
  expect(outcome.status).toBe("rejected");
  expect(outcome.error).toMatch(/old_string not found/);
});

it("edit：old_string 多处匹配 ⇒ 拒（必须唯一）", async () => {
  const dir = fixture();
  writeFileSync(join(dir, "dup.txt"), "a\na\n");
  const outcome = await runFs(
    'await tools.edit({ path: "dup.txt", old_string: "a", new_string: "b" }); return 1;',
    dir,
  );
  expect(outcome.status).toBe("rejected");
  expect(outcome.error).toMatch(/must be unique/);
});

// ── 限额（limits）─────────────────────────────────────────────────

it("limits：默认超时 = DEFAULT_LIMITS.timeoutMs", () => {
  expect(effectiveTimeoutMs(undefined)).toBe(DEFAULT_LIMITS.timeoutMs);
});

it("limits：请求再小也有 1 秒下限；区间内原样", () => {
  expect(effectiveTimeoutMs(500)).toBe(1_000);
  expect(effectiveTimeoutMs(5_000)).toBe(5_000);
});

it("limits：请求再大也不突破 DEFAULT_LIMITS.maxTimeoutMs", () => {
  expect(effectiveTimeoutMs(10_000_000)).toBe(DEFAULT_LIMITS.maxTimeoutMs);
});

// ── worker 池（pool）─────────────────────────────────────────────

const fakeWorkerPool = (capacity: number) => {
  const state = { spawned: 0, terminated: 0 };
  const pool = new WorkerPool(() => {
    state.spawned++;
    const worker = {
      once: () => worker,
      terminate: () => {
        state.terminated++;
        return Promise.resolve(0);
      },
      postMessage: () => {},
    };
    return worker as unknown as Worker;
  }, capacity);
  return { pool, state };
};

it("池复用：release 后的 worker 被下一个 acquire 取回", async () => {
  const { pool, state } = fakeWorkerPool(1);
  const first = await pool.acquire();
  pool.release(first);
  const second = await pool.acquire();
  expect(second).toBe(first);
  expect(state.spawned).toBe(1);
});

it("池容量：满后 acquire 超时", async () => {
  vi.useFakeTimers();
  try {
    const { pool } = fakeWorkerPool(1);
    await pool.acquire();
    const pending = pool.acquire(50);
    // 先挂拒绝处理器再推表钟：否则拒绝早于 handler ⇒ 变成 unhandled rejection
    const assertion = expect(pending).rejects.toThrow(/acquire timed out/);
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
  } finally {
    vi.useRealTimers();
  }
});

it("池回收：drain 退役空闲 worker", async () => {
  const { pool, state } = fakeWorkerPool(1);
  const worker = await pool.acquire();
  pool.release(worker);
  pool.drain();
  expect(state.terminated).toBe(1);
});

it("池回收：discard 收回名额（下一个 acquire 直接起新的）", async () => {
  const { pool, state } = fakeWorkerPool(1);
  const first = await pool.acquire();
  pool.discard(first);
  expect(state.terminated).toBe(1);
  const next = await pool.acquire(1_000);
  expect(next).not.toBe(first);
  expect(state.spawned).toBe(2);
});

it("F8 池复用：同一 worker 三连 run（归还时摘除监听后 reset 握手仍正常）", async () => {
  const pool = new WorkerPool(spawnPtcWorker);
  try {
    const runOnce = (v: number) =>
      runPtcProgram({ code: "return " + v, bindings: {}, pool, timeoutMs: 20_000 });
    const r1 = await runOnce(1);
    const r2 = await runOnce(2);
    const r3 = await runOnce(3);
    expect(r1.value).toBe(1);
    expect(r2.value).toBe(2);
    expect(r3.value).toBe(3);
  } finally {
    pool.drain();
  }
});

// ── 子调用轨迹（sub-calls）───────────────────────────────────────

interface SubCall {
  callId: number;
  name: string;
  argsPreview: string;
  args?: unknown;
  status: string;
  durationMs?: number;
}

const subCalls = (outcome: { subCalls?: unknown[] }): SubCall[] =>
  (outcome.subCalls ?? []) as SubCall[];

it("程序跑通：返回值与子调用记录都在（无模型、无 pi）", async () => {
  const dir = fixture();
  const outcome = await runFs('const a = await tools.read({ path: "a.txt" }); return { a };', dir);
  expect(outcome.status).toBe("fulfilled");
  expect(outcome.value).toEqual({ a: "hello ptc\n" });
  const calls = subCalls(outcome);
  expect(calls.length).toBe(1);
  expect(calls[0]?.name).toBe("read");
  expect(calls[0]?.status).toBe("ok");
  // 结构化 args（程序型子代理 delivery 轨迹的数据源，issue #293）：预览截断不影响原值
  expect(calls[0]?.args).toEqual({ path: "a.txt" });
});

it("子调用轨迹：argsPreview 截断到 60 字符", async () => {
  const long = "x".repeat(120);
  const outcome = await run('await tools.read({ path: "' + long + '" }); return 1;');
  const call = subCalls(outcome)[0];
  expect(call?.argsPreview.length).toBe(60);
});

it("子调用轨迹：binding 抛错 ⇒ 记录 status=error", async () => {
  const outcome = await run("try { await tools.fail(); } catch {} return 1;");
  const call = subCalls(outcome)[0];
  expect(call?.name).toBe("fail");
  expect(call?.status).toBe("error");
});
