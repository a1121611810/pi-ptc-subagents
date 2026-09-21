/**
 * PTC run limits and spawn-time hardening, in one frozen `DEFAULT_CONFIG`.
 *
 * The numbers are DSH's (`dsh-v0.1.6-alpha.2`, `@deepseek-ai/dsh-ptc-runtime-node`)
 * carried over verbatim — see ADR-0003 (output budget), ADR-0004 (pending calls) and
 * ADR-0005 (execution boundary, F1–F4). Tests assert against these constants rather
 * than repeating the literals, so a future re-sync only has to change this file.
 *
 * Deliberately absent:
 * - `syncTimeoutMs` / `maxConcurrentAgents` / `maxTotalAgents` — workflow-engine caps
 *   for a cooperative VM and for `agent()`. We run the program directly in the worker
 *   realm (no VM) and ship no `agent()` (G1 #13 → B), so there is nothing to cap.
 * - `sandbox-unavailable` is not an error kind either: ADR-0007 ships no OS sandbox.
 */

/** The two worker surfaces. Each run gets a fresh worker with exactly one of them. */
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
  /** Concurrent binding dispatches; DSH's `maxParallelSubCalls` (ADR-0004 consequence). */
  maxParallelSubCalls: number;
  /** Items accepted by a single `parallel()` / `pipeline()` call (R1 §1, workflow-side; pinned
   *  here because it guards a helper call rather than an agent budget). */
  maxItemsPerCall: number;
  /** Cooperative-cancel grace before the worker is terminated outright. */
  graceMs: number;
  /** V8 old-generation cap handed to `new Worker({ resourceLimits })` (F2). */
  maxOldGenerationSizeMb: number;
  /** V8 young-generation cap handed to `new Worker({ resourceLimits })` (F2). */
  maxYoungGenerationSizeMb: number;
}

export const DEFAULT_CONFIG: Readonly<PtcConfig> = Object.freeze({
  timeoutMs: 120_000,
  maxTimeoutMs: 600_000,
  maxOutputBytes: 67_108_864,
  maxMessageBytes: 134_217_728,
  maxPendingCalls: 128,
  maxParallelSubCalls: 10,
  maxItemsPerCall: 4_096,
  graceMs: 3_000,
  maxOldGenerationSizeMb: 512,
  maxYoungGenerationSizeMb: 64,
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
export function effectiveTimeoutMs(requested: number | undefined, config: PtcConfig = DEFAULT_CONFIG): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) return config.timeoutMs;
  return Math.min(requested, config.maxTimeoutMs);
}
