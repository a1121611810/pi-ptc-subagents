/**
 * PTC programs run in strict mode (ADR-0060).
 *
 * The seam is the one the worker state-machine suite already uses: a real `workerMain` call
 * driven through a fake parent port, so the program is really compiled and really executed in
 * this process — no mock, no hand-built frame.
 *
 * **Why strict mode is a specification and not a preference.** Upstream DSH materialises every
 * program with a `'use strict';` prefix in the function body
 * (`docs/research/upstream-20260930/01-dsh-ptc-core.md` §1.1 quotes the upstream call shape),
 * and this repository's parity audit — the "DSH has it / we do not" table, rows A1–A12 in
 * `docs/research/ptc-upstream-parity-audit-20260930.md` — never registered this row. The
 * expectations below are therefore pinned to the upstream shape and to what ECMAScript's
 * strict mode requires, not to whatever this implementation happens to do.
 *
 * Every assertion here has a counterfactual: with the `"use strict";` prefix removed from the
 * compiled wrapper, each of them goes red. The three that go red for *different* reasons are
 * worth naming:
 *   - the undeclared assignment and the mistyped assignment target: the run ends in an error
 *     frame instead of a result frame (sloppy mode writes a global and reports success);
 *   - the top-level `this`: it is the global object instead of `undefined`;
 *   - the duplicate parameter and the octal literal: they compile instead of failing to compile.
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
 * A minimal `MessagePort` stand-in: the worker's contract only needs `on` and `postMessage`.
 * `emit` drives a frame into the worker and `outbound` collects what the worker posts back.
 */
class MockPort {
  readonly outbound: unknown[] = [];
  readonly listeners = new Map<string, Array<(value: unknown) => void>>();

  on(event: string, listener: (value: unknown) => void): unknown {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  postMessage(value: unknown): void {
    this.outbound.push(value);
  }

  emit(event: "message", value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

/** Build a valid init frame with the supplied program body. */
const initFrame = (code: string): PtcHostFrame => ({
  kind: HOST_FRAME_KIND.init,
  runId: "strict-mode-test",
  surface: "run_code",
  code,
  bindings: [],
  bindingCandidates: [],
  maxItemsPerCall: 1000,
  maxPendingCalls: 1000,
});

/** Wait until the worker has posted its closing `ready` frame, or the timeout elapses. */
const awaitReady = async (control: MockPort): Promise<void> => {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ready = control.outbound.some(
      (frame) => (frame as { kind?: string }).kind === WORKER_FRAME_KIND.ready,
    );
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the worker never posted a ready frame");
};

interface WorkerFixture {
  /**
   * Run one program in this worker and return the frames it produced.
   *
   * The SAME worker serves every call, so two `run()`s are two programs in one warm worker —
   * which is the only way to observe cross-run contamination.
   */
  run: (code: string) => Promise<PtcWorkerFrame[]>;
}

const startWorker = (): WorkerFixture => {
  const parentPort = new MockPort();
  const control = new MockPort();

  workerMain({
    parentPort: parentPort as unknown as WorkerMainPort,
    workerData: { runId: "strict-mode-test", env: {} },
    inspect: inspect as unknown as (value: unknown, options?: Record<string, unknown>) => string,
    stripTypes: stripTypeScriptTypes,
    protocol: workerProtocolSpec(),
  });

  parentPort.emit("message", { kind: HOST_FRAME_KIND.connect, port: control });
  control.outbound.length = 0; // discard the boot ready

  return {
    run: async (code: string): Promise<PtcWorkerFrame[]> => {
      control.emit("message", initFrame(code));
      await awaitReady(control);
      return control.outbound.splice(0) as PtcWorkerFrame[];
    },
  };
};

/** The value a result frame carries. Throws when the frame is not a result frame. */
const valueOf = (frame: PtcWorkerFrame | undefined): unknown => {
  if (frame === undefined) throw new Error("expected a frame, got none");
  if (frame.kind !== WORKER_FRAME_KIND.result) {
    throw new Error(`expected a result frame, got ${JSON.stringify(frame)}`);
  }
  return frame.value;
};

interface WorkerFailure {
  readonly kind: string;
  readonly message: string;
  readonly stack: string;
}

/** The payload of an error frame. Throws when the frame is not an error frame. */
const errorOf = (frame: PtcWorkerFrame | undefined): WorkerFailure => {
  if (frame === undefined) throw new Error("expected a frame, got none");
  if (frame.kind !== WORKER_FRAME_KIND.error) {
    throw new Error(`expected an error frame, got ${JSON.stringify(frame)}`);
  }
  const error = frame.error;
  if (typeof error.kind !== "string" || typeof error.message !== "string") {
    throw new Error(`the error frame carried no error payload: ${JSON.stringify(frame)}`);
  }
  return { kind: error.kind, message: error.message, stack: error.stack ?? "" };
};

afterEach(() => {
  // `installWarningCapture` registers a process-wide listener; reset between tests so a stale
  // handler does not leak into another suite.
  if (typeof process.removeAllListeners === "function") {
    process.removeAllListeners("warning");
  }
  // `workerMain` runs in this process, so `globalThis` here IS the worker's realm. Under strict
  // mode the programs below cannot create a global at all; this is the belt to that braces, so a
  // regression that re-enables sloppy mode cannot leave its litter in the next suite.
  for (const key of ["leakedGlobal", "results"]) {
    delete (globalThis as unknown as Record<string, unknown>)[key];
  }
});

test(
  "an undeclared assignment is a loud ReferenceError, not a silent global write",
  async () => {
    const worker = startWorker();
    const frames = await worker.run("leakedGlobal = 42; return 1;");

    // The load-bearing assertion: the run ends in an error frame, not a result frame.
    // Counterfactual: with the strict prefix removed, sloppy mode writes a global and the
    // program reports success, so the frame kinds become [result, ready] and this goes red.
    expect(frames.map((frame) => frame.kind)).toEqual([
      WORKER_FRAME_KIND.error,
      WORKER_FRAME_KIND.ready,
    ]);
    const failure = errorOf(frames[0]);
    expect(failure.kind).toBe(PTC_ERROR_KIND.exception);
    // ECMAScript's strict mode requires an assignment to an unresolvable reference to throw a
    // ReferenceError; V8 words that "X is not defined" and names the identifier.
    expect(failure.message).toBe("leakedGlobal is not defined");
    expect(failure.stack).toContain("ReferenceError: leakedGlobal is not defined");
  },
  RUN_TIMEOUT_MS,
);

test(
  "the program's top-level `this` is undefined, not the global object",
  async () => {
    const worker = startWorker();
    const frames = await worker.run(
      "return { self: typeof this, isGlobalObject: this === globalThis };",
    );

    expect(frames.map((frame) => frame.kind)).toEqual([
      WORKER_FRAME_KIND.result,
      WORKER_FRAME_KIND.ready,
    ]);
    // Counterfactual: with the strict prefix removed, `this` is the global object, so
    // `self` would be "object" and `isGlobalObject` would be true.
    expect(valueOf(frames[0])).toEqual({ self: "undefined", isGlobalObject: false });
  },
  RUN_TIMEOUT_MS,
);

test(
  'a program that writes its own "use strict"; stays legal and is a no-op',
  async () => {
    const worker = startWorker();

    // The program carries its own directive. It must stay legal — a wrapper that rejected a
    // second directive would fail to compile it, and the frame kinds would become
    // [error, ready].
    const withDirective = await worker.run(
      '"use strict";\nreturn { self: typeof this, value: 1 + 1 };',
    );
    expect(withDirective.map((frame) => frame.kind)).toEqual([
      WORKER_FRAME_KIND.result,
      WORKER_FRAME_KIND.ready,
    ]);
    expect(valueOf(withDirective[0])).toEqual({ self: "undefined", value: 2 });

    // The directive is a no-op, not a second mode: a program WITHOUT one behaves the same way
    // in the same worker. Counterfactual: without the wrapper's own strict prefix, the second
    // program is sloppy, so `self` would be "object" and this goes red.
    const withoutDirective = await worker.run("return { self: typeof this, value: 1 + 1 };");
    expect(withoutDirective.map((frame) => frame.kind)).toEqual([
      WORKER_FRAME_KIND.result,
      WORKER_FRAME_KIND.ready,
    ]);
    expect(valueOf(withoutDirective[0])).toEqual({ self: "undefined", value: 2 });
  },
  RUN_TIMEOUT_MS,
);

test(
  "two programs in one worker do not contaminate each other",
  async () => {
    const worker = startWorker();

    // Run 1: the undeclared write. Under strict mode it fails, so no global is ever created.
    const first = await worker.run("leakedGlobal = 42; return 1;");
    expect(first.map((frame) => frame.kind)).toEqual([
      WORKER_FRAME_KIND.error,
      WORKER_FRAME_KIND.ready,
    ]);

    // Run 2: the same worker, the next program. It must not see run 1's global.
    const second = await worker.run("return typeof leakedGlobal;");
    expect(second.map((frame) => frame.kind)).toEqual([
      WORKER_FRAME_KIND.result,
      WORKER_FRAME_KIND.ready,
    ]);
    expect(valueOf(second[0])).toBe("undefined");
  },
  RUN_TIMEOUT_MS,
);

test(
  "a mistyped assignment target fails loudly instead of writing a global",
  async () => {
    const worker = startWorker();
    // The hand-slip: the model means `result` and writes `results`. In sloppy mode the
    // assignment creates a global and the program reports success, so the model is handed a
    // value it never produced and the typo leaves a global behind for the next run.
    const frames = await worker.run("const result = 1;\nresults = result;\nreturn result;");

    expect(frames.map((frame) => frame.kind)).toEqual([
      WORKER_FRAME_KIND.error,
      WORKER_FRAME_KIND.ready,
    ]);
    const failure = errorOf(frames[0]);
    expect(failure.kind).toBe(PTC_ERROR_KIND.exception);
    expect(failure.message).toBe("results is not defined");
  },
  RUN_TIMEOUT_MS,
);

test(
  "duplicate parameters are a compile-time error, not a silent run",
  async () => {
    const worker = startWorker();
    const frames = await worker.run("function f(a, a) { return a; }\nreturn f(1, 2);");

    expect(frames.map((frame) => frame.kind)).toEqual([
      WORKER_FRAME_KIND.error,
      WORKER_FRAME_KIND.ready,
    ]);
    const failure = errorOf(frames[0]);
    // "program failed to compile:" is how the worker says the program never ran — the only
    // way to tell a compile-time failure from a runtime one.
    expect(failure.message).toContain("program failed to compile:");
    // ECMAScript's strict mode forbids duplicate parameter names; the error type is V8's.
    expect(failure.stack).toContain("SyntaxError:");
    // Counterfactual: with the strict prefix removed, the program compiles and returns 2, so
    // the frame kinds become [result, ready] and this goes red.
  },
  RUN_TIMEOUT_MS,
);

test(
  "an octal literal is a compile-time error, not a silent 8",
  async () => {
    const worker = startWorker();
    const frames = await worker.run("return 010;");

    expect(frames.map((frame) => frame.kind)).toEqual([
      WORKER_FRAME_KIND.error,
      WORKER_FRAME_KIND.ready,
    ]);
    const failure = errorOf(frames[0]);
    expect(failure.message).toContain("program failed to compile:");
    expect(failure.stack).toContain("SyntaxError:");
    // Counterfactual: with the strict prefix removed, `010` is a legacy octal literal worth 8
    // and the program returns 8, so the frame kinds become [result, ready] and this goes red.
  },
  RUN_TIMEOUT_MS,
);
