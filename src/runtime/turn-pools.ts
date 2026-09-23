/**
 * Per-turn pool holder: one `WorkerPool` per PTC surface, created lazily on first use
 * and retired together at turn end (ADR-0017 §1–§2).
 *
 * The pi extension owns one `TurnPools` per agent turn and hands each tool a getter for
 * its own surface's pool. Lazy creation is what makes the cold turn cheap: a turn that
 * never runs a PTC program never spawns a worker, and a turn that runs one `ptc_run_code`
 * pays exactly one cold spawn (which the pool then keeps warm for the rest of the turn).
 *
 * `run_code` and `workflow` do not share a pool (ADR-0017 §2): their worker surfaces differ
 * (`installWorkflowHelpers` is conditional in `worker-main.ts`), and one pool per surface
 * keeps that story simple. The workers themselves carry no surface state — each run's
 * `init` frame names its surface — so the split is about ownership, not correctness.
 */
import { createWorkerEnv, resolveConfig } from "./limits.ts";
import type { PtcConfig, PtcSurface } from "./limits.ts";
import { WorkerPool, workerSpawnOptions } from "./worker-pool.ts";
import { buildWorkerUrl } from "./worker-source.ts";

export interface TurnPoolsOptions {
  /** Per-turn limit overrides on top of `DEFAULT_CONFIG` (pool size, acquire bound, V8 caps). */
  config?: Partial<PtcConfig>;
}

export class TurnPools {
  readonly #config: PtcConfig;
  readonly #pools = new Map<PtcSurface, WorkerPool>();

  constructor(options: TurnPoolsOptions = {}) {
    this.#config = resolveConfig(options.config);
  }

  /**
   * The pool for one surface, created on first request. Warm workers from an earlier
   * run in this turn are served by the same pool (that is the point); a fresh
   * `TurnPools` is how a turn gets a fresh set.
   */
  get(surface: PtcSurface): WorkerPool {
    const existing = this.#pools.get(surface);
    if (existing !== undefined) return existing;

    const env = createWorkerEnv();
    const pool = new WorkerPool({
      buildWorkerUrl,
      size: this.#config.poolSize,
      acquireTimeoutMs: this.#config.poolAcquireTimeoutMs,
      // Pool retirement is part of the turn contract too: the `turn_end` drain waits for
      // in-flight runs only as long as this holder was configured to (ADR-0017 §1 retires the
      // holder's pools; `drainGraceMs` is the bound it drains within).
      drainGraceMs: this.#config.drainGraceMs,
      // Spawn-time options — `env`, `workerData` and the V8 caps — are built here, once, by the
      // shared factory (`workerSpawnOptions`), and a warm worker keeps them for the rest of the
      // turn: a live worker's heap ceiling is not a runtime setting.
      //
      // So a per-run `PtcConfig` override is **inert for these fields on the pooled
      // path**: `runPtcProgram({ config: { maxOldGenerationSizeMb: X } })` cannot reseat
      // the caps of a worker that already exists, and the caps in force are this holder's,
      // resolved from the `TurnPools` constructor. The cold path (no `pool`) still honours
      // a per-run config, because `dispatcher.ts` spawns that worker per run. A caller
      // wanting different caps, env or `workerData` needs a differently-constructed
      // `TurnPools` — or no pool — not a different per-run config. `workerData` carries no
      // `runId` for the same reason: a warm worker outlives any one run.
      workerOptions: workerSpawnOptions({
        surface,
        env,
        limits: this.#config,
      }),
    });
    this.#pools.set(surface, pool);
    return pool;
  }

  /**
   * Terminate every pool this holder created. Idempotent, and safe to call from a turn
   * boundary hook: a second call finds nothing to drain.
   */
  async drain(): Promise<void> {
    const pools = [...this.#pools.values()];
    this.#pools.clear();
    await Promise.all(pools.map((pool) => pool.drain()));
  }
}
