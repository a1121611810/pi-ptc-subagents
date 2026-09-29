import { expect, test } from "vitest";
import {
  BUILTIN_BINDING_NAMES,
  createBuiltinBindings,
  DISPATCH_BINDING_NAME,
} from "../src/runtime/bindings.ts";
import { runPtcProgram } from "../src/runtime/dispatcher.ts";
import { DEFAULT_CONFIG } from "../src/runtime/limits.ts";
import { makeBindings, RUN_TIMEOUT_MS } from "./helpers/ptc.ts";

const bindings = makeBindings({});
const runCode = (code: string, extra: Partial<Parameters<typeof runPtcProgram>[0]> = {}) =>
  runPtcProgram({ code, surface: "run_code", cwd: process.cwd(), bindings, ...extra });
const runWorkflow = (code: string, extra: Partial<Parameters<typeof runPtcProgram>[0]> = {}) =>
  runPtcProgram({ code, surface: "workflow", cwd: process.cwd(), bindings, ...extra });

test(
  "run_code resolves the program's return value as lossless JSON",
  async () => {
    const outcome = await runCode(
      'return { nested: [1, "two", null, true], deep: { a: { b: 2 } } };',
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toEqual({ nested: [1, "two", null, true], deep: { a: { b: 2 } } });
  },
  RUN_TIMEOUT_MS,
);

test(
  "run_code reports no value when the program returns nothing",
  async () => {
    const outcome = await runCode("const x = 1;");
    expect(outcome.error).toBeUndefined();
    expect("value" in outcome).toBe(false);
  },
  RUN_TIMEOUT_MS,
);

test(
  "run_code strips TypeScript annotations",
  async () => {
    const outcome = await runCode(
      "const x: number = 41;\nconst f = (v: number): number => v + 1;\nreturn f(x);",
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toBe(42);
  },
  RUN_TIMEOUT_MS,
);

test(
  "run_code captures console output with level-agnostic formatting",
  async () => {
    const outcome = await runCode(
      'console.log("plain", 1, true); console.error("as error"); console.warn({ a: 1 }); console.log();',
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.logs.length).toBe(4);
    expect(outcome.logs[0]).toBe("plain 1 true");
    expect(outcome.logs[1]).toBe("as error");
    expect(String(outcome.logs[2])).toMatch(/\{ a: 1 \}/);
    expect(outcome.logs[3]).toBe("");
  },
  RUN_TIMEOUT_MS,
);

test(
  "run_code surface exposes tools and Node only — no helpers",
  async () => {
    const outcome = await runCode(
      "return { tools: typeof tools, log: typeof log, phase: typeof phase, parallel: typeof parallel, pipeline: typeof pipeline, agent: typeof agent, args: typeof args, require: typeof require };",
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toEqual({
      tools: "object",
      log: "undefined",
      phase: "undefined",
      parallel: "undefined",
      pipeline: "undefined",
      agent: "undefined",
      args: "undefined",
      require: "undefined",
    });
  },
  RUN_TIMEOUT_MS,
);

test(
  "calling a helper that the surface does not have is a plain ReferenceError",
  async () => {
    const outcome = await runCode('log("nope");');
    expect(outcome.error?.kind).toBe("exception");
    expect(String(outcome.error?.message)).toMatch(/log is not defined/);
    expect(outcome.value).toBeUndefined();
  },
  RUN_TIMEOUT_MS,
);

test(
  "workflow surface installs the helper globals and binds args",
  async () => {
    const outcome = await runWorkflow(
      "return { log: typeof log, phase: typeof phase, parallel: typeof parallel, pipeline: typeof pipeline, agent: typeof agent, args, tools: typeof tools };",
      { args: { task: "write the report" } },
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toEqual({
      log: "function",
      phase: "function",
      parallel: "function",
      pipeline: "function",
      agent: "undefined",
      args: { task: "write the report" },
      tools: "object",
    });
  },
  RUN_TIMEOUT_MS,
);

test(
  "workflow log() and phase() emit frames instead of console output",
  async () => {
    const outcome = await runWorkflow(
      'log("step one"); phase("Research"); console.log("printed"); phase("Write");',
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.narrations).toEqual(["step one"]);
    expect(outcome.phases).toEqual(["Research", "Write"]);
    expect(outcome.logs).toEqual(["printed"]);
  },
  RUN_TIMEOUT_MS,
);

test(
  "workflow log/phase validate their argument",
  async () => {
    const badLog = await runWorkflow("log(42);");
    expect(badLog.error?.kind).toBe("exception");
    expect(String(badLog.error?.message)).toMatch(/log\(message\) expects a string/);

    const badPhase = await runWorkflow("phase(null);");
    expect(badPhase.error?.kind).toBe("exception");
    expect(String(badPhase.error?.message)).toMatch(/phase\(title\) expects a string/);
  },
  RUN_TIMEOUT_MS,
);

test(
  "parallel() runs thunks concurrently and maps per-item failures to null",
  async () => {
    const outcome = await runWorkflow(
      'const out = await parallel([async () => { await new Promise((r) => setTimeout(r, 5)); return "a"; }, async () => { throw new Error("boom"); }, async () => 3]); return out;',
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toEqual(["a", null, 3]);
  },
  RUN_TIMEOUT_MS,
);

test(
  "parallel() validates its argument shape",
  async () => {
    const notArray = await runWorkflow('await parallel("nope");');
    expect(notArray.error?.kind).toBe("exception");
    expect(String(notArray.error?.message)).toMatch(/parallel\(thunks\) expects an array/);

    const notFunctions = await runWorkflow("await parallel([1]);");
    expect(notFunctions.error?.kind).toBe("exception");
    expect(String(notFunctions.error?.message)).toMatch(
      /parallel\(thunks\) expects functions; item 0 is a number/,
    );
  },
  RUN_TIMEOUT_MS,
);

test(
  "parallel() enforces maxItemsPerCall",
  async () => {
    const outcome = await runWorkflow(
      `await parallel(Array.from({ length: ${DEFAULT_CONFIG.maxItemsPerCall + 1} }, () => async () => 1));`,
    );
    expect(outcome.error?.kind).toBe("exception");
    expect(String(outcome.error?.message)).toMatch(/maxItemsPerCall/);
    expect(String(outcome.error?.message)).toMatch(
      new RegExp(String(DEFAULT_CONFIG.maxItemsPerCall)),
    );
  },
  RUN_TIMEOUT_MS,
);

test(
  "pipeline() threads each item through every stage without a cross-stage barrier",
  async () => {
    const outcome = await runWorkflow(
      [
        "const items = [1, 2, 3];",
        "const out = await pipeline(",
        "  items,",
        "  async (prev, item, index) => `${index}:${prev}:${item}`,",
        '  async (prev) => prev + "!",',
        ");",
        "return out;",
      ].join("\n"),
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toEqual(["0:1:1!", "1:2:2!", "2:3:3!"]);
  },
  RUN_TIMEOUT_MS,
);

test(
  "pipeline() turns a failing item into null and keeps siblings",
  async () => {
    const outcome = await runWorkflow(
      "const out = await pipeline([1, 2, 3], async (prev, item) => { if (item === 2) throw new Error('boom'); return prev * 10; }); return out;",
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toEqual([10, null, 30]);
  },
  RUN_TIMEOUT_MS,
);

test(
  "pipeline() validates its arguments and enforces maxItemsPerCall",
  async () => {
    const noStages = await runWorkflow("await pipeline([1, 2]);");
    expect(String(noStages.error?.message)).toMatch(/requires at least one stage function/);

    const badStage = await runWorkflow("await pipeline([1], 'nope');");
    expect(String(badStage.error?.message)).toMatch(/stage 0 is a string/);

    const tooMany = await runWorkflow(
      `await pipeline(Array.from({ length: ${DEFAULT_CONFIG.maxItemsPerCall + 1} }, (_, i) => i), async (v) => v);`,
    );
    expect(String(tooMany.error?.message)).toMatch(/maxItemsPerCall/);
  },
  RUN_TIMEOUT_MS,
);

test(
  "workflow surface has no agent() helper either",
  async () => {
    const outcome = await runWorkflow('agent("do something");');
    expect(outcome.error?.kind).toBe("exception");
    expect(String(outcome.error?.message)).toMatch(/agent is not defined/);
  },
  RUN_TIMEOUT_MS,
);

test(
  "a program that fails to compile reports an exception",
  async () => {
    const outcome = await runCode("return ((((;");
    expect(outcome.error?.kind).toBe("exception");
    expect(String(outcome.error?.message)).toMatch(/failed to compile/);
  },
  RUN_TIMEOUT_MS,
);

test(
  "a thrown program error carries a trimmed stack",
  async () => {
    const outcome = await runCode('throw new Error("exploded");');
    expect(outcome.error?.kind).toBe("exception");
    expect(outcome.error?.message).toBe("exploded");
    expect(outcome.error?.stack?.includes("exploded"), "stack keeps the message line").toBe(true);
    expect(
      outcome.error?.stack ?? "",
      "stack points at a worker file rather than the bootstrap payload",
    ).toMatch(/worker(-entry\.ts|\.js|-main\.ts)/);
    expect((outcome.error?.stack?.split("\n").length ?? 0) <= 6, "stack depth is capped").toBe(
      true,
    );
  },
  RUN_TIMEOUT_MS,
);

test(
  "results that are not lossless JSON report invalid-output with a path",
  async () => {
    const cases: Array<[string, RegExp]> = [
      ["return new Date();", /result is a Date/],
      ["return new Map();", /result is a Map/],
      ["return () => 1;", /result is a function/],
      ["return Number.NaN;", /result is NaN/],
      ["return { deep: { bad: Infinity } };", /result\.deep\.bad is Infinity/],
      ["const a = {}; a.self = a; return a;", /result\.self is a circular reference/],
      ["return [1, () => 1];", /result\[1\] is a function/],
    ];
    for (const [code, expected] of cases) {
      const outcome = await runCode(code);
      expect(outcome.error?.kind, `${code} must be rejected`).toBe("invalid-output");
      expect(String(outcome.error?.message)).toMatch(expected);
      expect("value" in outcome).toBe(false);
    }
  },
  RUN_TIMEOUT_MS,
);

test(
  "undefined follows JSON.stringify rules inside containers",
  async () => {
    const outcome = await runCode(
      "return { kept: 1, dropped: undefined, list: [1, undefined, 3] };",
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toEqual({ kept: 1, list: [1, null, 3] });
  },
  RUN_TIMEOUT_MS,
);

test(
  "each run gets a fresh worker realm",
  async () => {
    const first = await runCode("globalThis.leaked = 1; return typeof leaked;");
    expect(first.value).toBe("number");
    const second = await runCode("return typeof leaked;");
    expect(second.value).toBe("undefined");
  },
  RUN_TIMEOUT_MS,
);

// ---------------------------------------------------------------------------
// ptcBindings — the per-run binding manifest (field report pitfall #5)
// ---------------------------------------------------------------------------
//
// Specification (docs/testing-constraints.md #4/#5): the global must carry THIS run's
// actual binding table — the same names as the `tools` keys, in table order, with
// `pi.dispatch` present iff the table bound it. A static list, or one that ignores the
// caller's explicit subset, fails one of these arms.

test(
  "ptcBindings mirrors the default binding table, pi.dispatch included and frozen",
  async () => {
    const table = createBuiltinBindings({ cwd: process.cwd() });
    const outcome = await runPtcProgram({
      code: "return { names: [...ptcBindings], frozen: Object.isFrozen(ptcBindings) };",
      surface: "run_code",
      cwd: process.cwd(),
      bindings: table,
    });
    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toEqual({
      names: [...BUILTIN_BINDING_NAMES, DISPATCH_BINDING_NAME],
      frozen: true,
    });
  },
  RUN_TIMEOUT_MS,
);

test(
  "ptcBindings reflects an explicit binding subset, pi.dispatch only when bound",
  async () => {
    const withDispatch = createBuiltinBindings({
      cwd: process.cwd(),
      names: ["read", "bash"],
      includeDispatch: true,
    });
    const first = await runPtcProgram({
      code: "return [...ptcBindings];",
      surface: "run_code",
      cwd: process.cwd(),
      bindings: withDispatch,
    });
    expect(first.error).toBeUndefined();
    expect(first.value).toEqual(["read", "bash", DISPATCH_BINDING_NAME]);

    const withoutDispatch = createBuiltinBindings({ cwd: process.cwd(), names: ["read", "bash"] });
    const second = await runPtcProgram({
      code: "return [...ptcBindings];",
      surface: "run_code",
      cwd: process.cwd(),
      bindings: withoutDispatch,
    });
    expect(second.error).toBeUndefined();
    expect(second.value).toEqual(["read", "bash"]);
  },
  RUN_TIMEOUT_MS,
);
