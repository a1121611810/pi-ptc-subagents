/**
 * Worker-side PTC runtime: installs one surface, runs one program, routes `tools.*`
 * calls back to the host.
 *
 * ⚠️ SELF-CONTAINMENT RULE — read before editing.
 *
 * `workerMain` is serialized with `Function.prototype.toString()` and re-evaluated
 * inside a freshly spawned worker (see `worker-source.ts`). Everything it touches at
 * runtime must therefore be one of:
 *
 *   1. a worker-realm global (`process`, `globalThis`, `console`, `Map`, `Promise`, …),
 *   2. a declaration nested inside this function,
 *   3. a `deps` property injected at spawn.
 *
 * It must never reference an imported *value* or any other module-scope binding: those
 * names are resolved in the host bundle, not inside the worker, and the composed source
 * would fail with a `ReferenceError`. TypeScript types from this repo are fine — they
 * are erased from both the dev (type-stripping) and bundled (`rolldown`) forms of the
 * function, which is what makes `toString()` output valid plain JavaScript in both.
 */
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
  /** The spawning host's `workerData`: `{ runId, env }` (F3). */
  workerData: unknown;
  /** `node:util`'s `inspect`, used to render non-string console arguments. */
  inspect: (value: unknown, options?: Record<string, unknown>) => string;
  /** `node:module`'s `stripTypeScriptTypes`: the program is TypeScript, run type-stripped. */
  stripTypes: (code: string, options: { mode: "strip" }) => string;
  protocol: WorkerProtocolSpec;
}

export function workerMain(deps: WorkerMainDeps): void {
  const hostFrame = deps.protocol.hostFrame;
  const workerFrame = deps.protocol.workerFrame;
  const logLevel = deps.protocol.logLevel;
  const errorKind = deps.protocol.errorKind;
  /** Wrapper name used to compile a program body (`return …` is legal inside it). */
  const programName = "__ptcProgram";

  let control: WorkerMainPort | undefined;
  let started = false;
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
   * Frames inside the worker bootstrap point at the `data:` URL the worker was spawned
   * from, which is tens of kilobytes of encoded source; dropping those lines and capping
   * the depth keeps the model-facing stack (and the output budget) sane.
   */
  const stackOf = (error: unknown): string | undefined => {
    if (!(error instanceof Error) || typeof error.stack !== "string") return undefined;
    const lines = error.stack.split("\n");
    const kept = [lines[0] ?? ""];
    for (const line of lines.slice(1)) {
      if (line.includes("data:text/javascript")) continue;
      kept.push(line);
      if (kept.length >= 6) break;
    }
    return kept.join("\n");
  };
  const describeValue = (value: unknown): string => {
    if (value === null) return "null";
    if (Array.isArray(value)) return "an array";
    return `a ${typeof value}`;
  };

  const post = (frame: unknown): boolean => {
    if (!control) return false;
    try {
      control.postMessage(frame);
      return true;
    } catch {
      // Port closed (run already settled) — nothing useful to do with the frame.
      return false;
    }
  };

  const postLog = (level: PtcLogLevel, text: string): void => {
    post({ kind: workerFrame.log, level, text });
  };

  const postError = (kind: PtcErrorKind, message: string, stack?: string): void => {
    post(
      stack === undefined
        ? { kind: workerFrame.error, error: { kind, message } }
        : { kind: workerFrame.error, error: { kind, message, stack } },
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
   * so the model (not the terminal) sees the program's output.
   */
  const installConsole = (): void => {
    const write = (level: PtcLogLevel) => {
      return (...args: unknown[]): void => {
        postLog(level, formatArgs(args));
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
    return new Function(`${source}\nreturn ${programName}();`) as () => unknown;
  };

  const runProgram = async (code: string): Promise<void> => {
    let program: () => unknown;
    try {
      program = compileProgram(code);
    } catch (error) {
      postError(
        errorKind.exception,
        `program failed to compile: ${messageOf(error)}`,
        stackOf(error),
      );
      return;
    }
    try {
      const value = await program();
      const normalized = toJsonValue(value);
      if (!normalized.ok) {
        postError(errorKind.invalidOutput, normalized.reason);
        return;
      }
      post(
        normalized.value === undefined
          ? { kind: workerFrame.result }
          : { kind: workerFrame.result, value: normalized.value },
      );
    } catch (error) {
      postError(cancelled ?? errorKind.exception, messageOf(error), stackOf(error));
    }
  };

  /**
   * `tools.<name>(args)` — acquire an admission slot, post a call frame, and await the
   * matching `call-result`.
   *
   * The slot is released on every exit path (settled, admission refused by `post`, cancel),
   * which is what keeps a burst draining instead of deadlocking.
   */
  const makeBinding = (name: string) => {
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
        const sent = post({ kind: workerFrame.call, callId, tool: name, args });
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

  const installWorkflowHelpers = (args: unknown, maxItemsPerCall: number): void => {
    const target = globals();
    target.args = args === undefined ? null : args;

    target.log = (message: unknown): void => {
      if (typeof message !== "string")
        throw new TypeError(`log(message) expects a string, received ${describeValue(message)}`);
      post({ kind: workerFrame.narration, message });
    };

    target.phase = (title: unknown): void => {
      if (typeof title !== "string")
        throw new TypeError(`phase(title) expects a string, received ${describeValue(title)}`);
      post({ kind: workerFrame.phase, title });
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
  /* frame handling                                                      */
  /* ------------------------------------------------------------------ */

  const startRun = (frame: Record<string, unknown>): void => {
    installFrozenEnv();
    installConsole();

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
    for (const name of bindingNames) tools[name] = makeBinding(name);
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

    if (frame.surface === "workflow") {
      const maxItemsPerCall = typeof frame.maxItemsPerCall === "number" ? frame.maxItemsPerCall : 0;
      installWorkflowHelpers(frame.args, maxItemsPerCall);
    }

    void runProgram(typeof frame.code === "string" ? frame.code : "");
  };

  const handleHostFrame = (raw: unknown): void => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
    const frame = raw as Record<string, unknown>;
    if (frame.kind === hostFrame.init) {
      if (started) return;
      started = true;
      startRun(frame);
      return;
    }
    if (frame.kind === hostFrame.callResult) {
      settleCall(frame);
      return;
    }
    if (frame.kind === hostFrame.cancel) {
      cancelPending(frame.reason === "timeout" ? "timeout" : "abort");
    }
  };

  // `port.on("message", ...)` hands over the raw value — unlike a browser `MessageEvent`
  // there is no `{ data }` wrapper to unwrap here.
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
    control = port as WorkerMainPort;
    control.on("message", handleHostFrame);
    // The host is gone (it closed the control port, e.g. after terminating the run): no
    // response can arrive any more, so stop waiting for one.
    control.on("close", () => {
      flushPendingCalls(closedError());
    });
    installWarningCapture();
    post({ kind: workerFrame.ready });
  });
}
