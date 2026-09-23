/**
 * Per-turn worker pool: keeps `worker_threads` Workers warm across PTC runs so the
 * second `ptc_run_code` of a turn does not pay the V8 spin-up + module-graph load cost
 * the first one did (ADR-0017).
 *
 * The pool is created by the pi extension hook at turn entry, passed to
 * `runPtcProgram()` via `RunPtcProgramOptions.pool`, and drained at turn exit. Two
 * surfaces (`run_code`, `workflow`) do not share a pool: their worker programs are
 * different (`installWorkflowHelpers` in `worker-main.ts`), and one pool per surface
 * is the cleanest ownership story.
 *
 * Capacity model
 * ──────────────
 * "Resident workers" ≤ `size`, "in-flight calls" ≤ unbounded but queued when the pool
 * is full. An acquire when the pool is at capacity joins a FIFO wait list; a waiter is
 * served the instant an `acquire()` resolves with the released worker — the released
 * worker is handed directly to the next waiter rather than going through `idle`. This
 * matches the host's own `acquireDispatchSlot` semantics: the queue is the throughput
 * story, not the rejection story.
 *
 * Waiters time out after `acquireTimeoutMs`; on timeout the run fails with
 * `kind: workerExit` and a message naming the pool (ADR-0017 W-2 / §4).
 *
 * `drain()` — awaited by the pi extension hook at turn end — gives in-flight runs
 * `drainGraceMs` (default 5 000 ms) to release their worker. Whatever is still in flight
 * when the grace expires is terminated together with the idle workers: a worker whose
 * `release()` never arrives (a stuck dispatcher promise, a crash no one observed) must
 * bound the turn-end hook, not hang it. Drain therefore always resolves — expiry is not
 * an error, because a turn boundary should not fail over one bad worker.
 *
 * Health
 * ──────
 * A worker that has emitted `exit` is retired — it never re-enters `idle`. The pool
 * detects exit on the next `release()`: if `worker.threadId === -1` (Node marks a
 * terminated worker with a sentinel threadId) the worker is dropped rather than kept
 * idle. This keeps a worker that crashed between two runs from being handed out again.
 */
import { Worker } from "node:worker_threads";
import type { WorkerOptions } from "node:worker_threads";
import diagnosticsChannel from "node:diagnostics_channel";
import type { PtcConfig, PtcSurface } from "./limits.ts";

/** Options the dispatcher hands to `new Worker(...)`. */
export type WorkerPoolWorkerOptions = ConstructorParameters<typeof Worker>[1];

/**
 * Build the `Worker` options for one spawn (ADR-0005 F1–F3 hardening in one place).
 *
 * `runId` is optional and deliberately absent on the pooled path: a warm worker serves many runs,
 * so its spawn-time `workerData` cannot carry any single run's identity (each run's `runId`
 * travels in its `init` frame instead).
 */
export function workerSpawnOptions(options: {
  surface: PtcSurface;
  env: Record<string, string>;
  limits: Pick<PtcConfig, "maxOldGenerationSizeMb" | "maxYoungGenerationSizeMb">;
  runId?: string;
}): WorkerPoolWorkerOptions {
  return {
    name: `ptc-${options.surface}`,
    // F1: allow-list only — never the host's full environment (ADR-0005).
    env: options.env,
    // F3: the frozen snapshot the worker records. On the cold path that snapshot also names the
    // run; on the pooled path it cannot (see the doc comment above).
    workerData:
      options.runId === undefined
        ? { env: options.env }
        : { runId: options.runId, env: options.env },
    // F2: V8 caps (ADR-0005).
    resourceLimits: {
      maxOldGenerationSizeMb: options.limits.maxOldGenerationSizeMb,
      maxYoungGenerationSizeMb: options.limits.maxYoungGenerationSizeMb,
    },
  };
}

export interface WorkerPoolOptions {
  /**
   * Build a fresh worker URL for each spawn. The pool calls this only when it actually
   * needs to grow the resident count, so a heavy `buildWorkerUrl` is amortised across
   * warm reuses.
   */
  buildWorkerUrl: () => URL;
  /** Maximum resident workers; acquire when full queues the caller. Default 4. */
  size?: number;
  /** Acquire-wait bound; default 30 000 ms. */
  acquireTimeoutMs?: number;
  /**
   * Bound on how long `drain()` waits for in-flight workers to be released before it
   * terminates them anyway. Default 5 000 ms. Drain resolves either way — expiry is not
   * an error, it just means a worker was retired without a clean release.
   */
  drainGraceMs?: number;
  /** Options passed verbatim to `new Worker(url, options)` when spawning. */
  workerOptions: WorkerPoolWorkerOptions;
}

/**
 * Internal acquisition waiter. The `resolve` hands the worker directly to the caller's
 * `release` chain (no idle round-trip) when capacity opens up.
 */
interface PoolWaiter {
  resolve: (worker: Worker) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
  startedAt: number;
}

/**
 * Diagnostics channels the pool publishes to (ADR-0017 W-5, Addendum). Channels have
 * zero subscribers by default — `diagnostics_channel.channel(...)` always returns the
 * same instance, but `publish` short-circuits when no one is listening, so this is the
 * documented cheap path.
 */
const channels = {
  acquireLatency: diagnosticsChannel.channel("ptc:pool:acquire-latency"),
  resetTime: diagnosticsChannel.channel("ptc:worker:reset-time"),
  imageBytes: diagnosticsChannel.channel("ptc:image:hoist-bytes"),
} as const;

/** `node:diagnostics_channel` doesn't export its Channel type; this is the public surface we use. */
type DiagnosticsChannel = {
  publish: (message: unknown) => void;
};

function publish(channel: DiagnosticsChannel, message: unknown): void {
  // Node short-circuits `publish` when the channel has no subscribers, so this is a
  // no-op in production. Subscribers are e2e tests and future instrumentation.
  channel.publish(message);
}

export interface WorkerPoolStats {
  resident: number;
  inFlight: number;
  waiters: number;
  totalAcquires: number;
  poolExhaustions: number;
}

/**
 * A fixed-capacity FIFO-served worker pool. Not safe for concurrent `acquire()` calls
 * beyond Node's microtask interleaving guarantees — callers (`runPtcProgram`) await
 * `acquire` before scheduling anything that touches the pool, so the only concurrent
 * surface is `release()` against an in-flight worker.
 */
export class WorkerPool {
  readonly #buildWorkerUrl: () => URL;
  readonly #size: number;
  readonly #acquireTimeoutMs: number;
  readonly #drainGraceMs: number;
  readonly #workerOptions: WorkerPoolWorkerOptions;

  readonly #idle: Worker[] = [];
  readonly #inFlight: Set<Worker> = new Set();
  readonly #waiters: PoolWaiter[] = [];
  /**
   * When each worker was last released (i.e., the previous run settled). Used by the
   * dispatcher to publish `ptc:worker:reset-time` when a warm worker emits its first
   * `ready` frame — the time between settle and reset-complete is the worker's
   * per-run reset cost (ADR-0017 Addendum).
   */
  readonly #lastSettledAt = new WeakMap<Worker, number>();
  #totalAcquires = 0;
  #poolExhaustions = 0;
  /**
   * `true` once `drain()` has resolved. After this point every `acquire()` rejects
   * — the pool is single-use, the parent turn owns it for one cycle (ADR-0017 §1).
   */
  #drained = false;

  constructor(options: WorkerPoolOptions) {
    if (typeof options.buildWorkerUrl !== "function") {
      throw new TypeError("WorkerPool: buildWorkerUrl must be a function");
    }
    if (
      options.size !== undefined &&
      (typeof options.size !== "number" || !Number.isFinite(options.size) || options.size <= 0)
    ) {
      throw new TypeError(
        `WorkerPool: size must be a positive finite number, received ${String(options.size)}`,
      );
    }
    if (
      options.acquireTimeoutMs !== undefined &&
      (typeof options.acquireTimeoutMs !== "number" ||
        !Number.isFinite(options.acquireTimeoutMs) ||
        options.acquireTimeoutMs <= 0)
    ) {
      throw new TypeError(
        `WorkerPool: acquireTimeoutMs must be a positive finite number, received ${String(options.acquireTimeoutMs)}`,
      );
    }
    if (
      options.drainGraceMs !== undefined &&
      (typeof options.drainGraceMs !== "number" ||
        !Number.isFinite(options.drainGraceMs) ||
        options.drainGraceMs <= 0)
    ) {
      throw new TypeError(
        `WorkerPool: drainGraceMs must be a positive finite number, received ${String(options.drainGraceMs)}`,
      );
    }
    this.#buildWorkerUrl = options.buildWorkerUrl;
    this.#size = options.size ?? 4;
    this.#acquireTimeoutMs = options.acquireTimeoutMs ?? 30_000;
    this.#drainGraceMs = options.drainGraceMs ?? 5_000;
    this.#workerOptions = options.workerOptions;
  }

  /**
   * Acquire an idle worker, spawn a new one if below capacity, or queue until capacity
   * opens up. Throws `Error("pool acquire timed out after ${acquireTimeoutMs} ms")` on
   * timeout; the dispatcher wraps that message with a `pool acquire failed: ` prefix (ADR-0017 §4).
   */
  async acquire(): Promise<Worker> {
    if (this.#drained) {
      throw new Error("pool has been drained and can no longer serve workers");
    }
    // One logical acquire, one increment: retiring an idle worker below must not
    // re-enter this method (that would double-count, and `stats()` is the fact source
    // for tests and diagnostics).
    this.#totalAcquires += 1;
    const startedAt = Date.now();

    // Fast path: idle worker ready. Move it to in-flight and return. Skip (and drop) any
    // worker that has already exited — the `'exit'` listener normally removes it, but the
    // event is async, so a worker can exit between the listener and this shift.
    let idle = this.#idle.shift();
    while (idle !== undefined && !this.#isHealthy(idle)) {
      idle = this.#idle.shift();
    }
    if (idle !== undefined) {
      this.#inFlight.add(idle);
      // An idle worker is parked by `unref()` so a warm pool never keeps the host
      // process alive; taking it back into flight means the run depends on it, so
      // re-ref it before handing it over.
      idle.ref();
      publish(channels.acquireLatency, {
        poolSize: this.#size,
        waiters: this.#waiters.length,
        durationMs: Date.now() - startedAt,
      });
      return idle;
    }

    // Spawn path: capacity available.
    if (this.#inFlight.size < this.#size) {
      const worker = this.#spawn();
      this.#inFlight.add(worker);
      publish(channels.acquireLatency, {
        poolSize: this.#size,
        waiters: this.#waiters.length,
        durationMs: Date.now() - startedAt,
      });
      return worker;
    }

    // Wait path: queue a waiter with timeout.
    this.#poolExhaustions += 1;
    return await new Promise<Worker>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.#waiters.findIndex((entry) => entry.timer === timer);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new Error(`pool acquire timed out after ${this.#acquireTimeoutMs} ms`));
      }, this.#acquireTimeoutMs);
      this.#waiters.push({ resolve, reject, timer, startedAt });
    });
  }

  /**
   * Hand a worker back to the pool. If a waiter is queued, hand the worker directly to
   * them (no idle round-trip). Otherwise park the worker in `idle` — unless it has
   * already exited, in which case retire it.
   */
  release(worker: Worker): void {
    if (!this.#inFlight.delete(worker)) {
      // Not tracked as in-flight (release called twice, or never acquired from us).
      // Be lenient: don't throw, just ignore. The dispatcher only releases what it
      // acquired.
      return;
    }
    if (!this.#isHealthy(worker)) {
      // Crashed since acquire: drop it. The next acquire will spawn a fresh one
      // (capacity accounting already removed it from in-flight above).
      return;
    }
    this.#lastSettledAt.set(worker, Date.now());
    const waiter = this.#waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      this.#inFlight.add(worker);
      publish(channels.acquireLatency, {
        poolSize: this.#size,
        waiters: this.#waiters.length,
        // The waiter's queue wait, measured from when it entered `acquire()`. This is
        // the number the channel exists to report: how long a caller waited for capacity.
        durationMs: Date.now() - waiter.startedAt,
      });
      waiter.resolve(worker);
      return;
    }
    this.#idle.push(worker);
    // Park the idle worker so the host process can exit with a warm pool still standing
    // (a ref'd Worker keeps Node's event loop alive). The next `acquire()` re-refs it.
    worker.unref();
  }

  /**
   * Last time `release()` was called for `worker`. The dispatcher reads this to
   * publish `ptc:worker:reset-time` on a warm `ready` frame: `now - lastSettledAt`
   * is the worker's per-run reset cost (ADR-0017 Addendum). `undefined` for a worker
   * the pool never released (cold-start).
   */
  lastSettledAt(worker: Worker): number | undefined {
    return this.#lastSettledAt.get(worker);
  }

  /**
   * Wait for every in-flight worker to be released — bounded by `drainGraceMs` — then
   * terminate every resident worker and reject every queued waiter. After `drain()`
   * returns the pool is unusable.
   *
   * The bound matters: `drain()` is awaited from the pi `turn_end` hook, so a worker
   * whose `release()` never arrives (a stuck dispatcher promise, an unobserved crash)
   * must not hold the turn open. Workers still in flight when the grace expires are
   * terminated with the idle ones, and `drain()` resolves normally — a single bad worker
   * is not a reason to fail the turn boundary.
   */
  async drain(): Promise<void> {
    // Reject any queued waiter up front: the pool is going away.
    while (this.#waiters.length > 0) {
      const waiter = this.#waiters.shift();
      if (!waiter) break;
      clearTimeout(waiter.timer);
      waiter.reject(new Error("pool drained before acquire could be satisfied"));
    }
    // Wait for in-flight to settle — drain resolves only after every active run released.
    // Callers (the pi extension hook) hand the pool to `runPtcProgram` and await all
    // those promises before `drain`, so this is a defensive barrier for tests. The
    // deadline makes the barrier bounded; polling is deliberate (simple, and 5 ms is
    // nothing against a turn boundary).
    const deadline = Date.now() + this.#drainGraceMs;
    while (this.#inFlight.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // Terminate every resident worker: idle ones always, plus any in-flight worker that
    // outlived the grace. Clearing `#inFlight` first keeps `stats()` honest — a stuck
    // worker is no longer part of what the pool will serve.
    const terminating = [...this.#idle, ...this.#inFlight];
    this.#idle.length = 0;
    this.#inFlight.clear();
    await Promise.all(terminating.map((worker) => worker.terminate().catch(() => undefined)));
    this.#drained = true;
  }

  /** Read-only snapshot of the pool's counters; useful for tests and diagnostics. */
  stats(): WorkerPoolStats {
    return {
      resident: this.#inFlight.size + this.#idle.length,
      inFlight: this.#inFlight.size,
      waiters: this.#waiters.length,
      totalAcquires: this.#totalAcquires,
      poolExhaustions: this.#poolExhaustions,
    };
  }

  /**
   * Spawn one worker and wire its retirement listener. Private: the pool owns worker
   * lifecycle, so a caller outside `acquire()` has no business growing the pool (the
   * dispatcher spawns directly itself when no pool is configured).
   */
  #spawn(): Worker {
    const worker = new Worker(this.#buildWorkerUrl(), this.#workerOptions as WorkerOptions);
    // Once the worker exits, mark it retired by removing it from whichever pool list
    // currently holds it. Listeners are cheap; one per worker is fine.
    worker.once("exit", () => {
      const idleIndex = this.#idle.indexOf(worker);
      if (idleIndex >= 0) {
        this.#idle.splice(idleIndex, 1);
        return;
      }
      this.#inFlight.delete(worker);
    });
    return worker;
  }

  /**
   * A worker is healthy when it has not exited. Node marks a terminated worker with
   * `threadId === -1`; the `'exit'` event path also clears it from our lists, but the
   * `threadId` check is the cheap synchronous check for the common release path.
   *
   * Known window: `threadId` flips to `-1` **asynchronously**, so a worker whose
   * `terminate()` has been called but whose exit has not been processed yet still reads as
   * healthy (measured). That is unreachable in-tree today — `terminate()` is only called by
   * `drain()` (after which the pool refuses every `acquire`) and by the dispatcher's
   * unpooled path (whose worker never enters this pool) — so this is a note for whoever
   * adds a third caller, not a bug to chase.
   */
  #isHealthy(worker: Worker): boolean {
    return worker.threadId !== -1;
  }
}

/**
 * Publish a frame-transfer event when the dispatcher's callResult postMessage carries
 * image bytes. Called from the dispatcher, not the pool, but lives here so the channel
 * name and payload shape stay one-file-defined (ADR-0017 Addendum).
 */
export function publishImageBytes(byteLength: number): void {
  publish(channels.imageBytes, { byteLength });
}

/**
 * Publish the warm-worker's reset cost when its first `ready` frame arrives at the
 * host. `previousSettledAt` is the wall-clock time the pool last released this worker;
 * the gap is what the worker spent clearing per-run state and re-installing the surface.
 */
export function publishResetTime(durationMs: number): void {
  publish(channels.resetTime, { durationMs });
}
