import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createBuiltinBindings } from "../src/runtime/bindings.ts";
import type { BindingTable } from "../src/runtime/bindings.ts";
import { runPtcProgram } from "../src/runtime/dispatcher.ts";
import type { PtcRunOutcome } from "../src/runtime/dispatcher.ts";
import { createWorkerEnv, DEFAULT_CONFIG, WORKER_ENV_ALLOW_LIST } from "../src/runtime/limits.ts";
import type { PtcConfig } from "../src/runtime/limits.ts";
import {
  deferred,
  makeBindings,
  makeTempDir,
  ONE_PIXEL_PNG_BASE64,
  removeTempDir,
  RUN_TIMEOUT_MS,
} from "./helpers/ptc.ts";

/* --------------------------------------------------------------------------------------------
 * Seam: a worker frozen in BOOTING
 *
 * The dispatcher's settle path has to hold when the worker never becomes reachable — a spawn that
 * fails after `new Worker` returned, a module load that wedges, a thread the OS stops scheduling.
 * Every other worker in this suite reaches `ready`, so the two tests at the bottom of the cancel
 * section need to control the entry the dispatcher loads.
 *
 * `buildWorkerUrl()` has no injection point: `RunPtcProgramOptions` carries no worker-URL field,
 * and `worker-source.ts` resolves the entry from disk. The mock therefore wraps the real resolver
 * and only diverts while a test has armed `hungWorker.url`, so every other test in this file keeps
 * spawning the real worker.
 * ------------------------------------------------------------------------------------------ */

const hungWorker = vi.hoisted(() => ({ url: undefined as URL | undefined }));

vi.mock("../src/runtime/worker-source.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/worker-source.ts")>();
  return {
    ...actual,
    buildWorkerUrl: () => hungWorker.url ?? actual.buildWorkerUrl(),
  };
});

/**
 * A worker that boots and then does nothing: it never posts the `ready` frame the handshake
 * waits for. The self-exit is test hygiene — a failing (red) run would otherwise leak a live
 * thread past the end of the test — and is late enough never to rescue a red run.
 */
const BOOTING_FOREVER_WORKER_URL = new URL(
  `data:text/javascript,${encodeURIComponent("setTimeout(() => process.exit(0), 3_000);")}`,
);

/** Sentinel for "the run's promise was still pending when the ceiling elapsed". */
const HUNG = Symbol("the run never settled");

const hungAfter = (ms: number): Promise<typeof HUNG> =>
  new Promise((resolve) => {
    setTimeout(() => resolve(HUNG), ms);
  });

/** Render the raced result so a failure names the leak instead of a bare `undefined`. */
const settleKindOf = (raced: PtcRunOutcome | typeof HUNG): string =>
  raced === HUNG
    ? "the run never settled — the host leaked a pending run promise"
    : (raced.error?.kind ?? "(settled without an error)");

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

test(
  "independent binding calls overlap under Promise.all",
  async () => {
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
  },
  RUN_TIMEOUT_MS,
);

test(
  "dispatch forwarding is capped at maxParallelSubCalls",
  async () => {
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
  },
  RUN_TIMEOUT_MS,
);

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

test(
  "a workflow fan-out obeys the same admission budget",
  async () => {
    const maxPendingCalls = 4;
    const bindings = makeBindings({ step: async (args) => (args as { n: number }).n });
    const outcome = await run(
      `const out = await parallel(Array.from({ length: ${maxPendingCalls * 3} }, (_, n) => async () => tools.step({ n }))); return out.length;`,
      { bindings, config: { maxPendingCalls }, surface: "workflow" },
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toBe(maxPendingCalls * 3);
  },
  RUN_TIMEOUT_MS,
);

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

test(
  "worker crashes surface as worker-exit",
  async () => {
    const outcome = await run("process.exit(3);");
    expect(outcome.error?.kind).toBe("worker-exit");
    expect(String(outcome.error?.message)).toMatch(/exited with code 3/);
  },
  RUN_TIMEOUT_MS,
);

test(
  "F1 — the worker environment is the allow-list and nothing else",
  async () => {
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
  },
  RUN_TIMEOUT_MS,
);

test(
  "F2 — the worker heap is capped by resourceLimits",
  async () => {
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
  },
  RUN_TIMEOUT_MS,
);

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

test(
  "F3 — a run id passed by the caller is the one the worker sees",
  async () => {
    const outcome = await runPtcProgram({
      code: "return (await import('node:worker_threads')).workerData.runId;",
      surface: "run_code",
      cwd: process.cwd(),
      bindings: empty,
      runId: "run-abc",
    });
    expect(outcome.value).toBe("run-abc");
  },
  RUN_TIMEOUT_MS,
);

test(
  "F4 — bindings run in the run's cwd, not the host process cwd",
  async () => {
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
  },
  RUN_TIMEOUT_MS,
);

test(
  "a run that outlives its deadline fails with timeout",
  async () => {
    const timeoutMs = 150;
    const started = Date.now();
    const outcome = await run("await new Promise(() => {});", {
      timeoutMs,
      config: { graceMs: timeoutMs },
    });
    expect(outcome.error?.kind).toBe("timeout");
    expect(String(outcome.error?.message)).toMatch(new RegExp(String(timeoutMs)));
    expect(Date.now() - started).toBeLessThan(RUN_TIMEOUT_MS);
  },
  RUN_TIMEOUT_MS,
);

test(
  "aborting the caller's signal cancels the run and aborts in-flight bindings",
  async () => {
    let bindingSawAbort = false;
    let markBindingStarted: () => void = () => {};
    const bindingStarted = new Promise<void>((resolve) => {
      markBindingStarted = resolve;
    });
    const bindings: BindingTable = makeBindings({
      slow: async (_args, context) => {
        markBindingStarted();
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
    const runPromise = run("await tools.slow({}); return 1;", {
      bindings,
      signal: controller.signal,
      config: { graceMs: 5_000 },
    });
    // Deterministic, not timing-based: wait until the binding is actually executing, then
    // abort. The old `setTimeout(…, 100)` raced worker spawn under file-level parallelism.
    // The grace window is what lets the in-flight binding observe the abort before the run
    // terminates.
    await bindingStarted;
    controller.abort();
    const outcome = await runPromise;
    expect(outcome.error?.kind).toBe("abort");
    expect(bindingSawAbort, "the binding received the run's abort signal").toBe(true);
  },
  RUN_TIMEOUT_MS,
);

test(
  "a call still queued for a dispatch slot when the run settles is dropped, not executed",
  async () => {
    // The `settled` guard in `dispatchCall` is only reachable through slot contention: a call
    // whose frame arrived before the cancel but whose `acquireDispatchSlot()` was still waiting.
    // Executing the binding there would start host-side work after the caller was already told
    // the run is over — for `pi.dispatch` that means spawning a pi subprocess only to SIGTERM it
    // (`dispatch.ts` spawns, then checks `signal.aborted`) — and the result could not be
    // delivered anyway, because the run's port is closed.
    const holdStarted = deferred<void>();
    const releaseHold = deferred<void>();
    let probeCalled = false;
    const bindings = makeBindings({
      hold: async () => {
        holdStarted.resolve(undefined);
        // The test keeps the single dispatch slot occupied across the run's end.
        await releaseHold.promise;
        return null;
      },
      probe: async () => {
        probeCalled = true;
        return null;
      },
    });
    const controller = new AbortController();
    const runPromise = run("await Promise.all([tools.hold({}), tools.probe({})]); return 1;", {
      bindings,
      signal: controller.signal,
      config: { maxParallelSubCalls: 1, graceMs: 5_000 },
    });
    await holdStarted.promise;
    // Drain the event loop before aborting: `probe`'s call frame is the very next message the
    // worker sent, so it is queued host-side (waiting for the slot) by the time the cancel lands.
    await new Promise((resolve) => setTimeout(resolve, 25));
    controller.abort();
    const outcome = await runPromise;
    expect(outcome.error?.kind).toBe("abort");
    // The slot frees only now, after the run has settled: the queued call resumes exactly in the
    // state this test is about.
    releaseHold.resolve(undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(probeCalled, "the queued call must not run after the run settled").toBe(false);
  },
  RUN_TIMEOUT_MS,
);

test(
  "a deadline that fires while the worker is stuck in BOOTING still settles the run",
  async () => {
    hungWorker.url = BOOTING_FOREVER_WORKER_URL;
    try {
      // The worker never sends `ready`, so the deadline is the only thing that can start the
      // cancel and the grace window is the only thing that can end it. Before the fix the
      // deadline timer was cleared by `beginCancel` and the grace timer was waiting for a
      // `ready` frame that never arrives: `finish()` was never called and the run's promise
      // stayed pending forever.
      const raced = await Promise.race([
        run("return 1;", { timeoutMs: 50, config: { graceMs: 200 } }),
        hungAfter(1_000),
      ]);
      expect(settleKindOf(raced)).toBe("timeout");
    } finally {
      hungWorker.url = undefined;
    }
  },
  RUN_TIMEOUT_MS,
);

test(
  "an abort that lands while the worker is stuck in BOOTING still settles the run",
  async () => {
    hungWorker.url = BOOTING_FOREVER_WORKER_URL;
    const controller = new AbortController();
    try {
      const runPromise = run("return 1;", {
        signal: controller.signal,
        config: { graceMs: 200 },
      });
      // The listener is registered before `run()` returns (the dispatcher's body is synchronous
      // up to the handshake), so this abort lands after the run started and before any `ready`
      // frame could arrive: the path that used to clear the deadline timer and arm nothing else.
      controller.abort();
      const raced = await Promise.race([runPromise, hungAfter(1_000)]);
      expect(settleKindOf(raced)).toBe("abort");
    } finally {
      hungWorker.url = undefined;
    }
  },
  RUN_TIMEOUT_MS,
);

test(
  "cancelling an already-aborted signal never spawns work",
  async () => {
    const outcome = await run("return 1;", { signal: AbortSignal.abort() });
    expect(outcome.error?.kind).toBe("abort");
    expect(outcome.logs).toEqual([]);
  },
  RUN_TIMEOUT_MS,
);

test(
  "the joint output budget covers logs and the completion value",
  async () => {
    const budget = Math.floor(DEFAULT_CONFIG.maxOutputBytes / 1024);
    const chunk = "x".repeat(Math.ceil(budget / 2));
    const outcome = await run(
      `console.log(${JSON.stringify(chunk)}); console.log(${JSON.stringify(chunk)}); console.log("third"); return 1;`,
      { config: { maxOutputBytes: budget } },
    );
    expect(outcome.error?.kind).toBe("output-limit");
    expect(outcome.logs.length, "the fitting log prefix is retained").toBe(1);
    expect(outcome.value).toBeUndefined();
  },
  RUN_TIMEOUT_MS,
);

test(
  "an oversized single control frame is a protocol failure",
  async () => {
    const maxMessageBytes = Math.floor(DEFAULT_CONFIG.maxMessageBytes / 1024);
    const oversized = "y".repeat(maxMessageBytes * 2);
    const outcome = await run(`console.log("z".repeat(${oversized.length})); return 1;`, {
      config: { maxMessageBytes },
    });
    expect(outcome.error?.kind).toBe("protocol");
    expect(String(outcome.error?.message)).toMatch(/maxMessageBytes/);
  },
  RUN_TIMEOUT_MS,
);

test(
  "concurrent runs stay isolated from each other",
  async () => {
    const bindings = makeBindings({ echo: async (args) => args });
    const [first, second] = await Promise.all([
      run('console.log("first"); await tools.echo({ tag: "a" }); return "a";', { bindings }),
      run('console.log("second"); await tools.echo({ tag: "b" }); return "b";', { bindings }),
    ]);
    expect(first.value).toBe("a");
    expect(second.value).toBe("b");
    expect(first.logs).toEqual(["first"]);
    expect(second.logs).toEqual(["second"]);
  },
  RUN_TIMEOUT_MS,
);

test(
  "the workflow surface runs through the dispatcher end to end",
  async () => {
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
  },
  RUN_TIMEOUT_MS,
);

/* --------------------------------------------------------------------------------------------
 * Hoisted images (ADR-0014, ADR-0017 §8)
 *
 * DSH attaches the content of a successful image-bearing subtool result to the caller's context in
 * its scheduler's commit step (`dsh-tools`: `exec.deferContext(createUserMessage(...))`). pi-ptc
 * hoists at the same seam — the host, after the result is posted to the worker — and the tool layer
 * forwards the images as image blocks on the PTC tool result.
 *
 * Image bytes ride the run outcome as base64 (`PtcImage.data`) — the same representation pi's own
 * `read` returns, so the tool layer forwards them without re-encoding. A binding that emits raw
 * `bytes` instead is normalised host-side (covered by `tests/image-wire.test.ts`).
 * ------------------------------------------------------------------------------------------ */

const imageBindings = makeBindings({
  shot: async () => ({
    content: [
      { type: "text", text: "Read image file [image/png]" },
      { type: "image", data: ONE_PIXEL_PNG_BASE64, mimeType: "image/png" },
    ],
    details: null,
  }),
});

test(
  "a successful image-bearing result is hoisted onto the outcome",
  async () => {
    const outcome = await run("const r = await tools.shot({}); return r.content.length;", {
      bindings: imageBindings,
    });
    expect(outcome.error).toBeUndefined();
    // The program still sees the whole content: the hoist is additive, it does not strip the image.
    expect(outcome.value).toBe(2);
    expect(outcome.images).toHaveLength(1);
    const image = outcome.images?.[0];
    expect(image?.mimeType).toBe("image/png");
    // Character-for-character equality with what the binding emitted: no decode/encode round trip.
    expect(image?.data).toBe(ONE_PIXEL_PNG_BASE64);
  },
  RUN_TIMEOUT_MS,
);

test(
  "the same image twice is attached twice (no dedupe — the program's calls are the record)",
  async () => {
    const outcome = await run("await tools.shot({}); await tools.shot({}); return 1;", {
      bindings: imageBindings,
    });
    expect(outcome.images).toHaveLength(2);
    expect(outcome.images?.[0]?.data).toBe(ONE_PIXEL_PNG_BASE64);
    expect(outcome.images?.[1]?.data).toBe(ONE_PIXEL_PNG_BASE64);
  },
  RUN_TIMEOUT_MS,
);

test(
  "a failed binding call contributes no image",
  async () => {
    const bindings = makeBindings({
      shot: async () => {
        throw new Error("no screenshot for you");
      },
    });
    const outcome = await run('try { await tools.shot({}); } catch { return "caught"; }', {
      bindings,
    });
    expect(outcome.value).toBe("caught");
    expect(outcome.images).toBeUndefined();
  },
  RUN_TIMEOUT_MS,
);

test(
  "a failed run attaches no images (ADR-0014 §2)",
  async () => {
    const bindings = makeBindings({
      shot: async () => ({
        content: [
          { type: "text", text: "Read image file [image/png]" },
          { type: "image", data: ONE_PIXEL_PNG_BASE64, mimeType: "image/png" },
        ],
        details: null,
      }),
    });
    // The program hoists an image, then throws: the outcome must carry the error and no images.
    const outcome = await run('await tools.shot({}); throw new Error("boom");', { bindings });
    expect(outcome.error).toBeDefined();
    expect(outcome.images).toBeUndefined();
  },
  RUN_TIMEOUT_MS,
);

test(
  "no cap: every image the program's calls produced is attached, in order",
  async () => {
    let seen = 0;
    const bindings = makeBindings({
      shot: async () => {
        // A distinct base64 payload per call so the hoist can be compared by content.
        const payload = Buffer.from(`image number ${seen++}`).toString("base64");
        return {
          content: [{ type: "image", data: payload, mimeType: "image/png" }],
          details: null,
        };
      },
    });
    const count = 25;
    const program = `for (let i = 0; i < ${count}; i++) await tools.shot({}); return "done";`;
    const outcome = await run(program, { bindings });
    expect(outcome.images).toHaveLength(count);
    // Order is the call order, so the meta can be trusted as a record of what the program did.
    const first = Buffer.from(outcome.images?.[0]?.data ?? "", "base64").toString("utf8");
    const last = Buffer.from(outcome.images?.[count - 1]?.data ?? "", "base64").toString("utf8");
    expect(first).toBe("image number 0");
    expect(last).toBe(`image number ${count - 1}`);
  },
  RUN_TIMEOUT_MS,
);
