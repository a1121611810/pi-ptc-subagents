import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createBuiltinBindings } from "../src/runtime/bindings.ts";
import type { BindingTable } from "../src/runtime/bindings.ts";
import { runPtcProgram } from "../src/runtime/dispatcher.ts";
import { createWorkerEnv, DEFAULT_CONFIG, WORKER_ENV_ALLOW_LIST } from "../src/runtime/limits.ts";
import type { PtcConfig } from "../src/runtime/limits.ts";
import {
  deferred,
  makeBindings,
  makeTempDir,
  removeTempDir,
  RUN_TIMEOUT_MS,
} from "./helpers/ptc.ts";

const options = { timeout: RUN_TIMEOUT_MS };
const empty = makeBindings({});
const run = (
  code: string,
  extra: {
    bindings?: BindingTable;
    cwd?: string;
    config?: Partial<PtcConfig>;
    timeoutMs?: number;
    signal?: AbortSignal;
    surface?: "run_code" | "workflow";
  } = {},
) =>
  runPtcProgram({
    code,
    surface: extra.surface ?? "run_code",
    cwd: extra.cwd ?? process.cwd(),
    bindings: extra.bindings ?? empty,
    ...(extra.config === undefined ? {} : { config: extra.config }),
    ...(extra.timeoutMs === undefined ? {} : { timeoutMs: extra.timeoutMs }),
    ...(extra.signal === undefined ? {} : { signal: extra.signal }),
  });

void test(
  "end-to-end smoke: `return 40 + 2` resolves to 42 through the real dispatcher",
  options,
  async () => {
    const outcome = await run("return 40 + 2;");
    assert.deepEqual(outcome, { logs: [], narrations: [], phases: [], value: 42 });
  },
);

void test(
  "console output is collected in arrival order around binding calls",
  options,
  async () => {
    const bindings = makeBindings({
      ping: async () => {
        return { pong: true };
      },
    });
    const outcome = await run(
      'console.log("before"); const r = await tools.ping({}); console.log("after", r.pong); return 1;',
      { bindings },
    );
    assert.equal(outcome.error, undefined);
    assert.deepEqual(outcome.logs, ["before", "after true"]);
    assert.equal(outcome.value, 1);
  },
);

void test(
  "bindings round-trip through the real worker against a temp-dir fixture",
  options,
  async () => {
    const dir = await makeTempDir();
    try {
      await writeFile(join(dir, "fixture.txt"), "content from the fixture\n");
      const bindings = createBuiltinBindings({ cwd: dir, names: ["read", "bash"] });
      const outcome = await run(
        [
          'const file = await tools.read({ path: "fixture.txt" });',
          'const cwd = await tools.bash({ command: "pwd" });',
          "return { file: file.content[0].text, cwd: cwd.content[0].text.trim() };",
        ].join("\n"),
        { bindings, cwd: dir },
      );
      assert.equal(outcome.error, undefined);
      assert.deepEqual(outcome.value, { file: "content from the fixture\n", cwd: dir });
    } finally {
      await removeTempDir(dir);
    }
  },
);

void test("independent binding calls overlap under Promise.all", options, async () => {
  const release = deferred<void>();
  let started = 0;
  const bindings = makeBindings({
    wait: async () => {
      started += 1;
      await release.promise;
      return started;
    },
  });
  const promise = run(
    "const rs = await Promise.all([tools.wait({}), tools.wait({}), tools.wait({})]); return rs;",
    { bindings },
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(started, 3, "all three calls reached the host before any of them resolved");
  release.resolve(undefined);
  const outcome = await promise;
  assert.equal(outcome.error, undefined);
  assert.deepEqual(outcome.value, [3, 3, 3]);
});

void test("dispatch forwarding is capped at maxParallelSubCalls", options, async () => {
  let active = 0;
  let peak = 0;
  const bindings = makeBindings({
    probe: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return active;
    },
  });
  const count = DEFAULT_CONFIG.maxParallelSubCalls * 3;
  const outcome = await run(
    `const rs = await Promise.all(Array.from({ length: ${count} }, (_, i) => tools.probe({ i }))); return rs.length;`,
    { bindings },
  );
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.value, count, "every queued call still runs");
  assert.equal(peak, DEFAULT_CONFIG.maxParallelSubCalls, "concurrency stays at the cap");
});

void test(
  "a wide fan-out queues inside the worker instead of failing the run",
  options,
  async () => {
    const maxPendingCalls = 4;
    const calls = maxPendingCalls * 5;
    const bindings = makeBindings({ ping: async (args) => (args as { i: number }).i });
    const outcome = await run(
      `const rs = await Promise.all(Array.from({ length: ${calls} }, (_, i) => tools.ping({ i }))); return rs.length;`,
      { bindings, config: { maxPendingCalls } },
    );
    assert.equal(outcome.error, undefined, "admission control must not fail a legitimate burst");
    assert.equal(outcome.value, calls);
  },
);

void test(
  "the worker keeps simultaneous host binding calls at or below maxPendingCalls",
  options,
  async () => {
    const maxPendingCalls = 4;
    let active = 0;
    let peak = 0;
    const bindings = makeBindings({
      probe: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
        return null;
      },
    });
    const outcome = await run(
      `const rs = await Promise.all(Array.from({ length: ${maxPendingCalls * 5} }, () => tools.probe({}))); return rs.length;`,
      { bindings, config: { maxPendingCalls } },
    );
    assert.equal(outcome.error, undefined);
    assert.equal(outcome.value, maxPendingCalls * 5, "every call still runs");
    assert.ok(
      peak <= maxPendingCalls,
      `observed ${peak} simultaneous calls, ceiling is ${maxPendingCalls}`,
    );
    assert.ok(peak > 1, `expected the burst to overlap, saw ${peak} concurrent call(s)`);
  },
);

void test(
  "cancel while calls wait for admission rejects them without waiting out the grace window",
  options,
  async () => {
    const graceMs = DEFAULT_CONFIG.graceMs;
    const bindings = makeBindings({ hold: async () => await new Promise(() => {}) });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 80);
    const started = Date.now();
    const outcome = await run(
      "await Promise.all(Array.from({ length: 5 }, () => tools.hold({}))); return 1;",
      {
        bindings,
        signal: controller.signal,
        config: { maxPendingCalls: 1, graceMs },
      },
    );
    const elapsed = Date.now() - started;
    assert.equal(outcome.error?.kind, "abort");
    assert.ok(
      elapsed < graceMs / 2,
      `cancel settled after ${elapsed}ms, i.e. it waited for the grace window`,
    );
  },
);

void test("a workflow fan-out obeys the same admission budget", options, async () => {
  const maxPendingCalls = 4;
  const bindings = makeBindings({ step: async (args) => (args as { n: number }).n });
  const outcome = await run(
    `const out = await parallel(Array.from({ length: ${maxPendingCalls * 3} }, (_, n) => async () => tools.step({ n }))); return out.length;`,
    { bindings, config: { maxPendingCalls }, surface: "workflow" },
  );
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.value, maxPendingCalls * 3);
});

void test(
  "a failing binding rejects the call with ToolCallError and keeps the run alive",
  options,
  async () => {
    const bindings = makeBindings({
      boom: async () => {
        throw new Error("binding exploded");
      },
    });
    const outcome = await run(
      "try { await tools.boom({}); } catch (error) { return { name: error.name, toolName: error.toolName, message: error.message }; }",
      { bindings },
    );
    assert.equal(outcome.error, undefined);
    assert.deepEqual(outcome.value, {
      name: "ToolCallError",
      toolName: "boom",
      message: "binding exploded",
    });
  },
);

void test(
  "a binding result that cannot be transferred fails the call instead of hanging",
  options,
  async () => {
    const bindings = makeBindings({
      bogus: async () => {
        return { content: [], details: { fn: () => 1 } };
      },
    });
    const outcome = await run(
      "try { await tools.bogus({}); return 'no error'; } catch (error) { return error.message; }",
      { bindings },
    );
    assert.equal(outcome.error, undefined);
    assert.ok(
      typeof outcome.value === "string" && outcome.value.includes("could not be transferred"),
      `expected a string mentioning the transfer failure, got ${JSON.stringify(outcome.value)}`,
    );
  },
);

void test("worker crashes surface as worker-exit", options, async () => {
  const outcome = await run("process.exit(3);");
  assert.equal(outcome.error?.kind, "worker-exit");
  assert.match(String(outcome.error?.message), /exited with code 3/);
});

void test("F1 — the worker environment is the allow-list and nothing else", options, async () => {
  const outcome = await run("return Object.keys(process.env).sort();");
  assert.equal(outcome.error, undefined);
  const workerKeys = outcome.value as string[];
  assert.deepEqual(workerKeys, Object.keys(createWorkerEnv()).sort());
  for (const name of workerKeys) {
    assert.ok(WORKER_ENV_ALLOW_LIST.includes(name), `${name} is not on the allow-list`);
  }
  for (const name of Object.keys(process.env)) {
    if (WORKER_ENV_ALLOW_LIST.includes(name)) continue;
    assert.equal(workerKeys.includes(name), false, `host-only ${name} leaked into the worker`);
  }
});

void test("F2 — the worker heap is capped by resourceLimits", options, async () => {
  const outcome = await run(
    "return (await import('node:v8')).getHeapStatistics().heap_size_limit;",
  );
  assert.equal(outcome.error, undefined);
  const limit = outcome.value as number;
  const capBytes = DEFAULT_CONFIG.maxOldGenerationSizeMb * 1024 * 1024;
  assert.ok(limit > 0);
  // The cap only covers the old generation, so the effective heap ceiling sits above it;
  // the generous 2x bound still fails loudly if `resourceLimits` stops being applied
  // (Node's default ceiling is multiple GiB on a normal host).
  assert.ok(
    limit < capBytes * 2,
    `heap limit ${limit} is not capped by ${capBytes} old-generation bytes`,
  );
});

void test(
  "F3 — the frozen per-run environment travels in workerData and is authoritative",
  options,
  async () => {
    const outcome = await run("return (await import('node:worker_threads')).workerData;");
    assert.equal(outcome.error, undefined);
    const data = outcome.value as { runId: string; env: Record<string, string> };
    assert.equal(typeof data.runId, "string");
    assert.deepEqual(data.env, createWorkerEnv());
    assert.equal(
      Object.isFrozen(data.env),
      false,
      "structured clone gives the worker its own copy of the record",
    );
  },
);

void test("F3 — a run id passed by the caller is the one the worker sees", options, async () => {
  const outcome = await runPtcProgram({
    code: "return (await import('node:worker_threads')).workerData.runId;",
    surface: "run_code",
    cwd: process.cwd(),
    bindings: empty,
    runId: "run-abc",
  });
  assert.equal(outcome.value, "run-abc");
});

void test("F4 — bindings run in the run's cwd, not the host process cwd", options, async () => {
  const dir = await makeTempDir();
  try {
    const bindings = createBuiltinBindings({ cwd: dir, names: ["bash", "read"] });
    await writeFile(join(dir, "marker.txt"), "marker\n");
    const outcome = await run(
      [
        'const pwd = await tools.bash({ command: "pwd" });',
        'const file = await tools.read({ path: "marker.txt" });',
        "return { pwd: pwd.content[0].text.trim(), marker: file.content[0].text.trim(), processCwd: process.cwd() };",
      ].join("\n"),
      { bindings, cwd: dir },
    );
    assert.equal(outcome.error, undefined);
    const value = outcome.value as { pwd: string; marker: string; processCwd: string };
    assert.equal(value.pwd, dir);
    assert.equal(value.marker, "marker");
    // A worker cannot chdir: the process cwd is shared, which is why `cwd` is carried in
    // the run config and applied by the tools instead (ADR-0005 F4).
    assert.notEqual(value.processCwd, dir);
  } finally {
    await removeTempDir(dir);
  }
});

void test("a run that outlives its deadline fails with timeout", options, async () => {
  const timeoutMs = 150;
  const started = Date.now();
  const outcome = await run("await new Promise(() => {});", {
    timeoutMs,
    config: { graceMs: timeoutMs },
  });
  assert.equal(outcome.error?.kind, "timeout");
  assert.match(String(outcome.error?.message), new RegExp(String(timeoutMs)));
  assert.ok(Date.now() - started < RUN_TIMEOUT_MS);
});

void test(
  "aborting the caller's signal cancels the run and aborts in-flight bindings",
  options,
  async () => {
    let bindingSawAbort = false;
    const bindings: BindingTable = makeBindings({
      slow: async (_args, context) => {
        await new Promise((_resolve, reject) => {
          context.signal?.addEventListener("abort", () => {
            bindingSawAbort = true;
            reject(new Error("aborted"));
          });
        });
        return null;
      },
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const outcome = await run("await tools.slow({}); return 1;", {
      bindings,
      signal: controller.signal,
      config: { graceMs: 500 },
    });
    assert.equal(outcome.error?.kind, "abort");
    assert.equal(bindingSawAbort, true, "the binding received the run's abort signal");
  },
);

void test("cancelling an already-aborted signal never spawns work", options, async () => {
  const outcome = await run("return 1;", { signal: AbortSignal.abort() });
  assert.equal(outcome.error?.kind, "abort");
  assert.deepEqual(outcome.logs, []);
});

void test("the joint output budget covers logs and the completion value", options, async () => {
  const budget = Math.floor(DEFAULT_CONFIG.maxOutputBytes / 1024);
  const chunk = "x".repeat(Math.ceil(budget / 2));
  const outcome = await run(
    `console.log(${JSON.stringify(chunk)}); console.log(${JSON.stringify(chunk)}); console.log("third"); return 1;`,
    { config: { maxOutputBytes: budget } },
  );
  assert.equal(outcome.error?.kind, "output-limit");
  assert.equal(outcome.logs.length, 1, "the fitting log prefix is retained");
  assert.equal(outcome.value, undefined);
});

void test("an oversized single control frame is a protocol failure", options, async () => {
  const maxMessageBytes = Math.floor(DEFAULT_CONFIG.maxMessageBytes / 1024);
  const oversized = "y".repeat(maxMessageBytes * 2);
  const outcome = await run(`console.log("z".repeat(${oversized.length})); return 1;`, {
    config: { maxMessageBytes },
  });
  assert.equal(outcome.error?.kind, "protocol");
  assert.match(String(outcome.error?.message), /maxMessageBytes/);
});

void test("concurrent runs stay isolated from each other", options, async () => {
  const bindings = makeBindings({ echo: async (args) => args });
  const [first, second] = await Promise.all([
    run('console.log("first"); await tools.echo({ tag: "a" }); return "a";', { bindings }),
    run('console.log("second"); await tools.echo({ tag: "b" }); return "b";', { bindings }),
  ]);
  assert.equal(first.value, "a");
  assert.equal(second.value, "b");
  assert.deepEqual(first.logs, ["first"]);
  assert.deepEqual(second.logs, ["second"]);
});

void test("the workflow surface runs through the dispatcher end to end", options, async () => {
  const bindings = makeBindings({ double: async (args) => (args as { n: number }).n * 2 });
  const outcome = await runPtcProgram({
    code: 'log("start"); phase("Compute"); const values = await parallel(args.items.map((n) => async () => tools.double({ n }))); return values;',
    surface: "workflow",
    cwd: process.cwd(),
    bindings,
    args: { items: [1, 2, 3] },
  });
  assert.equal(outcome.error, undefined);
  assert.deepEqual(outcome.value, [2, 4, 6]);
  assert.deepEqual(outcome.narrations, ["start"]);
  assert.deepEqual(outcome.phases, ["Compute"]);
});
