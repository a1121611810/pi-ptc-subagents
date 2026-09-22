import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
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

test(
  "end-to-end smoke: `return 40 + 2` resolves to 42 through the real dispatcher",
  async () => {
    const outcome = await run("return 40 + 2;");
    expect(outcome).toEqual({ logs: [], narrations: [], phases: [], value: 42 });
  },
  RUN_TIMEOUT_MS,
);

test(
  "console output is collected in arrival order around binding calls",
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
    expect(outcome.error).toBeUndefined();
    expect(outcome.logs).toEqual(["before", "after true"]);
    expect(outcome.value).toBe(1);
  },
  RUN_TIMEOUT_MS,
);

test(
  "bindings round-trip through the real worker against a temp-dir fixture",
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
      expect(outcome.error).toBeUndefined();
      expect(outcome.value).toEqual({ file: "content from the fixture\n", cwd: dir });
    } finally {
      await removeTempDir(dir);
    }
  },
  RUN_TIMEOUT_MS,
);

test("independent binding calls overlap under Promise.all", async () => {
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
  // The previous `setTimeout(resolve, 50)` raced against the worker cold-start
  // budget (~45–95 ms: `new Worker` + ~40 KB data-URL decode + connect/ready/init
  // handshake + startRun). The invariant is "started reached 3 before any call
  // resolved"; sample it directly instead of wall-clock. 5 s ceiling still trips
  // RUN_TIMEOUT_MS if dispatch regresses to serial. See
  // docs/research/dispatcher-test-timing-rootcause.md.
  const deadline = Date.now() + 5_000;
  while (started < 3 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(started).toBe(3);
  release.resolve(undefined);
  const outcome = await promise;
  expect(outcome.error).toBeUndefined();
  expect(outcome.value).toEqual([3, 3, 3]);
}, RUN_TIMEOUT_MS);

test("dispatch forwarding is capped at maxParallelSubCalls", async () => {
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
  expect(outcome.error).toBeUndefined();
  expect(outcome.value).toBe(count);
  expect(peak).toBe(DEFAULT_CONFIG.maxParallelSubCalls);
}, RUN_TIMEOUT_MS);

test(
  "a wide fan-out queues inside the worker instead of failing the run",
  async () => {
    const maxPendingCalls = 4;
    const calls = maxPendingCalls * 5;
    const bindings = makeBindings({ ping: async (args) => (args as { i: number }).i });
    const outcome = await run(
      `const rs = await Promise.all(Array.from({ length: ${calls} }, (_, i) => tools.ping({ i }))); return rs.length;`,
      { bindings, config: { maxPendingCalls } },
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toBe(calls);
  },
  RUN_TIMEOUT_MS,
);

test(
  "the worker keeps simultaneous host binding calls at or below maxPendingCalls",
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
    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toBe(maxPendingCalls * 5);
    expect(peak).toBeLessThanOrEqual(maxPendingCalls);
    expect(peak).toBeGreaterThan(1);
  },
  RUN_TIMEOUT_MS,
);

test(
  "cancel while calls wait for admission rejects them without waiting out the grace window",
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
    expect(outcome.error?.kind).toBe("abort");
    expect(elapsed).toBeLessThan(graceMs / 2);
  },
  RUN_TIMEOUT_MS,
);

test("a workflow fan-out obeys the same admission budget", async () => {
  const maxPendingCalls = 4;
  const bindings = makeBindings({ step: async (args) => (args as { n: number }).n });
  const outcome = await run(
    `const out = await parallel(Array.from({ length: ${maxPendingCalls * 3} }, (_, n) => async () => tools.step({ n }))); return out.length;`,
    { bindings, config: { maxPendingCalls }, surface: "workflow" },
  );
  expect(outcome.error).toBeUndefined();
  expect(outcome.value).toBe(maxPendingCalls * 3);
}, RUN_TIMEOUT_MS);

test(
  "a failing binding rejects the call with ToolCallError and keeps the run alive",
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
    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toEqual({
      name: "ToolCallError",
      toolName: "boom",
      message: "binding exploded",
    });
  },
  RUN_TIMEOUT_MS,
);

test(
  "a binding result that cannot be transferred fails the call instead of hanging",
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
    expect(outcome.error).toBeUndefined();
    expect(
      typeof outcome.value === "string" && outcome.value.includes("could not be transferred"),
    ).toBe(true);
  },
  RUN_TIMEOUT_MS,
);

test("worker crashes surface as worker-exit", async () => {
  const outcome = await run("process.exit(3);");
  expect(outcome.error?.kind).toBe("worker-exit");
  expect(String(outcome.error?.message)).toMatch(/exited with code 3/);
}, RUN_TIMEOUT_MS);

test("F1 — the worker environment is the allow-list and nothing else", async () => {
  const outcome = await run("return Object.keys(process.env).sort();");
  expect(outcome.error).toBeUndefined();
  const workerKeys = outcome.value as string[];
  expect(workerKeys).toEqual(Object.keys(createWorkerEnv()).sort());
  for (const name of workerKeys) {
    expect(WORKER_ENV_ALLOW_LIST).toContain(name);
  }
  for (const name of Object.keys(process.env)) {
    if (WORKER_ENV_ALLOW_LIST.includes(name)) continue;
    expect(workerKeys.includes(name)).toBe(false);
  }
}, RUN_TIMEOUT_MS);

test("F2 — the worker heap is capped by resourceLimits", async () => {
  const outcome = await run(
    "return (await import('node:v8')).getHeapStatistics().heap_size_limit;",
  );
  expect(outcome.error).toBeUndefined();
  const limit = outcome.value as number;
  const capBytes = DEFAULT_CONFIG.maxOldGenerationSizeMb * 1024 * 1024;
  expect(limit).toBeGreaterThan(0);
  // The cap only covers the old generation, so the effective heap ceiling sits above it;
  // the generous 2x bound still fails loudly if `resourceLimits` stops being applied
  // (Node's default ceiling is multiple GiB on a normal host).
  expect(limit).toBeLessThan(capBytes * 2);
}, RUN_TIMEOUT_MS);

test(
  "F3 — the frozen per-run environment travels in workerData and is authoritative",
  async () => {
    const outcome = await run("return (await import('node:worker_threads')).workerData;");
    expect(outcome.error).toBeUndefined();
    const data = outcome.value as { runId: string; env: Record<string, string> };
    expect(typeof data.runId).toBe("string");
    expect(data.env).toEqual(createWorkerEnv());
    expect(
      Object.isFrozen(data.env),
      "structured clone gives the worker its own copy of the record",
    ).toBe(false);
  },
  RUN_TIMEOUT_MS,
);

test("F3 — a run id passed by the caller is the one the worker sees", async () => {
  const outcome = await runPtcProgram({
    code: "return (await import('node:worker_threads')).workerData.runId;",
    surface: "run_code",
    cwd: process.cwd(),
    bindings: empty,
    runId: "run-abc",
  });
  expect(outcome.value).toBe("run-abc");
}, RUN_TIMEOUT_MS);

test("F4 — bindings run in the run's cwd, not the host process cwd", async () => {
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
    expect(outcome.error).toBeUndefined();
    const value = outcome.value as { pwd: string; marker: string; processCwd: string };
    expect(value.pwd).toBe(dir);
    expect(value.marker).toBe("marker");
    // A worker cannot chdir: the process cwd is shared, which is why `cwd` is carried in
    // the run config and applied by the tools instead (ADR-0005 F4).
    expect(value.processCwd).not.toBe(dir);
  } finally {
    await removeTempDir(dir);
  }
}, RUN_TIMEOUT_MS);

test("a run that outlives its deadline fails with timeout", async () => {
  const timeoutMs = 150;
  const started = Date.now();
  const outcome = await run("await new Promise(() => {});", {
    timeoutMs,
    config: { graceMs: timeoutMs },
  });
  expect(outcome.error?.kind).toBe("timeout");
  expect(String(outcome.error?.message)).toMatch(new RegExp(String(timeoutMs)));
  expect(Date.now() - started).toBeLessThan(RUN_TIMEOUT_MS);
}, RUN_TIMEOUT_MS);

test(
  "aborting the caller's signal cancels the run and aborts in-flight bindings",
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
    expect(outcome.error?.kind).toBe("abort");
    expect(bindingSawAbort, "the binding received the run's abort signal").toBe(true);
  },
  RUN_TIMEOUT_MS,
);

test("cancelling an already-aborted signal never spawns work", async () => {
  const outcome = await run("return 1;", { signal: AbortSignal.abort() });
  expect(outcome.error?.kind).toBe("abort");
  expect(outcome.logs).toEqual([]);
}, RUN_TIMEOUT_MS);

test("the joint output budget covers logs and the completion value", async () => {
  const budget = Math.floor(DEFAULT_CONFIG.maxOutputBytes / 1024);
  const chunk = "x".repeat(Math.ceil(budget / 2));
  const outcome = await run(
    `console.log(${JSON.stringify(chunk)}); console.log(${JSON.stringify(chunk)}); console.log("third"); return 1;`,
    { config: { maxOutputBytes: budget } },
  );
  expect(outcome.error?.kind).toBe("output-limit");
  expect(outcome.logs.length, "the fitting log prefix is retained").toBe(1);
  expect(outcome.value).toBeUndefined();
}, RUN_TIMEOUT_MS);

test("an oversized single control frame is a protocol failure", async () => {
  const maxMessageBytes = Math.floor(DEFAULT_CONFIG.maxMessageBytes / 1024);
  const oversized = "y".repeat(maxMessageBytes * 2);
  const outcome = await run(`console.log("z".repeat(${oversized.length})); return 1;`, {
    config: { maxMessageBytes },
  });
  expect(outcome.error?.kind).toBe("protocol");
  expect(String(outcome.error?.message)).toMatch(/maxMessageBytes/);
}, RUN_TIMEOUT_MS);

test("concurrent runs stay isolated from each other", async () => {
  const bindings = makeBindings({ echo: async (args) => args });
  const [first, second] = await Promise.all([
    run('console.log("first"); await tools.echo({ tag: "a" }); return "a";', { bindings }),
    run('console.log("second"); await tools.echo({ tag: "b" }); return "b";', { bindings }),
  ]);
  expect(first.value).toBe("a");
  expect(second.value).toBe("b");
  expect(first.logs).toEqual(["first"]);
  expect(second.logs).toEqual(["second"]);
}, RUN_TIMEOUT_MS);

test("the workflow surface runs through the dispatcher end to end", async () => {
  const bindings = makeBindings({ double: async (args) => (args as { n: number }).n * 2 });
  const outcome = await runPtcProgram({
    code: 'log("start"); phase("Compute"); const values = await parallel(args.items.map((n) => async () => tools.double({ n }))); return values;',
    surface: "workflow",
    cwd: process.cwd(),
    bindings,
    args: { items: [1, 2, 3] },
  });
  expect(outcome.error).toBeUndefined();
  expect(outcome.value).toEqual([2, 4, 6]);
  expect(outcome.narrations).toEqual(["start"]);
  expect(outcome.phases).toEqual(["Compute"]);
}, RUN_TIMEOUT_MS);