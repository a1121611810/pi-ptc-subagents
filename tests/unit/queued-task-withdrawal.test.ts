/**
 * ADR-0057: cancellation applies ONLY to a task that has not started.
 *
 * The ticket's acceptance criteria, one test each:
 *
 *   1. a task that is still WAITING for a concurrency slot can be stopped, and it is marked
 *      canceled rather than refused;
 *   2. a task that is already RUNNING cannot be canceled — it goes down the signal ladder
 *      (`running -> stopping`), unchanged;
 *   3. after a withdrawal the task occupies no queue position, and freeing a slot never starts
 *      it;
 *   4. the withdrawal leaves a trace on the record (the status and the reason), so it does not
 *      silently disappear;
 *   5. the sentence that says what a stop does is ONE constant, carried by both model-facing
 *      surfaces (the tool's description and the guideline).
 *
 * SPECIFICATION tests (docs/testing-constraints.md #4/#6): every expected value is a literal
 * from the ticket, from ADR-0057 or from ADR-0022 §8's vocabulary (`canceled`, `stopping`,
 * `stopReason`) — never a value read back out of the implementation. The queue lengths and the
 * spawn counts are the ticket's own words ("it no longer occupies a queue position", "never
 * starts a process").
 *
 * Dependencies are injected: the child is a `MockChildProcessLifecycle`, the record store is
 * an `InMemoryTaskStorage`, and the queue is a `DispatchSlotCounter` of limit 1 — so no `pi`
 * process is ever spawned and no home directory is touched.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  DispatchSlotCounter,
  dispatch,
  isDispatchHandle,
  type DispatchDeps,
} from "../../src/runtime/dispatch.ts";
import {
  MockChildProcessLifecycle,
  type ChildHandle,
} from "../../src/runtime/child-process-lifecycle.ts";
import {
  createTaskRegistry,
  type DispatchHandle,
  type TaskRegistry,
} from "../../src/runtime/task-registry.ts";
import {
  InMemoryTaskStorage,
  type TaskRecord,
  type TaskStatus,
  type ULID,
} from "../../src/runtime/task-storage.ts";
import { InMemoryOutputStorage } from "../../src/runtime/output-storage.ts";
import {
  createPtcTaskStopTool,
  type AnyTool,
  type PtcTaskStopDetails,
} from "../../src/tools/ptc-task.ts";
import { TASK_STOP_SEMANTICS } from "../../src/tools/task-stop-text.ts";
import { makeTempDir, removeTempDir, waitFor } from "../helpers/ptc.ts";

const AGENT = "withdrawal-probe";
const AGENT_MD = "---\nname: withdrawal-probe\n---\nYou answer.\n";

/** The child's answer, a literal — not a value the implementation produced. */
const ANSWER = "PONG";

/** The reason the model gives when it stops a task; a literal, so the assertion is about the
 *  record carrying the CALLER's reason rather than about any wording of ours. */
const STOP_REASON = "no longer needed";

/** Records every handle the branch spawns, so a test can drive its exit. */
class RecordingLifecycle extends MockChildProcessLifecycle {
  readonly spawned: ChildHandle[] = [];

  override spawn(
    argv: readonly string[],
    opts: Parameters<MockChildProcessLifecycle["spawn"]>[1],
  ): ChildHandle {
    const handle = super.spawn(argv, opts);
    this.spawned.push(handle);
    return handle;
  }

  /** The handle at `index`, or a loud failure (no unchecked-index silencing). */
  handleAt(index: number): ChildHandle {
    const handle = this.spawned[index];
    if (handle === undefined) {
      throw new Error("RecordingLifecycle: no spawned handle at index " + String(index));
    }
    return handle;
  }
}

interface Harness {
  registry: TaskRegistry;
  lifecycle: RecordingLifecycle;
  slots: DispatchSlotCounter;
  deps: DispatchDeps;
}

/**
 * The harness wires the queue INTO the registry (ADR-0057): the registry owns the withdrawal,
 * so it needs the queue it withdraws from. Production does the same in
 * `createBackgroundTaskRuntime`, where the session's one counter is both the admission queue
 * and the registry's queue.
 */
function createHarness(options: { limit?: number } = {}): Harness {
  const storage = new InMemoryTaskStorage();
  const slots = new DispatchSlotCounter(options.limit ?? 8);
  const registry = createTaskRegistry(storage, { clock: () => 1_000, queue: slots });
  const lifecycle = new RecordingLifecycle();
  const outputStorage = new InMemoryOutputStorage();
  return {
    registry,
    lifecycle,
    slots,
    deps: { taskRegistry: registry, lifecycle, slots, outputStorage, clock: () => 1_000 },
  };
}

/** Write a project-scope agent markdown into a fresh temp cwd and run `body`. */
async function withAgent<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await makeTempDir();
  try {
    await mkdir(join(dir, ".pi", "agents"), { recursive: true });
    await writeFile(join(dir, ".pi", "agents", AGENT + ".md"), AGENT_MD, { encoding: "utf-8" });
    // The prompt temp file is not what these tests are about, and the real writer costs an fs
    // round trip PER DISPATCH. The seam is the repo's own (`setPromptFileWriter`).
    const { setPromptFileWriter } = await import("../../src/runtime/dispatch.ts");
    setPromptFileWriter(async () => ({
      dir: join(dir, "prompt-dir"),
      filePath: join(dir, "prompt-dir", "prompt.md"),
    }));
    try {
      return await body(dir);
    } finally {
      setPromptFileWriter(undefined);
    }
  } finally {
    await removeTempDir(dir);
  }
}

/** The dispatch context for one call; only `callId` differs between calls in a test. */
function ctx(callId: number): {
  callId: number;
  cwd: string;
  depth: number;
  maxDispatchDepth: number;
} {
  return { callId, cwd: "", depth: 0, maxDispatchDepth: 3 };
}

/**
 * Wait until the registry holds at least `count` records in `status`.
 *
 * The registry's read side is async, so this polls the registry itself rather than a
 * captured snapshot — a snapshot read once would race the write it is waiting for.
 */
async function waitForStatus(
  registry: TaskRegistry,
  status: TaskStatus,
  count = 1,
): Promise<TaskRecord[]> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const records = await registry.query({ status: [status] });
    if (records.length >= count) return records;
    if (Date.now() > deadline) {
      throw new Error("waitForStatus timed out waiting for " + String(count) + " " + status);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Drive one child to a clean close with `text` as its answer. */
function answerChild(lifecycle: RecordingLifecycle, index: number, text: string): void {
  lifecycle.pushEvent(lifecycle.handleAt(index), {
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] },
  });
  lifecycle.resolveExit(lifecycle.handleAt(index), 0, null);
}

/** Run one `ptc_task_stop` call and read its `details`. */
async function callStop(tool: AnyTool, taskId: ULID, reason: string): Promise<PtcTaskStopDetails> {
  const result = await tool.execute(
    "call-1",
    { taskId, reason },
    undefined,
    undefined,
    undefined as never,
  );
  return (result as { details: PtcTaskStopDetails }).details;
}

// ---------------------------------------------------------------------------
//  1 + 3 + 4. a stop on a QUEUED task withdraws it
// ---------------------------------------------------------------------------

describe("ADR-0057: stopping a task that is still waiting for a slot withdraws it", () => {
  test("the record is canceled with the reason, the queue slot is freed, and no child starts", async () => {
    await withAgent(async (dir) => {
      // One slot, and it is taken: the cap is reached by the very next call.
      const h = createHarness({ limit: 1 });
      const running = dispatch(
        { agent: AGENT, task: "first", agentScope: "project" },
        { ...ctx(1), cwd: dir },
        h.deps,
      );
      await waitFor(() => h.lifecycle.spawnCount > 0);

      const queued = dispatch(
        { agent: AGENT, task: "second", agentScope: "project" },
        { ...ctx(2), cwd: dir },
        h.deps,
      );
      const queuedRecords = await waitForStatus(h.registry, "queued");
      const queuedId = queuedRecords[0]?.id as ULID;
      expect(h.slots.queued, "the second dispatch is waiting for a slot").toBe(1);

      // The model stops the task that has not started yet.
      const stop = createPtcTaskStopTool(h.registry, h.lifecycle, { clock: () => 1_000 });
      const details = await callStop(stop, queuedId, STOP_REASON);

      // ADR-0057: a task with no child to signal is WITHDRAWN, not stopped-and-signaled.
      expect(details.fromStatus, "the stop started from `queued`").toBe("queued");
      expect(details.task.status, "a task that never started is canceled").toBe("canceled");

      // The trace is on the record: the status and the reason.
      const record = await h.registry.get(queuedId);
      expect(record?.status, "the record says the task was canceled").toBe("canceled");
      expect(record?.stopReason, "the caller's reason is on the record").toBe(STOP_REASON);

      // The queue position is gone.
      expect(h.slots.queued, "the withdrawn task occupies no queue position").toBe(0);

      // The waiting caller is told, rather than left waiting for a slot that will never come.
      const result = await queued;
      expect(result.status, "the withdrawn foreground call is refused").toBe("rejected");
      expect(result.errorMessage).toBe("dispatch was withdrawn from the admission queue");

      // Freeing the slot must NOT start the withdrawn child.
      answerChild(h.lifecycle, 0, ANSWER);
      await running;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(h.lifecycle.spawnCount, "the withdrawn request never launched a child").toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
//  2. a RUNNING task cannot be canceled — it goes down the signal ladder
// ---------------------------------------------------------------------------

describe("ADR-0057: a task that is already running is not canceled", () => {
  test("the stop drives `running -> stopping`, and the child's close writes the terminal state", async () => {
    await withAgent(async (dir) => {
      const h = createHarness({ limit: 1 });
      // A background dispatch returns its handle at once, so the task is up while the test runs.
      const spawned = await dispatch(
        { agent: AGENT, task: "first", agentScope: "project", background: true },
        { ...ctx(1), cwd: dir },
        h.deps,
      );
      if (!isDispatchHandle(spawned)) throw new Error("the call did not return a handle");
      const handle: DispatchHandle = spawned;
      await waitFor(() => h.lifecycle.spawnCount > 0);

      const stop = createPtcTaskStopTool(h.registry, h.lifecycle, { clock: () => 1_000 });
      const details = await callStop(stop, handle.taskId, STOP_REASON);

      // ADR-0022 §8: a running task goes to `stopping` and the DISPATCHER writes the terminal
      // `canceled` when the child closes. The tool never claims `canceled` for a live child.
      expect(details.fromStatus, "the stop started from `running`").toBe("running");
      expect(details.task.status, "a running task goes to `stopping`").toBe("stopping");

      const record = await h.registry.get(handle.taskId);
      expect(record?.status, "the record is `stopping`, not `canceled`").toBe("stopping");
      expect(record?.stopReason, "the caller's reason is on the record").toBe(STOP_REASON);
    });
  });
});

// ---------------------------------------------------------------------------
//  5. one shared sentence on both model-facing surfaces
// ---------------------------------------------------------------------------

describe("ADR-0057: the stop sentence is one constant on both model-facing surfaces", () => {
  test("the tool's description and the guideline carry the SAME shared sentence", async () => {
    const h = createHarness();
    const stop = createPtcTaskStopTool(h.registry, h.lifecycle, { clock: () => 1_000 });

    // The same sentence reaches the model twice — as the tool's declaration and as a guideline
    // in the system prompt. Two copies would be two things that can drift.
    expect(stop.description, "the description carries the shared sentence").toContain(
      TASK_STOP_SEMANTICS,
    );
    expect(
      (stop.promptGuidelines ?? []).join(" "),
      "the guideline carries the same shared sentence",
    ).toContain(TASK_STOP_SEMANTICS);
  });

  test("the model-facing text never says `sandbox`", async () => {
    const h = createHarness();
    const stop = createPtcTaskStopTool(h.registry, h.lifecycle, { clock: () => 1_000 });
    // This package has no OS sandbox (ADR-0007), and the wording is model-facing: a model that
    // reads "sandbox" may believe it is contained when it is not.
    expect(stop.description).not.toMatch(/sandbox/i);
    expect((stop.promptGuidelines ?? []).join(" ")).not.toMatch(/sandbox/i);
  });
});
