/**
 * The PTC wire protocol: every frame that crosses the host↔worker boundary, plus a
 * runtime guard for every arm of both closed unions.
 *
 * Shape rules:
 * - Frame kinds, log levels and error kinds live here once; the worker receives the
 *   same tables as plain data at spawn (`workerProtocolSpec`), so the two ends cannot
 *   drift on names.
 * - Guards validate *shape only*. They never walk payloads: a `log` frame may carry a
 *   64 MiB string and a `call` frame arbitrary tool arguments, so byte accounting is
 *   the dispatcher's job (see `serializedBytes` usage there).
 * - Error kinds are R1 §3's taxonomy minus `sandbox-unavailable` (ADR-0007 ships no OS
 *   sandbox) and minus any `agent`-related kind (there is no `agent()` helper).
 */
import { MessagePort } from "node:worker_threads";
import type { PtcSurface } from "./limits.ts";

/** host → worker */
export const HOST_FRAME_KIND = Object.freeze({
  connect: "connect",
  init: "init",
  callResult: "call-result",
  cancel: "cancel",
} as const);

/** worker → host */
export const WORKER_FRAME_KIND = Object.freeze({
  ready: "ready",
  call: "call",
  log: "log",
  narration: "narration",
  phase: "phase",
  result: "result",
  error: "error",
} as const);

export const PTC_LOG_LEVEL = Object.freeze({
  log: "log",
  info: "info",
  warn: "warn",
  error: "error",
  debug: "debug",
} as const);
export type PtcLogLevel = (typeof PTC_LOG_LEVEL)[keyof typeof PTC_LOG_LEVEL];

export const PTC_ERROR_KIND = Object.freeze({
  /** Program parse error or thrown exception (includes `ReferenceError` from a helper that does not exist on this surface). */
  exception: "exception",
  /** Elapsed deadline expiry. */
  timeout: "timeout",
  /** Caller cancellation. */
  abort: "abort",
  /** Malformed or excessive control traffic. */
  protocol: "protocol",
  /** Early worker exit or a worker-level crash. */
  workerExit: "worker-exit",
  /** Completion value could not be materialized as lossless JSON. */
  invalidOutput: "invalid-output",
  /** Oversized outer result; collected logs are retained. */
  outputLimit: "output-limit",
} as const);
export type PtcErrorKind = (typeof PTC_ERROR_KIND)[keyof typeof PTC_ERROR_KIND];

export type PtcCancelReason = "timeout" | "abort";

/** Lossless-JSON payloads, the only values that may cross the boundary as data. */
export interface PtcJsonObject {
  [key: string]: PtcJsonValue;
}
export type PtcJsonValue = string | number | boolean | null | PtcJsonValue[] | PtcJsonObject;

export interface PtcErrorShape {
  kind: PtcErrorKind;
  message: string;
  stack?: string;
}

/* -------------------------------------------------------------------------- */
/* host → worker                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Handshake frame sent over `parentPort` right after spawn.
 *
 * The port must appear *in the payload*, not only in the transfer list: Node silently
 * drops a transfer-list-only entry (the worker receives the message without any port
 * and would wait forever), and it does not populate `msg.ports` for `worker_threads`
 * messages the way the browser `MessageEvent.ports` does. Both were verified against
 * Node v24.18.0 while writing this module.
 */
export interface PtcConnectFrame {
  kind: "connect";
  port: MessagePort;
}

/** First frame on the control port: installs the surface and starts the program. */
export interface PtcInitFrame {
  kind: "init";
  runId: string;
  surface: PtcSurface;
  code: string;
  /** Binding names the worker may expose as `tools.<name>`; the keys of the host table. */
  bindings: readonly string[];
  maxItemsPerCall: number;
  /** Workflow surface only: value bound to the `args` global. */
  args?: unknown;
}

export interface PtcCallResultOkFrame {
  kind: "call-result";
  callId: number;
  tool: string;
  ok: true;
  value: unknown;
}

export interface PtcCallResultErrorFrame {
  kind: "call-result";
  callId: number;
  tool: string;
  ok: false;
  message: string;
}

export type PtcCallResultFrame = PtcCallResultOkFrame | PtcCallResultErrorFrame;

export interface PtcCancelFrame {
  kind: "cancel";
  reason: PtcCancelReason;
}

export type PtcHostFrame = PtcConnectFrame | PtcInitFrame | PtcCallResultFrame | PtcCancelFrame;

/* -------------------------------------------------------------------------- */
/* worker → host                                                              */
/* -------------------------------------------------------------------------- */

/** Control port is live and the surface may be installed. */
export interface PtcReadyFrame {
  kind: "ready";
}

/** `tools.<tool>(args)`: the worker is waiting for a `call-result` with the same id. */
export interface PtcCallFrame {
  kind: "call";
  callId: number;
  tool: string;
  args: unknown;
}

export interface PtcLogFrame {
  kind: "log";
  level: PtcLogLevel;
  text: string;
}

/** Workflow `log(message)`: narration for the UI, not console output. */
export interface PtcNarrationFrame {
  kind: "narration";
  message: string;
}

/** Workflow `phase(title)`. */
export interface PtcPhaseFrame {
  kind: "phase";
  title: string;
}

/** Program completed. `value` is absent when the program returned nothing. */
export interface PtcResultFrame {
  kind: "result";
  value?: PtcJsonValue;
}

export interface PtcErrorFrame {
  kind: "error";
  error: PtcErrorShape;
}

export type PtcWorkerFrame =
  | PtcReadyFrame
  | PtcCallFrame
  | PtcLogFrame
  | PtcNarrationFrame
  | PtcPhaseFrame
  | PtcResultFrame
  | PtcErrorFrame;

/* -------------------------------------------------------------------------- */
/* guards                                                                     */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPtcLogLevel(value: unknown): value is PtcLogLevel {
  return typeof value === "string" && Object.values(PTC_LOG_LEVEL).some((level) => level === value);
}

export function isPtcErrorKind(value: unknown): value is PtcErrorKind {
  return typeof value === "string" && Object.values(PTC_ERROR_KIND).some((kind) => kind === value);
}

export function isPtcCancelReason(value: unknown): value is PtcCancelReason {
  return value === "timeout" || value === "abort";
}

export function isPtcConnectFrame(value: unknown): value is PtcConnectFrame {
  return isRecord(value) && value.kind === HOST_FRAME_KIND.connect && value.port instanceof MessagePort;
}

export function isPtcInitFrame(value: unknown): value is PtcInitFrame {
  return (
    isRecord(value) &&
    value.kind === HOST_FRAME_KIND.init &&
    typeof value.runId === "string" &&
    (value.surface === "run_code" || value.surface === "workflow") &&
    typeof value.code === "string" &&
    Array.isArray(value.bindings) &&
    value.bindings.every((name) => typeof name === "string") &&
    typeof value.maxItemsPerCall === "number" &&
    Number.isFinite(value.maxItemsPerCall)
  );
}

export function isPtcCallResultFrame(value: unknown): value is PtcCallResultFrame {
  if (!isRecord(value) || value.kind !== HOST_FRAME_KIND.callResult) return false;
  if (!Number.isInteger(value.callId) || typeof value.tool !== "string") return false;
  if (value.ok === true) return "value" in value;
  return value.ok === false && typeof value.message === "string";
}

export function isPtcCancelFrame(value: unknown): value is PtcCancelFrame {
  return isRecord(value) && value.kind === HOST_FRAME_KIND.cancel && isPtcCancelReason(value.reason);
}

export function isPtcHostFrame(value: unknown): value is PtcHostFrame {
  return isPtcConnectFrame(value) || isPtcInitFrame(value) || isPtcCallResultFrame(value) || isPtcCancelFrame(value);
}

export function isPtcReadyFrame(value: unknown): value is PtcReadyFrame {
  return isRecord(value) && value.kind === WORKER_FRAME_KIND.ready;
}

export function isPtcCallFrame(value: unknown): value is PtcCallFrame {
  return (
    isRecord(value) &&
    value.kind === WORKER_FRAME_KIND.call &&
    Number.isInteger(value.callId) &&
    typeof value.tool === "string" &&
    value.tool.length > 0 &&
    "args" in value
  );
}

export function isPtcLogFrame(value: unknown): value is PtcLogFrame {
  return isRecord(value) && value.kind === WORKER_FRAME_KIND.log && isPtcLogLevel(value.level) && typeof value.text === "string";
}

export function isPtcNarrationFrame(value: unknown): value is PtcNarrationFrame {
  return isRecord(value) && value.kind === WORKER_FRAME_KIND.narration && typeof value.message === "string";
}

export function isPtcPhaseFrame(value: unknown): value is PtcPhaseFrame {
  return isRecord(value) && value.kind === WORKER_FRAME_KIND.phase && typeof value.title === "string";
}

export function isPtcResultFrame(value: unknown): value is PtcResultFrame {
  return isRecord(value) && value.kind === WORKER_FRAME_KIND.result;
}

export function isPtcErrorFrame(value: unknown): value is PtcErrorFrame {
  if (!isRecord(value) || value.kind !== WORKER_FRAME_KIND.error) return false;
  const error = value.error;
  return (
    isRecord(error) &&
    isPtcErrorKind(error.kind) &&
    typeof error.message === "string" &&
    (error.stack === undefined || typeof error.stack === "string")
  );
}

export function isPtcWorkerFrame(value: unknown): value is PtcWorkerFrame {
  return (
    isPtcReadyFrame(value) ||
    isPtcCallFrame(value) ||
    isPtcLogFrame(value) ||
    isPtcNarrationFrame(value) ||
    isPtcPhaseFrame(value) ||
    isPtcResultFrame(value) ||
    isPtcErrorFrame(value)
  );
}

/* -------------------------------------------------------------------------- */
/* worker-side spec                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The protocol tables as plain data, injected into the worker at spawn.
 *
 * The worker bootstrap is self-contained (see `worker-main.ts`), so it cannot import
 * these constants — it receives them instead, which is what keeps both ends on the
 * same strings.
 */
export interface WorkerProtocolSpec {
  hostFrame: typeof HOST_FRAME_KIND;
  workerFrame: typeof WORKER_FRAME_KIND;
  logLevel: typeof PTC_LOG_LEVEL;
  errorKind: typeof PTC_ERROR_KIND;
}

export function workerProtocolSpec(): WorkerProtocolSpec {
  return {
    hostFrame: HOST_FRAME_KIND,
    workerFrame: WORKER_FRAME_KIND,
    logLevel: PTC_LOG_LEVEL,
    errorKind: PTC_ERROR_KIND,
  };
}
