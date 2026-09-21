import assert from "node:assert/strict";
import { test } from "node:test";
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
  maxItemsPerCall: DEFAULT_CONFIG.maxItemsPerCall,
  maxPendingCalls: DEFAULT_CONFIG.maxPendingCalls,
};

test("frame kind tables are closed sets of unique strings", () => {
  for (const table of [HOST_FRAME_KIND, WORKER_FRAME_KIND, PTC_ERROR_KIND, PTC_LOG_LEVEL]) {
    const values = Object.values(table);
    assert.equal(new Set(values).size, values.length, "duplicate kind");
    for (const value of values) assert.equal(typeof value, "string");
    assert.equal(Object.isFrozen(table), true);
  }
  assert.deepEqual(workerProtocolSpec(), {
    hostFrame: HOST_FRAME_KIND,
    workerFrame: WORKER_FRAME_KIND,
    logLevel: PTC_LOG_LEVEL,
    errorKind: PTC_ERROR_KIND,
  });
});

test("connect frame guard requires a live MessagePort in the payload", () => {
  const { frame, close } = withPort();
  try {
    assert.equal(isPtcConnectFrame(frame), true);
    assert.equal(isPtcHostFrame(frame), true);
    // Transfer-list-only ports never reach `msg.ports`, so a payload without the port
    // must not validate: the worker would otherwise silently wait forever.
    assert.equal(isPtcConnectFrame({ kind: HOST_FRAME_KIND.connect }), false);
    assert.equal(isPtcConnectFrame({ kind: HOST_FRAME_KIND.connect, port: {} }), false);
    assert.equal(isPtcConnectFrame({ kind: "ready", port: (frame as { port: unknown }).port }), false);
  } finally {
    close();
  }
});

test("init frame guard validates every field", () => {
  assert.equal(isPtcInitFrame(initFrame), true);
  assert.equal(isPtcInitFrame({ ...initFrame, args: { task: "x" } }), true);
  assert.equal(isPtcInitFrame({ ...initFrame, runId: 1 }), false);
  assert.equal(isPtcInitFrame({ ...initFrame, surface: "workflow_typo" }), false);
  assert.equal(isPtcInitFrame({ ...initFrame, code: undefined }), false);
  assert.equal(isPtcInitFrame({ ...initFrame, bindings: ["read", 7] }), false);
  assert.equal(isPtcInitFrame({ ...initFrame, bindings: "read" }), false);
  assert.equal(isPtcInitFrame({ ...initFrame, maxItemsPerCall: Number.NaN }), false);
  assert.equal(isPtcInitFrame({ ...initFrame, maxPendingCalls: undefined }), false);
  assert.equal(isPtcInitFrame({ ...initFrame, maxPendingCalls: Number.POSITIVE_INFINITY }), false);
  assert.equal(isPtcInitFrame({ ...initFrame, kind: HOST_FRAME_KIND.cancel }), false);
  assert.equal(isPtcInitFrame(null), false);
});

test("call-result frame guard covers both arms", () => {
  const ok = { kind: HOST_FRAME_KIND.callResult, callId: 1, tool: "read", ok: true, value: { content: [] } };
  assert.equal(isPtcCallResultFrame(ok), true);
  assert.equal(isPtcCallResultFrame({ ...ok, value: undefined }), true, "an undefined value is still an explicit payload");
  assert.equal(isPtcCallResultFrame({ kind: HOST_FRAME_KIND.callResult, callId: 1, tool: "read", ok: true }), false);

  const failed = { kind: HOST_FRAME_KIND.callResult, callId: 1, tool: "read", ok: false, message: "boom" };
  assert.equal(isPtcCallResultFrame(failed), true);
  assert.equal(isPtcCallResultFrame({ ...failed, message: 7 }), false);
  assert.equal(isPtcCallResultFrame({ ...failed, callId: 1.5 }), false);
  assert.equal(isPtcCallResultFrame({ ...failed, ok: "false" }), false);
  assert.equal(isPtcCallResultFrame({ ...failed, tool: undefined }), false);
});

test("cancel frame guard validates reason and kind", () => {
  assert.equal(isPtcCancelFrame({ kind: HOST_FRAME_KIND.cancel, reason: "timeout" }), true);
  assert.equal(isPtcCancelFrame({ kind: HOST_FRAME_KIND.cancel, reason: "abort" }), true);
  assert.equal(isPtcCancelFrame({ kind: HOST_FRAME_KIND.cancel, reason: "stop" }), false);
  assert.equal(isPtcCancelFrame({ kind: HOST_FRAME_KIND.cancel }), false);
  assert.equal(isPtcCancelReason("abort"), true);
  assert.equal(isPtcCancelReason("cancel"), false);
});

test("host frame union rejects unknown kinds and non-frames", () => {
  assert.equal(isPtcHostFrame({ kind: "nope" }), false);
  assert.equal(isPtcHostFrame(undefined), false);
  assert.equal(isPtcHostFrame([]), false);
  assert.equal(isPtcHostFrame("connect"), false);
  assert.equal(isPtcHostFrame({ kind: WORKER_FRAME_KIND.ready }), false, "worker frames are not host frames");
});

test("ready frame guard", () => {
  assert.equal(isPtcReadyFrame({ kind: WORKER_FRAME_KIND.ready }), true);
  assert.equal(isPtcReadyFrame({ kind: WORKER_FRAME_KIND.ready, extra: 1 }), true);
  assert.equal(isPtcReadyFrame({ kind: WORKER_FRAME_KIND.call }), false);
  assert.equal(isPtcWorkerFrame({ kind: WORKER_FRAME_KIND.ready }), true);
});

test("call frame guard validates ids, names and payload presence", () => {
  const call = { kind: WORKER_FRAME_KIND.call, callId: 3, tool: "bash", args: { command: "ls" } };
  assert.equal(isPtcCallFrame(call), true);
  assert.equal(isPtcCallFrame({ ...call, args: undefined }), true);
  assert.equal(isPtcCallFrame({ kind: WORKER_FRAME_KIND.call, callId: 3, tool: "bash" }), false);
  assert.equal(isPtcCallFrame({ ...call, callId: 3.5 }), false);
  assert.equal(isPtcCallFrame({ ...call, tool: "" }), false);
  assert.equal(isPtcCallFrame({ ...call, tool: null }), false);
});

test("log frame guard validates level and text", () => {
  assert.equal(isPtcLogFrame({ kind: WORKER_FRAME_KIND.log, level: PTC_LOG_LEVEL.log, text: "hi" }), true);
  assert.equal(isPtcLogFrame({ kind: WORKER_FRAME_KIND.log, level: PTC_LOG_LEVEL.error, text: "" }), true);
  assert.equal(isPtcLogFrame({ kind: WORKER_FRAME_KIND.log, level: "verbose", text: "hi" }), false);
  assert.equal(isPtcLogFrame({ kind: WORKER_FRAME_KIND.log, text: "hi" }), false);
  assert.equal(isPtcLogFrame({ kind: WORKER_FRAME_KIND.log, level: PTC_LOG_LEVEL.log }), false);
  assert.equal(isPtcLogLevel("warn"), true);
  assert.equal(isPtcLogLevel(undefined), false);
});

test("narration and phase frame guards", () => {
  assert.equal(isPtcNarrationFrame({ kind: WORKER_FRAME_KIND.narration, message: "starting" }), true);
  assert.equal(isPtcNarrationFrame({ kind: WORKER_FRAME_KIND.narration, message: 1 }), false);
  assert.equal(isPtcPhaseFrame({ kind: WORKER_FRAME_KIND.phase, title: "one" }), true);
  assert.equal(isPtcPhaseFrame({ kind: WORKER_FRAME_KIND.phase }), false);
});

test("result frame guard allows an absent value but no other shape", () => {
  assert.equal(isPtcResultFrame({ kind: WORKER_FRAME_KIND.result }), true);
  assert.equal(isPtcResultFrame({ kind: WORKER_FRAME_KIND.result, value: { a: [1, 2] } }), true);
  assert.equal(isPtcResultFrame({ kind: WORKER_FRAME_KIND.result, value: undefined }), true);
  assert.equal(isPtcResultFrame({ kind: WORKER_FRAME_KIND.phase }), false);
});

test("error frame guard validates the nested error shape", () => {
  const base = { kind: WORKER_FRAME_KIND.error, error: { kind: PTC_ERROR_KIND.exception, message: "boom" } };
  assert.equal(isPtcErrorFrame(base), true);
  assert.equal(isPtcErrorFrame({ ...base, error: { ...base.error, stack: "at x" } }), true);
  assert.equal(isPtcErrorFrame({ kind: WORKER_FRAME_KIND.error, error: { kind: "kaboom", message: "x" } }), false);
  assert.equal(isPtcErrorFrame({ kind: WORKER_FRAME_KIND.error, error: { kind: PTC_ERROR_KIND.exception } }), false);
  assert.equal(isPtcErrorFrame({ kind: WORKER_FRAME_KIND.error, error: { ...base.error, stack: 7 } }), false);
  assert.equal(isPtcErrorFrame({ kind: WORKER_FRAME_KIND.error }), false);
  assert.equal(isPtcErrorKind(PTC_ERROR_KIND.outputLimit), true);
  assert.equal(isPtcErrorKind("sandbox-unavailable"), false, "ADR-0007 ships no sandbox, so the kind is absent");
  assert.equal(isPtcErrorKind("agent"), false, "there is no agent() helper (G1 #13 → B)");
});

test("worker frame union rejects unknown kinds and non-frames", () => {
  assert.equal(isPtcWorkerFrame({ kind: "nope" }), false);
  assert.equal(isPtcWorkerFrame(undefined), false);
  assert.equal(isPtcWorkerFrame(42), false);
  assert.equal(isPtcWorkerFrame([]), false);
  assert.equal(isPtcWorkerFrame({} as unknown), false);
  assert.equal(isPtcWorkerFrame({ kind: HOST_FRAME_KIND.init }), false, "host frames are not worker frames");
});
