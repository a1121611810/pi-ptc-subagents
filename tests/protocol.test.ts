import { expect, test } from "vitest";
import { MessageChannel } from "node:worker_threads";
import {
  HOST_FRAME_KIND,
  isPtcCallFrame,
  isPtcCallResultFrame,
  isPtcCancelFrame,
  isPtcCancelReason,
  isPtcConnectFrame,
  isPtcErrorFrame,
  isPtcErrorKind,
  isPtcHostFrame,
  isPtcInitFrame,
  isPtcLogFrame,
  isPtcLogLevel,
  isPtcNarrationFrame,
  isPtcPhaseFrame,
  isPtcReadyFrame,
  isPtcResultFrame,
  isPtcWorkerFrame,
  PTC_ERROR_KIND,
  PTC_LOG_LEVEL,
  WORKER_FRAME_KIND,
  workerProtocolSpec,
} from "../src/runtime/protocol.ts";
import { DEFAULT_CONFIG } from "../src/runtime/limits.ts";

function withPort(): { frame: unknown; close: () => void } {
  const channel = new MessageChannel();
  return {
    frame: { kind: HOST_FRAME_KIND.connect, port: channel.port2 },
    close: () => {
      channel.port1.close();
      channel.port2.close();
    },
  };
}

const initFrame = {
  kind: HOST_FRAME_KIND.init,
  runId: "run-1",
  surface: "run_code",
  code: "return 1;",
  bindings: ["read", "bash"],
  bindingCandidates: ["read", "bash", "edit", "write"],
  maxItemsPerCall: DEFAULT_CONFIG.maxItemsPerCall,
  maxPendingCalls: DEFAULT_CONFIG.maxPendingCalls,
};

test("frame kind tables are closed sets of unique strings", () => {
  for (const table of [HOST_FRAME_KIND, WORKER_FRAME_KIND, PTC_ERROR_KIND, PTC_LOG_LEVEL]) {
    const values = Object.values(table);
    expect(new Set(values).size).toBe(values.length);
    for (const value of values) expect(typeof value).toBe("string");
    expect(Object.isFrozen(table)).toBe(true);
  }
  expect(workerProtocolSpec()).toEqual({
    hostFrame: HOST_FRAME_KIND,
    workerFrame: WORKER_FRAME_KIND,
    logLevel: PTC_LOG_LEVEL,
    errorKind: PTC_ERROR_KIND,
  });
});

test("connect frame guard requires a live MessagePort in the payload", () => {
  const { frame, close } = withPort();
  try {
    expect(isPtcConnectFrame(frame)).toBe(true);
    expect(isPtcHostFrame(frame)).toBe(true);
    // Transfer-list-only ports never reach `msg.ports`, so a payload without the port
    // must not validate: the worker would otherwise silently wait forever.
    expect(isPtcConnectFrame({ kind: HOST_FRAME_KIND.connect })).toBe(false);
    expect(isPtcConnectFrame({ kind: HOST_FRAME_KIND.connect, port: {} })).toBe(false);
    expect(
      isPtcConnectFrame({ kind: "ready", port: (frame as { port: unknown }).port }),
    ).toBe(false);
  } finally {
    close();
  }
});

test("init frame guard validates every field", () => {
  expect(isPtcInitFrame(initFrame)).toBe(true);
  expect(isPtcInitFrame({ ...initFrame, args: { task: "x" } })).toBe(true);
  expect(isPtcInitFrame({ ...initFrame, runId: 1 })).toBe(false);
  expect(isPtcInitFrame({ ...initFrame, surface: "workflow_typo" })).toBe(false);
  expect(isPtcInitFrame({ ...initFrame, code: undefined })).toBe(false);
  expect(isPtcInitFrame({ ...initFrame, bindings: ["read", 7] })).toBe(false);
  expect(isPtcInitFrame({ ...initFrame, bindings: "read" })).toBe(false);
  expect(isPtcInitFrame({ ...initFrame, bindingCandidates: ["read", 7] })).toBe(false);
  expect(isPtcInitFrame({ ...initFrame, bindingCandidates: undefined })).toBe(false);
  expect(isPtcInitFrame({ ...initFrame, maxItemsPerCall: Number.NaN })).toBe(false);
  expect(isPtcInitFrame({ ...initFrame, maxPendingCalls: undefined })).toBe(false);
  expect(isPtcInitFrame({ ...initFrame, maxPendingCalls: Number.POSITIVE_INFINITY })).toBe(false);
  expect(isPtcInitFrame({ ...initFrame, kind: HOST_FRAME_KIND.cancel })).toBe(false);
  expect(isPtcInitFrame(null)).toBe(false);
});

test("call-result frame guard covers both arms", () => {
  const ok = {
    kind: HOST_FRAME_KIND.callResult,
    callId: 1,
    tool: "read",
    ok: true,
    value: { content: [] },
  };
  expect(isPtcCallResultFrame(ok)).toBe(true);
  expect(
    isPtcCallResultFrame({ ...ok, value: undefined }),
  ).toBe(true);
  expect(
    isPtcCallResultFrame({ kind: HOST_FRAME_KIND.callResult, callId: 1, tool: "read", ok: true }),
  ).toBe(false);

  const failed = {
    kind: HOST_FRAME_KIND.callResult,
    callId: 1,
    tool: "read",
    ok: false,
    message: "boom",
  };
  expect(isPtcCallResultFrame(failed)).toBe(true);
  expect(isPtcCallResultFrame({ ...failed, message: 7 })).toBe(false);
  expect(isPtcCallResultFrame({ ...failed, callId: 1.5 })).toBe(false);
  expect(isPtcCallResultFrame({ ...failed, ok: "false" })).toBe(false);
  expect(isPtcCallResultFrame({ ...failed, tool: undefined })).toBe(false);
});

test("cancel frame guard validates reason and kind", () => {
  expect(isPtcCancelFrame({ kind: HOST_FRAME_KIND.cancel, reason: "timeout" })).toBe(true);
  expect(isPtcCancelFrame({ kind: HOST_FRAME_KIND.cancel, reason: "abort" })).toBe(true);
  expect(isPtcCancelFrame({ kind: HOST_FRAME_KIND.cancel, reason: "stop" })).toBe(false);
  expect(isPtcCancelFrame({ kind: HOST_FRAME_KIND.cancel })).toBe(false);
  expect(isPtcCancelReason("abort")).toBe(true);
  expect(isPtcCancelReason("cancel")).toBe(false);
});

test("host frame union rejects unknown kinds and non-frames", () => {
  expect(isPtcHostFrame({ kind: "nope" })).toBe(false);
  expect(isPtcHostFrame(undefined)).toBe(false);
  expect(isPtcHostFrame([])).toBe(false);
  expect(isPtcHostFrame("connect")).toBe(false);
  expect(
    isPtcHostFrame({ kind: WORKER_FRAME_KIND.ready }),
  ).toBe(false);
});

test("ready frame guard", () => {
  expect(isPtcReadyFrame({ kind: WORKER_FRAME_KIND.ready })).toBe(true);
  expect(isPtcReadyFrame({ kind: WORKER_FRAME_KIND.ready, extra: 1 })).toBe(true);
  expect(isPtcReadyFrame({ kind: WORKER_FRAME_KIND.call })).toBe(false);
  expect(isPtcWorkerFrame({ kind: WORKER_FRAME_KIND.ready })).toBe(true);
});

test("call frame guard validates ids, names and payload presence", () => {
  const call = { kind: WORKER_FRAME_KIND.call, callId: 3, tool: "bash", args: { command: "ls" } };
  expect(isPtcCallFrame(call)).toBe(true);
  expect(isPtcCallFrame({ ...call, args: undefined })).toBe(true);
  expect(isPtcCallFrame({ kind: WORKER_FRAME_KIND.call, callId: 3, tool: "bash" })).toBe(false);
  expect(isPtcCallFrame({ ...call, callId: 3.5 })).toBe(false);
  expect(isPtcCallFrame({ ...call, tool: "" })).toBe(false);
  expect(isPtcCallFrame({ ...call, tool: null })).toBe(false);
});

test("log frame guard validates level and text", () => {
  expect(
    isPtcLogFrame({ kind: WORKER_FRAME_KIND.log, level: PTC_LOG_LEVEL.log, text: "hi" }),
  ).toBe(true);
  expect(
    isPtcLogFrame({ kind: WORKER_FRAME_KIND.log, level: PTC_LOG_LEVEL.error, text: "" }),
  ).toBe(true);
  expect(isPtcLogFrame({ kind: WORKER_FRAME_KIND.log, level: "verbose", text: "hi" })).toBe(false);
  expect(isPtcLogFrame({ kind: WORKER_FRAME_KIND.log, text: "hi" })).toBe(false);
  expect(isPtcLogFrame({ kind: WORKER_FRAME_KIND.log, level: PTC_LOG_LEVEL.log })).toBe(false);
  expect(isPtcLogLevel("warn")).toBe(true);
  expect(isPtcLogLevel(undefined)).toBe(false);
});

test("narration and phase frame guards", () => {
  expect(
    isPtcNarrationFrame({ kind: WORKER_FRAME_KIND.narration, message: "starting" }),
  ).toBe(true);
  expect(isPtcNarrationFrame({ kind: WORKER_FRAME_KIND.narration, message: 1 })).toBe(false);
  expect(isPtcPhaseFrame({ kind: WORKER_FRAME_KIND.phase, title: "one" })).toBe(true);
  expect(isPtcPhaseFrame({ kind: WORKER_FRAME_KIND.phase })).toBe(false);
});

test("result frame guard allows an absent value but no other shape", () => {
  expect(isPtcResultFrame({ kind: WORKER_FRAME_KIND.result })).toBe(true);
  expect(isPtcResultFrame({ kind: WORKER_FRAME_KIND.result, value: { a: [1, 2] } })).toBe(true);
  expect(isPtcResultFrame({ kind: WORKER_FRAME_KIND.result, value: undefined })).toBe(true);
  expect(isPtcResultFrame({ kind: WORKER_FRAME_KIND.phase })).toBe(false);
});

test("error frame guard validates the nested error shape", () => {
  const base = {
    kind: WORKER_FRAME_KIND.error,
    error: { kind: PTC_ERROR_KIND.exception, message: "boom" },
  };
  expect(isPtcErrorFrame(base)).toBe(true);
  expect(isPtcErrorFrame({ ...base, error: { ...base.error, stack: "at x" } })).toBe(true);
  expect(
    isPtcErrorFrame({ kind: WORKER_FRAME_KIND.error, error: { kind: "kaboom", message: "x" } }),
  ).toBe(false);
  expect(
    isPtcErrorFrame({ kind: WORKER_FRAME_KIND.error, error: { kind: PTC_ERROR_KIND.exception } }),
  ).toBe(false);
  expect(
    isPtcErrorFrame({ kind: WORKER_FRAME_KIND.error, error: { ...base.error, stack: 7 } }),
  ).toBe(false);
  expect(isPtcErrorFrame({ kind: WORKER_FRAME_KIND.error })).toBe(false);
  expect(isPtcErrorKind(PTC_ERROR_KIND.outputLimit)).toBe(true);
  expect(
    isPtcErrorKind("sandbox-unavailable"),
  ).toBe(false);
  expect(isPtcErrorKind("agent")).toBe(false);
});

test("worker frame union rejects unknown kinds and non-frames", () => {
  expect(isPtcWorkerFrame({ kind: "nope" })).toBe(false);
  expect(isPtcWorkerFrame(undefined)).toBe(false);
  expect(isPtcWorkerFrame(42)).toBe(false);
  expect(isPtcWorkerFrame([])).toBe(false);
  expect(isPtcWorkerFrame({} as unknown)).toBe(false);
  expect(
    isPtcWorkerFrame({ kind: HOST_FRAME_KIND.init }),
  ).toBe(false);
});