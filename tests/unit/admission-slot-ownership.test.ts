/**
 * ADR-0056 / ADR-0057: the admission queue OWNS the slot, and every way out of it gives the
 * slot back.
 *
 * Two defects, one root — a release that does not release, and a release that releases without
 * starting the waiter it promoted:
 *
 *   1. a dispatch whose task record cannot be written while it is QUEUED called the plain
 *      `release` on a holder that holds NO slot (a queued holder lives in the wait list, not in
 *      the holder set), so the release was a no-op and the waiter stayed in the queue for ever.
 *      The session then lost one slot of effective concurrency per occurrence, silently;
 *   2. a withdrawal of a holder that had ALREADY been promoted called the plain `release` too.
 *      That release IS the promoting one — it hands the freed slot to the oldest waiter and
 *      RETURNS it — and the return value was dropped, so the next waiter held a slot that
 *      nobody ever started.
 *
 * SPECIFICATION tests (docs/testing-constraints.md #4/#6): the expected values are the queue
 * invariants ADR-0056 states ("a freed slot goes to the oldest waiter", "a queued task holds
 * no slot") and facts a caller can SEE — whether the next dispatch was admitted at once, and
 * whether its child started. None of them reads back a value the implementation happened to
 * produce.
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
  setPromptFileWriter,
  type DispatchDeps,
} from "../../src/runtime/dispatch.ts";
import {
  MockChildProcessLifecycle,
  type ChildHandle,
} from "../../src/runtime/child-process-lifecycle.ts";
import {
  createTaskRegistry,
  type RegistryLogger,
  type TaskRegistry,
} from "../../src/runtime/task-registry.ts";
import {
  InMemoryTaskStorage,
  type TaskRecord,
  type TaskStatus,
} from "../../src/runtime/task-storage.ts";
import { InMemoryOutputStorage } from "../../src/runtime/output-storage.ts";
import { makeTempDir, removeTempDir, waitFor } from "../helpers/ptc.ts";

const AGENT = "slot-ownership-probe";
const AGENT_MD = "---\nname: slot-ownership-probe\n---\nYou answer.\n";

/** The child's answer, a literal — not a value the implementation produced. */
const ANSWER = "PONG";

/**
 * The fs error a session directory that cannot be written produces.
 *
 * A LITERAL, shaped like the `node:fs` error the caller would see, so the refusal's message
 * is the one a reader would recognise (testing-constraints #2).
 */
const WRITE_FAILURE = "EACCES: permission denied, open '/tmp/pi-ptc-session/tasks/record.json'";

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

/** A logger that KEEPS what it was told, so a test can read the runtime's own report. */
class RecordingLogger implements RegistryLogger {
  readonly warnings: string[] = [];

  info(): void {
    // The `info` channel is not what these tests are about.
  }

  warn(msg: string): void {
    this.warnings.push(msg);
  }
}

interface Harness {
  registry: TaskRegistry;
  lifecycle: RecordingLifecycle;
  slots: DispatchSlotCounter;
  logger: RecordingLogger;
  deps: DispatchDeps;
}

function createHarness(options: { limit?: number } = {}): Harness {
  const storage = new InMemoryTaskStorage();
  const slots = new DispatchSlotCounter(options.limit ?? 8);
  const registry = createTaskRegistry(storage, { clock: () => 1_000, queue: slots });
  const lifecycle = new RecordingLifecycle();
  const logger = new RecordingLogger();
  const outputStorage = new InMemoryOutputStorage();
  return {
    registry,
    lifecycle,
    slots,
    logger,
    deps: { taskRegistry: registry, lifecycle, slots, outputStorage, clock: () => 1_000, logger },
  };
}

/**
 * A registry whose SPAWN write fails, and only that.
 *
 * Every other command is delegated to the real registry, so the queue, the records and the
 * stop path keep working: what is under test is the dispatch's reaction to a write that
 * cannot land, not a registry that is broken everywhere.
 */
function spawnFailingRegistry(inner: TaskRegistry, message: string): TaskRegistry {
  return {
    transition: (command, ctx) =>
      command.kind === "spawn"
        ? Promise.reject(new Error(message))
        : inner.transition(command, ctx),
    query: (view) => inner.query(view),
    get: (taskId) => inner.get(taskId),
    taskFaceVisible: () => inner.taskFaceVisible(),
    onTransition: (observer) => inner.onTransition(observer),
    reconcileLostTasks: () => inner.reconcileLostTasks(),
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
 * The registry's read side is async, so this polls the registry itself rather than a captured
 * snapshot — a snapshot read once would race the write it is waiting for.
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

/**
 * Poll until `condition` holds; `false` when it never did.
 *
 * Used where the assertion is ABOUT the absence of an event: the poll gives the event its
 * chance to happen, and the assertion that follows says whether it did.
 */
async function settled(condition: () => boolean, timeoutMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return true;
}

/** Drive one child to a clean close with `text` as its answer. */
function answerChild(lifecycle: RecordingLifecycle, index: number, text: string): void {
  lifecycle.pushEvent(lifecycle.handleAt(index), {
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] },
  });
  lifecycle.resolveExit(lifecycle.handleAt(index), 0, null);
}

// ---------------------------------------------------------------------------
//  1. a failed task-record write must not strand the waiter
// ---------------------------------------------------------------------------

describe("ADR-0056: a dispatch whose task record cannot be written leaves the queue", () => {
  test("the admission is withdrawn, so the queue is empty and the next dispatch is admitted", async () => {
    await withAgent(async (dir) => {
      // One slot, and it is taken: the cap is reached by the very next call.
      const h = createHarness({ limit: 1 });
      const running = dispatch(
        { wait: true, agent: AGENT, task: "first", agentScope: "project" },
        { ...ctx(1), cwd: dir },
        h.deps,
      );
      await waitFor(() => h.lifecycle.spawnCount > 0);
      expect(h.slots.active, "the running child holds the one slot").toBe(1);

      // The second dispatch QUEUES, and then its task record cannot be written.
      const failed = await dispatch(
        { wait: true, agent: AGENT, task: "second", agentScope: "project" },
        { ...ctx(2), cwd: dir },
        { ...h.deps, taskRegistry: spawnFailingRegistry(h.registry, WRITE_FAILURE) },
      );

      // The refusal names the cause (testing-constraints #3 -- no silent failure).
      expect(failed.status, "the dispatch is refused rather than run unrecorded").toBe("rejected");
      expect(failed.errorMessage).toBe(
        "dispatch could not register its task record: " + WRITE_FAILURE,
      );

      // The queue is EMPTY. A queued holder holds no slot, so the plain `release` this path
      // used to call found no holder at all and left the waiter in the queue for ever.
      expect(h.slots.queued, "the failed dispatch is not left waiting in the queue").toBe(0);
      expect(h.slots.active, "and it holds no slot of its own").toBe(1);
      expect(h.slots.waiting, "the wait list is empty").toEqual([]);

      // No task appears in the list: the record write is what failed.
      const records = await h.registry.query({});
      expect(records, "only the running task left a record behind").toHaveLength(1);

      // The capacity is REAL: the next dispatch is admitted at once instead of queueing
      // behind a task that will never start.
      answerChild(h.lifecycle, 0, ANSWER);
      await running;
      const next = await dispatch(
        { agent: AGENT, task: "third", agentScope: "project" },
        { ...ctx(3), cwd: dir },
        h.deps,
      );
      expect(isDispatchHandle(next), "the next dispatch returned a handle").toBe(true);
      if (!isDispatchHandle(next)) throw new Error("the next dispatch did not return a handle");
      expect(
        next.status,
        "the next dispatch was ADMITTED, not queued behind a task that will never start",
      ).toBe("running");
      expect(h.slots.queued, "and nothing is left waiting").toBe(0);

      await waitFor(() => h.lifecycle.spawnCount > 1);
      answerChild(h.lifecycle, 1, ANSWER);
    });
  });
});

// ---------------------------------------------------------------------------
//  2. a withdrawal must not swallow the promotion it causes
// ---------------------------------------------------------------------------

describe("ADR-0057: withdrawing an already-promoted holder does not swallow the next waiter", () => {
  test("the waiter behind the withdrawn one is STARTED, and holds exactly one slot", async () => {
    await withAgent(async (dir) => {
      const h = createHarness({ limit: 1 });

      // The one slot is taken by a DETACHED child, so the test can read its task id: the
      // holder is the token every release is keyed by.
      const holder = await dispatch(
        { agent: AGENT, task: "first", agentScope: "project" },
        { ...ctx(1), cwd: dir },
        h.deps,
      );
      expect(isDispatchHandle(holder), "the holder returned a handle").toBe(true);
      if (!isDispatchHandle(holder)) throw new Error("the holder did not return a handle");
      await waitFor(() => h.lifecycle.spawnCount > 0);
      expect(h.slots.active, "the detached child holds the one slot").toBe(1);

      // Two more queue behind it, in a known order: "second" before "third".
      const controller = new AbortController();
      const aborted = dispatch(
        { wait: true, agent: AGENT, task: "second", agentScope: "project" },
        { ...ctx(2), cwd: dir, signal: controller.signal },
        h.deps,
      );
      const third = dispatch(
        { wait: true, agent: AGENT, task: "third", agentScope: "project" },
        { ...ctx(3), cwd: dir },
        h.deps,
      );
      const queued = await waitForStatus(h.registry, "queued", 2);
      const abortedId = queued.find((record) => record.label === "second")?.id;
      const thirdId = queued.find((record) => record.label === "third")?.id;
      expect(h.slots.queued, "both over-cap dispatches are waiting").toBe(2);

      // The abort and the slot handover land in the SAME tick: the abort settles the wait as
      // "aborted", and the counter hands the freed slot to the OLDEST waiter before the
      // withdrawal runs. That is the window under test — the holder is PROMOTED and then
      // withdrawn, so the withdrawal has to give the slot back to the NEXT waiter.
      controller.abort();
      const promoted = h.slots.release(holder.taskId);
      expect(promoted?.holder, "the freed slot went to the oldest waiter").toBe(abortedId);
      // The counter hands the slot over and returns the waiter; starting it is the caller's
      // job, which is what the module's own release does.
      promoted?.onGranted();

      // The withdrawal gives the slot back — and the next waiter must be STARTED, not left
      // holding a slot nobody ever uses.
      await settled(() => h.lifecycle.spawnCount > 1);
      expect(
        h.lifecycle.spawnCount,
        "the waiter behind the withdrawn holder was STARTED, not left holding the slot",
      ).toBe(2);

      const thirdRecord = await h.registry.get(thirdId as never);
      expect(thirdRecord?.status, "the next waiter left the queue and started").toBe("running");
      expect(h.slots.active, "and it holds exactly one slot").toBe(1);
      expect(h.slots.queued, "nothing is left waiting").toBe(0);

      // The aborted dispatch is told what happened to it.
      const abortedResult = await aborted;
      expect(abortedResult.status, "the aborted dispatch is refused").toBe("rejected");
      expect(abortedResult.errorMessage).toBe(
        "dispatch was aborted while it waited for a concurrency slot",
      );

      await waitFor(() => h.lifecycle.spawnCount > 1);
      answerChild(h.lifecycle, 1, ANSWER);
      await third;
      answerChild(h.lifecycle, 0, ANSWER);
    });
  });
});
