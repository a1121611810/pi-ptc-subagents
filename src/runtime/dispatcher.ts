/**
 * Host-side dispatcher: one `runPtcProgram()` call = one program in one worker.
 *
 * The worker's lifecycle depends on the path (ADR-0017 §1):
 * - **cold** (no `pool`): the dispatcher spawns a worker for the run and terminates it when the
 *   run settles — one run, one worker;
 * - **pooled** (`pool` set): the dispatcher acquires a warm worker from the turn's pool and
 *   releases it back when the run settles. The worker outlives the run — the turn's later runs
 *   reuse it, and the pool's `drain()` retires it at turn end, not this file.
 *
 * Responsibilities:
 * - spawn a hardened worker (F1 env scrub, F2 V8 caps, F3 frozen per-run env in
 *   `workerData`, F4 `cwd` carried in the run config and handed to the bindings) — the
 *   hardening itself is defined once, in `workerSpawnOptions` (`worker-pool.ts`),
 * - complete the `MessageChannel` handshake and send the `init` frame,
 * - route `tools.*` calls to the binding table — concurrently, with DSH's
 *   `maxPendingCalls` admission control, the `maxParallelSubCalls` builtin
 *   forwarding cap (ADR-0004 consequence: the overflow FIFO-queues for a
 *   slot), and the per-run `dispatchConcurrency` hard cap on in-flight
 *   `pi.dispatch` calls (ADR-0016 §2: the overflow resolves immediately as
 *   rejected, it is never queued). The two caps have independent counters:
 *   neither throttles the other.
 * - collect logs / narration / phases and enforce the joint output budget,
 * - enforce the deadline, honour caller cancellation, and settle the run: hand the worker
 *   back (pooled) or tear it down (cold).
 *
 * Everything the worker can influence is treated as untrusted input: every frame goes
 * through the protocol guards, is size-checked, and can only ever end the run.
 */
import { randomUUID } from "node:crypto";
import { MessageChannel, Worker } from "node:worker_threads";
import type { MessagePort } from "node:worker_threads";
import { BUILTIN_BINDING_NAMES, DISPATCH_BINDING_NAME, type BindingTable } from "./bindings.ts";
import { DispatchSlotCounter, type DispatchDeps } from "./dispatch.ts";
import { createWorkerEnv, effectiveTimeoutMs, resolveConfig } from "./limits.ts";
import type { PtcConfig, PtcSurface } from "./limits.ts";
import type { ULID } from "./task-storage.ts";
import {
  HOST_FRAME_KIND,
  isPtcHostFrame,
  isPtcWorkerFrame,
  PTC_ERROR_KIND,
  WORKER_FRAME_KIND,
} from "./protocol.ts";
import type {
  PtcCallFrame,
  PtcCallResultErrorFrame,
  PtcCallResultFrame,
  PtcCancelReason,
  PtcErrorKind,
  PtcErrorShape,
  PtcHostFrame,
  PtcJsonValue,
  SubCallRecord,
} from "./protocol.ts";
import type { SubCallTracker } from "./sub-call-tracker.ts";
import { createSubCallTracker } from "./sub-call-tracker.ts";
import {
  WorkerPool,
  publishImageBytes,
  publishResetTime,
  workerSpawnOptions,
} from "./worker-pool.ts";
import { buildWorkerUrl } from "./worker-source.ts";

export interface RunPtcProgramOptions {
  /** Program body: an async function body (`return`/`await` at the top level). */
  code: string;
  surface: PtcSurface;
  /** Working directory for bindings and the run's recorded cwd (F4). */
  cwd: string;
  /** Bindings the program may call; the table keys become `tools.<name>`. */
  bindings: BindingTable;
  /** Workflow surface only: value bound to the program's `args` global. */
  args?: unknown;
  /** Requested deadline; `0`/absent fall back to `timeoutMs`, then clamped to `maxTimeoutMs`. */
  timeoutMs?: number;
  /** Per-run limit overrides on top of `DEFAULT_CONFIG`. */
  config?: Partial<PtcConfig>;
  /** Cancels the run; the worker gets a cooperative cancel window before termination. */
  signal?: AbortSignal;
  /**
   * Depth of this run in the `pi.dispatch` recursion chain (ADR-0016 Recursive section):
   * 0 for the parent turn's run, 1+ for a run inside a child spawned by `pi.dispatch`.
   * Handed to the binding context so the dispatch binding can bound recursion. The
   * extension entrypoint derives it from `PI_PTC_DEPTH`; direct library use defaults
   * to 0.
   */
  depth?: number;
  /**
   * ADR-0022 §3/reopen R-m12: this process's own background task id, when the run is inside a
   * child spawned by `pi.dispatch({ background: true })`. The entrypoint reads it from
   * `PI_PTC_TASK_ID` and threads it to the binding context so a nested spawn records
   * `TaskRecord.parentTaskId`. Absent for a top-level session.
   */
  parentTaskId?: ULID;
  /** Identifier carried to the worker; generated when omitted. */
  runId?: string;
  /**
   * ADR-0022 R1: the session dir background children persist into, when the host has one.
   * Threaded to the binding context so `pi.dispatch({ background: true })` can stamp the R1
   * session flags; absent means the background spawn keeps the foreground no-session shape.
   */
  sessionDir?: string;
  /**
   * ADR-0022 §3/§9: session-level dispatch dependencies (TaskRegistry / OutputStorage /
   * lifecycle / clock / logger). The dispatcher merges its per-run `DispatchSlotCounter`
   * into this bag before handing it to the `pi.dispatch` binding, so background tasks count
   * against this run's `dispatchConcurrency` for their whole lifetime.
   */
  dispatchDeps?: DispatchDeps;
  /**
   * Optional worker pool (ADR-0017). Absent = spawn a fresh worker and terminate it
   * at run end (the original cold-start path). Present = the dispatcher acquires a
   * worker from the pool at run start and releases it back at run end. Acquire waits
   * are bounded by `config.poolAcquireTimeoutMs`; on timeout the run fails with
   * `kind: workerExit`.
   */
  pool?: WorkerPool;
  /**
   * Called every time a sub-call starts or ends, so the caller can push a live partial result
   * and have the tree visible while the run is in flight (ADR-0021 §4). Never called after the
   * run settles — `finish` owns the terminal snapshot. Absent means "no live updates wanted"
   * (direct library use, tests that only assert the terminal outcome).
   *
   * The argument is a **thunk**, not the snapshot itself: a wide `Promise.all` produces an
   * event per call, and `snapshot()` copies every record. Building it eagerly would make N
   * sequential calls cost O(N²) copies for pushes that the caller's throttle mostly drops.
   * Call it only when a push is actually due.
   */
  onSubCallChange?: (snapshot: () => readonly SubCallRecord[]) => void;
}

/**
 * One image hoisted out of a successful binding result (DSH parity — see ADR-0014,
 * ADR-0017 §8).
 *
 * `data` is base64 exactly as pi's own `read` tool returns it, so the tool layer can
 * forward it as an `ImageContent` block without re-encoding. The host↔worker wire carries
 * base64 too: the worker's channel is lossless JSON (a program may return part of a
 * binding result), and a `MessagePort` transferList of raw bytes could not survive that
 * contract — a transferred `ArrayBuffer` would be unusable as a program's return value.
 * Keeping one representation end to end means zero conversions between the binding and
 * pi's image adapter.
 */
export interface PtcImage {
  data: string;
  mimeType: string;
}

export interface PtcRunOutcome {
  /** `console.*` output in arrival order. */
  logs: string[];
  /** Workflow `log(message)` narration (observers only, never console output). */
  narrations: string[];
  /** Workflow `phase(title)` titles in arrival order. */
  phases: string[];
  /** Completion value; absent when the program returned nothing or the run failed. */
  value?: PtcJsonValue;
  /**
   * Images hoisted out of successful binding results, in call order.
   *
   * Every image a program's tool calls produced, with no cap and no dedupe: how many images a run
   * attaches is the program's business, exactly as it is in DSH. Each entry carries base64 `data`,
   * the representation pi's image adapter consumes, so the tool layer forwards it untouched.
   * Present only when at least one was hoisted — a failed or cancelled run attaches nothing
   * (ADR-0014 §2), because the tool layer throws for it (`codeRunFailedError`) and its image would
   * never reach the model.
   */
  images?: PtcImage[];
  /** Failure details; absent on success. */
  error?: PtcErrorShape;
  /**
   * One record per binding call the program made (ADR-0021).
   *
   * Present only when the dispatcher tracked sub-calls for the surface in question (always,
   * post-ADR-0021 — the dispatcher wires `SubCallTracker` for every run). Order is host-side
   * dispatch order; the renderer reads it as a point-in-time snapshot. Absent for runs that settled
   * before the tracker was constructed (the pre-`Promise` abort and pool-acquire-failed paths).
   */
  subCalls?: readonly SubCallRecord[];
}

/**
 * Classify a `pi.dispatch` return value that did not succeed.
 *
 * `DispatchResult.status: "rejected"` covers two different things, and the sub-call tree colours
 * them differently (ADR-0021 §6):
 *
 * - `started: false` — the harness declined to run it (depth gate, concurrency gate, unknown
 *   agent, a spawn that never happened). That is `rejected`.
 * - `started: true` — the child ran and failed (non-zero exit, no final text, killed). That is
 *   `error`, and it keeps the duration it actually took.
 *
 * Shape-checked rather than cast: this runs on any binding's resolved value, and a caller-supplied
 * binding is free to return whatever it likes.
 */
function dispatchOutcome(
  value: unknown,
): { kind: "refused" | "failed"; message: string } | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as { status?: unknown; started?: unknown; errorMessage?: unknown };
  if (candidate.status !== "rejected") return undefined;
  const message =
    typeof candidate.errorMessage === "string"
      ? candidate.errorMessage
      : candidate.started === false
        ? "dispatch refused"
        : "dispatch failed";
  return { kind: candidate.started === false ? "refused" : "failed", message };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * First non-empty line of a binding result's text content, for the sub-row's `resultSummary`.
 *
 * Builtins wrap their model-facing payload as `{ content: [{ type: "text", text: ... }, ...] }`;
 * the `pi.dispatch` binding returns a flat `DispatchResult` (no `content`). Both are handled
 * here so the tracker doesn't have to know which adapter produced the value. Returns
 * `undefined` when nothing readable is on the record — the tracker's `resultSummary` is then
 * simply absent, which is the same shape a tracker-only test sees.
 */
function firstLineOf(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const content = (value as { content?: unknown }).content;
  if (Array.isArray(content) && content.length > 0) {
    const first = content[0];
    if (first !== null && typeof first === "object") {
      const text = (first as { text?: unknown }).text;
      if (typeof text === "string" && text.length > 0) {
        const newline = text.indexOf("\n");
        return newline === -1 ? text : text.slice(0, newline);
      }
    }
  }
  return undefined;
}

/** A leaf whose bytes JSON cannot express: it is billed by `byteLength`, not by its JSON text. */
function isBinaryLeaf(value: unknown): value is ArrayBuffer | ArrayBufferView {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

/**
 * Walk a value tree, calling `onBinary` on every binary leaf (`ArrayBuffer` and any
 * `ArrayBufferView`). Cycles and shared sub-objects are visited once, so a pathological frame
 * cannot wedge or inflate the walk.
 *
 * Binary leaves are billed here rather than by their JSON text for two reasons: `JSON.stringify`
 * serialises an `ArrayBuffer` as `{}` (the size vanishes) and explodes a typed-array view into
 * one key per element (the size is overstated by ~6 bytes per element). The walk therefore stops
 * at the leaf and never recurses into a view's `.buffer`, which would count the same bytes twice.
 * ADR-0017 W-6 spells out the refactor; this is its binary half.
 */
function walkBinaryLeaves(
  value: unknown,
  onBinary: (binaryLeaf: ArrayBuffer | ArrayBufferView) => void,
): void {
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown): void => {
    if (candidate === null || candidate === undefined) return;
    if (candidate instanceof ArrayBuffer) {
      onBinary(candidate);
      return;
    }
    if (ArrayBuffer.isView(candidate)) {
      onBinary(candidate);
      return;
    }
    if (typeof candidate !== "object") return;
    if (seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    for (const key of Object.keys(candidate as Record<string, unknown>)) {
      visit((candidate as Record<string, unknown>)[key]);
    }
  };
  visit(value);
}

/**
 * Serialized byte size of a frame, the unit both the output and message budgets use.
 *
 * The count is the JSON text the frame becomes — every brace, bracket, separator, key name and
 * scalar — plus the bytes of any binary leaf, which that text cannot express. Two passes:
 *
 * 1. the whole value through `JSON.stringify` with binary leaves substituted by `null`: every
 *    structural character, key name and scalar is billed the way the old helper billed it, and a
 *    cyclic value throws here (as before);
 * 2. the binary leaves by `byteLength`, added on top.
 *
 * A frame with binary leaves therefore counts 4 bytes (its substituted `null`) more than the JSON
 * text it would have if the bytes vanished. That residue is deliberate and the safe direction:
 * under-counting the payload is the hole ADR-0017 W-6 closes, and the worker's channel clones
 * those bytes for real.
 *
 * A frame with no binary leaf produces exactly the previous helper's number — the substituter is
 * a no-op when there is nothing to substitute — and a cyclic or otherwise unaccountable payload
 * still reports `Number.POSITIVE_INFINITY` so the caller fails the run.
 */
function serializedBytes(value: unknown): number {
  try {
    const text = Buffer.byteLength(
      JSON.stringify(value, (_key, item) => (isBinaryLeaf(item) ? null : item)) ?? "",
      "utf8",
    );
    let binary = 0;
    walkBinaryLeaves(value, (leaf) => {
      binary += leaf.byteLength;
    });
    return text + binary;
  } catch {
    // Cyclic or otherwise unaccountable payload: report as unbounded so the caller fails the run.
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Run one PTC program in a fresh worker and resolve with its outcome.
 *
 * Never rejects for program/ limit / cancellation failures — those are reported as
 * `outcome.error` so callers have one place to render from. It only throws on caller bugs
 * (invalid config overrides).
 */
export async function runPtcProgram(options: RunPtcProgramOptions): Promise<PtcRunOutcome> {
  const config = resolveConfig(options.config);
  const env = createWorkerEnv();
  const runId = options.runId ?? randomUUID();
  const timeoutMs = effectiveTimeoutMs(options.timeoutMs, config);

  const logs: string[] = [];
  const narrations: string[] = [];
  const phases: string[] = [];

  if (options.signal?.aborted) {
    return {
      logs,
      narrations,
      phases,
      error: { kind: PTC_ERROR_KIND.abort, message: "run cancelled before start" },
    };
  }

  // Acquire the worker before entering the Promise constructor: pool acquires are
  // async (they queue when the pool is full and time out per `poolAcquireTimeoutMs`),
  // and the constructor callback cannot `await`. Cold-start falls back to `new Worker`
  // when no pool is configured. ADR-0017 §1.
  let worker: Worker;
  try {
    if (options.pool) {
      worker = await options.pool.acquire();
    } else {
      // Cold path: one run owns this worker outright, so it carries the run's own `runId`.
      // The hardening (F1–F3) has one definition for both paths — `workerSpawnOptions`.
      worker = new Worker(
        buildWorkerUrl(),
        workerSpawnOptions({ surface: options.surface, env, limits: config, runId }),
      );
    }
  } catch (error) {
    // Pool acquire timed out (or another acquire-side failure): surface as workerExit
    // so the tool layer renders a coherent "the harness could not get me a worker"
    // message rather than a stack trace.
    return {
      logs,
      narrations,
      phases,
      error: {
        kind: PTC_ERROR_KIND.workerExit,
        message: `pool acquire failed: ${messageOf(error)}`,
      },
    };
  }

  return await new Promise<PtcRunOutcome>((resolve) => {
    const channel = new MessageChannel();
    const control: MessagePort = channel.port1;
    const workerPort: MessagePort = channel.port2;

    const bindingAbort = new AbortController();
    let settled = false;
    /**
     * Sub-call tracker: one record per `call` frame, mutated as the binding lifecycle progresses
     * (ADR-0021). Wrapped so every start and end also pushes a live snapshot to the caller —
     * that is what lets the tool emit a partial result and have the tree visible while the run
     * is still in flight (ADR-0021 §4), not only once it settles.
     */
    const rawSubCallTracker = createSubCallTracker();
    const notifySubCalls = (): void => {
      // Nothing to say once the run is over: `finish` owns the terminal snapshot, and a
      // post-settle partial result would resurrect a row the run already closed.
      if (settled) return;
      options.onSubCallChange?.(() => rawSubCallTracker.snapshot());
    };
    const subCallTracker: SubCallTracker = {
      recordStart(callId, name, args) {
        rawSubCallTracker.recordStart(callId, name, args);
        notifySubCalls();
      },
      recordEnd(callId, status, summary) {
        const record = rawSubCallTracker.recordEnd(callId, status, summary);
        notifySubCalls();
        return record;
      },
      snapshot: () => rawSubCallTracker.snapshot(),
    };
    /** Set once a stop is under way; owns the terminal state from then on (`settleTerminal`). */
    let cancelling: PtcCancelReason | undefined;
    /**
     * Whether the worker has emitted its first `ready` frame. A cancel that lands before it does
     * still arms the grace window (the settle time must be bounded even for a worker that never
     * becomes reachable); the `ready` handler restarts that window, so a merely slow spawn gets
     * its full `graceMs` from the moment it can actually react.
     */
    let workerReady = false;
    let pendingCalls = 0;
    let outputBytes = 0;
    /**
     * Concurrently in-flight `pi.dispatch` calls, counted so the per-run hard cap
     * (ADR-0016 §2) can reject the overflow immediately. There is deliberately no
     * waiter queue behind this counter: the N+1th concurrent call resolves as
     * rejected instead of waiting for a slot. Independent of `activeBuiltinCalls`.
     *
     * ADR-0022 §9, as amended at review round 4: this is the FALLBACK counter, not the owner.
     * Since the acquire moved into `dispatch()` there is one session counter (built at
     * `background-runtime.ts:505`) and it serves every front; `dispatchDeps.slots` below prefers it,
     * so in a real pi session THIS counter is never consulted. It is reached only by a caller
     * that supplies no session counter -- a library caller, or `runPtcProgram` driven directly --
     * and there it is the configured `dispatchConcurrency`. Measured: with no session counter,
     * `dispatchConcurrency: 4` admits exactly 4.
     */
    const dispatchSlots = new DispatchSlotCounter(config.dispatchConcurrency);
    /**
     * Concurrently in-flight builtin binding calls, counted against
     * `maxParallelSubCalls` (ADR-0004 consequence). Unlike the dispatch cap,
     * the overflow FIFO-queues for a slot — DSH's semantics for builtin fan-out.
     * Independent of `activeDispatches`.
     */
    let activeBuiltinCalls = 0;
    const builtinWaiters: Array<() => void> = [];
    // Per-run depth for `pi.dispatch` (ADR-0016 Recursive section).
    // The parent turn's PTC run is depth 0; a run inside a child spawned by `pi.dispatch`
    // starts at the depth the child was stamped with (`PI_PTC_DEPTH` → the `depth`
    // option). The dispatcher itself does not change it within a single run.
    const runDepth = options.depth ?? 0;
    /** Deadline timer: fires `timeoutMs` after the run started. A cancel does not disarm it. */
    let runTimer: NodeJS.Timeout | undefined;
    /** The cancel's cooperative window: armed and re-armed by `armGraceTimer` only. */
    let graceTimer: NodeJS.Timeout | undefined;

    /* --------------------------- hoisted images (ADR-0014 / ADR-0017 §8) --------------------------- */

    const images: PtcImage[] = [];

    /**
     * Capture the image blocks from one binding result.
     *
     * `PtcImage` has exactly one representation — base64 `data`, the same shape pi's own `read`
     * returns and the same shape the JSON-only worker channel carries. A binding that emits
     * `data: <base64>` passes through untouched (no decode/encode round trip); a binding that
     * produces raw bytes is normalised here, once, host-side.
     *
     * The caller (`dispatchCall`) only keeps the captured list when `postCallResult` returned
     * true: a frame the port rejected was not a successful subtool result (ADR-0014 §2).
     */
    const captureImages = (value: unknown): PtcImage[] => {
      const captured: PtcImage[] = [];
      const content = (value as { content?: unknown } | null)?.content;
      if (!Array.isArray(content)) return captured;
      for (const block of content) {
        if (block === null || typeof block !== "object") continue;
        const candidate = block as {
          type?: unknown;
          data?: unknown;
          bytes?: unknown;
          mimeType?: unknown;
        };
        if (candidate.type !== "image") continue;
        let data: string | undefined;
        if (typeof candidate.data === "string" && candidate.data.length > 0) {
          // The shape pi's own tools emit, and the shape the wire carries: pass through.
          data = candidate.data;
        } else if (candidate.bytes instanceof ArrayBuffer && candidate.bytes.byteLength > 0) {
          // A binding that produces raw bytes (no pi tool does today) is normalised here, so
          // `PtcImage` has exactly one representation downstream.
          data = Buffer.from(candidate.bytes).toString("base64");
        }
        if (data === undefined) continue;
        captured.push({
          data,
          mimeType:
            typeof candidate.mimeType === "string"
              ? candidate.mimeType
              : "application/octet-stream",
        });
      }
      return captured;
    };

    const cancelMessage = (reason: PtcCancelReason): string =>
      reason === "timeout" ? `run timed out after ${timeoutMs} ms` : "run cancelled";

    /** The error kind a stop reports: whichever reason asked for it. */
    const cancelErrorKind = (reason: PtcCancelReason): PtcErrorKind =>
      reason === "timeout" ? PTC_ERROR_KIND.timeout : PTC_ERROR_KIND.abort;

    const finish = (outcome: PtcRunOutcome): void => {
      if (settled) return;
      settled = true;
      if (runTimer) clearTimeout(runTimer);
      if (graceTimer) clearTimeout(graceTimer);
      options.signal?.removeEventListener("abort", onAbortSignal);
      bindingAbort.abort();
      control.close();
      if (options.pool) {
        // Warm-reuse path: hand the worker back to the pool. The pool retires it
        // if it has already exited (Node marks a terminated worker with
        // `threadId === -1`); otherwise it parks the worker in `idle` or hands it
        // to the next waiter. ADR-0017 §1.
        options.pool.release(worker);
      } else {
        // Cold-start path: terminate the worker. The runtime owns the lifecycle.
        void worker.terminate();
      }
      // Take the terminal snapshot once and only here: by `finish` every dispatch path has
      // either reached its terminal record or is racing the settle and is captured as
      // still-running. A run that never made any binding call snapshots to `[]` and we omit
      // the field entirely — the renderer falls back to the existing
      // `code / out / log / warn / image` blocks when `subCalls` is absent (ADR-0021 §2).
      const subCalls = subCallTracker.snapshot();
      resolve(subCalls.length > 0 ? { ...outcome, subCalls } : outcome);
    };

    const fail = (kind: PtcErrorKind, message: string, stack?: string): void => {
      finish({
        logs,
        narrations,
        phases,
        error: stack === undefined ? { kind, message } : { kind, message, stack },
      });
    };

    /* -------------------------------- sending -------------------------------- */

    const sendControl = (frame: PtcHostFrame): void => {
      if (settled) return;
      // Every outbound frame is validated by the same guard the worker's inbound frames
      // go through: a construction bug fails the run here rather than inside the worker.
      if (!isPtcHostFrame(frame)) {
        fail(PTC_ERROR_KIND.protocol, "internal error: malformed host frame");
        return;
      }
      control.postMessage(frame);
    };

    const sendInit = (): void => {
      const frame: PtcHostFrame = {
        kind: HOST_FRAME_KIND.init,
        runId,
        surface: options.surface,
        code: options.code,
        bindings: [...options.bindings.keys()],
        bindingCandidates: [...BUILTIN_BINDING_NAMES],
        maxItemsPerCall: config.maxItemsPerCall,
        maxPendingCalls: config.maxPendingCalls,
        ...(options.args === undefined ? {} : { args: options.args }),
      };
      if (!isPtcHostFrame(frame)) {
        fail(PTC_ERROR_KIND.protocol, "internal error: malformed init frame");
        return;
      }
      const bytes = serializedBytes(frame);
      if (bytes > config.maxMessageBytes) {
        fail(
          PTC_ERROR_KIND.protocol,
          `init frame of ${bytes} bytes exceeds maxMessageBytes (${config.maxMessageBytes})`,
        );
        return;
      }
      sendControl(frame);
    };

    /* ------------------------------- receiving ------------------------------- */

    const accountOutput = (bytes: number, source: string): boolean => {
      outputBytes += bytes;
      if (outputBytes <= config.maxOutputBytes) return true;
      // R1 §3: an oversize payload keeps the log prefix that did fit.
      fail(
        PTC_ERROR_KIND.outputLimit,
        `${source} exceeded the output budget: logs + result reached ${outputBytes} bytes (maxOutputBytes=${config.maxOutputBytes}); ${logs.length} log line(s) retained`,
      );
      return false;
    };

    /* ---------------------- builtin fan-out cap (ADR-0004) ---------------------- */

    const acquireBuiltinSlot = async (): Promise<void> => {
      if (activeBuiltinCalls < config.maxParallelSubCalls) {
        activeBuiltinCalls += 1;
        return;
      }
      await new Promise<void>((slot) => {
        builtinWaiters.push(slot);
      });
    };

    const releaseBuiltinSlot = (): void => {
      const next = builtinWaiters.shift();
      if (next) {
        // Hand the slot over directly; `activeBuiltinCalls` is unchanged.
        next();
        return;
      }
      activeBuiltinCalls -= 1;
    };

    const handleCall = (frame: PtcCallFrame): void => {
      subCallTracker.recordStart(frame.callId, frame.tool, frame.args);
      pendingCalls += 1;
      if (pendingCalls > config.maxPendingCalls) {
        // Defense in depth only. The shipped worker admits calls before posting them
        // (`maxPendingCalls` travels in the init frame), so a normal program — including a
        // wide `Promise.all` or `parallel()` fan-out — never reaches this branch: the burst
        // queues in the worker, and arrivals here stay at or below the ceiling. This fires
        // only for a worker that ignores its admission budget, which is why it fails the
        // run instead of throttling. The record the tracker already holds for this `callId`
        // is finalised here so the terminal snapshot does not carry a still-running entry for
        // a frame the dispatcher never dispatched.
        subCallTracker.recordEnd(frame.callId, "error", {
          errorMessage: `more than maxPendingCalls (${config.maxPendingCalls}) binding calls in flight`,
        });
        fail(
          PTC_ERROR_KIND.protocol,
          `more than maxPendingCalls (${config.maxPendingCalls}) binding calls in flight`,
        );
        return;
      }
      void dispatchCall(frame).finally(() => {
        pendingCalls -= 1;
      });
    };

    const dispatchCall = async (frame: PtcCallFrame): Promise<void> => {
      const binding = options.bindings.get(frame.tool);
      if (!binding) {
        subCallTracker.recordEnd(frame.callId, "error", {
          errorMessage:
            `no binding named "${frame.tool}" in this run; available bindings: ` +
            ([...options.bindings.keys()].join(", ") || "(none)"),
        });
        postCallResult({
          kind: HOST_FRAME_KIND.callResult,
          callId: frame.callId,
          tool: frame.tool,
          ok: false,
          message:
            `no binding named "${frame.tool}" in this run; available bindings: ` +
            ([...options.bindings.keys()].join(", ") || "(none)"),
        });
        return;
      }
      const isDispatch = frame.tool === DISPATCH_BINDING_NAME;
      // ADR-0026 / round-3 finding: the dispatch cap moved INTO `dispatch()`, which is now the
      // single owner for both dispatch fronts. A background dispatch already owned its slot in
      // `dispatchBackground`; a foreground one now owns it in the foreground branch, so acquiring
      // here as well would charge every foreground dispatch TWO slots — `tryAcquire` has no
      // dedup for the anonymous form — and halve effective concurrency.
      //
      // The observable refusal is unchanged: `dispatch()` returns the same settled
      // `dispatchConcurrencyLimitReached()` DispatchResult the binding never throws (ADR-0016 §3),
      // so a Promise.all over pi.dispatch calls still sees a settled record, not a throw.
      if (!isDispatch) {
        // Builtin fan-out cap (ADR-0004 consequence): the overflow waits for a slot
        // instead of failing.
        await acquireBuiltinSlot();
        if (settled) {
          // Late arrival: the run settled (deadline/abort) while this call was waiting
          // for a builtin slot, so the worker that asked is gone and `bindingAbort` has
          // already fired. Do NOT execute the binding: it would start host-side work
          // whose only possible outcome is the abort it cannot deliver anywhere — the
          // port is closed. The in-flight case is covered: a call that was already
          // executing when the cancel fired sees `bindingAbort` through its context.
          subCallTracker.recordEnd(frame.callId, "cancelled", {
            errorMessage: "run settled before binding started",
          });
          releaseBuiltinSlot();
          return;
        }
      }
      try {
        const value = await binding.execute(frame.args, {
          signal: bindingAbort.signal,
          callId: frame.callId,
          depth: runDepth,
          maxDispatchDepth: config.maxDispatchDepth,
          // ADR-0022 §5/R1: the run id is the subscriber, and the host session dir (when it
          // has one) travels to the background spawn as the R1 `--session-dir` flag.
          callerId: runId,
          ...(options.parentTaskId === undefined ? {} : { parentTaskId: options.parentTaskId }),
          ...(options.sessionDir === undefined ? {} : { sessionDir: options.sessionDir }),
          // ADR-0022 §9: a session-supplied counter wins; otherwise keep this run's own
          // counter as the default (nothing regresses for callers that pass no deps).
          dispatchDeps: {
            ...options.dispatchDeps,
            slots: options.dispatchDeps?.slots ?? dispatchSlots,
          },
        });
        // Capture image blocks before the callResult post so the hoist can never race the
        // worker's view of the result; the captures are committed only once the post
        // returned true.
        const captured = captureImages(value);
        // Per-frame byte accounting before the post, as for every other frame: a `callResult` is
        // the other host→worker control frame, so it answers to the same `maxMessageBytes` cap as
        // the `init` frame and every inbound frame ("cap on a single control frame, either
        // direction", limits.ts / R1 §1). Over the cap is excessive control traffic — DSH's own
        // wording for `kind: protocol`, R1 §error kinds — so it ends the run here instead of
        // shipping a 128 MiB structured clone. Compare `postCallResult`: a value the *port*
        // rejects is a per-call failure (the program can catch a `ToolCallError`); a frame over
        // the documented cap is not, it is the same run-level failure the other three frame
        // checks produce.
        const callFrame: PtcHostFrame = {
          kind: HOST_FRAME_KIND.callResult,
          callId: frame.callId,
          tool: frame.tool,
          ok: true,
          value,
        };
        const callFrameBytes = serializedBytes(callFrame);
        if (callFrameBytes > config.maxMessageBytes) {
          subCallTracker.recordEnd(frame.callId, "error", {
            errorMessage: `callResult frame of ${callFrameBytes} bytes exceeds maxMessageBytes (${config.maxMessageBytes})`,
          });
          fail(
            PTC_ERROR_KIND.protocol,
            `callResult frame of ${callFrameBytes} bytes exceeds maxMessageBytes (${config.maxMessageBytes})`,
          );
          return;
        }
        const posted = postCallResult(callFrame);
        // Hoist only a result the worker actually received: DSH's condition is a *successful*
        // subtool result, and a payload the port rejected was not one (ADR-0014 §2).
        if (posted) {
          // Images do not pass ADR-0003's output budget (ADR-0014 Consequences: "Images are not
          // output ... That is deliberate"). The per-frame `maxMessageBytes` guard above still
          // bounds what a single callResult may carry, so a pathological binding cannot smuggle
          // unbounded payload in one frame. Volume stays observable: `ptc:image:hoist-bytes`
          // publishes every hoisted block and the PTC row's meta carries the count.
          for (const image of captured) {
            images.push(image);
            publishImageBytes(Buffer.byteLength(image.data, "base64"));
          }
        }
        // Mid-flight cancellation can also resolve normally: a binding that observed the abort
        // and surfaced it through the return value (the `pi.dispatch` binding does this — its
        // promise never rejects) lands here even when `bindingAbort.signal.aborted` is true.
        // `bash` and the other built-ins reject on abort, so they hit the catch branch below.
        // The discriminator is the signal itself: if the abort fired, the binding's outcome is a
        // cancellation regardless of which way it surfaced. ADR-0021 §1.
        if (bindingAbort.signal.aborted) {
          subCallTracker.recordEnd(frame.callId, "cancelled", {
            errorMessage: "binding aborted by run cancellation",
          });
        } else {
          // A `pi.dispatch` that did not succeed resolves rather than throwing, so its outcome
          // has to come off the value — recording every one of them as `ok` would tell the reader
          // a dispatch worked when it was either declined or failed (ADR-0021 §6).
          const outcome = isDispatch ? dispatchOutcome(value) : undefined;
          if (outcome !== undefined) {
            subCallTracker.recordEnd(
              frame.callId,
              outcome.kind === "refused" ? "rejected" : "error",
              {
                errorMessage: outcome.message,
              },
            );
          } else {
            subCallTracker.recordEnd(frame.callId, "ok", {
              resultSummary: firstLineOf(value),
            });
          }
        }
      } catch (error) {
        // Same abort discriminator: a built-in that observes `signal.aborted` rejects with
        // its own message (often `"aborted"`). The contract is "the abort fired" → cancelled,
        // not "the binding threw" → error. ADR-0021 §1.
        if (bindingAbort.signal.aborted) {
          subCallTracker.recordEnd(frame.callId, "cancelled", {
            errorMessage: messageOf(error),
          });
        } else {
          subCallTracker.recordEnd(frame.callId, "error", {
            errorMessage: messageOf(error),
          });
        }
        postCallResult({
          kind: HOST_FRAME_KIND.callResult,
          callId: frame.callId,
          tool: frame.tool,
          ok: false,
          message: messageOf(error),
        });
      } finally {
        // Dispatch slots are no longer this layer's business: `dispatchBackground` releases on the
        // pump's terminal transition and the foreground branch releases in its own `finalize`.
        // Releasing here as well would free a reservation this call never made.
        if (!isDispatch) releaseBuiltinSlot();
      }
    };

    /** `true` when the worker actually received the result (see the hoist at the call site). */
    const postCallResult = (frame: PtcCallResultFrame): boolean => {
      if (settled) return false;
      try {
        control.postMessage(frame);
        return true;
      } catch (error) {
        // The binding's value could not be structured-cloned; report the call as failed
        // instead of leaving the worker waiting on a response that will never arrive.
        // The failing payload is dropped rather than resent — it is exactly what the
        // clone rejected.
        try {
          control.postMessage({
            kind: HOST_FRAME_KIND.callResult,
            callId: frame.callId,
            tool: frame.tool,
            ok: false,
            message: `binding result could not be transferred: ${messageOf(error)}`,
          } satisfies PtcCallResultErrorFrame);
        } catch {
          fail(PTC_ERROR_KIND.protocol, "binding result is not transferable");
        }
        return false;
      }
    };

    const settleTerminal = (outcome: PtcRunOutcome): PtcRunOutcome => {
      if (!cancelling) return outcome;
      // Once cancelled, the caller asked for a stop: the run reports the stop, not the
      // value the program managed to produce inside the grace window. A failed run
      // attaches nothing (ADR-0014 §2): the tool layer throws for it, so images could
      // never reach the model anyway.
      return {
        logs,
        narrations,
        phases,
        error: {
          kind: cancelErrorKind(cancelling),
          message: cancelMessage(cancelling),
        },
      };
    };

    const handleFrame = (frame: unknown): void => {
      if (settled) return;
      if (!isPtcWorkerFrame(frame)) {
        fail(PTC_ERROR_KIND.protocol, "malformed worker frame");
        return;
      }
      const bytes = frame.kind === WORKER_FRAME_KIND.ready ? 0 : serializedBytes(frame);
      if (!Number.isFinite(bytes)) {
        fail(PTC_ERROR_KIND.protocol, "worker frame could not be serialized for accounting");
        return;
      }
      if (bytes > config.maxMessageBytes) {
        fail(
          PTC_ERROR_KIND.protocol,
          `control frame of ${bytes} bytes exceeds maxMessageBytes (${config.maxMessageBytes})`,
        );
        return;
      }

      switch (frame.kind) {
        case WORKER_FRAME_KIND.ready: {
          // Warm-reuse signal: a worker that has been through at least one run reports
          // "ready" again after clearing per-run state. The gap since the previous
          // release is the per-run reset cost, which is what ADR-0017 measures to
          // verify the warm path actually saves time.
          if (options.pool) {
            const previousSettled = options.pool.lastSettledAt(worker);
            if (previousSettled !== undefined) {
              publishResetTime(Date.now() - previousSettled);
            }
          }
          if (!workerReady) {
            workerReady = true;
            if (cancelling) {
              // The cancel arrived while this worker was still booting, so it armed the fallback
              // window (see `beginCancel`). The worker can react now: restart the window so it
              // gets its full `graceMs` to observe the cancel. Still bounded — the run's deadline
              // timer stays armed through a cancel, and the fallback never waited for `ready`.
              armGraceTimer(cancelling);
              // Do **not** hand a cancelled run a program: `init` would start work whose result
              // nobody is waiting for, and the worker would spend the grace window running it.
              // A worker that was cancelled while booting reports the cancel instead of a
              // `ready` (see `reportIdleCancel`); this branch is the belt-and-braces path for a
              // `ready` and a `cancel` that crossed on the wire.
              return;
            }
          }
          sendInit();
          return;
        }
        case WORKER_FRAME_KIND.call:
          handleCall(frame);
          return;
        case WORKER_FRAME_KIND.log:
          if (accountOutput(bytes, "console output")) logs.push(frame.text);
          return;
        case WORKER_FRAME_KIND.narration:
          if (accountOutput(bytes, "workflow narration")) narrations.push(frame.message);
          return;
        case WORKER_FRAME_KIND.phase:
          if (accountOutput(bytes, "workflow phase")) phases.push(frame.title);
          return;
        case WORKER_FRAME_KIND.result: {
          if (!accountOutput(bytes, "completion value")) return;
          // A cancel owns the terminal state and takes the images with it: `settleTerminal`
          // rebuilds the outcome without them, which is ADR-0014 §2's "a failed run attaches
          // nothing" rule.
          const base = {
            logs,
            narrations,
            phases,
            ...(images.length > 0 ? { images } : {}),
          };
          finish(
            settleTerminal(frame.value === undefined ? base : { ...base, value: frame.value }),
          );
          return;
        }
        case WORKER_FRAME_KIND.error:
          // A failed run attaches nothing (ADR-0014 §2): the tool layer throws for it, so an
          // image hoisted earlier in the run could never reach the model anyway.
          finish(settleTerminal({ logs, narrations, phases, error: frame.error }));
          return;
        default:
          fail(PTC_ERROR_KIND.protocol, "unknown worker frame");
      }
    };

    /* ------------------------------- lifecycle ------------------------------- */

    function onAbortSignal(): void {
      beginCancel("abort");
    }

    /**
     * Arm the cooperative-cancel window: `graceMs` from now the run settles with `reason`, unless
     * the worker settles it first. Re-arming replaces the pending window.
     *
     * The invariant this guards: **from the moment a run starts, it settles in bounded time.**
     * The window is therefore armed by `beginCancel` itself, not by the worker's `ready` frame —
     * a worker that never becomes reachable (spawn failure, wedged module load, a thread the OS
     * stopped scheduling) can no longer leave the run pending forever.
     */
    const armGraceTimer = (reason: PtcCancelReason): void => {
      if (graceTimer) clearTimeout(graceTimer);
      graceTimer = setTimeout(() => {
        fail(cancelErrorKind(reason), cancelMessage(reason));
      }, config.graceMs);
    };

    function beginCancel(reason: PtcCancelReason): void {
      if (settled) return;
      if (cancelling) {
        // A stop arrived while one was already pending — either the deadline landing on an
        // in-flight cancel, or the caller's abort landing after the deadline already fired (the
        // abort listener is registered `once`, so it can only ever be the first abort). This
        // branch is reached whether or not the worker became reachable: a worker that is mid-run
        // when the second stop arrives takes it too.
        //
        // Settle now rather than waiting out another `graceMs`. The run is already stopping and a
        // second stop must not extend that wait: in the cancel-first ordering the deadline has
        // just arrived, so the run must not stay unsettled past it, and in the deadline-first
        // ordering that deadline has already fired and is winding down through its own grace
        // window. The reason reported is the stop that arrived first — it is why the run is
        // ending; the second one only confirmed there was nothing left to wait for.
        fail(cancelErrorKind(cancelling), cancelMessage(cancelling));
        return;
      }
      cancelling = reason;
      // The deadline timer is deliberately left armed: while it is still pending it bounds a
      // cancelled run — if it fires with a cancel in flight, the branch above settles the run
      // right there, with the reason the caller asked for — so a caller's abort cannot outlive
      // the run's own deadline. The converse ordering has no deadline bound, and is not meant to:
      // see `runTimer` below for why a timed-out run settles at `timeoutMs + graceMs`.
      bindingAbort.abort();
      sendControl({ kind: HOST_FRAME_KIND.cancel, reason });
      // Arm the window immediately rather than waiting for the worker's first `ready` frame. The
      // window is about "time the worker has had to react"; the `ready` handler restarts it for a
      // worker that turns out to be merely slow. What it must never do is refuse to arm — that
      // left a worker stuck in BOOTING with no timer at all.
      armGraceTimer(reason);
    }

    worker.on("error", (error: Error) => {
      fail(PTC_ERROR_KIND.workerExit, `worker failed: ${messageOf(error)}`);
    });
    worker.on("exit", (code: number) => {
      fail(PTC_ERROR_KIND.workerExit, `worker exited with code ${code} before the run completed`);
    });
    control.on("message", handleFrame);
    control.on("messageerror", () => {
      fail(PTC_ERROR_KIND.protocol, "worker sent a frame that could not be deserialized");
    });

    options.signal?.addEventListener("abort", onAbortSignal, { once: true });
    // The run's deadline. It is one-shot: when it fires by itself the timer is spent, so what ends
    // a timed-out run is the cancel it starts — `beginCancel("timeout")` arms a `graceMs` window of
    // its own, and that window's expiry is the settle. A run that times out therefore settles by
    // `timeoutMs + graceMs` ("the program gets `timeoutMs`, then `graceMs` to wind down"), which is
    // the intended semantics, not a leak. While this timer is still pending it also bounds a run
    // the caller has already cancelled: a cancel never disarms it (see `beginCancel`), so that
    // ordering settles at the deadline.
    runTimer = setTimeout(() => {
      beginCancel("timeout");
    }, timeoutMs);

    // The connect frame carries the control port *in the payload*; a transfer-list-only
    // entry is silently dropped by Node and the worker would wait forever.
    const connectFrame: PtcHostFrame = { kind: HOST_FRAME_KIND.connect, port: workerPort };
    if (!isPtcHostFrame(connectFrame)) {
      fail(PTC_ERROR_KIND.protocol, "internal error: malformed connect frame");
    } else {
      worker.postMessage(connectFrame, [workerPort]);
    }
  });
}
