import assert from "node:assert/strict";
import { test } from "node:test";
import { runPtcProgram } from "../src/runtime/dispatcher.ts";
import { DEFAULT_CONFIG } from "../src/runtime/limits.ts";
import { makeBindings, RUN_TIMEOUT_MS } from "./helpers/ptc.ts";

const bindings = makeBindings({});
const runCode = (code: string, extra: Partial<Parameters<typeof runPtcProgram>[0]> = {}) =>
  runPtcProgram({ code, surface: "run_code", cwd: process.cwd(), bindings, ...extra });
const runWorkflow = (code: string, extra: Partial<Parameters<typeof runPtcProgram>[0]> = {}) =>
  runPtcProgram({ code, surface: "workflow", cwd: process.cwd(), bindings, ...extra });
const options = { timeout: RUN_TIMEOUT_MS };

test("run_code resolves the program's return value as lossless JSON", options, async () => {
  const outcome = await runCode('return { nested: [1, "two", null, true], deep: { a: { b: 2 } } };');
  assert.equal(outcome.error, undefined);
  assert.deepEqual(outcome.value, { nested: [1, "two", null, true], deep: { a: { b: 2 } } });
});

test("run_code reports no value when the program returns nothing", options, async () => {
  const outcome = await runCode("const x = 1;");
  assert.equal(outcome.error, undefined);
  assert.equal("value" in outcome, false);
});

test("run_code strips TypeScript annotations", options, async () => {
  const outcome = await runCode("const x: number = 41;\nconst f = (v: number): number => v + 1;\nreturn f(x);");
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.value, 42);
});

test("run_code captures console output with level-agnostic formatting", options, async () => {
  const outcome = await runCode(
    'console.log("plain", 1, true); console.error("as error"); console.warn({ a: 1 }); console.log();',
  );
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.logs.length, 4);
  assert.equal(outcome.logs[0], "plain 1 true");
  assert.equal(outcome.logs[1], "as error");
  assert.match(String(outcome.logs[2]), /\{ a: 1 \}/);
  assert.equal(outcome.logs[3], "");
});

test("run_code surface exposes tools and Node only — no helpers", options, async () => {
  const outcome = await runCode(
    "return { tools: typeof tools, log: typeof log, phase: typeof phase, parallel: typeof parallel, pipeline: typeof pipeline, agent: typeof agent, args: typeof args, require: typeof require };",
  );
  assert.equal(outcome.error, undefined);
  assert.deepEqual(outcome.value, {
    tools: "object",
    log: "undefined",
    phase: "undefined",
    parallel: "undefined",
    pipeline: "undefined",
    agent: "undefined",
    args: "undefined",
    require: "undefined",
  });
});

test("calling a helper that the surface does not have is a plain ReferenceError", options, async () => {
  const outcome = await runCode('log("nope");');
  assert.equal(outcome.error?.kind, "exception");
  assert.match(String(outcome.error?.message), /log is not defined/);
  assert.equal(outcome.value, undefined);
});

test("workflow surface installs the helper globals and binds args", options, async () => {
  const outcome = await runWorkflow(
    "return { log: typeof log, phase: typeof phase, parallel: typeof parallel, pipeline: typeof pipeline, agent: typeof agent, args, tools: typeof tools };",
    { args: { task: "write the report" } },
  );
  assert.equal(outcome.error, undefined);
  assert.deepEqual(outcome.value, {
    log: "function",
    phase: "function",
    parallel: "function",
    pipeline: "function",
    agent: "undefined",
    args: { task: "write the report" },
    tools: "object",
  });
});

test("workflow log() and phase() emit frames instead of console output", options, async () => {
  const outcome = await runWorkflow('log("step one"); phase("Research"); console.log("printed"); phase("Write");');
  assert.equal(outcome.error, undefined);
  assert.deepEqual(outcome.narrations, ["step one"]);
  assert.deepEqual(outcome.phases, ["Research", "Write"]);
  assert.deepEqual(outcome.logs, ["printed"]);
});

test("workflow log/phase validate their argument", options, async () => {
  const badLog = await runWorkflow("log(42);");
  assert.equal(badLog.error?.kind, "exception");
  assert.match(String(badLog.error?.message), /log\(message\) expects a string/);

  const badPhase = await runWorkflow("phase(null);");
  assert.equal(badPhase.error?.kind, "exception");
  assert.match(String(badPhase.error?.message), /phase\(title\) expects a string/);
});

test("parallel() runs thunks concurrently and maps per-item failures to null", options, async () => {
  const outcome = await runWorkflow(
    'const out = await parallel([async () => { await new Promise((r) => setTimeout(r, 5)); return "a"; }, async () => { throw new Error("boom"); }, async () => 3]); return out;',
  );
  assert.equal(outcome.error, undefined);
  assert.deepEqual(outcome.value, ["a", null, 3]);
});

test("parallel() validates its argument shape", options, async () => {
  const notArray = await runWorkflow('await parallel("nope");');
  assert.equal(notArray.error?.kind, "exception");
  assert.match(String(notArray.error?.message), /parallel\(thunks\) expects an array/);

  const notFunctions = await runWorkflow("await parallel([1]);");
  assert.equal(notFunctions.error?.kind, "exception");
  assert.match(String(notFunctions.error?.message), /parallel\(thunks\) expects functions; item 0 is a number/);
});

test("parallel() enforces maxItemsPerCall", options, async () => {
  const outcome = await runWorkflow(
    `await parallel(Array.from({ length: ${DEFAULT_CONFIG.maxItemsPerCall + 1} }, () => async () => 1));`,
  );
  assert.equal(outcome.error?.kind, "exception");
  assert.match(String(outcome.error?.message), /maxItemsPerCall/);
  assert.match(String(outcome.error?.message), new RegExp(String(DEFAULT_CONFIG.maxItemsPerCall)));
});

test("pipeline() threads each item through every stage without a cross-stage barrier", options, async () => {
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
  assert.equal(outcome.error, undefined);
  assert.deepEqual(outcome.value, ["0:1:1!", "1:2:2!", "2:3:3!"]);
});

test("pipeline() turns a failing item into null and keeps siblings", options, async () => {
  const outcome = await runWorkflow(
    "const out = await pipeline([1, 2, 3], async (prev, item) => { if (item === 2) throw new Error('boom'); return prev * 10; }); return out;",
  );
  assert.equal(outcome.error, undefined);
  assert.deepEqual(outcome.value, [10, null, 30]);
});

test("pipeline() validates its arguments and enforces maxItemsPerCall", options, async () => {
  const noStages = await runWorkflow("await pipeline([1, 2]);");
  assert.match(String(noStages.error?.message), /requires at least one stage function/);

  const badStage = await runWorkflow("await pipeline([1], 'nope');");
  assert.match(String(badStage.error?.message), /stage 0 is a string/);

  const tooMany = await runWorkflow(
    `await pipeline(Array.from({ length: ${DEFAULT_CONFIG.maxItemsPerCall + 1} }, (_, i) => i), async (v) => v);`,
  );
  assert.match(String(tooMany.error?.message), /maxItemsPerCall/);
});

test("workflow surface has no agent() helper either", options, async () => {
  const outcome = await runWorkflow('agent("do something");');
  assert.equal(outcome.error?.kind, "exception");
  assert.match(String(outcome.error?.message), /agent is not defined/);
});

test("a program that fails to compile reports an exception", options, async () => {
  const outcome = await runCode("return ((((;");
  assert.equal(outcome.error?.kind, "exception");
  assert.match(String(outcome.error?.message), /failed to compile/);
});

test("a thrown program error carries a trimmed stack", options, async () => {
  const outcome = await runCode('throw new Error("exploded");');
  assert.equal(outcome.error?.kind, "exception");
  assert.equal(outcome.error?.message, "exploded");
  assert.ok(outcome.error?.stack?.includes("exploded"), "stack keeps the message line");
  assert.equal(outcome.error?.stack?.includes("data:text/javascript"), false, "worker bootstrap frames are dropped");
  assert.ok((outcome.error?.stack?.split("\n").length ?? 0) <= 6, "stack depth is capped");
});

test("results that are not lossless JSON report invalid-output with a path", options, async () => {
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
    assert.equal(outcome.error?.kind, "invalid-output", `${code} must be rejected`);
    assert.match(String(outcome.error?.message), expected);
    assert.equal("value" in outcome, false);
  }
});

test("undefined follows JSON.stringify rules inside containers", options, async () => {
  const outcome = await runCode("return { kept: 1, dropped: undefined, list: [1, undefined, 3] };");
  assert.equal(outcome.error, undefined);
  assert.deepEqual(outcome.value, { kept: 1, list: [1, null, 3] });
});

test("each run gets a fresh worker realm", options, async () => {
  const first = await runCode("globalThis.leaked = 1; return typeof leaked;");
  assert.equal(first.value, "number");
  const second = await runCode("return typeof leaked;");
  assert.equal(second.value, "undefined");
});
