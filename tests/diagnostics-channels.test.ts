/**
 * Diagnostics-channel integration tests (ADR-0017 W-5, Addendum).
 *
 * The dispatcher and pool publish three channels:
 *
 *   - `ptc:pool:acquire-latency` — on every successful `pool.acquire()`
 *   - `ptc:worker:reset-time` — on a warm `ready` frame
 *   - `ptc:image:hoist-bytes` — when an image block is hoisted (payload = base64 bytes)
 *
 * Channels are zero-cost when unsubscribed (Node short-circuits `publish`); this
 * suite asserts both the positive (a subscriber receives the event with the
 * documented payload) and the zero-cost story (no subscriber, no error, no
 * retention).
 */
import diagnosticsChannel from "node:diagnostics_channel";
import { afterEach, describe, expect, test } from "vitest";
import { runPtcProgram } from "../src/runtime/dispatcher.ts";
import {
  makeBindings,
  ONE_PIXEL_PNG_BASE64,
  onePixelPngBytes,
  RUN_TIMEOUT_MS,
} from "./helpers/ptc.ts";
import { WorkerPool } from "../src/runtime/worker-pool.ts";
import { buildWorkerUrl } from "../src/runtime/worker-source.ts";
import { createWorkerEnv, DEFAULT_CONFIG } from "../src/runtime/limits.ts";

const channels = {
  acquireLatency: diagnosticsChannel.channel("ptc:pool:acquire-latency"),
  resetTime: diagnosticsChannel.channel("ptc:worker:reset-time"),
  imageBytes: diagnosticsChannel.channel("ptc:image:hoist-bytes"),
};

/** Subscribers added by each test, so `afterEach` can detach them. */
const activeSubscribers: Array<{
  channel: typeof channels.acquireLatency;
  listener: (message: unknown) => void;
}> = [];

/** Subscribe `listener` to `channel`, tracking it for teardown. */
function trackSubscribe(
  channel: typeof channels.acquireLatency,
  listener: (message: unknown) => void,
): void {
  channel.subscribe(listener);
  activeSubscribers.push({ channel, listener });
}

/** Drain all tracked subscribers after every test so one test cannot leak into another. */
function resetAll(): void {
  while (activeSubscribers.length > 0) {
    const entry = activeSubscribers.pop();
    if (entry) entry.channel.unsubscribe(entry.listener);
  }
}
afterEach(resetAll);

describe("ptc:pool:acquire-latency", () => {
  test(
    "an acquire that succeeds publishes once with the documented payload",
    async () => {
      const events: unknown[] = [];
      trackSubscribe(channels.acquireLatency, (message) => {
        events.push(message);
      });
      const pool = new WorkerPool({
        size: 1,
        buildWorkerUrl: () => buildWorkerUrl(),
        workerOptions: {
          name: "ptc-diag-acquire",
          env: createWorkerEnv(),
          workerData: { runId: "diag-acquire", env: createWorkerEnv() },
        },
      });
      try {
        const outcome = await runPtcProgram({
          code: "return 1;",
          surface: "run_code",
          cwd: process.cwd(),
          bindings: makeBindings({}),
          pool,
          config: { poolSize: 1 },
        });
        expect(outcome.error).toBeUndefined();
      } finally {
        await pool.drain();
      }
      expect(events.length).toBeGreaterThanOrEqual(1);
      const last = events[events.length - 1] as {
        poolSize: number;
        waiters: number;
        durationMs: number;
      };
      expect(typeof last.poolSize).toBe("number");
      expect(typeof last.waiters).toBe("number");
      expect(typeof last.durationMs).toBe("number");
      expect(last.durationMs).toBeGreaterThanOrEqual(0);
      expect(last.poolSize).toBe(1);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "a queued acquire reports its real queue wait, not 0",
    async () => {
      const events: unknown[] = [];
      trackSubscribe(channels.acquireLatency, (message) => {
        events.push(message);
      });
      const pool = new WorkerPool({
        size: 1,
        buildWorkerUrl: () => buildWorkerUrl(),
        workerOptions: {
          name: "ptc-diag-queued",
          env: createWorkerEnv(),
          workerData: { runId: "diag-queued", env: createWorkerEnv() },
        },
      });
      // Tracked so `finally` can hand every worker back: `drain()` waits for in-flight
      // workers, so a worker left checked out would turn an assertion failure into a
      // test timeout instead of a readable failure.
      let held: import("node:worker_threads").Worker | undefined;
      try {
        // Fill the only slot, then queue a second acquire behind it.
        const first = await pool.acquire();
        held = first;
        const queued = pool.acquire();
        const queueWaitMs = 30;
        await new Promise((resolve) => setTimeout(resolve, queueWaitMs));
        // Releasing hands the worker straight to the waiter. That hand-off is the
        // event whose `durationMs` is the whole point of the channel: the time the
        // caller spent queued.
        pool.release(first);
        const worker = await queued;
        held = worker;
        expect(events.length).toBeGreaterThanOrEqual(2);
        const handoff = events[events.length - 1] as {
          poolSize: number;
          waiters: number;
          durationMs: number;
        };
        expect(typeof handoff.durationMs).toBe("number");
        // The waiter queued for ~30 ms; the bound is generous (20 ms) so scheduler
        // jitter cannot make this flaky, while still failing the 0 a
        // `Date.now() - Date.now()` measurement reports.
        expect(handoff.durationMs).toBeGreaterThanOrEqual(20);
        expect(handoff.waiters).toBe(0);
      } finally {
        if (held !== undefined) pool.release(held);
        await pool.drain();
      }
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "no subscriber: the run still completes (zero-cost publish)",
    async () => {
      // No `subscribe` — confirms Node's short-circuit.
      const pool = new WorkerPool({
        buildWorkerUrl: () => buildWorkerUrl(),
        workerOptions: {
          name: "ptc-diag-no-sub",
          env: createWorkerEnv(),
          workerData: { runId: "diag-no-sub", env: createWorkerEnv() },
        },
      });
      try {
        const outcome = await runPtcProgram({
          code: "return 1;",
          surface: "run_code",
          cwd: process.cwd(),
          bindings: makeBindings({}),
          pool,
          config: { poolSize: 1 },
        });
        expect(outcome.error).toBeUndefined();
      } finally {
        await pool.drain();
      }
    },
    RUN_TIMEOUT_MS,
  );
});

describe("ptc:worker:reset-time", () => {
  test(
    "a warm `ready` frame publishes reset-time; cold start does not",
    async () => {
      const events: unknown[] = [];
      trackSubscribe(channels.resetTime, (message) => {
        events.push(message);
      });
      const pool = new WorkerPool({
        buildWorkerUrl: () => buildWorkerUrl(),
        workerOptions: {
          name: "ptc-diag-reset",
          env: createWorkerEnv(),
          workerData: { runId: "diag-reset", env: createWorkerEnv() },
        },
      });
      try {
        // First run: cold-start. `lastSettledAt` is undefined → no publish.
        await runPtcProgram({
          code: "return 1;",
          surface: "run_code",
          cwd: process.cwd(),
          bindings: makeBindings({}),
          pool,
          config: { poolSize: 1 },
        });
        expect(events.length).toBe(0);

        // Second run: warm reuse. The previous settle is recorded, so the warm
        // `ready` frame triggers a publish.
        await runPtcProgram({
          code: "return 2;",
          surface: "run_code",
          cwd: process.cwd(),
          bindings: makeBindings({}),
          pool,
          config: { poolSize: 1 },
        });
        expect(events.length).toBeGreaterThanOrEqual(1);
        const last = events[events.length - 1] as { durationMs: number };
        expect(typeof last.durationMs).toBe("number");
        expect(last.durationMs).toBeGreaterThanOrEqual(0);
      } finally {
        await pool.drain();
      }
    },
    RUN_TIMEOUT_MS,
  );
});

describe("ptc:image:hoist-bytes", () => {
  test(
    "an image-bearing binding result publishes once with { byteLength }",
    async () => {
      const events: unknown[] = [];
      trackSubscribe(channels.imageBytes, (message) => {
        events.push(message);
      });
      const bytes = onePixelPngBytes();
      const bindings = makeBindings({
        shot: async () => ({
          content: [{ type: "image", bytes, mimeType: "image/png" }],
          details: null,
        }),
      });
      const outcome = await runPtcProgram({
        code: "await tools.shot({}); return 1;",
        surface: "run_code",
        cwd: process.cwd(),
        bindings,
      });
      expect(outcome.error).toBeUndefined();
      expect(events.length).toBe(1);
      const last = events[events.length - 1] as { byteLength: number };
      expect(typeof last.byteLength).toBe("number");
      // The published size is the hoisted image's payload as it travels on the outcome:
      // base64. A `bytes: ArrayBuffer` binding is normalised host-side, so the raw byte
      // count is *not* what the channel reports.
      expect(last.byteLength).toBe(Buffer.byteLength(ONE_PIXEL_PNG_BASE64, "base64"));
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "a run with no image-binding calls publishes nothing",
    async () => {
      const events: unknown[] = [];
      trackSubscribe(channels.imageBytes, (message) => {
        events.push(message);
      });
      const outcome = await runPtcProgram({
        code: "return 1;",
        surface: "run_code",
        cwd: process.cwd(),
        bindings: makeBindings({}),
      });
      expect(outcome.error).toBeUndefined();
      expect(events.length).toBe(0);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "no subscriber: image hoist still completes (zero-cost publish)",
    async () => {
      const bytes = onePixelPngBytes();
      const bindings = makeBindings({
        shot: async () => ({
          content: [{ type: "image", bytes, mimeType: "image/png" }],
          details: null,
        }),
      });
      const outcome = await runPtcProgram({
        code: "await tools.shot({}); return 1;",
        surface: "run_code",
        cwd: process.cwd(),
        bindings,
      });
      expect(outcome.error).toBeUndefined();
      // The image is hoisted regardless of whether anyone is listening on the channel.
      expect(outcome.images).toHaveLength(1);
    },
    RUN_TIMEOUT_MS,
  );
});

describe("channel independence", () => {
  test(
    "subscribing to one channel does not affect the others",
    async () => {
      let acquire = 0;
      let reset = 0;
      let image = 0;
      trackSubscribe(channels.acquireLatency, () => {
        acquire += 1;
      });
      trackSubscribe(channels.resetTime, () => {
        reset += 1;
      });
      trackSubscribe(channels.imageBytes, () => {
        image += 1;
      });
      const pool = new WorkerPool({
        buildWorkerUrl: () => buildWorkerUrl(),
        workerOptions: {
          name: "ptc-diag-indep",
          env: createWorkerEnv(),
          workerData: { runId: "indep", env: createWorkerEnv() },
        },
      });
      try {
        const bindings = makeBindings({
          shot: async () => ({
            content: [{ type: "image", bytes: onePixelPngBytes(), mimeType: "image/png" }],
            details: null,
          }),
        });
        // Run twice so the second `ready` triggers reset-time.
        await runPtcProgram({
          code: "await tools.shot({}); return 1;",
          surface: "run_code",
          cwd: process.cwd(),
          bindings,
          pool,
          config: { poolSize: 1 },
        });
        await runPtcProgram({
          code: "await tools.shot({}); return 1;",
          surface: "run_code",
          cwd: process.cwd(),
          bindings,
          pool,
          config: { poolSize: 1 },
        });
        expect(acquire).toBeGreaterThanOrEqual(2);
        expect(image).toBe(2); // one per run
        expect(reset).toBeGreaterThanOrEqual(1); // only the warm ready triggers
      } finally {
        await pool.drain();
      }
    },
    RUN_TIMEOUT_MS,
  );
});

// Touch the import so the typecheck pass does not flag unused identifiers.
void DEFAULT_CONFIG;
