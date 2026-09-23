/**
 * WorkerPool behaviour tests (ADR-0017 §1–§7).
 *
 * The pool is the central infrastructure change in ADR-0017, so it gets a dedicated
 * suite. Cases follow the brief's "6 个必需测试场景":
 *
 *  - warm reuse (the second `runPtcProgram({ pool })` is a warm worker)
 *  - capacity overflow (poolSize=N with N+K concurrent runs queues the last K)
 *  - acquire timeout (poolAcquireTimeoutMs bounds the wait)
 *  - worker mid-run crash (the pool does not poison subsequent acquires)
 *  - drain (no further spawns after drain)
 *  - reset isolation (a worker that has been settled does not leak per-run state)
 *
 * The "reset isolation" case is covered by warm reuse: the second run of that test runs
 * on the first run's worker and must observe no leftover state. The clearing it observes
 * is the next run's own `startRun` (ADR-0017 §10(d)); the `ready` frame is only the
 * handshake that tells the host the worker will take the next `init` (see
 * `publishResetTime` in `worker-pool.ts`).
 *
 * Each case uses a counting `buildWorkerUrl` so the test asserts on the spawn count
 * directly rather than relying on wall-clock or worker-thread identity alone.
 */
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { runPtcProgram } from "../src/runtime/dispatcher.ts";
import type { RunPtcProgramOptions } from "../src/runtime/dispatcher.ts";
import { createWorkerEnv, DEFAULT_CONFIG } from "../src/runtime/limits.ts";
import { buildWorkerUrl } from "../src/runtime/worker-source.ts";
import { WorkerPool, workerSpawnOptions } from "../src/runtime/worker-pool.ts";
import type { WorkerPoolOptions } from "../src/runtime/worker-pool.ts";
import { deferred, makeBindings, RUN_TIMEOUT_MS } from "./helpers/ptc.ts";

/**
 * A `buildWorkerUrl` that records every URL it produces. The URL itself is the real
 * `dist/worker.js` (or `src/runtime/worker-entry.ts` under vitest), so the worker
 * actually runs; what we capture is how many times the pool decided to grow the
 * resident count.
 */
function makeCountingBuildWorkerUrl(): { url: () => URL; spawnCount: () => number } {
  let count = 0;
  return {
    url: () => {
      count += 1;
      return buildWorkerUrl();
    },
    spawnCount: () => count,
  };
}

function poolOptions(
  overrides: Partial<WorkerPoolOptions> = {},
): WorkerPoolOptions & { spawnCount: () => number } {
  const counter = makeCountingBuildWorkerUrl();
  // `buildWorkerUrl` always uses the counter, even when the override doesn't touch
  // it — otherwise tests would race on which URL the pool uses.
  return {
    ...overrides,
    buildWorkerUrl: counter.url,
    workerOptions: {
      name: "ptc-pool-test",
      env: createWorkerEnv(),
      workerData: { runId: "pool-test", env: createWorkerEnv() },
      resourceLimits: {
        maxOldGenerationSizeMb: DEFAULT_CONFIG.maxOldGenerationSizeMb,
        maxYoungGenerationSizeMb: DEFAULT_CONFIG.maxYoungGenerationSizeMb,
      },
    },
    spawnCount: counter.spawnCount,
  };
}

const empty = makeBindings({});
const baseOptions: Omit<RunPtcProgramOptions, "code" | "surface" | "cwd" | "bindings"> = {
  // `pool` is supplied per-test.
};

test(
  "warm reuse: the second run reuses the same worker (no new spawn)",
  async () => {
    const counter = makeCountingBuildWorkerUrl();
    const pool = new WorkerPool({
      buildWorkerUrl: counter.url,
      workerOptions: {
        name: "ptc-pool-warm",
        env: createWorkerEnv(),
        workerData: { runId: "warm", env: createWorkerEnv() },
      },
    });
    try {
      const first = await runPtcProgram({
        ...baseOptions,
        code: "return 1;",
        surface: "run_code",
        cwd: process.cwd(),
        bindings: empty,
        pool,
      });
      expect(first.error).toBeUndefined();
      const afterFirst = pool.stats().resident;
      const spawnsAfterFirst = counter.spawnCount();

      const second = await runPtcProgram({
        ...baseOptions,
        code: "return 2;",
        surface: "run_code",
        cwd: process.cwd(),
        bindings: empty,
        pool,
      });
      expect(second.error).toBeUndefined();
      // A second spawn would indicate the pool failed to retain the worker; a higher
      // resident count is also a fail signal.
      expect(counter.spawnCount()).toBe(spawnsAfterFirst);
      expect(pool.stats().resident).toBe(afterFirst);
    } finally {
      await pool.drain();
    }
  },
  RUN_TIMEOUT_MS,
);

test(
  "capacity overflow: poolSize=2 with 4 concurrent runs queues the last 2",
  async () => {
    const counter = makeCountingBuildWorkerUrl();
    const pool = new WorkerPool({
      size: 2,
      buildWorkerUrl: counter.url,
      workerOptions: {
        name: "ptc-pool-overflow",
        env: createWorkerEnv(),
        workerData: { runId: "overflow", env: createWorkerEnv() },
      },
    });
    try {
      const release = deferred<void>();
      const blocker = makeBindings({
        hold: async () => {
          await release.promise;
          return null;
        },
      });
      const promises = Array.from({ length: 4 }, (_, index) =>
        runPtcProgram({
          ...baseOptions,
          code: `await tools.hold({}); return ${index};`,
          surface: "run_code",
          cwd: process.cwd(),
          bindings: blocker,
          pool,
        }),
      );
      // Wait until the resident count reaches the cap.
      const deadline = Date.now() + 5_000;
      while (pool.stats().resident < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(pool.stats().resident).toBe(2);
      expect(pool.stats().waiters).toBe(2);
      // The remaining two runs are queued, not spawned: spawn count is exactly 2.
      expect(counter.spawnCount()).toBe(2);
      release.resolve(undefined);
      const outcomes = await Promise.all(promises);
      for (const outcome of outcomes) expect(outcome.error).toBeUndefined();
      // All four runs returned distinct values: every queued run actually executed.
      expect(new Set(outcomes.map((outcome) => outcome.value)).size).toBe(4);
      expect(pool.stats().totalAcquires).toBe(4);
      expect(pool.stats().poolExhaustions).toBe(2);
    } finally {
      await pool.drain();
    }
  },
  RUN_TIMEOUT_MS,
);

test(
  "acquire timeout: poolAcquireTimeoutMs bounds the wait; the run fails with workerExit",
  async () => {
    const counter = makeCountingBuildWorkerUrl();
    const pool = new WorkerPool({
      size: 1,
      acquireTimeoutMs: 100,
      buildWorkerUrl: counter.url,
      workerOptions: {
        name: "ptc-pool-timeout",
        env: createWorkerEnv(),
        workerData: { runId: "timeout", env: createWorkerEnv() },
      },
    });
    try {
      const release = deferred<void>();
      const blocker = makeBindings({
        hold: async () => {
          await release.promise;
          return null;
        },
      });
      // First run holds a worker for the duration of the test.
      const first = runPtcProgram({
        ...baseOptions,
        code: "await tools.hold({}); return 1;",
        surface: "run_code",
        cwd: process.cwd(),
        bindings: blocker,
        pool,
      });
      // Wait until the first run has actually acquired a worker.
      const deadline = Date.now() + 5_000;
      while (pool.stats().inFlight === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(pool.stats().inFlight).toBe(1);

      // Second run will time out.
      const startedAt = Date.now();
      const second = await runPtcProgram({
        ...baseOptions,
        code: "return 1;",
        surface: "run_code",
        cwd: process.cwd(),
        bindings: empty,
        pool,
      });
      const elapsed = Date.now() - startedAt;
      expect(second.error?.kind).toBe("worker-exit");
      expect(String(second.error?.message)).toMatch(/pool/);
      // The wait was bounded — the timeout is 100 ms, but the assertion is generous
      // (1 s) to absorb scheduler jitter on CI hosts.
      expect(elapsed).toBeLessThan(1_000);

      release.resolve(undefined);
      await first;
    } finally {
      await pool.drain();
    }
  },
  RUN_TIMEOUT_MS,
);

test(
  "worker mid-run crash: the pool does not poison subsequent acquires",
  async () => {
    const counter = makeCountingBuildWorkerUrl();
    const pool = new WorkerPool({
      size: 1,
      buildWorkerUrl: counter.url,
      workerOptions: {
        name: "ptc-pool-crash",
        env: createWorkerEnv(),
        workerData: { runId: "crash", env: createWorkerEnv() },
      },
    });
    try {
      const first = await runPtcProgram({
        ...baseOptions,
        code: "process.exit(7);",
        surface: "run_code",
        cwd: process.cwd(),
        bindings: empty,
        pool,
      });
      expect(first.error?.kind).toBe("worker-exit");

      // Pool's resident count drops after the crash because the `'exit'` listener
      // removes the worker. The next acquire must succeed — fresh spawn, not a
      // recycled crashed worker.
      const afterFirst = counter.spawnCount();
      const second = await runPtcProgram({
        ...baseOptions,
        code: "return 1;",
        surface: "run_code",
        cwd: process.cwd(),
        bindings: empty,
        pool,
      });
      expect(second.error).toBeUndefined();
      expect(counter.spawnCount()).toBeGreaterThan(afterFirst);
    } finally {
      await pool.drain();
    }
  },
  RUN_TIMEOUT_MS,
);

test(
  "drain: no further spawns after drain completes",
  async () => {
    const counter = makeCountingBuildWorkerUrl();
    const pool = new WorkerPool({
      size: 1,
      buildWorkerUrl: counter.url,
      workerOptions: {
        name: "ptc-pool-drain",
        env: createWorkerEnv(),
        workerData: { runId: "drain", env: createWorkerEnv() },
      },
    });
    await runPtcProgram({
      ...baseOptions,
      code: "return 1;",
      surface: "run_code",
      cwd: process.cwd(),
      bindings: empty,
      pool,
    });
    expect(pool.stats().resident).toBe(1);
    await pool.drain();
    expect(pool.stats().resident).toBe(0);
    const spawnCountAtDrain = counter.spawnCount();
    // `runPtcProgram` after `drain`: `pool.acquire` immediately rejects, the
    // dispatcher surfaces that as a `workerExit` outcome (it never throws for
    // harness-side failures). The pool's `buildWorkerUrl` is never invoked again,
    // so the spawn count stays put.
    const outcome = await runPtcProgram({
      ...baseOptions,
      code: "return 1;",
      surface: "run_code",
      cwd: process.cwd(),
      bindings: empty,
      pool,
    });
    expect(outcome.error?.kind).toBe("worker-exit");
    expect(counter.spawnCount()).toBe(spawnCountAtDrain);
  },
  RUN_TIMEOUT_MS,
);

test(
  "drain: a worker that is never released does not hang drain; it is terminated at the grace bound",
  async () => {
    // The production path awaits `drain()` from the pi `turn_end` hook, so an
    // in-flight worker whose `release()` never arrives (dispatcher promise stuck,
    // worker crash mid-run) must not loop forever: the wait is bounded by
    // `drainGraceMs`, and whatever is still in flight is retired at the bound.
    const pool = new WorkerPool({
      size: 1,
      drainGraceMs: 250,
      buildWorkerUrl: () => buildWorkerUrl(),
      workerOptions: {
        name: "ptc-pool-drain-grace",
        env: createWorkerEnv(),
        workerData: { runId: "drain-grace", env: createWorkerEnv() },
      },
    });
    const worker = await pool.acquire();
    expect(pool.stats().inFlight).toBe(1);
    // Deliberately never release it.
    const startedAt = Date.now();
    await pool.drain();
    const elapsed = Date.now() - startedAt;
    // Bounded: the grace is 250 ms; the assertion is generous (5 s) to absorb
    // scheduler jitter while still failing an unbounded wait.
    expect(elapsed).toBeLessThan(5_000);
    // The grace was actually honoured — in-flight runs get their window to settle
    // before the pool stops waiting.
    expect(elapsed).toBeGreaterThanOrEqual(200);
    // The stuck worker was retired rather than leaked.
    expect(worker.threadId).toBe(-1);
    expect(pool.stats().resident).toBe(0);
  },
  RUN_TIMEOUT_MS,
);

test(
  "stats: totalAcquires counts logical acquires, not hand-offs",
  async () => {
    // Regression guard for the acquire path: discarding a retired idle worker must
    // not re-enter `acquire()` and inflate the counter `stats()` reports. Five
    // acquire/release round trips are five logical acquires.
    const pool = new WorkerPool({
      size: 1,
      buildWorkerUrl: () => buildWorkerUrl(),
      workerOptions: {
        name: "ptc-pool-acquire-count",
        env: createWorkerEnv(),
        workerData: { runId: "acquire-count", env: createWorkerEnv() },
      },
    });
    try {
      for (let index = 0; index < 5; index += 1) {
        const worker = await pool.acquire();
        pool.release(worker);
      }
      expect(pool.stats().totalAcquires).toBe(5);
    } finally {
      await pool.drain();
    }
  },
  RUN_TIMEOUT_MS,
);

test(
  "reset isolation: a settled worker hands back to the pool with cleared state",
  async () => {
    const counter = makeCountingBuildWorkerUrl();
    const pool = new WorkerPool({
      size: 1,
      buildWorkerUrl: counter.url,
      workerOptions: {
        name: "ptc-pool-reset",
        env: createWorkerEnv(),
        workerData: { runId: "reset", env: createWorkerEnv() },
      },
    });
    try {
      // The first run mutates a global in the worker (`globalThis`). If the pool
      // handed the same worker back without clearing it, the second run would
      // observe the mutation. Where the clearing comes from is the subtle part
      // (ADR-0017 §10): the isolation is §10(d)'s unconditional `startRun` clearing
      // at the next run's start, not the `ready` reset handshake — §5 / W-3 describe
      // only the handshake, which tells the host this worker will take the next `init`.
      const first = await runPtcProgram({
        ...baseOptions,
        code: "globalThis.__ptc_marker = 'first'; return 1;",
        surface: "run_code",
        cwd: process.cwd(),
        bindings: empty,
        pool,
      });
      expect(first.error).toBeUndefined();
      const spawnsAfterFirst = counter.spawnCount();

      const second = await runPtcProgram({
        ...baseOptions,
        code: "return globalThis.__ptc_marker === undefined ? 'clean' : 'leaked';",
        surface: "run_code",
        cwd: process.cwd(),
        bindings: empty,
        pool,
      });
      expect(second.error).toBeUndefined();
      expect(second.value).toBe("clean");
      expect(counter.spawnCount()).toBe(spawnsAfterFirst);
    } finally {
      await pool.drain();
    }
  },
  RUN_TIMEOUT_MS,
);

test(
  "release of an unknown worker is a no-op (defensive: caller bug, not a throw)",
  async () => {
    const pool = new WorkerPool({
      buildWorkerUrl: () => buildWorkerUrl(),
      workerOptions: {
        name: "ptc-pool-unknown",
        env: createWorkerEnv(),
        workerData: { runId: "unknown", env: createWorkerEnv() },
      },
    });
    // Hand-construct a Worker the pool never tracked: this is a pathological
    // scenario, but the contract is "do not throw".
    const here = dirname(fileURLToPath(import.meta.url));
    const entry = resolve(here, "..", "src", "runtime", "worker-entry.ts");
    const foreign = new Worker(entry, { name: "foreign" });
    expect(() => pool.release(foreign)).not.toThrow();
    await foreign.terminate();
    // The pool is still usable.
    const outcome = await runPtcProgram({
      ...baseOptions,
      code: "return 1;",
      surface: "run_code",
      cwd: process.cwd(),
      bindings: empty,
      pool,
    });
    expect(outcome.error).toBeUndefined();
    await pool.drain();
  },
  RUN_TIMEOUT_MS,
);

describe("workerSpawnOptions — the single definition of a spawn's options", () => {
  const env = { PATH: "/usr/bin", TEMP: "/tmp" };
  const limits = { maxOldGenerationSizeMb: 111, maxYoungGenerationSizeMb: 22 };

  // Regression protection, not red-green: this factory was extracted from two live call sites
  // (`dispatcher.ts`'s cold path and `turn-pools.ts`'s `get()`) that had drifted apart in
  // comments while agreeing in behaviour. The tests below pin the shape both call sites rely on,
  // so a future edit cannot quietly drop a field (or reintroduce a `runId` on the pooled path).
  test("cold path: name, env, workerData{runId, env} and V8 caps", () => {
    expect(workerSpawnOptions({ surface: "run_code", env, limits, runId: "run-1" })).toEqual({
      name: "ptc-run_code",
      env,
      workerData: { runId: "run-1", env },
      resourceLimits: { maxOldGenerationSizeMb: 111, maxYoungGenerationSizeMb: 22 },
    });
  });

  test("pooled path: workerData carries env and no runId", () => {
    const options = workerSpawnOptions({ surface: "workflow", env, limits });
    expect(options).toEqual({
      name: "ptc-workflow",
      env,
      workerData: { env },
      resourceLimits: { maxOldGenerationSizeMb: 111, maxYoungGenerationSizeMb: 22 },
    });
    // Spelled out beyond the shape match: a warm worker serves many runs, so any run id in its
    // spawn-time data would be stale from the second run on (each run's id travels in `init`).
    expect(Object.keys(options?.workerData ?? {})).toEqual(["env"]);
  });
});

describe("constructor argument validation", () => {
  test("rejects negative size", () => {
    expect(() => new WorkerPool(poolOptions({ size: -1 }))).toThrow(TypeError);
  });
  test("rejects zero size", () => {
    expect(() => new WorkerPool(poolOptions({ size: 0 }))).toThrow(TypeError);
  });
  test("rejects non-numeric size", () => {
    expect(() => new WorkerPool(poolOptions({ size: Number.NaN }))).toThrow(TypeError);
  });
  test("rejects negative acquireTimeoutMs", () => {
    expect(() => new WorkerPool(poolOptions({ acquireTimeoutMs: -1 }))).toThrow(TypeError);
  });
  test("rejects zero acquireTimeoutMs", () => {
    expect(() => new WorkerPool(poolOptions({ acquireTimeoutMs: 0 }))).toThrow(TypeError);
  });
  test("rejects negative drainGraceMs", () => {
    expect(() => new WorkerPool(poolOptions({ drainGraceMs: -1 }))).toThrow(TypeError);
  });
  test("rejects zero drainGraceMs", () => {
    expect(() => new WorkerPool(poolOptions({ drainGraceMs: 0 }))).toThrow(TypeError);
  });
});

test(
  "acquire returns idle workers and skips retired ones on the next acquire",
  async () => {
    // A direct path that exercises the `#idle` retire logic without going through
    // the dispatcher. A retired worker (its `'exit'` event fired while in `idle`)
    // must not be returned by `acquire`.
    const pool = new WorkerPool({
      size: 1,
      buildWorkerUrl: () => buildWorkerUrl(),
      workerOptions: {
        name: "ptc-pool-idle",
        env: createWorkerEnv(),
        workerData: { runId: "idle", env: createWorkerEnv() },
      },
    });
    try {
      const w1 = await pool.acquire();
      // Simulate an early exit (e.g., worker crashed before release).
      await w1.terminate();
      // Release sees the unhealthy worker and drops it without putting it in idle.
      pool.release(w1);
      // The next acquire must spawn a fresh worker.
      const w2 = await pool.acquire();
      expect(w2).not.toBe(w1);
      expect(w2.threadId).not.toBe(-1);
      pool.release(w2);
    } finally {
      await pool.drain();
    }
  },
  RUN_TIMEOUT_MS,
);

// Ensure `workerPoolStats` is referenced so the type stays in scope if a future
// test wants to read counters directly through the pool's stats() method.
void DEFAULT_CONFIG;
