/**
 * Host-side dispatcher: one `runPtcProgram()` call = one worker = one program.
 *
 * Responsibilities:
 * - spawn a hardened worker (F1 env scrub, F2 V8 caps, F3 frozen per-run env in
 *   `workerData`, F4 `cwd` carried in the run config and handed to the bindings),
 * - complete the `MessageChannel` handshake and send the `init` frame,
 * - route `tools.*` calls to the binding table — concurrently, with DSH's
 *   `maxParallelSubCalls` forwarding cap and `maxPendingCalls` admission control,
 * - collect logs / narration / phases and enforce the joint output budget,
 * - enforce the deadline, honour caller cancellation, and always tear the worker down.
 *
 * Everything the worker can influence is treated as untrusted input: every frame goes
 * through the protocol guards, is size-checked, and can only ever end the run.
 */
import { randomUUID } from "node:crypto";
import { MessageChannel, Worker } from "node:worker_threads";
import type { MessagePort } from "node:worker_threads";
import type { BindingTable } from "./bindings.ts";
import { createWorkerEnv, effectiveTimeoutMs, resolveConfig } from "./limits.ts";
import type { PtcConfig, PtcSurface } from "./limits.ts";
import {
  HOST_FRAME_KIND,
  isPtcHostFrame,
  isPtcWorkerFrame,
  PTC_ERROR_KIND,
  WORKER_FRAME_KIND,
  workerProtocolSpec,
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
} from "./protocol.ts";
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
  /** Identifier carried to the worker; generated when omitted. */
  runId?: string;
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
  /** Failure details; absent on success. */
  error?: PtcErrorShape;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Serialized byte size of a frame, the unit both the output and message budgets use. */
function serializedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    // Cyclic or otherwise unserializable payload: report as unbounded so the caller fails the run.
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
  const protocol = workerProtocolSpec();
  const env = createWorkerEnv();
  const runId = options.runId ?? randomUUID();
  const timeoutMs = effectiveTimeoutMs(options.timeoutMs, config);

  const logs: string[] = [];
  const narrations: string[] = [];
  const phases: string[] = [];

  if (options.signal?.aborted) {
    return { logs, narrations, phases, error: { kind: PTC_ERROR_KIND.abort, message: "run cancelled before start" } };
  }

  return await new Promise<PtcRunOutcome>((resolve) => {
    const worker = new Worker(buildWorkerUrl(protocol), {
      name: `ptc-${options.surface}`,
      // F1: allow-list only — never the host's full environment.
      env,
      // F3: the same frozen snapshot is the worker's recorded environment.
      workerData: { runId, env },
      // F2: V8 caps (ADR-0005).
      resourceLimits: {
        maxOldGenerationSizeMb: config.maxOldGenerationSizeMb,
        maxYoungGenerationSizeMb: config.maxYoungGenerationSizeMb,
      },
    });
    const channel = new MessageChannel();
    const control: MessagePort = channel.port1;
    const workerPort: MessagePort = channel.port2;

    const bindingAbort = new AbortController();
    let settled = false;
    let cancelling: PtcCancelReason | undefined;
    let pendingCalls = 0;
    let outputBytes = 0;
    let activeDispatches = 0;
    const dispatchWaiters: Array<() => void> = [];
    let runTimer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;

    const cancelMessage = (reason: PtcCancelReason): string =>
      reason === "timeout" ? `run timed out after ${timeoutMs} ms` : "run cancelled";

    const finish = (outcome: PtcRunOutcome): void => {
      if (settled) return;
      settled = true;
      if (runTimer) clearTimeout(runTimer);
      if (graceTimer) clearTimeout(graceTimer);
      options.signal?.removeEventListener("abort", onAbortSignal);
      bindingAbort.abort();
      control.close();
      void worker.terminate();
      resolve(outcome);
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
        maxItemsPerCall: config.maxItemsPerCall,
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

    const acquireDispatchSlot = async (): Promise<void> => {
      if (activeDispatches < config.maxParallelSubCalls) {
        activeDispatches += 1;
        return;
      }
      await new Promise<void>((slot) => {
        dispatchWaiters.push(slot);
      });
    };

    const releaseDispatchSlot = (): void => {
      const next = dispatchWaiters.shift();
      if (next) {
        // Hand the slot over directly; `activeDispatches` is unchanged.
        next();
        return;
      }
      activeDispatches -= 1;
    };

    const handleCall = (frame: PtcCallFrame): void => {
      pendingCalls += 1;
      if (pendingCalls > config.maxPendingCalls) {
        fail(PTC_ERROR_KIND.protocol, `more than maxPendingCalls (${config.maxPendingCalls}) binding calls in flight`);
        return;
      }
      void dispatchCall(frame).finally(() => {
        pendingCalls -= 1;
      });
    };

    const dispatchCall = async (frame: PtcCallFrame): Promise<void> => {
      const binding = options.bindings.get(frame.tool);
      if (!binding) {
        postCallResult({
          kind: HOST_FRAME_KIND.callResult,
          callId: frame.callId,
          tool: frame.tool,
          ok: false,
          message: `no binding named "${frame.tool}" in this run`,
        });
        return;
      }
      await acquireDispatchSlot();
      if (settled) {
        releaseDispatchSlot();
        return;
      }
      try {
        const value = await binding.execute(frame.args, { signal: bindingAbort.signal, callId: frame.callId });
        postCallResult({ kind: HOST_FRAME_KIND.callResult, callId: frame.callId, tool: frame.tool, ok: true, value });
      } catch (error) {
        postCallResult({
          kind: HOST_FRAME_KIND.callResult,
          callId: frame.callId,
          tool: frame.tool,
          ok: false,
          message: messageOf(error),
        });
      } finally {
        releaseDispatchSlot();
      }
    };

    const postCallResult = (frame: PtcCallResultFrame): void => {
      if (settled) return;
      try {
        control.postMessage(frame);
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
      }
    };

    const settleTerminal = (outcome: PtcRunOutcome): PtcRunOutcome => {
      if (!cancelling) return outcome;
      // Once cancelled, the caller asked for a stop: the run reports the stop, not the
      // value the program managed to produce inside the grace window.
      return {
        logs,
        narrations,
        phases,
        error: { kind: cancelling === "timeout" ? PTC_ERROR_KIND.timeout : PTC_ERROR_KIND.abort, message: cancelMessage(cancelling) },
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
        fail(PTC_ERROR_KIND.protocol, `control frame of ${bytes} bytes exceeds maxMessageBytes (${config.maxMessageBytes})`);
        return;
      }

      switch (frame.kind) {
        case WORKER_FRAME_KIND.ready:
          sendInit();
          return;
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
        case WORKER_FRAME_KIND.result:
          if (!accountOutput(bytes, "completion value")) return;
          finish(settleTerminal(frame.value === undefined ? { logs, narrations, phases } : { logs, narrations, phases, value: frame.value }));
          return;
        case WORKER_FRAME_KIND.error:
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

    function beginCancel(reason: PtcCancelReason): void {
      if (settled || cancelling) return;
      cancelling = reason;
      if (runTimer) {
        clearTimeout(runTimer);
        runTimer = undefined;
      }
      bindingAbort.abort();
      sendControl({ kind: HOST_FRAME_KIND.cancel, reason });
      graceTimer = setTimeout(() => {
        fail(reason === "timeout" ? PTC_ERROR_KIND.timeout : PTC_ERROR_KIND.abort, cancelMessage(reason));
      }, config.graceMs);
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
