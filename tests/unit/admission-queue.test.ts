/**
 * ADR-0056: admission queues instead of rejecting.
 *
 * The ticket's acceptance criteria, one test each:
 *
 *   1. over the cap, a request is QUEUED, never refused (the cap is no longer a rejection
 *      reason);
 *   2. queueing creates the task record, with status `queued` — so a queued task is visible
 *      in the task list;
 *   3. a slot is held only by a child that is actually RUNNING — a queued task holds none;
 *   4. the queue is FIFO: the oldest waiter runs first;
 *   5. dequeue takes the slot, the record turns `running`, and only then does the child start;
 *   6. the two concurrency REFUSAL factories are gone — the cap is not a rejection reason any more.
 *
 * SPECIFICATION tests (docs/testing-constraints.md #4/#6): every expected value is a literal
 * from the ticket or the spec, or a value read back out of the fixture — never something the
 * implementation happened to produce. The counters and limits are the ticket's own words
 * ("FIFO", "unbounded", "no timeout"), and the ordering assertions are about which task ran
 * FIRST, which is the property the FIFO rule exists to give.
 *
 * Dependencies are injected: the child is a `MockChildProcessLifecycle`, the record store is
 * an `InMemoryTaskStorage`, so no `pi` process is ever spawned and no home directory is touched.
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
  type DispatchResult,
} from "../../src/runtime/dispatch.ts";
import {
  MockChildProcessLifecycle,
  type ChildHandle,
} from "../../src/runtime/child-process-lifecycle.ts";
import { createTaskRegistry, type TaskRegistry } from "../../src/runtime/task-registry.ts";
import {
  InMemoryTaskStorage,
  type TaskRecord,
  type TaskStatus,
  type ULID,
} from "../../src/runtime/task-storage.ts";
import { InMemoryOutputStorage } from "../../src/runtime/output-storage.ts";
import { createPtcTaskListTool } from "../../src/tools/ptc-task.ts";
import { makeTempDir, removeTempDir, waitFor } from "../helpers/ptc.ts";

const AGENT = "admission-probe";
const AGENT_MD = "---\nname: admission-probe\n---\nYou answer.\n";

/** The child's answer, a literal — not a value the implementation produced. */
const ANSWER = "PONG";

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
  storage: InMemoryTaskStorage;
  registry: TaskRegistry;
  lifecycle: RecordingLifecycle;
  slots: DispatchSlotCounter;
  outputStorage: InMemoryOutputStorage;
  deps: DispatchDeps;
}

function createHarness(options: { limit?: number } = {}): Harness {
  const storage = new InMemoryTaskStorage();
  const registry = createTaskRegistry(storage, { clock: () => 1_000 });
  const lifecycle = new RecordingLifecycle();
  const slots = new DispatchSlotCounter(options.limit ?? 8);
  const outputStorage = new InMemoryOutputStorage();
  return {
    storage,
    registry,
    lifecycle,
    slots,
    outputStorage,
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

// ---------------------------------------------------------------------------
//  1 + 2 + 3. over the cap: queued, visible, and holding no slot
// ---------------------------------------------------------------------------

describe("ADR-0056: over the cap, a dispatch waits instead of being refused", () => {
  test("a foreground dispatch over the cap queues, and it is not settled while it waits", async () => {
    await withAgent(async (dir) => {
      // One slot, and it is taken: the cap is reached by the very next call.
      const h = createHarness({ limit: 1 });
      const running = dispatch(
        { agent: AGENT, task: "first", agentScope: "project" },
        { ...ctx(1), cwd: dir },
        h.deps,
      );
      await waitFor(() => h.lifecycle.spawnCount > 0);
      expect(h.slots.active, "the running child holds the one slot").toBe(1);

      // The second dispatch has nowhere to go. It must WAIT — the cap is no longer a
      // rejection reason.
      let settled = false;
      const queued = dispatch(
        { agent: AGENT, task: "second", agentScope: "project" },
        { ...ctx(2), cwd: dir },
        h.deps,
      ).then((result: DispatchResult) => {
        settled = true;
        return result;
      });

      // Queueing CREATES the record (the queue IS the set of `queued` records), so the
      // task is already visible to the model while it waits.
      const queuedRecords = await waitForStatus(h.registry, "queued");
      expect(queuedRecords, "the queued dispatch left one record behind").toHaveLength(1);
      expect(settled, "the queued dispatch has not settled: it is waiting, not refused").toBe(
        false,
      );
      expect(h.lifecycle.spawnCount, "the queued dispatch has not started a child yet").toBe(1);
      expect(h.slots.active, "a queued task holds no slot — only the running child holds one").toBe(
        1,
      );
      expect(h.slots.queued, "the counter knows one dispatch is waiting").toBe(1);

      // Freeing the slot lets the queued dispatch run.
      answerChild(h.lifecycle, 0, ANSWER);
      await running;
      await waitFor(() => h.lifecycle.spawnCount > 1);
      answerChild(h.lifecycle, 1, ANSWER);
      const result = await queued;
      expect(result.status, "the queued dispatch ran once a slot freed").toBe("fulfilled");
      expect(result.text).toBe(ANSWER);
    });
  });
});

// ---------------------------------------------------------------------------
//  4 + 5. FIFO order, and the record turns `running` before the child starts
// ---------------------------------------------------------------------------

describe("ADR-0056: the queue is FIFO", () => {
  test("two dispatches over the cap run in the order they queued", async () => {
    await withAgent(async (dir) => {
      const h = createHarness({ limit: 1 });
      const running = dispatch(
        { agent: AGENT, task: "first", agentScope: "project" },
        { ...ctx(1), cwd: dir },
        h.deps,
      );
      await waitFor(() => h.lifecycle.spawnCount > 0);

      // Two more, queued in a known order: "second" before "third".
      const second = dispatch(
        { agent: AGENT, task: "second", agentScope: "project" },
        { ...ctx(2), cwd: dir },
        h.deps,
      );
      const third = dispatch(
        { agent: AGENT, task: "third", agentScope: "project" },
        { ...ctx(3), cwd: dir },
        h.deps,
      );
      const queuedRecords = await waitForStatus(h.registry, "queued", 2);
      expect(queuedRecords, "both over-cap dispatches queued").toHaveLength(2);
      expect(
        h.slots.waiting,
        "the queue is FIFO: the first waiter is the one that queued first",
      ).toEqual([queuedRecords[0]?.id, queuedRecords[1]?.id]);

      // Free the slot: the OLDEST waiter runs first.
      answerChild(h.lifecycle, 0, ANSWER);
      await running;
      await waitFor(() => h.lifecycle.spawnCount > 1);
      const firstQueued = await h.registry.get(queuedRecords[0]?.id as never);
      expect(
        firstQueued?.status,
        "the head of the queue turned `running` before its child started",
      ).toBe("running");

      answerChild(h.lifecycle, 1, ANSWER);
      await second;
      await waitFor(() => h.lifecycle.spawnCount > 2);
      answerChild(h.lifecycle, 2, ANSWER);
      await third;

      // The order the two answers came back in IS the queue order.
      const secondResult = await Promise.resolve(second);
      const thirdResult = await Promise.resolve(third);
      expect(secondResult.status).toBe("fulfilled");
      expect(thirdResult.status).toBe("fulfilled");
      expect(h.slots.active, "every queued task ran and released its slot").toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
//  6. the refusal factories are gone
// ---------------------------------------------------------------------------

describe("ADR-0056: the cap is no longer a rejection reason", () => {
  test("the module exports no concurrency refusal factory any more", async () => {
    const module = (await import("../../src/runtime/dispatch.ts")) as Record<string, unknown>;
    expect(
      "dispatchConcurrencyLimitReached" in module,
      "the foreground concurrency refusal factory is gone",
    ).toBe(false);
    expect(
      "backgroundDispatchConcurrencyLimitReached" in module,
      "the background concurrency refusal factory is gone",
    ).toBe(false);
    expect(
      "DISPATCH_CONCURRENCY_LIMIT_MESSAGE" in module,
      "the concurrency refusal message is gone",
    ).toBe(false);
    expect(
      "BACKGROUND_CONCURRENCY_LIMIT_MESSAGE" in module,
      "the background concurrency refusal message is gone",
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  the background front: a not-waiting dispatch returns its handle at once
// ---------------------------------------------------------------------------

describe("ADR-0056: a background dispatch over the cap returns its handle at once", () => {
  test("the handle says `queued`, and the child starts when the head of the queue is reached", async () => {
    await withAgent(async (dir) => {
      const h = createHarness({ limit: 1 });

      // The one slot is taken by a child that is still running.
      const first = await dispatch(
        { agent: AGENT, task: "first", agentScope: "project", background: true },
        { ...ctx(1), cwd: dir },
        h.deps,
      );
      expect(isDispatchHandle(first), "the first call returned a handle").toBe(true);
      if (!isDispatchHandle(first)) throw new Error("the first call did not return a handle");
      expect(first.status, "the first child is up").toBe("running");
      await waitFor(() => h.lifecycle.spawnCount > 0);

      // The second call has nowhere to go. It does NOT wait for a slot: a background
      // dispatch returns its handle at once, and the child waits.
      const second = await dispatch(
        { agent: AGENT, task: "second", agentScope: "project", background: true },
        { ...ctx(2), cwd: dir },
        h.deps,
      );
      expect(isDispatchHandle(second), "the queued call returned a handle, not a refusal").toBe(
        true,
      );
      if (!isDispatchHandle(second)) throw new Error("the queued call did not return a handle");
      expect(second.status, "the queued call's handle says it is queued").toBe("queued");
      expect(h.lifecycle.spawnCount, "the queued call has not started a child yet").toBe(1);

      // Freeing the slot lets the queued child start.
      answerChild(h.lifecycle, 0, ANSWER);
      await waitFor(() => h.lifecycle.spawnCount > 1);
      const record = await h.registry.get(second.taskId);
      expect(record?.status, "the queued task turned `running` when it started").toBe("running");
      answerChild(h.lifecycle, 1, ANSWER);
    });
  });
});

// ---------------------------------------------------------------------------
//  the queued task is visible to the model
// ---------------------------------------------------------------------------

describe("ADR-0056: a queued task is visible in the task list", () => {
  test("ptc_task_list shows the queued task with its `queued` status", async () => {
    await withAgent(async (dir) => {
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
      await waitForStatus(h.registry, "queued");

      // The model-facing surface: the queued task is a row in the task list, and it can be
      // filtered for by the status the queue gives it.
      const list = createPtcTaskListTool(h.registry);
      const rendered = await list.execute(
        "call-1",
        { status: ["queued"] },
        undefined,
        undefined,
        undefined as never,
      );
      const text = rendered.content.map((part) => (part as { text?: string }).text ?? "").join("");
      expect(text, "the task list shows the queued task").toContain("queued");
      expect(text, "and names it by id").toContain("second");

      answerChild(h.lifecycle, 0, ANSWER);
      await running;
      await waitFor(() => h.lifecycle.spawnCount > 1);
      answerChild(h.lifecycle, 1, ANSWER);
      await queued;
    });
  });
});

// ---------------------------------------------------------------------------
//  the foreground's own bound: an aborted run withdraws its queued request
// ---------------------------------------------------------------------------

describe("ADR-0056: an aborted foreground run withdraws its queued request", () => {
  test("the queued record is canceled and no child is ever launched", async () => {
    await withAgent(async (dir) => {
      const h = createHarness({ limit: 1 });
      const running = dispatch(
        { agent: AGENT, task: "first", agentScope: "project" },
        { ...ctx(1), cwd: dir },
        h.deps,
      );
      await waitFor(() => h.lifecycle.spawnCount > 0);

      const controller = new AbortController();
      const queued = dispatch(
        { agent: AGENT, task: "second", agentScope: "project" },
        { ...ctx(2), cwd: dir, signal: controller.signal },
        h.deps,
      );
      const queuedRecords = await waitForStatus(h.registry, "queued");
      const queuedId = queuedRecords[0]?.id as ULID;

      // The run is aborted while its request is still waiting for a slot.
      controller.abort();
      const result = await queued;
      expect(result.status, "the aborted request is refused, not queued forever").toBe("rejected");
      expect(result.errorMessage).toBe(
        "dispatch was aborted while it waited for a concurrency slot",
      );

      // The withdrawal leaves a trace: the record says it was canceled.
      const canceled = await h.registry.get(queuedId);
      expect(canceled?.status, "the withdrawn task is marked canceled").toBe("canceled");
      expect(
        canceled?.stopReason,
        "and the reason is on the record — it did not silently disappear",
      ).toBe("the dispatch was aborted while it waited for a concurrency slot");
      expect(h.slots.queued, "and it is no longer in the queue").toBe(0);

      // Freeing the slot must NOT start the withdrawn child.
      answerChild(h.lifecycle, 0, ANSWER);
      await running;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(h.lifecycle.spawnCount, "the withdrawn request never launched a child").toBe(1);
    });
  });
});
