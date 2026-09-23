/**
 * Worker state-machine tests (ADR-0017 §5).
 *
 * `workerMain` runs the lifecycle `CREATED → BOOTING → READY ↔ RUNNING`. These
 * tests drive that machine through a real `workerMain` call with a fake
 * `parentPort` / control port, so the state transitions and the per-run
 * `globalThis` reset can be observed in process — without standing up a pool
 * (the pool has its own suite in `tests/worker-pool.test.ts`).
 */
import { afterEach, expect, test } from "vitest";
import { stripTypeScriptTypes } from "node:module";
import { inspect } from "node:util";
import { workerMain } from "../src/runtime/worker-main.ts";
import type { WorkerMainPort } from "../src/runtime/worker-main.ts";
import {
  HOST_FRAME_KIND,
  PTC_ERROR_KIND,
  WORKER_FRAME_KIND,
  workerProtocolSpec,
} from "../src/runtime/protocol.ts";
import type { PtcHostFrame, PtcWorkerFrame } from "../src/runtime/protocol.ts";
import { RUN_TIMEOUT_MS } from "./helpers/ptc.ts";

/**
 * A minimal `MessagePort` stand-in. The worker's contract only needs `on` and
 * `postMessage`; we add `emit` so the test can drive frames synchronously and
 * `drain` to collect the worker's outbound traffic without races.
 */
class MockPort {
  readonly outbound: unknown[] = [];
  readonly listeners = new Map<string, Array<(value: unknown) => void>>();
  /**
   * Frames that arrived before anything was listening. A real `MessagePort` queues them and hands
   * them over once `port.on("message", …)` attaches a listener — verified against
   * `node:worker_threads` on Node 24: a frame posted before the listener exists is delivered after
   * the attaching block, never dropped. The mock has to queue the same way, because that is how a
   * test can put a frame in a worker's hands *during* the connect handler, before the worker has
   * finished booting.
   */
  readonly pendingIn = new Map<string, Array<unknown>>();
  /**
   * Set by `close()`. A real `MessagePort` silently drops a post made after `close()` rather
   * than throwing (verified against `node:worker_threads` on Node 24), so the harness drops too:
   * a frame sent to a port whose run the host abandoned is unobservable, which is exactly what
   * lets a test tell "run 1's frame went to run 1's port" apart from "run 1's frame went
   * somewhere a reader could see it".
   */
  closed = false;

  on(event: string, listener: (value: unknown) => void): unknown {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    if (event === "message") {
      const queued = this.pendingIn.get("message") ?? [];
      this.pendingIn.delete("message");
      for (const value of queued) listener(value);
    }
    return this;
  }

  postMessage(value: unknown): void {
    if (this.closed) return;
    this.outbound.push(value);
  }

  /** Deliver a frame to this port's "message" listeners, queueing it if none are attached yet. */
  emit(event: "message", value: unknown): void {
    if (event !== "message") return;
    const listeners = this.listeners.get("message") ?? [];
    if (listeners.length === 0) {
      const queued = this.pendingIn.get("message") ?? [];
      queued.push(value);
      this.pendingIn.set("message", queued);
      return;
    }
    for (const listener of listeners) listener(value);
  }

  /** Deliver the port's "close" event — the host closed the control channel. */
  close(): void {
    this.closed = true;
    for (const listener of this.listeners.get("close") ?? []) listener(undefined);
  }
}

interface Harness {
  parentPort: MockPort;
  control: MockPort;
  drainOutbound: () => PtcWorkerFrame[];
}

const makeHarness = (workerData: unknown = { runId: "state-test", env: {} }): Harness => {
  const parentPort = new MockPort();
  const control = new MockPort();
  const protocol = workerProtocolSpec();

  workerMain({
    parentPort: parentPort as unknown as WorkerMainPort,
    workerData,
    inspect: inspect as unknown as (value: unknown, options?: Record<string, unknown>) => string,
    stripTypes: stripTypeScriptTypes,
    protocol,
  });

  return {
    parentPort,
    control,
    drainOutbound: (): PtcWorkerFrame[] => control.outbound.splice(0) as PtcWorkerFrame[],
  };
};

/** Build a valid init frame with the supplied program body. */
const initFrame = (code: string): PtcHostFrame => ({
  kind: HOST_FRAME_KIND.init,
  runId: "state-test",
  surface: "run_code",
  code,
  bindings: [],
  bindingCandidates: [],
  maxItemsPerCall: 1000,
  maxPendingCalls: 1000,
});

/** Wait until the control port has at least one frame queued, or the timeout elapses. */
const awaitOutbound = async (control: MockPort, minCount: number): Promise<void> => {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (control.outbound.length < minCount && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (control.outbound.length < minCount) {
    throw new Error(
      `expected at least ${minCount} outbound frames, got ${control.outbound.length}`,
    );
  }
};

afterEach(() => {
  // `installWarningCapture` registers a process-wide listener; reset between tests so
  // a stale handler doesn't leak into another suite.
  if (typeof process.removeAllListeners === "function") {
    process.removeAllListeners("warning");
  }
  // `workerMain` runs in this process (`globalThis` here *is* the worker's realm), so the
  // handover tests' stray globals are cleaned by hand — a later test's warm baseline would
  // otherwise be snapshotted with them already in place.
  for (const key of HANDOVER_TEST_GLOBALS) delete testGlobals()[key];
  for (const key of installedProbeKeys.splice(0)) delete testGlobals()[key];
});

/** Globals the handover tests below leave on `globalThis`; cleaned between tests. */
const HANDOVER_TEST_GLOBALS = ["runOneFinished", "runOneLeftover"] as const;

/** Non-enumerable probe keys installed by `installProbe`; cleaned between tests. */
const installedProbeKeys: string[] = [];

/**
 * An observation point that a run's own reset cannot clear.
 *
 * `restoreWarmBaseline` walks `globalThis`'s own *enumerable* string keys only, so a property
 * installed here is invisible to it — it is neither deleted nor restored. The test keeps the
 * reference, so whatever a run writes into the probe stays readable even after the worker has
 * moved on to its next leg. (That gap is documented in `worker-main.ts`: a warm worker is
 * isolated for the values a program assigns to `globalThis`, not for everything it can reach.)
 */
const installProbe = <T>(key: string, probe: T): T => {
  Object.defineProperty(globalThis, key, { value: probe, configurable: true });
  installedProbeKeys.push(key);
  return probe;
};

/**
 * The test process's `globalThis`. `workerMain` is called in-process here, so this *is* the
 * realm a program sees — which is what makes a leftover global directly observable.
 */
const testGlobals = (): Record<string, unknown> => globalThis as unknown as Record<string, unknown>;

test(
  "worker reaches READY after boot and posts the ready frame",
  async () => {
    const { parentPort, control, drainOutbound } = makeHarness();

    parentPort.emit("message", { kind: HOST_FRAME_KIND.connect, port: control });

    const frames = drainOutbound();
    expect(frames).toEqual([{ kind: WORKER_FRAME_KIND.ready }]);
  },
  RUN_TIMEOUT_MS,
);

test(
  "RUNNING → READY: after a run settles, a fresh ready frame is posted",
  async () => {
    const { parentPort, control, drainOutbound } = makeHarness();

    parentPort.emit("message", { kind: HOST_FRAME_KIND.connect, port: control });
    drainOutbound(); // discard the boot ready

    control.emit("message", initFrame("return 41 + 1;"));
    await awaitOutbound(control, 2);

    const frames = drainOutbound();
    const kinds = frames.map((frame) => frame.kind);
    expect(kinds).toEqual([WORKER_FRAME_KIND.result, WORKER_FRAME_KIND.ready]);
  },
  RUN_TIMEOUT_MS,
);

test(
  "globalThis pollution from run N does not survive into run N+1",
  async () => {
    const { parentPort, control, drainOutbound } = makeHarness();

    parentPort.emit("message", { kind: HOST_FRAME_KIND.connect, port: control });
    drainOutbound(); // boot ready

    control.emit("message", initFrame("globalThis.leakedAcrossRuns = 1; return 1;"));
    await awaitOutbound(control, 2);
    drainOutbound();

    control.emit(
      "message",
      initFrame("return typeof (globalThis as { leakedAcrossRuns?: unknown }).leakedAcrossRuns;"),
    );
    await awaitOutbound(control, 2);

    const frames = drainOutbound();
    const resultFrame = frames[0];
    if (resultFrame === undefined) throw new Error("expected at least one frame");
    if (resultFrame.kind !== WORKER_FRAME_KIND.result) {
      throw new Error(`expected result frame, got ${JSON.stringify(resultFrame)}`);
    }
    expect(resultFrame.value).toBe("undefined");
  },
  RUN_TIMEOUT_MS,
);

test(
  "workflow helpers from run N do not leak into a run_code run N+1",
  async () => {
    const { parentPort, control, drainOutbound } = makeHarness();

    parentPort.emit("message", { kind: HOST_FRAME_KIND.connect, port: control });
    drainOutbound();

    // First run is workflow — installs log/phase/parallel/pipeline on globalThis.
    control.emit(
      "message",
      initFile("workflow", ['log("narrate");', 'phase("title");', "return typeof log;"].join("\n")),
    );
    await awaitOutbound(control, 4); // narration + phase + result + ready
    drainOutbound();

    // Second run is run_code — `log` must be gone (run_code has no helper globals).
    control.emit("message", initFile("run_code", "return { hasLog: typeof log !== 'undefined' };"));
    await awaitOutbound(control, 2);

    const frames = drainOutbound();
    const resultFrame = frames[0];
    if (resultFrame === undefined) throw new Error("expected at least one frame");
    if (resultFrame.kind !== WORKER_FRAME_KIND.result) {
      throw new Error(`expected result frame, got ${JSON.stringify(resultFrame)}`);
    }
    expect(resultFrame.value).toEqual({ hasLog: false });
  },
  RUN_TIMEOUT_MS,
);

test(
  "console capture from run N does not leak into run N+1",
  async () => {
    const { parentPort, control, drainOutbound } = makeHarness();

    parentPort.emit("message", { kind: HOST_FRAME_KIND.connect, port: control });
    drainOutbound();

    // Run 1: install a custom console, run code that captures it.
    control.emit(
      "message",
      initFile(
        "run_code",
        ["const before = console;", "return { beforeKind: typeof before.log };"].join("\n"),
      ),
    );
    await awaitOutbound(control, 2);

    const frames = drainOutbound();
    const resultFrame = frames[0];
    if (resultFrame === undefined) throw new Error("expected at least one frame");
    if (resultFrame.kind !== WORKER_FRAME_KIND.result) {
      throw new Error(`expected result frame, got ${JSON.stringify(resultFrame)}`);
    }
    expect(resultFrame.value).toEqual({ beforeKind: "function" });
  },
  RUN_TIMEOUT_MS,
);

/** Build an init frame for a given surface with the supplied program body. */
const initFile = (surface: "run_code" | "workflow", code: string): PtcHostFrame => ({
  kind: HOST_FRAME_KIND.init,
  runId: "state-test",
  surface,
  code,
  bindings: [],
  bindingCandidates: [],
  maxItemsPerCall: 1000,
  maxPendingCalls: 1000,
});

/** Build an init frame for one warm-reuse leg: run identity, surface, bindings, code. */
const runInit = (options: {
  runId: string;
  code: string;
  surface?: "run_code" | "workflow";
  bindings?: readonly string[];
}): PtcHostFrame => ({
  kind: HOST_FRAME_KIND.init,
  runId: options.runId,
  surface: options.surface ?? "run_code",
  code: options.code,
  bindings: [...(options.bindings ?? [])],
  bindingCandidates: [],
  maxItemsPerCall: 1000,
  maxPendingCalls: 1000,
});

/** Turn the event loop over so a superseded run's late unwinding has run its course. */
const settleEventLoop = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 25);
  });

/** Wait until `predicate` holds over the port's queued frames, or the timeout elapses. */
const awaitFrames = async (
  port: MockPort,
  predicate: (frames: PtcWorkerFrame[]) => boolean,
): Promise<void> => {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (!predicate(port.outbound as PtcWorkerFrame[]) && Date.now() < deadline) {
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
};

/** Wait until `predicate` holds in the worker's realm, or the timeout elapses. */
const awaitCondition = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
};

type CallFrame = Extract<PtcWorkerFrame, { kind: "call" }>;
type ErrorFrame = Extract<PtcWorkerFrame, { kind: "error" }>;
type ReadyFrame = Extract<PtcWorkerFrame, { kind: "ready" }>;
type ResultFrame = Extract<PtcWorkerFrame, { kind: "result" }>;

const isCallFrame = (frame: PtcWorkerFrame): frame is CallFrame =>
  frame.kind === WORKER_FRAME_KIND.call;
const isErrorFrame = (frame: PtcWorkerFrame): frame is ErrorFrame =>
  frame.kind === WORKER_FRAME_KIND.error;
const isReadyFrame = (frame: PtcWorkerFrame): frame is ReadyFrame =>
  frame.kind === WORKER_FRAME_KIND.ready;

/** True for run 2's completion: the binding value the host answered with came back. */
const isRun2Result = (frame: PtcWorkerFrame): frame is ResultFrame => {
  if (frame.kind !== WORKER_FRAME_KIND.result) return false;
  const value = frame.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return (value as { value?: unknown }).value === "echoed";
};

test(
  "a late reset() from a superseded run cannot clobber the next run",
  async () => {
    const { parentPort, control, drainOutbound } = makeHarness();
    parentPort.emit("message", { kind: HOST_FRAME_KIND.connect, port: control });
    drainOutbound(); // boot ready

    // Run 1 parks on a binding call the host never answers. The abandoning host closes
    // the control port; the program swallows that abort and only finishes after a timer,
    // which is what makes run 1's `reset()` land *after* run 2's `init`.
    control.emit(
      "message",
      runInit({
        runId: "run-1",
        bindings: ["park"],
        code: [
          "try { await tools.park({}); } catch {}",
          "await new Promise((resolve) => { setTimeout(resolve, 0); });",
          'return "run1-done";',
        ].join("\n"),
      }),
    );
    await awaitOutbound(control, 1);

    // The pool hands the worker to run 2: a fresh control port, then a fresh init. Run 1
    // is still unwinding at this point, so its `reset()` is late by construction.
    const nextControl = new MockPort();
    const drainNext = (): PtcWorkerFrame[] => nextControl.outbound.splice(0) as PtcWorkerFrame[];
    control.close();
    parentPort.emit("message", { kind: HOST_FRAME_KIND.connect, port: nextControl });
    // The handshake posts its own `ready` — that is this run's cue to send its init.
    expect(drainNext()).toEqual([{ kind: WORKER_FRAME_KIND.ready }]);
    nextControl.emit(
      "message",
      runInit({
        runId: "run-2",
        bindings: ["echo"],
        code: [
          'globalThis.marker = "run-2";',
          "const value = await tools.echo({ round: 2 });",
          "return { value, marker: (globalThis as { marker?: unknown }).marker };",
        ].join("\n"),
      }),
    );
    await awaitOutbound(nextControl, 1);
    const parked = nextControl.outbound as PtcWorkerFrame[];
    const run2Call = parked.find(isCallFrame);
    if (run2Call === undefined) {
      throw new Error(`expected run 2's call frame, got ${JSON.stringify(parked)}`);
    }

    // Run 1's unwinding now completes: it posts its result and calls `reset()` while run
    // 2 is parked on its binding call. That reset belongs to a run that no longer owns
    // the worker, so it must touch nothing.
    await settleEventLoop();
    const late = nextControl.outbound as PtcWorkerFrame[];
    // A superseded run's terminal frames still reach whatever port is current (the host
    // drops frames for a run it has already settled), but the two frames that corrupt the
    // *current* run must never appear: an `error` (run 2's in-flight call flushed by a
    // stranger) or a `ready` (the host reads `ready` as "this run settled, send the next
    // init" — that is how one program ends up executing twice).
    expect(late.filter(isErrorFrame).map((frame) => frame.error.message)).toEqual([]);
    expect(late.filter(isReadyFrame).length).toBe(0); // Run 2's per-run globals are still installed after the stranger's reset ran.
    expect((globalThis as { marker?: unknown }).marker).toBe("run-2");

    // Run 2 was still waiting for its binding call — answer it, and it must settle with
    // the host's value instead of an abort.
    nextControl.emit("message", {
      kind: HOST_FRAME_KIND.callResult,
      callId: run2Call.callId,
      tool: run2Call.tool,
      ok: true,
      value: "echoed",
    });
    await awaitFrames(
      nextControl,
      (frames) => frames.some(isErrorFrame) || frames.some(isRun2Result),
    );

    const settled = nextControl.outbound as PtcWorkerFrame[];
    const run2Result = settled.find(isRun2Result);
    if (run2Result === undefined) {
      throw new Error(`run 2 never settled its binding call: ${JSON.stringify(settled)}`);
    }
    expect(run2Result.value).toEqual({ value: "echoed", marker: "run-2" });

    // The one legitimate `ready` is run 2's own reset, and it follows run 2's result.
    const readyIndexes = settled
      .map((frame, index) => (isReadyFrame(frame) ? index : -1))
      .filter((index) => index >= 0);
    expect(readyIndexes.length).toBe(1);
    expect(readyIndexes[0] ?? -1).toBeGreaterThan(settled.indexOf(run2Result));
    // Run 2's own reset — not the stranger's — is what cleared the run.
    expect((globalThis as { marker?: unknown }).marker).toBeUndefined();

    // And the worker is still healthy for the leg after that.
    nextControl.emit("message", runInit({ runId: "run-3", code: "return 7;" }));
    await awaitFrames(
      nextControl,
      (frames) => frames.filter(isReadyFrame).length === readyIndexes.length + 1,
    );
    expect((nextControl.outbound as PtcWorkerFrame[]).slice(-2)).toEqual([
      { kind: WORKER_FRAME_KIND.result, value: 7 },
      { kind: WORKER_FRAME_KIND.ready },
    ]);
  },
  RUN_TIMEOUT_MS,
);

test(
  "warm-shape workerData ({ env } only) is enough: two runs with different init runIds both settle",
  async () => {
    // The pool spawns warm workers with `workerData: { env }` — no `runId` (F3, ADR-0017).
    // Contract pin, green before and after: `workerMain` never reads spawn-time run
    // identity (neither `workerData.runId` nor the init frame's `runId`), so the warm
    // payload must stay sufficient on its own. It would catch a fix that made the worker
    // depend on `workerData.runId`.
    const { parentPort, control, drainOutbound } = makeHarness({ env: {} });

    parentPort.emit("message", { kind: HOST_FRAME_KIND.connect, port: control });
    drainOutbound(); // boot ready

    control.emit("message", runInit({ runId: "warm-1", code: "return 1;" }));
    await awaitOutbound(control, 2);
    const first = drainOutbound();
    expect(first.map((frame) => frame.kind)).toEqual([
      WORKER_FRAME_KIND.result,
      WORKER_FRAME_KIND.ready,
    ]);

    control.emit("message", runInit({ runId: "warm-2", code: "return 2;" }));
    await awaitOutbound(control, 2);
    const second = drainOutbound();
    expect(second.map((frame) => frame.kind)).toEqual([
      WORKER_FRAME_KIND.result,
      WORKER_FRAME_KIND.ready,
    ]);
    expect(second[0]).toEqual({ kind: WORKER_FRAME_KIND.result, value: 2 });
  },
  RUN_TIMEOUT_MS,
);

/* ------------------------------------------------------------------ */
/* pool handover: a superseded run must not reach the run after it      */
/* ------------------------------------------------------------------ */

/*
 * Everything below drives the same situation, in the shape the pool produces it (ADR-0017 §5):
 * run 1's host gives up on it — a timeout, a cancel, a dropped promise — closes or abandons its
 * control port, and `pool.release(worker)` hands the worker to run 2, whose dispatcher builds a
 * *fresh* channel and sends a fresh `init`. Run 1's program is still running at that point (it
 * caught the binding abort and kept going), so it finishes *inside* run 2's lifetime.
 *
 * The aborts used here are all synchronous — a closed port, a `cancel` frame — so run 1's
 * continuation is a microtask queued *before* the handover lines and can only run after run 2
 * has claimed the worker. That ordering is the tests' whole premise, and it needs no timers.
 */

/**
 * Run 1's terminal frame: `"run-1"` is a value only that run can produce, so finding it on
 * another run's port *is* the cross-run pollution these tests pin.
 */
const isRun1Result = (frame: PtcWorkerFrame): frame is ResultFrame =>
  frame.kind === WORKER_FRAME_KIND.result && frame.value === "run-1";

/** Run 2's probe of what it can see on `globalThis` (the leftover test). */
const isLeftoverProbe = (frame: PtcWorkerFrame): frame is ResultFrame => {
  if (frame.kind !== WORKER_FRAME_KIND.result) return false;
  const value = frame.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return "leftover" in value && "hasLog" in value;
};

test(
  "a superseded run's result frame never reaches the next run's control port",
  async () => {
    const { parentPort, control, drainOutbound } = makeHarness();
    parentPort.emit("message", { kind: HOST_FRAME_KIND.connect, port: control });
    drainOutbound(); // boot ready

    // Run 1 parks on a binding call the abandoning host never answers. Node emits `close` on the
    // worker's port when the host closes its side — which is what the dispatcher's `finish()`
    // does on a timeout — so the call aborts, the program swallows that, and it completes.
    control.emit(
      "message",
      runInit({
        runId: "run-1",
        bindings: ["park"],
        code: [
          "try { await tools.park({}); } catch {}",
          "globalThis.runOneFinished = true;",
          'return "run-1";',
        ].join("\n"),
      }),
    );
    await awaitOutbound(control, 1); // run 1's call frame: the program is in flight

    // The pool hands the worker to run 2 before run 1 is done: run 1's port is closed and the next
    // dispatcher builds a fresh channel for itself.
    control.close();
    const nextControl = new MockPort();
    const drainNext = (): PtcWorkerFrame[] => nextControl.outbound.splice(0) as PtcWorkerFrame[];
    parentPort.emit("message", { kind: HOST_FRAME_KIND.connect, port: nextControl });
    // The handshake posts its own `ready` — that is run 2's dispatcher cue to send its init.
    expect(drainNext()).toEqual([{ kind: WORKER_FRAME_KIND.ready }]);
    nextControl.emit(
      "message",
      runInit({
        runId: "run-2",
        bindings: ["echo"],
        code: ["const value = await tools.echo({ round: 2 });", "return { value };"].join("\n"),
      }),
    );

    // Run 1 finishes now. The marker proves it: a run that never completed would make the
    // assertions below pass for the wrong reason.
    await awaitCondition(() => testGlobals().runOneFinished === true);
    await awaitFrames(nextControl, (frames) => frames.some(isCallFrame));
    const run2Call = (nextControl.outbound as PtcWorkerFrame[]).find(isCallFrame);
    if (run2Call === undefined) {
      throw new Error(`expected run 2's call frame, got ${JSON.stringify(nextControl.outbound)}`);
    }

    // Run 1's terminal frame went to the port it captured — a closed port, where it dies.
    // Nothing of run 1 may appear here: a `result` on run 2's port settles run 2 on the host's
    // `handleFrame` before run 2 ever answered its binding call.
    expect((nextControl.outbound as PtcWorkerFrame[]).filter(isRun1Result)).toEqual([]);
    expect(nextControl.outbound).toEqual([run2Call]);

    // Run 2 is unharmed: the host's answer still settles its call and it completes normally.
    nextControl.emit("message", {
      kind: HOST_FRAME_KIND.callResult,
      callId: run2Call.callId,
      tool: run2Call.tool,
      ok: true,
      value: "echoed",
    });
    await awaitFrames(nextControl, (frames) => frames.some(isRun2Result));
    const settled = (nextControl.outbound as PtcWorkerFrame[]).find(isRun2Result);
    if (settled === undefined) {
      throw new Error(`run 2 never settled: ${JSON.stringify(nextControl.outbound)}`);
    }
    expect(settled.value).toEqual({ value: "echoed" });
  },
  RUN_TIMEOUT_MS,
);

test(
  "a superseded run's frames stay on the port its run captured, not the one that replaced it",
  async () => {
    const { parentPort, control, drainOutbound } = makeHarness();
    parentPort.emit("message", { kind: HOST_FRAME_KIND.connect, port: control });
    drainOutbound(); // boot ready

    control.emit(
      "message",
      runInit({
        runId: "run-1",
        bindings: ["park"],
        code: [
          "try { await tools.park({}); } catch {}",
          "globalThis.runOneFinished = true;",
          'return "run-1";',
        ].join("\n"),
      }),
    );
    await awaitOutbound(control, 1); // run 1's call frame

    // The host gives up on run 1 (`cancel`) and the pool hands the worker on. Run 1's port is
    // deliberately left *open* here: the fix is routing, not suppression, so run 1's terminal
    // frame has to be observable landing on run 1's own port — an implementation that merely
    // dropped every frame from a superseded run would pass the test above and fail this one.
    control.emit("message", { kind: HOST_FRAME_KIND.cancel, reason: "abort" });
    const nextControl = new MockPort();
    parentPort.emit("message", { kind: HOST_FRAME_KIND.connect, port: nextControl });
    nextControl.emit(
      "message",
      runInit({
        runId: "run-2",
        bindings: ["echo"],
        code: ["await tools.echo({ round: 2 });", "return { value: 'run-2' };"].join("\n"),
      }),
    );

    // Run 1's terminal frame has to land *somewhere*, so waiting for it to land is the completion
    // signal here (unlike the test above, run 1's own result is what is being located).
    await awaitCondition(
      () =>
        (control.outbound as PtcWorkerFrame[]).some(isRun1Result) ||
        (nextControl.outbound as PtcWorkerFrame[]).some(isRun1Result),
    );
    const onOwnPort = (control.outbound as PtcWorkerFrame[]).filter(isRun1Result);
    const onNextPort = (nextControl.outbound as PtcWorkerFrame[]).filter(isRun1Result);
    expect({ onOwnPort: onOwnPort.length, onNextPort: onNextPort.length }).toEqual({
      onOwnPort: 1,
      onNextPort: 0,
    });
    expect(onOwnPort.map((frame) => frame.value)).toEqual(["run-1"]);
  },
  RUN_TIMEOUT_MS,
);

test(
  "leftovers from a superseded run do not survive into the next run",
  async () => {
    const { parentPort, control, drainOutbound } = makeHarness();
    parentPort.emit("message", { kind: HOST_FRAME_KIND.connect, port: control });
    drainOutbound(); // boot ready

    // Run 1 is a workflow run: it installs `tools`, `args`, the `log`/`phase`/`parallel`/
    // `pipeline` helpers, and a stray global of its own — then parks on a call.
    control.emit(
      "message",
      runInit({
        runId: "run-1",
        surface: "workflow",
        bindings: ["park"],
        code: ["globalThis.runOneLeftover = 1;", "try { await tools.park({}); } catch {}"].join(
          "\n",
        ),
      }),
    );
    await awaitOutbound(control, 1); // run 1's call frame: it installed its surface and its stray
    // Premise of this test: the leftovers are installed and nothing has cleared them yet.
    expect(testGlobals().runOneLeftover).toBe(1);

    // The host abandons run 1 and the pool hands the worker to run 2. Run 1's own `reset()` is
    // generation-guarded into a no-op once it eventually runs, so *nothing* but run 2's own start
    // can clear what run 1 left behind.
    control.close();
    const nextControl = new MockPort();
    parentPort.emit("message", { kind: HOST_FRAME_KIND.connect, port: nextControl });
    expect(nextControl.outbound).toEqual([{ kind: WORKER_FRAME_KIND.ready }]);
    nextControl.emit(
      "message",
      runInit({
        runId: "run-2",
        surface: "run_code",
        code: [
          "return {",
          "  leftover: typeof (globalThis as { runOneLeftover?: unknown }).runOneLeftover,",
          "  hasLog: typeof (globalThis as { log?: unknown }).log,",
          "};",
        ].join("\n"),
      }),
    );

    await awaitFrames(nextControl, (frames) => frames.some(isLeftoverProbe));
    const probe = (nextControl.outbound as PtcWorkerFrame[]).find(isLeftoverProbe);
    if (probe === undefined) {
      throw new Error(`run 2 never probed the realm: ${JSON.stringify(nextControl.outbound)}`);
    }
    // A run_code run sees a clean realm: run 1's stray global and its workflow helpers are gone.
    expect(probe.value).toEqual({ leftover: "undefined", hasLog: "undefined" });
  },
  RUN_TIMEOUT_MS,
);

test(
  "a superseded run's cancel verdict does not poison the next run",
  async () => {
    const { parentPort, control, drainOutbound } = makeHarness();
    parentPort.emit("message", { kind: HOST_FRAME_KIND.connect, port: control });
    drainOutbound(); // boot ready

    // Run 1 parks on a call; the host times it out the way the dispatcher does — a `cancel` frame.
    // Its port is left open so that the cancel is the *only* thing that can release run 1: the
    // verdict (`cancelled = "timeout"`) is therefore set for sure, and the program outlives it.
    control.emit(
      "message",
      runInit({
        runId: "run-1",
        bindings: ["park"],
        code: ["try { await tools.park({}); } catch {}", 'return "run-1";'].join("\n"),
      }),
    );
    await awaitOutbound(control, 1); // run 1's call frame
    control.emit("message", { kind: HOST_FRAME_KIND.cancel, reason: "timeout" });

    // Run 2 takes the worker over while run 1 is still unwinding. The verdict is still set, so the
    // only thing that can keep run 2 from inheriting the timeout is run 2's own start.
    const nextControl = new MockPort();
    parentPort.emit("message", { kind: HOST_FRAME_KIND.connect, port: nextControl });
    nextControl.emit(
      "message",
      runInit({
        runId: "run-2",
        bindings: ["echo"],
        code: ["const value = await tools.echo({ round: 2 });", "return { value };"].join("\n"),
      }),
    );

    await awaitFrames(
      nextControl,
      (frames) => frames.some(isCallFrame) || frames.some(isErrorFrame),
    );
    const frames = nextControl.outbound as PtcWorkerFrame[];
    const run2Call = frames.find(isCallFrame);
    if (run2Call === undefined) {
      throw new Error(
        `run 2 inherited the superseded run's verdict instead of calling the host: ${JSON.stringify(frames)}`,
      );
    }

    nextControl.emit("message", {
      kind: HOST_FRAME_KIND.callResult,
      callId: run2Call.callId,
      tool: run2Call.tool,
      ok: true,
      value: "echoed",
    });
    await awaitFrames(nextControl, (frames_) => frames_.some(isRun2Result));
    const settled = (nextControl.outbound as PtcWorkerFrame[]).find(isRun2Result);
    if (settled === undefined) {
      throw new Error(`run 2 never settled: ${JSON.stringify(nextControl.outbound)}`);
    }
    expect(settled.value).toEqual({ value: "echoed" });
  },
  RUN_TIMEOUT_MS,
);

/* ------------------------------------------------------------------ */
/* close routing: a dead port may only settle the run that still owns it */
/* ------------------------------------------------------------------ */

test(
  "a superseded run's late close event does not reject the run that replaced it",
  async () => {
    const { parentPort, control, drainOutbound } = makeHarness();
    parentPort.emit("message", { kind: HOST_FRAME_KIND.connect, port: control });
    drainOutbound(); // boot ready

    // Run 1 claims the worker on `control` and parks on a call the host never answers.
    control.emit(
      "message",
      runInit({
        runId: "run-1",
        bindings: ["park"],
        code: "try { await tools.park({}); } catch {}",
      }),
    );
    await awaitOutbound(control, 1); // run 1's call frame: the program is in flight

    // The host gives up on run 1 and the pool hands the worker to run 2, whose dispatcher builds a
    // fresh channel. A port `close` is a queued event, not a synchronous one: at this point the
    // worker has *not* seen run 1's close yet, while run 2's call is already in flight.
    const nextControl = new MockPort();
    parentPort.emit("message", { kind: HOST_FRAME_KIND.connect, port: nextControl });
    nextControl.emit(
      "message",
      runInit({
        runId: "run-2",
        bindings: ["echo"],
        code: ["const value = await tools.echo({ round: 2 });", "return { value };"].join("\n"),
      }),
    );
    await awaitFrames(nextControl, (frames) => frames.some(isCallFrame));
    const run2Call = (nextControl.outbound as PtcWorkerFrame[]).find(isCallFrame);
    if (run2Call === undefined) {
      throw new Error(`expected run 2's call frame, got ${JSON.stringify(nextControl.outbound)}`);
    }

    // Run 1's close event lands now, after the handover. It belongs to a port the worker no longer
    // owns, so it says nothing about run 2's channel: run 2's in-flight call must not be flushed.
    control.close();
    await settleEventLoop();
    expect((nextControl.outbound as PtcWorkerFrame[]).filter(isErrorFrame)).toEqual([]);

    // Run 2 was still waiting on the host, so the host's own answer is what settles it.
    nextControl.emit("message", {
      kind: HOST_FRAME_KIND.callResult,
      callId: run2Call.callId,
      tool: run2Call.tool,
      ok: true,
      value: "echoed",
    });
    await awaitFrames(
      nextControl,
      (frames) => frames.some(isRun2Result) || frames.some(isErrorFrame),
    );
    const settled = (nextControl.outbound as PtcWorkerFrame[]).find(isRun2Result);
    if (settled === undefined) {
      throw new Error(
        `run 2's call was settled by a superseded run's close event: ${JSON.stringify(nextControl.outbound)}`,
      );
    }
    expect(settled.value).toEqual({ value: "echoed" });
  },
  RUN_TIMEOUT_MS,
);

test(
  "a close event on the port the worker still owns flushes that run's in-flight calls",
  async () => {
    const { parentPort, control, drainOutbound } = makeHarness();
    parentPort.emit("message", { kind: HOST_FRAME_KIND.connect, port: control });
    drainOutbound(); // boot ready

    const flushed = installProbe<string[]>("closeFlushProbe", []);

    control.emit(
      "message",
      runInit({
        runId: "run-1",
        bindings: ["park"],
        code: [
          "try {",
          "  await tools.park({});",
          "} catch (error) {",
          "  (globalThis as { closeFlushProbe?: string[] }).closeFlushProbe?.push(",
          "    (error as Error).name,",
          "  );",
          "}",
        ].join("\n"),
      }),
    );
    await awaitOutbound(control, 1); // run 1's call frame: the program is in flight

    // No new run takes the worker over, so the port it is connected to *is* the abandoned run's
    // port: closing it is the worker's only signal that its host is gone.
    control.close();

    await awaitCondition(() => flushed.length > 0);
    // The flush reached run 1's own wait — the program's `await` was rejected instead of staying
    // parked for the rest of the worker's life. (Post-fix the guard must keep this path alive: the
    // close event of the port the worker still owns is the one that *does* mean "the host is gone".)
    expect(flushed).toEqual(["AbortError"]);
  },
  RUN_TIMEOUT_MS,
);

/* ------------------------------------------------------------------ */
/* idle cancel: a cancel with no run in flight is answered, not waited on */
/* ------------------------------------------------------------------ */

test(
  "a cancel on an idle (READY) worker is answered with an error frame instead of a ready",
  async () => {
    // Both reasons, because the error kind and message are the reason's, not a fixed pair.
    for (const [reason, kind, message] of [
      ["abort", PTC_ERROR_KIND.abort, "PTC run was cancelled"],
      ["timeout", PTC_ERROR_KIND.timeout, "PTC run timed out"],
    ] as const) {
      const { parentPort, control, drainOutbound } = makeHarness();
      parentPort.emit("message", { kind: HOST_FRAME_KIND.connect, port: control });
      expect(drainOutbound()).toEqual([{ kind: WORKER_FRAME_KIND.ready }]); // booted, no run in flight

      control.emit("message", { kind: HOST_FRAME_KIND.cancel, reason });

      // Synchronously — the point of the verdict is that the host does not wait out its grace
      // window for a run that will never start.
      expect(control.outbound).toEqual([
        { kind: WORKER_FRAME_KIND.error, error: { kind, message } },
      ]);
      // ...and no `ready`: a ready here would restart the host's window for a cancelled run.
      expect((control.outbound as PtcWorkerFrame[]).filter(isReadyFrame)).toEqual([]);
    }
  },
  RUN_TIMEOUT_MS,
);

test(
  "a cancel that lands while the worker is still booting is reported instead of a ready frame",
  async () => {
    const { parentPort, control, drainOutbound } = makeHarness();

    // Queued on the control port before anything is listening on it: a real `MessagePort` buffers a
    // frame posted before `port.on("message", …)` and delivers it once that listener is attached
    // (verified against `node:worker_threads` on Node 24), and the mock queues the same way. The
    // mock hands it over *synchronously* inside `on()`, so the frame is handled while the worker is
    // still BOOTING — the branch that must survive a verdict arriving mid-handshake. (A real port
    // delivers on a later turn of the loop, when `state` is already `READY`; the invariant pinned
    // here is the same either way — the host gets an `error` frame, never a `ready`.)
    control.emit("message", { kind: HOST_FRAME_KIND.cancel, reason: "timeout" });

    parentPort.emit("message", { kind: HOST_FRAME_KIND.connect, port: control });

    // Boot completes with a verdict in hand: report it rather than announce readiness for a run the
    // host has already cancelled. One frame, and it is not `ready`.
    expect(drainOutbound()).toEqual([
      {
        kind: WORKER_FRAME_KIND.error,
        error: { kind: PTC_ERROR_KIND.timeout, message: "PTC run timed out" },
      },
    ]);

    // The verdict is spent, not sticky: boot still left the worker usable, so the next `init` runs.
    control.emit("message", runInit({ runId: "after-boot-cancel", code: "return 3;" }));
    await awaitOutbound(control, 2);
    expect(drainOutbound()).toEqual([
      { kind: WORKER_FRAME_KIND.result, value: 3 },
      { kind: WORKER_FRAME_KIND.ready },
    ]);
  },
  RUN_TIMEOUT_MS,
);

test(
  "a superseded run's cancel verdict is not replayed down the next run's channel",
  async () => {
    const { parentPort, control, drainOutbound } = makeHarness();
    parentPort.emit("message", { kind: HOST_FRAME_KIND.connect, port: control });
    drainOutbound(); // boot ready

    // Run 1 claims the worker, parks on a call the host never answers, and then — after the abort
    // rejects that call — stays parked on a promise nothing can settle. That is what keeps the run
    // from reaching its `reset()` (which would consume the verdict): a superseded run may still be
    // unwinding, and this is the shape where it really is.
    control.emit(
      "message",
      runInit({
        runId: "run-1",
        bindings: ["park"],
        code: [
          "try { await tools.park({}); } catch {}",
          "await new Promise(() => {});",
          "return 1;",
        ].join("\n"),
      }),
    );
    await awaitOutbound(control, 1);

    // The host cancels run 1: the verdict belongs to *run 1*, and this is run 1's channel.
    control.emit("message", { kind: HOST_FRAME_KIND.cancel, reason: "abort" });
    await settleEventLoop();

    // The host gives up and the pool hands the worker to run 2 on a fresh channel. Run 2 is a
    // different caller with its own lifecycle: replaying "cancelled" here would end it before its
    // `init` ever arrives. The verdict is the superseded run's, so the handover clears it silently.
    const nextControl = new MockPort();
    parentPort.emit("message", { kind: HOST_FRAME_KIND.connect, port: nextControl });
    await settleEventLoop();

    expect(
      (nextControl.outbound as PtcWorkerFrame[]).filter(isErrorFrame),
      "run 1's cancel verdict must not reach run 2",
    ).toEqual([]);
    // The handover still announces readiness, so run 2 can start normally.
    expect(
      (nextControl.outbound as PtcWorkerFrame[]).some(
        (frame) => frame.kind === WORKER_FRAME_KIND.ready,
      ),
      "the handover still reports ready",
    ).toBe(true);

    // And run 2 really is usable: its program runs and settles.
    nextControl.emit("message", runInit({ runId: "run-2", code: "return 7;" }));
    await awaitOutbound(nextControl, 2);
    expect((nextControl.outbound as PtcWorkerFrame[]).filter(isErrorFrame)).toEqual([]);
    expect(
      (nextControl.outbound as PtcWorkerFrame[]).some(
        (frame) => frame.kind === WORKER_FRAME_KIND.result && frame.value === 7,
      ),
    ).toBe(true);
  },
  RUN_TIMEOUT_MS,
);
