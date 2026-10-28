// 决策 30 / ADR-0019 → 测试：程序运行格（vm cell）全矩阵
// 参照：ZCode dynamic-workflow-runtime security.test.ts（本地 /tmp/zcode 快照）+
//       vm 逃逸 CVE 清单（vercel/workflow#1026、n8n CVE-2025-68613：constructor 链拿宿主 Function）
// 分区：A 可见性 · B 逃逸面 · C 语义/跨 realm · D 隔离/生命周期 · E 协议边界
// 防假绿：B 区全部用例在「软格版」（宿主 facade 直注，本次加固前实现）上必红——构造函数链能摸到 process
import test from "node:test";
import assert from "node:assert/strict";
import { WorkerPool, runPtcProgram, spawnPtcWorker } from "../../packages/ptc/dist/index.js";

const fakeBindings = {
  read: async (args) => ({ text: `content-${args?.path}`, len: `content-${args?.path}`.length }),
  fail: async () => {
    throw new Error("binding-boom");
  },
  nothing: async () => undefined,
  circular: async () => {
    const o = { self: null };
    o.self = o;
    return o;
  },
};

async function run(code, extra = {}) {
  const savedExecArgv = process.execArgv.splice(0, process.execArgv.length);
  try {
    return await runPtcProgram({ code, bindings: fakeBindings, timeoutMs: 20_000, ...extra });
  } finally {
    process.execArgv.push(...savedExecArgv);
  }
}

async function runOk(code, extra) {
  const out = await run(code, extra);
  assert.equal(out.status, "fulfilled", `程序应 fulfilled, 实际 ${out.status}: ${out.error}`);
  return out.value;
}

// ── A. 可见性 ──────────────────────────────────────────────

test("A1 宿主能力不可见：process / fetch / require / setTimeout", async () => {
  assert.deepEqual(
    await runOk("return [typeof process, typeof fetch, typeof require, typeof setTimeout];"),
    ["undefined", "undefined", "undefined", "undefined"],
  );
});

test("A2 动态 import() 被阻断（格内 reject，程序可捕获）", async () => {
  assert.equal(
    await runOk('try { await import("node:fs"); return "leaked"; } catch { return "blocked"; }'),
    "blocked",
  );
});

test("A3 ES 标准内置齐全（curated 而非剥光 realm）：Map/Set/Promise/JSON/Date/Math", async () => {
  assert.equal(
    await runOk(
      'return new Map([["a",1]]).get("a") + (new Set([1,2]).size) + (typeof Promise) + (JSON.stringify({x:1})) + (Date.now() > 0) + (Math.floor(1.5));',
    ),
    '3function{"x":1}true1',
  );
});

// ── B. 逃逸面（CVE 同款 constructor 链；软格版此处全红）────────────────

test("B1 函数原型链两段都拿不到宿主 Function：(fn).constructor.constructor", async () => {
  assert.equal(
    await runOk('return (function(){}).constructor("return typeof process")();'),
    "undefined",
  );
});

test("B2 对象原型链两段：({}).constructor.constructor", async () => {
  assert.equal(
    await runOk('return ({}).constructor.constructor("return typeof process")();'),
    "undefined",
  );
});

test("B3 tools 表是格内对象：tools.read.constructor.constructor", async () => {
  assert.equal(
    await runOk('return tools.read.constructor.constructor("return typeof process")();'),
    "undefined",
  );
});

test("B4 console 是格内对象：console.log.constructor.constructor", async () => {
  assert.equal(
    await runOk('return console.log.constructor.constructor("return typeof process")();'),
    "undefined",
  );
});

test("B5 args 是格内对象：args.constructor.constructor（workflow 面）", async () => {
  assert.equal(
    await runOk('return args.constructor.constructor("return typeof process")();', {
      surface: "workflow",
      args: { tag: "t" },
    }),
    "undefined",
  );
});

test("B6 workflow 辅助是格内对象：workflow.parallel.constructor.constructor", async () => {
  assert.equal(
    await runOk('return workflow.parallel.constructor.constructor("return typeof process")();', {
      surface: "workflow",
    }),
    "undefined",
  );
});

test("B7 桥已脱手：__ptcCall / __ptcConsole / __ptcArgsJson 均为 undefined", async () => {
  assert.equal(
    await runOk('return [typeof __ptcCall, typeof __ptcConsole, typeof __ptcArgsJson].join(",");'),
    "undefined,undefined,undefined",
  );
});

test("B8 全局枚举：桥名仍在（vm 禁 delete）但值为 undefined；无 process/fetch", async () => {
  assert.equal(
    await runOk(
      'var names = Object.getOwnPropertyNames(globalThis); return [names.includes("process"), names.includes("fetch"), globalThis.__ptcCall === undefined, names.includes("tools"), names.includes("console"), names.includes("args")].join(",");',
    ),
    "false,false,true,true,true,true",
  );
});

test("B9 eval 与全局同视界：eval 看不到 process、看得到 tools", async () => {
  assert.equal(
    await runOk('return eval("typeof process") + "|" + eval("typeof tools");'),
    "undefined|object",
  );
});

test("B10 格内 new Function 编译对着格全局：看不到 process", async () => {
  assert.equal(await runOk('return new Function("return typeof process")();'), "undefined");
});

test("B11 错误栈首帧指向格内脚本 run_code.js", async () => {
  // 注：await 续体栈会带宿主 worker 帧（安装路径可见）——vm 无法剥，定性为装饰性信息
  // 泄漏（模型自己装的扩展，非秘密）；本测试只钉「程序自己的帧在格内」这一事实。
  const stack = await runOk('return new Error("probe").stack;');
  assert.match(stack.split("\n")[1], /run_code\.js/);
});

test("B12 直取桥逃逸：__ptcCall 若可达则 constructor 链通宿主（变异探针主钉）", async () => {
  assert.equal(
    await runOk(
      'if (typeof __ptcCall === "function") return __ptcCall.constructor.constructor("return typeof process")(); return "closed";',
    ),
    "closed",
  );
  assert.equal(
    await runOk(
      'if (typeof __ptcConsole === "function") return __ptcConsole.constructor.constructor("return typeof process")(); return "closed";',
    ),
    "closed",
  );
});

test("B13 序言内部名不可见：__bridge/__emit/__ptcFmt/__ptcJoin/__ptcTools/__args 全 undefined，直取逃逸 closed", async () => {
  assert.equal(
    await runOk(
      'var names = ["__bridge", "__emit", "__ptcFmt", "__ptcJoin", "__ptcTools", "__args"]; var vis = names.map(function (n) { return typeof globalThis[n]; }).join(","); var esc = "closed"; if (typeof globalThis.__bridge === "function") { esc = globalThis.__bridge.constructor.constructor("return typeof process")(); } return vis + "|" + esc;',
    ),
    "undefined,undefined,undefined,undefined,undefined,undefined|closed",
  );
});

// ── C. 语义 / 跨 realm ─────────────────────────────────────

test("C1 tools 结果在格内是普通对象（JSON 字符串回格再 parse）", async () => {
  assert.equal(
    await runOk(
      'const r = await tools.read({ path: "a" }); return r.constructor === Object && r.len;',
    ),
    9,
  );
});

test("C2 binding 返回 undefined → 程序拿到 null", async () => {
  assert.equal(await runOk("return (await tools.nothing()) === null;"), true);
});

test("C3 binding 抛错 → 程序 catch 到 message（错误跨格传播）", async () => {
  assert.equal(
    await runOk('try { await tools.fail(); return "no"; } catch (e) { return e.message; }'),
    "binding-boom",
  );
});

test("C4 binding 返回循环引用 → 调用 reject（返回值 JSON 门卫）", async () => {
  const out = await run(
    'try { await tools.circular(); return "leaked"; } catch (e) { return "rejected:" + (e.message.length > 0); }',
  );
  assert.equal(out.status, "fulfilled");
  assert.equal(out.value, "rejected:true");
});

test("C5 console 对象走 JSON 形态上提", async () => {
  const out = await run('console.log("s"); console.log({ a: 1 }); console.warn(42);');
  assert.equal(out.status, "fulfilled");
  assert.ok(out.logs.includes("s"));
  assert.ok(out.logs.includes('{"a":1}'), "对象应 JSON 化: " + JSON.stringify(out.logs));
  assert.ok(out.logs.some((l) => l.includes("42")));
});

test("C6 workflow 全套：phase 日志 + parallel allSettled + pipeline 顺序", async () => {
  const out = await run(
    'workflow.phase("p1"); const rs = await workflow.parallel([1,2].map((i) => async () => i * 10)); const pipe = await workflow.pipeline(["a","b"], async (x) => x + "!"); workflow.log("tail", pipe.length); return { rs: rs.map((s) => s.status + ":" + s.value), pipe };',
    { surface: "workflow" },
  );
  assert.equal(out.status, "fulfilled");
  assert.deepEqual(out.value, { rs: ["fulfilled:10", "fulfilled:20"], pipe: ["a!", "b!"] });
  assert.ok(
    out.logs.some((l) => l.includes("— phase: p1 —")),
    "phase 行应有: " + JSON.stringify(out.logs),
  );
});

test("C7 args 浅冻结：顶层写入 TypeError；嵌套对象可改（文档语义）", async () => {
  const frozen = await run('args.tag = "x"; return args.tag;', {
    surface: "workflow",
    args: { tag: "t" },
  });
  assert.equal(frozen.status, "rejected");
  assert.match(frozen.error, /Cannot assign to read only|read.only|not extensible/i);
  assert.equal(
    await runOk("args.nested.v = 99; return args.nested.v;", {
      surface: "workflow",
      args: { nested: { v: 1 } },
    }),
    99,
  );
});

test("C8 严格模式保持（ADR-0014）：隐式全局赋值 ReferenceError", async () => {
  const out = await run("implicitGlobal = 1; return implicitGlobal;");
  assert.equal(out.status, "rejected");
  assert.match(out.error, /implicitGlobal is not defined|ReferenceError/);
});

test("C9 程序 throw 的 message 不丢（跨 realm Error）", async () => {
  const out = await run('throw new Error("boom-cell");');
  assert.equal(out.status, "rejected");
  assert.match(out.error, /boom-cell/);
});

test("C10 返回值语义：undefined → $void；不可序列化 → rejected", async () => {
  assert.deepEqual(await runOk("return undefined;"), { $void: true });
  const bad = await run("return function() {};");
  assert.equal(bad.status, "rejected");
  assert.match(bad.error, /不可序列化/);
});

// ── D. 隔离 / 生命周期 ─────────────────────────────────────

test("D1 跨 run 隔离：run1 写的 globalThis 污染不进 run2（池复用）", async () => {
  const savedExecArgv = process.execArgv.splice(0, process.execArgv.length);
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
    assert.equal(r1.status, "fulfilled");
    assert.equal(r2.status, "fulfilled");
    assert.equal(r2.value, "undefined");
  } finally {
    pool.drain();
    process.execArgv.push(...savedExecArgv);
  }
});

test("D2 tools 表冻结：增删绑定不可行", async () => {
  assert.equal(
    await runOk('return Object.isFrozen(tools) && (typeof tools.read) === "function";'),
    true,
  );
  const out = await run("tools.fake = 1; return 1;");
  assert.equal(out.status, "rejected");
  assert.match(out.error, /Cannot assign|read.only|not extensible|extensible/i);
});

test("D3 面差异：run_code 面无 workflow；workflow 面有", async () => {
  assert.equal(await runOk("return typeof workflow;"), "undefined");
  assert.equal(await runOk("return typeof workflow;", { surface: "workflow" }), "object");
});

test("D4 args 常注入（run_code 面也是冻结空对象）", async () => {
  assert.equal(await runOk('return typeof args === "object" && Object.isFrozen(args);'), true);
});

// ── E. 协议边界 ────────────────────────────────────────────

test("E1 未知绑定不可达：tools.nonexistent 是 undefined（调用即 TypeError，可捕获）", async () => {
  assert.equal(
    await runOk(
      'try { await tools.nonexistent({}); return "called"; } catch (e) { return "TypeError"; }',
    ),
    "TypeError",
  );
});

async function runWith(bindings, code) {
  const savedExecArgv = process.execArgv.splice(0, process.execArgv.length);
  try {
    return await runPtcProgram({ code, bindings, timeoutMs: 20_000 });
  } finally {
    process.execArgv.push(...savedExecArgv);
  }
}

test("E2 无参调用：binding 收到 null（undefined 的 JSON 形态）", async () => {
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
  assert.equal(out.status, "fulfilled");
  assert.equal(received, "null");
});

test("E3 binding 收到的是解析后的 JSON 值（深对象往返不丢形状）", async () => {
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
  assert.equal(out.status, "fulfilled");
  assert.equal(receivedShape, '{"a":[1,{"b":"x"}],"c":null}');
});

test("E4 参数 JSON 契约：undefined 值被丢弃（旧 structuredClone 语义不同，钉住新契约）", async () => {
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
  assert.equal(out.status, "fulfilled");
  assert.equal(received, '{"a":1}');
});

test("E5 参数 JSON 契约：BigInt 让调用同步抛错（程序可捕获）", async () => {
  assert.equal(
    await runOk(
      'try { await tools.read({ path: 10n }); return "called"; } catch { return "rejected"; }',
    ),
    "rejected",
  );
});
