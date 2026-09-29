/**
 * Worker-side PTC runtime: installs one surface, runs one program, routes `tools.*`
 * calls back to the host.
 *
 * State machine (ADR-0017 §5):
 *
 *   CREATED ── function entry ──────────────────────────► BOOTING
 *      │                                                   │
 *      │                                          control port installed
 *      │                                                   │
 *      │                                           ┌───────┴───────┐
 *      │                                           │               │
 *      │                                           ▼               ▼
 *      │   (host sends init)                  READY ◄─── ready sent
 *      │       │                                 │
 *      │       ▼                                 │ init
 *      │   RUNNING                               │
 *      │       │                                 │
 *      │   (program completes / throws / cancel) │
 *      │       │                                 │
 *      │       ▼                                 │
 *      │   reset() + ready sent ───────────────► READY
 *      │
 *      └── (host closes control port) ─► worker terminates, no further transitions
 *
 * A later `connect` re-enters `READY` from wherever the worker is: a handover, not a wait — which is
 * how a worker the host abandoned is picked up by the next run (see the connect handler, ADR-0017
 * §10(h)).
 *
 * The `ready` frame has two meanings under ADR-0017 §5:
 *   - cold start: "booted, send init".
 *   - warm reuse: "cleared per-run state, ready for next init".
 *
 * Run identity: every accepted `init` starts a new run and claims the worker for it
 * (a run ordinal, captured by that run). A run only owns the worker until the next
 * `init` supersedes it — so the reset that ends a run must prove it still owns the
 * worker before it clears anything (see `reset`).
 *
 * Frame ownership: a run's outbound frames (`log`, `narration`, `phase`, `call`, `result`,
 * `error`) are posted through the control port that run captured when its `init` arrived —
 * never through "whichever port the worker is connected to now". Warm reuse replaces the
 * connection while a superseded run may still be unwinding, so routing is what keeps one run's
 * terminal frame from settling the next one (see `post` and `startRun`).
 *
 * The worker is loaded by file URL (`dist/worker.js`, see `worker-entry.ts`); V8's
 * code cache and Node's module cache survive across warm-reuse spawns. The
 * SELF-CONTAINMENT RULE that previously gated this module — `Function.prototype.toString()`
 * of `workerMain` into a `data:` URL — is retired.
 */
import { describeValue } from "./protocol.ts";
import type {
  PtcCancelReason,
  PtcErrorKind,
  PtcJsonObject,
  PtcJsonValue,
  PtcLogLevel,
  WorkerProtocolSpec,
} from "./protocol.ts";

/** The subset of `MessagePort`/`parentPort` the worker uses. */
export interface WorkerMainPort {
  on(event: "message", listener: (value: unknown) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  postMessage(value: unknown): void;
}

export interface WorkerMainDeps {
  parentPort: WorkerMainPort;
  /**
   * The spawning host's `workerData`: the frozen per-run env snapshot `{ env }` (F3,
   * ADR-0005) and nothing else. Per-run identity is *not* carried here: a warm worker
   * outlives the run that spawned it, so the host sends each run's `runId` in its own
   * `init` frame instead. This worker never reads either one — it routes calls, and the
   * host attributes frames to runs on its side.
   */
  workerData: unknown;
  /** `node:util`'s `inspect`, used to render non-string console arguments. */
  inspect: (value: unknown, options?: Record<string, unknown>) => string;
  /** `node:module`'s `stripTypeScriptTypes`: the program is TypeScript, run type-stripped. */
  stripTypes: (code: string, options: { mode: "strip" }) => string;
  protocol: WorkerProtocolSpec;
}

/**
 * Internal lifecycle of one worker (ADR-0017 §5). The values are exported only so
 * the unit-test seam can read the current state through a shared channel; the
 * worker itself never escapes `state` outside this module.
 */
export type WorkerMainState = "CREATED" | "BOOTING" | "READY" | "RUNNING";

export function workerMain(deps: WorkerMainDeps): void {
  const hostFrame = deps.protocol.hostFrame;
  const workerFrame = deps.protocol.workerFrame;
  const logLevel = deps.protocol.logLevel;
  const errorKind = deps.protocol.errorKind;
  /** Wrapper name used to compile a program body (`return …` is legal inside it). */
  const programName = "__ptcProgram";

  /** Active lifecycle state — see the doc comment at the top of the module. */
  let state: WorkerMainState = "CREATED";
  /**
   * Run ordinal: incremented once per accepted `init` frame, never decremented. The value
   * a run was born with is its identity for life — `reset()` checks it against this
   * counter before touching anything.
   */
  let runGeneration = 0;

  let control: WorkerMainPort | undefined;
  let cancelled: PtcCancelReason | undefined;
  let nextCallId = 1;
  /** Call frames posted and not yet answered; capped by `maxPendingCalls` (ADR-0004). */
  let inFlightCalls = 0;
  let maxPendingCalls = Number.POSITIVE_INFINITY;
  const admissionWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();
  /**
   * Snapshot of `globalThis` taken once, at boot (end of `installWarningCapture`), i.e. the
   * "warm baseline" a reset restores to.
   *
   * What it covers: `globalThis`'s own enumerable string keys — the way a PTC program normally
   * touches the realm. A `globalThis.x = 1` left by run N is deleted before run N+1 starts, and any
   * `console` / `tools` / `log` / `phase` / `parallel` / `pipeline` installed by run N is put back
   * to its boot value for run N+1 to replace with its own install.
   *
   * What it does **not** cover — a superseded run's leftovers that survive into the next one, so
   * "warm reuse is hermetic" would be the wrong reading of this snapshot:
   *   - a property added to `globalThis` that is non-enumerable or symbol-keyed (`Object.keys` is
   *     what both the snapshot and the restore walk, so such a property is neither deleted nor put
   *     back);
   *   - anything reachable through another object: `Array.prototype.x = 1`, a mutated built-in, the
   *     module-level state of a module the program imported (Node caches modules per worker, and a
   *     program can `import()` one);
   *   - `process` state the program wrote — `process.title`, `process.exitCode`, listeners it added;
   *   - timers it started, which keep firing (see `startRun`).
   *
   * Those are known, accepted limits of warm reuse rather than oversights of this snapshot.
   *
   * The *boot* snapshot is the only clean starting point there is: a later `connect` must not
   * take a new one, or whatever the run it superseded left behind would be part of the baseline
   * and would be restored into every run after it.
   */
  let warmBaseline: Map<string, unknown> | undefined;

  const globals = (): Record<string, unknown> => globalThis as unknown as Record<string, unknown>;

  class ToolCallError extends Error {
    toolName: string;
    constructor(toolName: string, message: string) {
      super(message);
      this.name = "ToolCallError";
      this.toolName = toolName;
    }
  }

  const messageOf = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

  /**
   * Trim a stack down to what a reader can act on.
   *
   * Capped at a small depth so the model-facing stack stays inside the output budget.
   * Now that the worker is loaded by file URL, no `data:text/javascript,…` frames
   * appear at all — the rule kept the previous bootstrap's encoded payload from
   * filling the stack.
   */
  const stackOf = (error: unknown): string | undefined => {
    if (!(error instanceof Error) || typeof error.stack !== "string") return undefined;
    const lines = error.stack.split("\n");
    const kept = [lines[0] ?? ""];
    for (const line of lines.slice(1)) {
      kept.push(line);
      if (kept.length >= 6) break;
    }
    return kept.join("\n");
  };
  /**
   * Post a frame through `port` — the control port the caller's run belongs to — defaulting to
   * the port the worker is currently connected to.
   *
   * Invariant (ADR-0017 §10(b)): *a run's outbound frames travel only through the port that run
   * captured at `init` time*. Warm reuse installs a new port while a superseded run may still be
   * unwinding, and that run's terminal `result` must not land on the *next* run's port — the host
   * reads any `result` there as "the current run settled" (`handleFrame` → `finish()`), which
   * would end a run whose program never finished. The port of a run the host has abandoned has
   * been closed on the host's side, so its late frames fail to send and are dropped here; that is
   * the right outcome for a frame nobody owns any more.
   *
   * Only realm-level frames — the `connect` handshake's `ready`, warning `log`s, which belong to
   * the worker rather than to a program — use the default.
   */
  const post = (frame: unknown, port: WorkerMainPort | undefined = control): boolean => {
    if (!port) return false;
    try {
      port.postMessage(frame);
      return true;
    } catch {
      // Port closed (run already settled) — nothing useful to do with the frame.
      return false;
    }
  };

  const postLog = (level: PtcLogLevel, text: string, port?: WorkerMainPort): void => {
    post({ kind: workerFrame.log, level, text }, port);
  };

  const postError = (
    kind: PtcErrorKind,
    message: string,
    stack?: string,
    port?: WorkerMainPort,
  ): void => {
    post(
      stack === undefined
        ? { kind: workerFrame.error, error: { kind, message } }
        : { kind: workerFrame.error, error: { kind, message, stack } },
      port,
    );
  };

  const abortError = (reason: PtcCancelReason): Error => {
    const error = new Error(reason === "timeout" ? "PTC run timed out" : "PTC run was cancelled");
    error.name = "AbortError";
    return error;
  };

  const closedError = (): Error => {
    const error = new Error("the PTC control channel closed before the call completed");
    error.name = "AbortError";
    return error;
  };

  /* ------------------------------------------------------------------ */
  /* call admission                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Admission control for host binding calls.
   *
   * "Maximum simultaneous host binding calls" is the worker's invariant to keep: a call
   * frame is only posted once fewer than `maxPendingCalls` are outstanding, so a wide
   * `Promise.all` / `parallel()` burst queues here rather than arriving at the host in one
   * tick. The host still counts arrivals as a backstop, but it must never see this budget
   * exceeded by a well-behaved program.
   *
   * Waiting for a slot is cancel-aware: `cancel` and a closed control port reject waiters
   * immediately, so an oversized burst unwinds at once instead of waiting out the grace
   * window before the host terminates the worker.
   */
  const acquireCallSlot = async (): Promise<void> => {
    if (inFlightCalls < maxPendingCalls) {
      inFlightCalls += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      admissionWaiters.push({ resolve, reject });
    });
  };

  const releaseCallSlot = (): void => {
    const next = admissionWaiters.shift();
    if (next) {
      // Hand the slot over: `inFlightCalls` already accounts for it, so it stays put.
      next.resolve();
      return;
    }
    inFlightCalls -= 1;
  };

  const rejectAdmissionWaiters = (error: unknown): void => {
    while (admissionWaiters.length > 0) {
      const waiter = admissionWaiters.shift();
      if (waiter) waiter.reject(error);
    }
  };

  /** Settle every outstanding call and every admission wait, so nothing can hang. */
  const flushPendingCalls = (error: Error): void => {
    rejectAdmissionWaiters(error);
    for (const [callId, entry] of pending) {
      pending.delete(callId);
      entry.reject(error);
    }
  };

  /**
   * F3 — reinstall the frozen per-run environment carried in `workerData`.
   *
   * The spawn already passes the same snapshot as the worker's `env` option; rebuilding
   * `process.env` from `workerData` here is what makes the snapshot the authority: the
   * program's environment is the frozen record, never whatever `process.env` happened
   * to hold when a binding call crossed the wire.
   */
  const installFrozenEnv = (): void => {
    const data = deps.workerData;
    if (typeof data !== "object" || data === null) return;
    const snapshot = (data as { env?: unknown }).env;
    if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) return;
    const env = snapshot as Record<string, unknown>;
    for (const key of Object.keys(process.env)) {
      if (!(key in env)) delete process.env[key];
    }
    for (const key of Object.keys(env)) {
      const value = env[key];
      if (typeof value === "string") process.env[key] = value;
    }
  };

  /**
   * Lossless-JSON materialization of the program's return value (R1 §3 `invalid-output`).
   *
   * Plain JSON only: class instances, `Date`/`Map`/`Set`, functions, symbols, bigints,
   * non-finite numbers and cycles are rejected with a path-qualified reason instead of
   * being silently lossy through the transport. `undefined` follows `JSON.stringify`:
   * object properties are dropped, array slots become `null`.
   */
  const toJsonValue = (
    value: unknown,
  ): { ok: true; value: PtcJsonValue | undefined } | { ok: false; reason: string } => {
    const seen = new Set<object>();

    const walk = (
      candidate: unknown,
      path: string,
    ): { ok: true; value: PtcJsonValue | undefined } | { ok: false; reason: string } => {
      if (candidate === null) return { ok: true, value: null };
      if (typeof candidate === "string" || typeof candidate === "boolean")
        return { ok: true, value: candidate };
      if (typeof candidate === "undefined") return { ok: true, value: undefined };
      if (typeof candidate === "number") {
        if (!Number.isFinite(candidate)) {
          return {
            ok: false,
            reason: `${path} is ${String(candidate)}, which is not representable as JSON`,
          };
        }
        return { ok: true, value: candidate };
      }
      if (typeof candidate !== "object") {
        return {
          ok: false,
          reason: `${path} is ${describeValue(candidate)}; results must be lossless JSON`,
        };
      }

      if (Array.isArray(candidate)) {
        if (seen.has(candidate)) return { ok: false, reason: `${path} is a circular reference` };
        seen.add(candidate);
        const items: PtcJsonValue[] = [];
        for (let index = 0; index < candidate.length; index += 1) {
          const item = walk(candidate[index], `${path}[${index}]`);
          if (!item.ok) return item;
          items.push(item.value === undefined ? null : item.value);
        }
        seen.delete(candidate);
        return { ok: true, value: items };
      }

      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        const ctor = (candidate as { constructor?: { name?: string } }).constructor;
        const name =
          ctor && typeof ctor.name === "string" && ctor.name.length > 0 ? ctor.name : "an object";
        return { ok: false, reason: `${path} is a ${name}; results must be plain JSON objects` };
      }
      if (seen.has(candidate)) return { ok: false, reason: `${path} is a circular reference` };
      seen.add(candidate);
      const entries: PtcJsonObject = {};
      for (const key of Object.keys(candidate)) {
        const item = walk((candidate as Record<string, unknown>)[key], `${path}.${key}`);
        if (!item.ok) return item;
        if (item.value !== undefined) entries[key] = item.value;
      }
      seen.delete(candidate);
      return { ok: true, value: entries };
    };

    return walk(value, "result");
  };

  const formatArgs = (args: readonly unknown[]): string =>
    args
      .map((arg) =>
        typeof arg === "string"
          ? arg
          : deps.inspect(arg, { depth: 4, breakLength: Infinity, colors: false }),
      )
      .join(" ");

  /**
   * Capture `console` instead of letting worker stdio reach the host terminal.
   *
   * Only the printing methods exist on this surface; everything routes to `log` frames
   * so the model (not the terminal) sees the program's output. Log frames belong to the run
   * whose console this is, hence the captured `port`.
   */
  const installConsole = (port: WorkerMainPort | undefined): void => {
    const write = (level: PtcLogLevel) => {
      return (...args: unknown[]): void => {
        postLog(level, formatArgs(args), port);
      };
    };
    globals().console = {
      log: write(logLevel.log),
      info: write(logLevel.info),
      warn: write(logLevel.warn),
      error: write(logLevel.error),
      debug: write(logLevel.debug),
    };
  };

  /**
   * Route `process.emitWarning` output through `log` frames.
   *
   * Node's default warning printer writes to stderr, which is piped to the host terminal.
   * `ExperimentalWarning`s are dropped rather than forwarded: the PTC runtime itself uses
   * experimental Node APIs (type stripping, for one) and those warnings are about the
   * harness, not about the program — forwarding them would put Node-internals noise into
   * every run's logs.
   */
  const installWarningCapture = (): void => {
    if (typeof process.removeAllListeners !== "function" || typeof process.on !== "function")
      return;
    process.removeAllListeners("warning");
    process.on("warning", (warning: unknown) => {
      const record =
        typeof warning === "object" && warning !== null
          ? (warning as Record<string, unknown>)
          : undefined;
      const name = record && typeof record.name === "string" ? record.name : "Warning";
      if (name === "ExperimentalWarning") return;
      const detail =
        record && typeof record.message === "string" ? record.message : String(warning);
      postLog(logLevel.warn, `${name}: ${detail}`);
    });
  };

  /**
   * Compile a program body into a callable.
   *
   * The body is wrapped in an async function so `return` and `await` work at the top
   * level, then run through `stripTypeScriptTypes` so the same body may carry type
   * annotations (DSH's "type annotations are advisory, the code runs type-stripped").
   * JavaScript the TypeScript parser rejects falls back to the unstripped source; a
   * genuine syntax error then surfaces from the `Function` constructor instead.
   */
  const compileProgram = (code: string): (() => unknown) => {
    const wrapped = `async function ${programName}() {\n${code}\n}`;
    let source = wrapped;
    try {
      source = deps.stripTypes(wrapped, { mode: "strip" });
    } catch {
      source = wrapped;
    }
    // oxlint-disable-next-line typescript/no-implied-eval -- compiling the submitted program is this worker's job; it never compiles host code.
    return new Function(`${source}\nreturn ${programName}();`) as () => unknown;
  };

  const runProgram = async (
    code: string,
    generation: number,
    port: WorkerMainPort | undefined,
  ): Promise<void> => {
    try {
      let program: () => unknown;
      try {
        program = compileProgram(code);
      } catch (error) {
        postError(
          errorKind.exception,
          `program failed to compile: ${messageOf(error)}`,
          stackOf(error),
          port,
        );
        return;
      }
      try {
        const value = await program();
        const normalized = toJsonValue(value);
        if (!normalized.ok) {
          postError(errorKind.invalidOutput, normalized.reason, undefined, port);
          return;
        }
        post(
          normalized.value === undefined
            ? { kind: workerFrame.result }
            : { kind: workerFrame.result, value: normalized.value },
          port,
        );
      } catch (error) {
        postError(cancelled ?? errorKind.exception, messageOf(error), stackOf(error), port);
      }
    } finally {
      // RUNNING → READY: every path through `runProgram` (compile fail, completion,
      // exception, cancel) leaves through here. Resetting and re-posting `ready`
      // is what makes warm reuse safe — without it, the worker would have to be
      // terminated and respawned between turns (ADR-0017 §5). The run ordinal is
      // threaded through so a run that has since been superseded resets nothing, and
      // the run's own port is threaded through so its `ready` cannot reach the port
      // that replaced it.
      await reset(generation, port);
    }
  };

  /**
   * `tools.<name>(args)` — acquire an admission slot, post a call frame, and await the
   * matching `call-result`.
   *
   * The slot is released on every exit path (settled, admission refused by `post`, cancel),
   * which is what keeps a burst draining instead of deadlocking. Call frames carry the
   * binding's own run port: a superseded run's late call is dropped at its closed port instead
   * of arriving at the host as a call for a run it never made.
   */
  const makeBinding = (name: string, port: WorkerMainPort | undefined) => {
    return async (args: unknown): Promise<unknown> => {
      if (cancelled) throw abortError(cancelled);
      await acquireCallSlot();
      try {
        if (cancelled) throw abortError(cancelled);
        const callId = nextCallId;
        nextCallId += 1;
        const promise = new Promise<unknown>((resolve, reject) => {
          pending.set(callId, { resolve, reject });
        });
        const sent = post({ kind: workerFrame.call, callId, tool: name, args }, port);
        if (!sent) {
          pending.delete(callId);
          throw new ToolCallError(
            name,
            `${name}() could not be called: the arguments are not transferable or the run has ended`,
          );
        }
        return await promise;
      } finally {
        releaseCallSlot();
      }
    };
  };

  const settleCall = (frame: Record<string, unknown>): void => {
    const callId = frame.callId;
    if (typeof callId !== "number") return;
    const entry = pending.get(callId);
    if (!entry) return;
    pending.delete(callId);
    if (frame.ok === true) {
      entry.resolve(frame.value);
      return;
    }
    entry.reject(
      new ToolCallError(
        typeof frame.tool === "string" ? frame.tool : "unknown",
        typeof frame.message === "string" ? frame.message : "binding call failed",
      ),
    );
  };

  const cancelPending = (reason: PtcCancelReason): void => {
    cancelled = reason;
    flushPendingCalls(abortError(reason));
  };

  /**
   * Confirm a cancel that has nothing to flush, and forget it.
   *
   * A cancel can arrive while the worker is idle — booting, or freshly reset and waiting for the
   * next `init`. There is no program to interrupt and no pending call to reject, so the honest
   * answer is to report the cancel: the host asked to stop, and it should settle now rather than
   * wait out its grace window for a run that will never start (and the `init` it might send next
   * would clear the verdict and run the program anyway).
   */
  const reportIdleCancel = (reason: PtcCancelReason, port: WorkerMainPort): void => {
    cancelled = undefined;
    const error = abortError(reason);
    postError(reason, error.message, undefined, port);
  };

  /* ------------------------------------------------------------------ */
  /* workflow helpers (ptc_workflow surface only)                        */
  /* ------------------------------------------------------------------ */

  const assertItemCount = (helper: string, count: number, maxItemsPerCall: number): void => {
    if (count > maxItemsPerCall) {
      throw new RangeError(
        `${helper}() received ${count} items, exceeding maxItemsPerCall (${maxItemsPerCall})`,
      );
    }
  };

  const installWorkflowHelpers = (
    args: unknown,
    maxItemsPerCall: number,
    port: WorkerMainPort | undefined,
  ): void => {
    const target = globals();
    target.args = args === undefined ? null : args;

    target.log = (message: unknown): void => {
      if (typeof message !== "string")
        throw new TypeError(`log(message) expects a string, received ${describeValue(message)}`);
      post({ kind: workerFrame.narration, message }, port);
    };

    target.phase = (title: unknown): void => {
      if (typeof title !== "string")
        throw new TypeError(`phase(title) expects a string, received ${describeValue(title)}`);
      post({ kind: workerFrame.phase, title }, port);
    };

    // parallel(thunks): all thunks start together; a rejected item becomes `null`
    // instead of failing the call (R1 §4).
    target.parallel = async (thunks: unknown): Promise<unknown[]> => {
      if (!Array.isArray(thunks))
        throw new TypeError(
          `parallel(thunks) expects an array of functions, received ${describeValue(thunks)}`,
        );
      assertItemCount("parallel", thunks.length, maxItemsPerCall);
      for (let index = 0; index < thunks.length; index += 1) {
        if (typeof thunks[index] !== "function") {
          throw new TypeError(
            `parallel(thunks) expects functions; item ${index} is ${describeValue(thunks[index])}`,
          );
        }
      }
      return await Promise.all(
        (thunks as Array<() => unknown>).map(async (thunk) => {
          try {
            return await thunk();
          } catch {
            return null;
          }
        }),
      );
    };

    // pipeline(items, ...stages): stages run per item with no cross-stage barrier; a
    // failing item becomes `null` while its siblings continue (R1 §4).
    target.pipeline = async (items: unknown, ...stages: unknown[]): Promise<unknown[]> => {
      if (!Array.isArray(items))
        throw new TypeError(
          `pipeline(items, ...stages) expects an array of items, received ${describeValue(items)}`,
        );
      assertItemCount("pipeline", items.length, maxItemsPerCall);
      if (stages.length === 0)
        throw new TypeError("pipeline(items, ...stages) requires at least one stage function");
      for (let index = 0; index < stages.length; index += 1) {
        if (typeof stages[index] !== "function") {
          throw new TypeError(
            `pipeline(items, ...stages) expects stage functions; stage ${index} is ${describeValue(stages[index])}`,
          );
        }
      }
      const stageFunctions = stages as Array<
        (previous: unknown, item: unknown, index: number) => unknown
      >;
      return await Promise.all(
        (items as unknown[]).map(async (item, index) => {
          try {
            let current: unknown = item;
            for (const stage of stageFunctions) {
              current = await stage(current, item, index);
            }
            return current;
          } catch {
            return null;
          }
        }),
      );
    };
  };

  /* ------------------------------------------------------------------ */
  /* reset handshake (ADR-0017 §5)                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Restore `globalThis` to the warm baseline taken at the end of the worker's
   * boot-time setup (`installWarningCapture`).
   *
   * This is stronger than deleting the known `RUN_GLOBAL_KEYS`: it also wipes any
   * stray property the previous run's program left behind (`globalThis.x = 1` and
   * similar). Without it, warm reuse would leak state from one run to the next.
   * Enumerating own *enumerable string* keys is also its limit — see `warmBaseline`
   * for the leftovers that walk past it.
   *
   * Properties in the baseline are restored even if the program overwrote them —
   * that is what keeps `console` honest for the next run, since the program's
   * console override does not survive the reset.
   */
  const restoreWarmBaseline = (): void => {
    if (!warmBaseline) return;
    const target = globals();
    for (const key of Object.keys(target)) {
      if (!warmBaseline.has(key)) delete target[key];
    }
    for (const [key, value] of warmBaseline) {
      // Skip properties whose descriptor is non-writable (e.g. `globalThis.crypto`
      // on modern Node — a getter with no setter). Forcing a write would throw and
      // break reset for every other key. The worker didn't install these, so leaving
      // them untouched is the correct behaviour — no run owns them.
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      if (descriptor !== undefined && descriptor.writable === false) continue;
      try {
        target[key] = value;
      } catch {
        // Same defence for accessor properties whose setter throws or rejects the
        // assignment — non-installed globals stay as Node shipped them.
      }
    }
  };

  /**
   * RUNNING → READY: clear the per-run state this worker owns so it is safe to accept
   * another `init` frame on warm reuse (ADR-0017 §5).
   *
   * Order matters: flush first so no settled call leaks into the next run, then
   * restore the warm baseline (the program may have left values behind that would
   * shadow the next install), then rehydrate the frozen env so the next run starts
   * from the same `process.env` snapshot the host captured. State transitions to
   * `READY` last — only when the worker is actually eligible for the next `init`.
   *
   * What it clears is exactly: the outstanding calls and admission waiters, the run
   * bookkeeping (`inFlightCalls`, `cancelled`, `nextCallId`, `pending`), `globalThis`'s own
   * enumerable keys (via the warm baseline — see `warmBaseline` for what that misses) and
   * `process.env`. It does **not** stop timers the program left running; nothing can, see
   * `startRun`. And when the run that produced this reset was superseded, none of it happens at
   * all: the clearing then falls to the *next* run's `startRun` (see the invariant below).
   *
   * Invariant — a reset is scoped to the run that produced it: `generation` is the run
   * ordinal the finishing run was born with. If the worker has since been handed to a
   * newer run (`generation !== runGeneration`), this reset is a no-op: it must not clear
   * the newer run's calls, globals or bookkeeping, and it must not post `ready` (the
   * host reads `ready` as "the current run settled, send the next init" — posting a
   * stranger's `ready` is what makes a program execute twice). Ownership is captured at
   * `init` time rather than read from the shared `state`, because `state` belongs to
   * whoever owns the worker now. `port` is the run's own control port for the same reason:
   * a `ready` that survives the ownership check still has no business on another run's port.
   */
  const reset = async (generation: number, port: WorkerMainPort | undefined): Promise<void> => {
    if (state !== "RUNNING" || generation !== runGeneration) return;
    flushPendingCalls(closedError());
    inFlightCalls = 0;
    cancelled = undefined;
    nextCallId = 1;
    pending.clear();
    restoreWarmBaseline();
    installFrozenEnv();

    state = "READY";
    post({ kind: workerFrame.ready }, port);
  };

  /* ------------------------------------------------------------------ */
  /* frame handling                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Claim the worker for one run and install that run's surface.
   *
   * `port` is the channel the run's `init` arrived on; it *is* the run's control port for life.
   * Every frame the run produces afterwards — `log`, `narration`, `phase`, `call`, `result`,
   * `error`, its closing `ready` — is posted through it, even if the worker has since been handed
   * to another run (see `post`).
   *
   * The run starts from a clean realm. That cannot be left to the previous run's `reset()`: a run
   * the host abandoned is superseded, and its reset is a generation-guarded no-op — so its strays on
   * `globalThis` (`tools`, the workflow helpers, whatever its program assigned) and its bookkeeping
   * would otherwise live on into this run and break the isolation warm reuse promises (ADR-0017
   * §10(d) — and note §5 is explicit that the reset handshake is *not* where isolation comes
   * from). Clearing here is unconditional: one run starting is the end of everything the previous
   * round was doing, whatever the previous round did or did not do.
   *
   * "Clean" is what `restoreWarmBaseline` can restore — `globalThis`'s own enumerable keys, then the
   * frozen env and this run's fresh installs — plus this worker's run bookkeeping. It is honestly
   * not every trace a program can leave: a timer it started keeps firing, a prototype it patched
   * stays patched, and `process` state it wrote stays written (see `warmBaseline` for the list).
   * Timers are the leftover this function used to claim to clear, and the claim was false: Node
   * offers no way to enumerate a worker's pending timers — inside a worker thread
   * `process._getActiveHandles()` returns `[]` and `process.getActiveResourcesInfo()` reports names
   * (`"Timeout"`), not handles (both checked on Node 24.21.0). A leftover interval is therefore a
   * known, accepted limitation of warm reuse, not something this function clears.
   */
  const startRun = (
    frame: Record<string, unknown>,
    generation: number,
    port: WorkerMainPort,
  ): void => {
    restoreWarmBaseline();

    // Bookkeeping resets with the globals: a cancel verdict from the abandoned run must not make
    // this run's first `tools.*` call throw `PTC run timed out`, and calls admitted but never
    // settled cannot be allowed to hold slots in this run's budget (ADR-0004).
    cancelled = undefined;
    inFlightCalls = 0;
    pending.clear();

    installFrozenEnv();
    installConsole(port);

    // ADR-0004's ceiling, handed over per run. The host's init guard requires the field;
    // the fallback only exists so a hand-built frame cannot silently wedge the surface
    // (the host's arrival-counted backstop still catches a flood in that case).
    maxPendingCalls =
      typeof frame.maxPendingCalls === "number" &&
      Number.isFinite(frame.maxPendingCalls) &&
      frame.maxPendingCalls > 0
        ? frame.maxPendingCalls
        : Number.POSITIVE_INFINITY;

    const tools: Record<string, (args: unknown) => Promise<unknown>> = {};
    const bindingNames = Array.isArray(frame.bindings)
      ? frame.bindings.filter((name): name is string => typeof name === "string")
      : [];
    for (const name of bindingNames) tools[name] = makeBinding(name, port);
    // Known-but-disabled tools (T7, #21): stub each with an actionable error instead of
    // letting the program hit `tools.write is not a function`.
    const available = bindingNames.join(", ") || "(none)";
    const candidates = Array.isArray(frame.bindingCandidates) ? frame.bindingCandidates : [];
    for (const name of candidates) {
      if (typeof name !== "string" || tools[name]) continue;
      tools[name] = async () => {
        throw new ToolCallError(
          name,
          `no binding named "${name}" in this run; available bindings: ${available}`,
        );
      };
    }
    globals().tools = tools;
    // Field report pitfall #5 (2026-09-29): the bound set can grow between runs (late-registered
    // extension tools), so the program sees THIS run's actual manifest — the same names as the
    // `tools` keys, `pi.dispatch` included only when it is bound — instead of a static list.
    // It is reinstalled per run: `restoreWarmBaseline` deletes the previous run's copy before
    // `startRun` replaces it.
    globals().ptcBindings = Object.freeze([...bindingNames]);

    if (frame.surface === "workflow") {
      const maxItemsPerCall = typeof frame.maxItemsPerCall === "number" ? frame.maxItemsPerCall : 0;
      installWorkflowHelpers(frame.args, maxItemsPerCall, port);
    }

    void runProgram(typeof frame.code === "string" ? frame.code : "", generation, port);
  };

  /**
   * Handle one host frame, tagging it with the port it arrived on: that port *is* the run's
   * control port if the frame is an `init` (see `startRun`), so the run's frames stay on the
   * channel its own host is listening to.
   */
  const handleHostFrame = (raw: unknown, port: WorkerMainPort): void => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
    const frame = raw as Record<string, unknown>;
    if (frame.kind === hostFrame.init) {
      // Only accept init in READY — during CREATED/BOOTING we are not installed yet,
      // during RUNNING a previous run is still in flight (or settling via `reset()`).
      if (state !== "READY") return;
      // A fresh run: claim the worker by bumping the run ordinal, then hand that ordinal
      // to the run so its eventual `reset()` can prove it still owns the worker.
      runGeneration += 1;
      const generation = runGeneration;
      state = "RUNNING";
      startRun(frame, generation, port);
      return;
    }
    if (frame.kind === hostFrame.callResult) {
      settleCall(frame);
      return;
    }
    if (frame.kind === hostFrame.cancel) {
      const reason = frame.reason === "timeout" ? "timeout" : "abort";
      if (state === "READY") {
        // No run is in flight, so there is nothing to flush — confirm the cancel instead of
        // leaving the host to wait out its window (see `reportIdleCancel`).
        reportIdleCancel(reason, port);
        return;
      }
      cancelPending(reason);
    }
  };

  // `port.on("message", ...)` hands over the raw value — unlike a browser `MessageEvent`
  // there is no `{ data }` wrapper to unwrap here.
  state = "BOOTING";
  deps.parentPort.on("message", (value: unknown) => {
    if (typeof value !== "object" || value === null) return;
    const frame = value as Record<string, unknown>;
    if (frame.kind !== hostFrame.connect) return;
    const port = frame.port;
    if (
      typeof port !== "object" ||
      port === null ||
      typeof (port as WorkerMainPort).on !== "function"
    )
      return;
    const connected = port as WorkerMainPort;
    // A `connect` is a (re)handover: the pool gives this worker to the run that just built this
    // channel. A previous run may still be unwinding here — it was superseded, so its `reset()`
    // will be a no-op and the new run's `startRun` is what clears what it left behind. Frames are
    // handled with the port they arrived on, which is how each run captures its own control port.
    control = connected;
    connected.on("message", (raw: unknown) => {
      handleHostFrame(raw, connected);
    });
    // The host is gone (it closed the control port, e.g. after terminating the run): no
    // response can arrive any more, so stop waiting for one. Only the port the worker still
    // owns gets to say that, though: `close` is a queued event, and a run the host abandoned
    // has its port closed while the worker may already belong to the next run, whose calls are
    // in flight in the *shared* `pending` map — flushing on a superseded run's late close would
    // reject the next run's calls. (A close with no handover since keeps `control === connected`,
    // which is the case this flush exists for.)
    connected.on("close", () => {
      if (control === connected) flushPendingCalls(closedError());
    });
    installWarningCapture();
    // Snapshot `globalThis` once, at boot, before any run has touched it: this is the warm
    // baseline every reset restores to. A later `connect` must **not** re-snapshot — whatever the
    // run it superseded left on `globalThis` would be baked into the baseline and become
    // permanent, which is the leak the baseline exists to prevent.
    //
    // That one-shot snapshot is also how this handler tells a first boot from a handover, which is
    // what decides the fate of a leftover cancel verdict below.
    const isFirstBoot = warmBaseline === undefined;
    if (isFirstBoot) warmBaseline = new Map(Object.entries(globals()));
    // The handover's own transition (ADR-0017 §10(h)): a `connect` puts the worker back in `READY`
    // **unconditionally**, from whichever state it was in — `BOOTING` on the first connect, and on
    // every later one from `RUNNING` (a run the pool took back while its program was still
    // unwinding) or from `READY` (an idle worker). §5 records the machine as
    // `CREATED → BOOTING → READY ↔ RUNNING` with `init` and the settle as its transitions; this
    // forced re-entry to `READY` is the one it does not mention, and it is what makes warm reuse
    // work at all — the next run never has to wait for the previous program to stop. It
    // deliberately does *not* clean up on the way: no flush, no `globalThis` restore. The
    // superseded run may still be unwinding, its late `reset()` is a generation-guarded no-op, and
    // clearing is the incoming run's `startRun` (§10(d)).
    state = "READY";
    // A cancel that landed while this worker was still booting is the whole story: the host asked
    // to stop before it ever handed over a program. Report it instead of announcing readiness for
    // a run that is already over — otherwise the host restarts its grace window on this `ready`
    // and waits out the full window for a program that will never start, and the `init` it sends
    // next would clear this verdict and run the program anyway.
    //
    // That reasoning holds only for the **first** connect. On a later one the verdict belongs to
    // the run this worker just stopped serving, and the caller on the other end is a stranger with
    // its own lifecycle: replaying "cancelled" down its channel would fail it before its `init`
    // ever arrives (ADR-0017 §10(e)). Clearing silently is what keeps one run's cancel from ending
    // the next.
    if (cancelled !== undefined) {
      if (isFirstBoot) {
        reportIdleCancel(cancelled, connected);
        return;
      }
      cancelled = undefined;
    }
    post({ kind: workerFrame.ready }, connected);
  });
}
