/**
 * Per-turn pool wiring (ADR-0017 §1–§2).
 *
 * The pool machinery is tested in `worker-pool.test.ts`; this file pins the *wiring*: that a
 * `TurnPools` holder really keeps one warm worker alive across the runs of a turn, that the two
 * surfaces never share a pool, and that the extension retires the turn's pools at `turn_end`.
 *
 * The warm-reuse evidence is the worker's own `threadId`: two runs served by the same warm worker
 * report the same id, while two cold (unpooled) runs cannot. That is a fact about the runtime, not
 * an assertion about our own bookkeeping.
 */
import { afterEach, describe, expect, test } from "vitest";
import diagnosticsChannel from "node:diagnostics_channel";
import ptcSubagents from "../src/index.ts";
import { runPtcProgram } from "../src/runtime/dispatcher.ts";
import { TurnPools } from "../src/runtime/turn-pools.ts";
import {
  makeBindings,
  makeExtensionStub,
  makeTempDir,
  removeTempDir,
  stubContext,
  RUN_TIMEOUT_MS,
} from "./helpers/ptc.ts";
import type { ExtensionStub } from "./helpers/ptc.ts";

/** Reads the executing worker's thread id — the identity of the Worker instance. */
const THREAD_ID_PROGRAM =
  'const { threadId } = await import("node:worker_threads"); return threadId;';

const tempDirs: string[] = [];

async function tempCwd(): Promise<string> {
  const cwd = await makeTempDir();
  tempDirs.push(cwd);
  return cwd;
}

afterEach(async () => {
  for (const cwd of tempDirs.splice(0)) await removeTempDir(cwd);
});

describe("TurnPools", () => {
  test("get() is lazy and idempotent per surface", () => {
    const pools = new TurnPools();
    const first = pools.get("run_code");
    expect(pools.get("run_code")).toBe(first);
  });

  test("the two surfaces never share a pool", () => {
    const pools = new TurnPools();
    expect(pools.get("run_code")).not.toBe(pools.get("workflow"));
  });

  test(
    "the configured drainGraceMs reaches the pool (the turn-end drain is configurable too)",
    async () => {
      // `poolSize` and `poolAcquireTimeoutMs` are settable through `TurnPools({ config })`, so
      // the drain grace has to be as well: `TurnPools` is the only config path the extension
      // has, and a turn-end drain hard-wired to the default would be unconfigurable in
      // production. The observable is the drain's own bound — an un-released worker is waited
      // for exactly `drainGraceMs`, then retired.
      const pools = new TurnPools({ config: { drainGraceMs: 250 } });
      const pool = pools.get("run_code");
      const worker = await pool.acquire();
      expect(pool.stats().inFlight).toBe(1);

      const startedAt = Date.now();
      await pool.drain();
      const elapsed = Date.now() - startedAt;

      // Bounded by the configured 250 ms rather than by the 5 000 ms default.
      expect(elapsed).toBeLessThan(1_000);
      // ...and the wait was actually honoured, not skipped.
      expect(elapsed).toBeGreaterThanOrEqual(200);
      expect(worker.threadId).toBe(-1);
      expect(pool.stats().resident).toBe(0);
    },
    RUN_TIMEOUT_MS,
  );

  test("drain() is idempotent and retires the holder's pools", async () => {
    const pools = new TurnPools();
    pools.get("run_code");
    await pools.drain();
    await pools.drain();
    // A drained holder hands out a fresh pool rather than a dead one.
    expect(pools.get("run_code")).not.toBe(undefined);
  });

  test(
    "two runs in one turn share a warm worker (same threadId)",
    async () => {
      const pools = new TurnPools();
      const cwd = await tempCwd();
      const bindings = makeBindings({});
      const pool = pools.get("run_code");

      const first = await runPtcProgram({
        code: THREAD_ID_PROGRAM,
        surface: "run_code",
        cwd,
        bindings,
        pool,
      });
      const second = await runPtcProgram({
        code: THREAD_ID_PROGRAM,
        surface: "run_code",
        cwd,
        bindings,
        pool,
      });

      expect(first.error).toBeUndefined();
      expect(second.error).toBeUndefined();
      expect(first.value).toBe(second.value);

      await pools.drain();
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "without a pool each run gets its own worker (different threadId)",
    async () => {
      const cwd = await tempCwd();
      const bindings = makeBindings({});
      const options = { code: THREAD_ID_PROGRAM, surface: "run_code" as const, cwd, bindings };

      const first = await runPtcProgram(options);
      const second = await runPtcProgram(options);

      expect(first.error).toBeUndefined();
      expect(second.error).toBeUndefined();
      expect(first.value).not.toBe(second.value);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "a fresh holder after drain gets a fresh worker (the turn boundary is real)",
    async () => {
      const cwd = await tempCwd();
      const bindings = makeBindings({});
      const options = { code: THREAD_ID_PROGRAM, surface: "run_code" as const, cwd, bindings };

      const firstTurn = new TurnPools();
      const first = await runPtcProgram({ ...options, pool: firstTurn.get("run_code") });
      await firstTurn.drain();

      const secondTurn = new TurnPools();
      const second = await runPtcProgram({ ...options, pool: secondTurn.get("run_code") });
      await secondTurn.drain();

      expect(first.value).not.toBe(second.value);
    },
    RUN_TIMEOUT_MS,
  );
  test(
    "a parked (warm) worker does not keep the process alive",
    async () => {
      // The pool `unref()`s an idle worker (ADR-0017 §6). Deliberately NOT draining here: if
      // the idle worker were ref'd, this file's process could not exit and the suite would
      // hang until the runner's timeout. Passing IS the assertion — the worker is parked,
      // healthy (it answered a run), and not pinning the event loop.
      const pools = new TurnPools();
      const cwd = await tempCwd();
      const outcome = await runPtcProgram({
        code: "return 1;",
        surface: "run_code",
        cwd,
        bindings: makeBindings({}),
        pool: pools.get("run_code"),
      });
      expect(outcome.error).toBeUndefined();
      expect(pools.get("run_code").stats().resident).toBe(1);
    },
    RUN_TIMEOUT_MS,
  );
});

describe("extension wiring", () => {
  /** Subscribe to a channel for the duration of one test; always unsubscribes. */
  function subscribe<T>(name: string, listener: (message: T) => void): () => void {
    const channel = diagnosticsChannel.channel(name);
    channel.subscribe(listener as (message: unknown) => void);
    return () => channel.unsubscribe(listener as (message: unknown) => void);
  }

  test(
    "ptc_run_code uses the turn's pool, and turn_end retires it",
    async () => {
      const stub: ExtensionStub = makeExtensionStub();
      ptcSubagents(stub.api);
      const tool = stub.tools.get("ptc_run_code");
      if (tool === undefined) throw new Error("ptc_run_code was not registered");
      const ctx = stubContext(stub);
      const cwd = await tempCwd();

      // `ptc:worker:reset-time` is published only when a *warm* worker sends `ready` — i.e. when
      // a run reused the pool's worker instead of spawning one. Counting it across two runs tells
      // us whether the pool was actually threaded through the tool.
      let warmReuses = 0;
      const unsubscribe = subscribe<{ durationMs: number }>("ptc:worker:reset-time", () => {
        warmReuses += 1;
      });

      try {
        const call = () =>
          tool.execute(
            "call-1",
            { code: "return 1;", description: "smoke" },
            undefined,
            undefined,
            { ...ctx, cwd } as never,
          );
        await call();
        await call();
        // The second run reused the first run's worker, so the pool was in play.
        expect(warmReuses).toBeGreaterThan(0);

        // A turn boundary retires the pools: the hook must exist and complete.
        await stub.emit("turn_end", ctx);
      } finally {
        unsubscribe();
      }
    },
    RUN_TIMEOUT_MS,
  );
});
