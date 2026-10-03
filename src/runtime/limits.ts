/**
 * PTC run limits and spawn-time hardening, in one frozen `DEFAULT_CONFIG`.
 *
 * The numbers are DSH's (`dsh-v0.2.0-rc.2`, `@deepseek-ai/dsh-ptc-runtime-node`,
 * `NodePtcRuntime.Config` defaults) carried over verbatim — see ADR-0003 (output budget),
 * ADR-0004 (pending calls) and ADR-0005 (execution boundary, F1–F4). Tests assert against
 * these constants rather than repeating the literals, so a future re-sync only has to change
 * this file.
 *
 * The baseline was `dsh-v0.1.6-alpha.2` until 2026-10-03. That tag was never the source of
 * these numbers — the research the values came from read a `0.2.0-rc.2` checkout, and the
 * values are byte-identical in both tags (verified field by field: 120000 / 600000 /
 * 67108864 / 134217728 / 128 / 3000, in `packages/ptc-runtime/ptc-runtime-node/src/index.ts`).
 * So the correction is to the version label only; no constant changed. The prior label was
 * wrong for a different reason worth keeping in mind: it was read off this comment rather
 * than off the research, and `docs/research/ptc-upstream-parity-audit-20260930.md` had
 * already recorded the mismatch (and that this file's self-description was the stale side).
 *
 * **These limits match a generation of the upstream that upstream has since deprecated.**
 * `dsh-v0.0.x` through `v0.1.6-alpha.2` ran a PTC program on `worker_threads` inside the host
 * process; DSH superseded that on 2026-09-11 and moved Node PTC into a separate process in
 * `v0.1.7-rc.1`, which also renamed the packages into the `ptc-runtime` family with no legacy
 * aliases. The numeric defaults did not change across that move — which is why they still match
 * — but the *shape* around them did, and this file configures the superseded shape (ADR-0005's
 * worker boundary, not a process boundary). So "the numbers are DSH's" is true of two versions
 * and describes an architecture upstream no longer recommends. Upstream's own README warns that
 * there will be compatibility-breaking changes; the parity audit's recommendations 1-3 (upgrade
 * pi, compare against its built-in `codemode`, and re-base this project's position) are the open
 * work, and none of them is a comment fix.
 *
 * Deliberately absent:
 * - `syncTimeoutMs` / `maxConcurrentAgents` / `maxTotalAgents` — workflow-engine caps
 *   for a cooperative VM and for `agent()`. We run the program directly in the worker
 *   realm (no VM) and ship no `agent()` (G1 #13 → B), so there is nothing to cap.
 * - `sandbox-unavailable` is not an error kind either: ADR-0007 ships no OS sandbox.
 */

/** The two worker surfaces. A worker is spawned with exactly one of them and keeps it. */
export type PtcSurface = "run_code" | "workflow";

export interface PtcConfig {
  /** Default elapsed deadline for a run, including nested binding waits (R1 §1). */
  timeoutMs: number;
  /** Ceiling the requested deadline is clamped to. */
  maxTimeoutMs: number;
  /** Joint budget for serialized logs + completion value (ADR-0003). */
  maxOutputBytes: number;
  /** Cap on a single control frame, either direction (R1 §1). */
  maxMessageBytes: number;
  /** Admission control for simultaneously in-flight worker→host binding calls (ADR-0004). */
  maxPendingCalls: number;
  /**
   * Concurrent builtin binding dispatches; DSH's `maxParallelSubCalls`
   * (ADR-0004 consequence), mirrored verbatim (10). The overflow
   * FIFO-queues for a slot instead of failing. This is the authoritative
   * cap for the builtin fan-out path — independent of
   * `dispatchConcurrency`, with its own counter: neither cap throttles
   * the other.
   */
  maxParallelSubCalls: number;
  /**
   * Hard cap on concurrently in-flight dispatch in ONE pi session, not
   * per run. Enforced inside `dispatch()` by a single
   * `DispatchSlotCounter`, so every front spends it: concurrent programs,
   * the `ptc_subagent` tool, and background children (which hold their
   * slot for the task's whole lifetime). The next call over the cap
   * resolves immediately with `{ status: "rejected", errorMessage:
   * "dispatch concurrency limit reached" }` — never queued, never
   * spawned, and never parked behind a long-running child.
   * Default 8, matches pi's `subagent` extension `MAX_PARALLEL_TASKS`.
   * ADR-0016 section 2 (as amended 2026-09-30), ADR-0022 section 9.
   *
   * Where the number is READ from is the counter's construction, not
   * this field alone: a pi session's counter is built by
   * `createBackgroundTaskRuntime({ concurrency })` with this value, and
   * the dispatcher hands the binding `options.dispatchDeps?.slots ??
   * dispatchSlots` — so a `runPtcProgram({ config })` override sizes only
   * the per-run counter, which a pi session never reaches.
   *
   * Independent of `maxParallelSubCalls`: builtin calls never consume a
   * dispatch slot and vice versa.
   */
  dispatchConcurrency: number;
  /** Maximum recursion depth for `pi.dispatch`. The child PTC run spawned by
   *  the (depth+1)-th dispatch is allowed only when childDepth <= maxDispatchDepth.
   *  Default 3. Aligns with dsh's `SubagentCapabilities.depthLimit` and codex's
   *  `agent_max_depth`. ADR-0016 Recursive dispatch section. */
  maxDispatchDepth: number;
  /** Items accepted by a single `parallel()` / `pipeline()` call (R1 §1, workflow-side; pinned
   *  here because it guards a helper call rather than an agent budget). */
  maxItemsPerCall: number;
  /** Cooperative-cancel grace before the worker is terminated outright. */
  graceMs: number;
  /** V8 old-generation cap handed to `new Worker({ resourceLimits })` (F2). */
  maxOldGenerationSizeMb: number;
  /** V8 young-generation cap handed to `new Worker({ resourceLimits })` (F2). */
  maxYoungGenerationSizeMb: number;
  /**
   * Per-turn worker pool capacity (ADR-0017 §3). Decoupled from
   * `dispatchConcurrency` because pool capacity is "resident workers" while
   * `dispatchConcurrency` is "in-flight calls" — two different ceilings.
   * Default 4.
   */
  poolSize: number;
  /**
   * How long `runPtcProgram({ pool })` will wait for an available worker before
   * failing the run with `kind: workerExit`. Decoupled from `timeoutMs` because
   * acquire-wait is bounded by the pool's responsiveness, not the run's overall
   * deadline. Default 30 000 ms.
   */
  poolAcquireTimeoutMs: number;
  /**
   * Ceiling on how long a pool's `drain()` waits for in-flight workers to release
   * themselves before terminating them outright: a worker whose `release()` never
   * arrives (a stuck dispatcher promise, an unobserved crash) must bound the turn-end
   * hook rather than hang it. Not `graceMs` above, which is a *run's* cooperative-cancel
   * window; this one is the *pool's* window at retirement, and drain resolves either way.
   * Default 5 000 ms.
   */
  drainGraceMs: number;
}

export const DEFAULT_CONFIG: Readonly<PtcConfig> = Object.freeze({
  timeoutMs: 120_000,
  maxTimeoutMs: 600_000,
  maxOutputBytes: 67_108_864,
  maxMessageBytes: 134_217_728,
  maxPendingCalls: 128,
  maxParallelSubCalls: 10,
  dispatchConcurrency: 8,
  maxDispatchDepth: 3,
  maxItemsPerCall: 4_096,
  graceMs: 3_000,
  maxOldGenerationSizeMb: 512,
  maxYoungGenerationSizeMb: 64,
  poolSize: 4,
  poolAcquireTimeoutMs: 30_000,
  drainGraceMs: 5_000,
});

/**
 * F1 — the only environment variables a PTC worker may inherit.
 *
 * These are what a shell needs to resolve binaries on each platform; everything
 * else the host has (tokens, API keys, proxies, home paths) stays out of the worker.
 */
export const WORKER_ENV_ALLOW_LIST: readonly string[] = Object.freeze([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "TEMP",
  "TMP",
]);

/**
 * Build the per-run environment snapshot: the allow-list entries that actually exist.
 *
 * Unset or empty entries are dropped rather than passed through as empty strings, so
 * `Object.keys(workerEnv)` is exactly what the worker sees in `process.env`.
 */
export function createWorkerEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of WORKER_ENV_ALLOW_LIST) {
    const value = source[name];
    if (typeof value === "string" && value.length > 0) env[name] = value;
  }
  return env;
}

/**
 * Merge per-run overrides onto `DEFAULT_CONFIG`.
 *
 * Overrides are validated rather than coerced: a negative or non-numeric limit is a
 * caller bug, and silently substituting a default would hide it.
 */
export function resolveConfig(overrides: Partial<PtcConfig> = {}): PtcConfig {
  const resolved: PtcConfig = { ...DEFAULT_CONFIG };
  for (const key of Object.keys(DEFAULT_CONFIG) as Array<keyof PtcConfig>) {
    const override = overrides[key];
    if (override === undefined) continue;
    if (typeof override !== "number" || !Number.isFinite(override) || override <= 0) {
      throw new TypeError(`invalid PTC config override for ${key}: ${String(override)}`);
    }
    resolved[key] = override;
  }
  return resolved;
}

/**
 * Resolve the effective deadline for one run.
 *
 * DSH semantics (R1 §3): `0` does not disable the deadline, it falls back to the
 * default; anything larger is clamped to `maxTimeoutMs`.
 */
export function effectiveTimeoutMs(
  requested: number | undefined,
  config: PtcConfig = DEFAULT_CONFIG,
): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0)
    return config.timeoutMs;
  return Math.min(requested, config.maxTimeoutMs);
}
