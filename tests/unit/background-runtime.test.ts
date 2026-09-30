/**
 * BG-14 unit tests for the session-scoped background runtime holder
 * (`src/runtime/background-runtime.ts`).
 *
 * SPECIFICATION tests (docs/testing-constraints.md #4/#6): every expected value traces to a
 * literal or invariant — the ADR-0022 §2 six-state machine (a restart marks `running` records
 * `lost` with `lost_on_session_restart`), §3/§7 (the record/event pair the renderer consumes),
 * §8 (the three distinct `lost` reasons; shutdown uses `session_ended_while_running`), §9 (one
 * session-level slot counter), and the holder contract itself. Nothing is copied from the
 * implementation.
 *
 * IO boundaries are exercised on both paths (constraint #1): a storage factory that throws, a
 * storage whose `listTasks` throws on a corrupt record, and the happy in-memory/file paths. The
 * child lifecycle is a `MockChildProcessLifecycle` so no real `pi` process is spawned.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { createBackgroundTaskRuntime } from "../../src/runtime/background-runtime.ts";
import {
  DISPATCH_KILL_GRACE_MS,
  dispatch,
  type DispatchResult,
} from "../../src/runtime/dispatch.ts";
import {
  MockChildProcessLifecycle,
  type ChildHandle,
  type ChildSpawnOptions,
} from "../../src/runtime/child-process-lifecycle.ts";
import {
  createTaskRegistry,
  type DispatchHandle,
  type TaskOwner,
  type TaskRecord,
} from "../../src/runtime/task-registry.ts";
import { InMemoryOutputStorage } from "../../src/runtime/output-storage.ts";
import {
  InMemoryTaskStorage,
  type TaskEvent,
  type TaskStorage,
  type ULID,
} from "../../src/runtime/task-storage.ts";
import {
  createPtcTaskListTool,
  type AnyTool,
  type PtcTaskListDetails,
} from "../../src/tools/ptc-task.ts";
import { DEFAULT_CONFIG } from "../../src/runtime/limits.ts";
import { makeTempDir, removeTempDir, waitFor } from "../helpers/ptc.ts";

// ---------------------------------------------------------------------------
//  Fixtures — literal ULID-shaped ids and the ADR-0022 §3 record shape
// ---------------------------------------------------------------------------

const TASK_RUNNING = "01JBZ000000000000000000001" as ULID;
const TASK_SECOND = "01JBZ000000000000000000002" as ULID;
const TASK_FOREIGN_ALIVE = "01JBZ00000000000000000000A" as ULID;
const TASK_FOREIGN_DEAD = "01JBZ00000000000000000000B" as ULID;
const TASK_LEGACY = "01JBZ00000000000000000000C" as ULID;
const OWNER = "run-prev";
const AGENT = "bg-runtime-probe";
const AGENT_MD = "---\nname: " + AGENT + "\n---\nYou probe.\n";

const TERMINAL: ReadonlySet<string> = new Set(["succeeded", "failed", "canceled", "lost"]);

/** Mock lifecycle that records every handle the real dispatch pump spawns. */
class RecordingLifecycle extends MockChildProcessLifecycle {
  readonly spawned: ChildHandle[] = [];

  override spawn(argv: readonly string[], opts: ChildSpawnOptions): ChildHandle {
    const handle = super.spawn(argv, opts);
    this.spawned.push(handle);
    return handle;
  }

  handleAt(index: number): ChildHandle {
    const handle = this.spawned[index];
    if (handle === undefined) {
      throw new Error("RecordingLifecycle: no spawned handle at index " + String(index));
    }
    return handle;
  }
}

/**
 * Spawn record: 15 keys — the ADR-0022 §3 fields minus the four the registry owns (`id`,
 * `status`, `createdAt`, `transitionAt`). The ADR-0023 owner fields are NOT set here; the
 * registry stamps them itself, which is what the ownership tests below assert.
 */
function spawnRecord(
  callerId: string,
): Omit<TaskRecord, "id" | "status" | "createdAt" | "transitionAt"> {
  return {
    label: "seeded task",
    agentName: "researcher",
    depth: 0,
    startedAt: 1_000,
    finishedAt: undefined,
    durationMs: undefined,
    outputRef: undefined,
    outputBytes: undefined,
    outputPreview: undefined,
    stopReason: undefined,
    errorMessage: undefined,
    exitCode: undefined,
    spawnSource: { kind: "ptc-program", callerId },
    parentTaskId: undefined,
    sessionFile: undefined,
  };
}

/** Spawn one `running` record (with its owner subscription) through a real registry. */
async function seedRunningTask(
  storage: InMemoryTaskStorage,
  taskId: ULID = TASK_RUNNING,
  owner = OWNER,
): Promise<TaskRecord> {
  const registry = createTaskRegistry(storage, { clock: () => 1_000 });
  const { record } = await registry.transition(
    {
      kind: "spawn",
      handle: { taskId, label: "seeded task", status: "running" },
      record: spawnRecord(owner),
    },
    { clock: () => 1_000, callerId: owner },
  );
  return record;
}

async function withAgent<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await makeTempDir();
  try {
    await mkdir(join(dir, ".pi", "agents"), { recursive: true });
    await writeFile(join(dir, ".pi", "agents", AGENT + ".md"), AGENT_MD, { encoding: "utf-8" });
    return await body(dir);
  } finally {
    await removeTempDir(dir);
  }
}

function asHandle(value: DispatchHandle | DispatchResult): DispatchHandle {
  if (!("taskId" in value))
    throw new Error("expected a DispatchHandle, got " + JSON.stringify(value));
  return value;
}

/** Wait until the pump persists a terminal status in the given storage. */
async function waitForTerminalRecord(
  storage: InMemoryTaskStorage,
  taskId: ULID,
): Promise<TaskRecord> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const record = await storage.loadTask(taskId);
    if (record !== null && TERMINAL.has(record.status)) return record;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("task " + taskId + " did not reach a terminal state");
}

// ---------------------------------------------------------------------------
//  Session-less usability (the tools / dispatch path must work before a session)
// ---------------------------------------------------------------------------

describe("session-less runtime", () => {
  test("exposes a usable registry and output storage before bindSession", async () => {
    const runtime = createBackgroundTaskRuntime({
      createLifecycle: () => new MockChildProcessLifecycle(),
    });

    await runtime.registry.transition(
      {
        kind: "spawn",
        handle: { taskId: TASK_RUNNING, label: "l", status: "running" },
        record: spawnRecord(OWNER),
      },
      { clock: () => 1_000, callerId: OWNER },
    );
    const record = await runtime.registry.get(TASK_RUNNING);
    expect(record?.status).toBe("running");

    await runtime.outputStorage.writeOutput(TASK_RUNNING, "body");
    expect(await runtime.outputStorage.readOutput(TASK_RUNNING)).toBe("body");

    // One session-level slot counter, not a per-run rebuild (ADR-0022 §9).
    expect(runtime.slots.limit).toBe(DEFAULT_CONFIG.dispatchConcurrency);
  });
});

// ---------------------------------------------------------------------------
//  bindSession: delegate swap + reconcile
// ---------------------------------------------------------------------------

describe("bindSession", () => {
  test("swaps the delegate, marks running records lost, and returns them", async () => {
    const storage = new InMemoryTaskStorage();
    await seedRunningTask(storage);
    let calls = 0;
    const runtime = createBackgroundTaskRuntime({
      createStorage: () => {
        calls += 1;
        return storage;
      },
      createLifecycle: () => new MockChildProcessLifecycle(),
    });

    const lost = await runtime.bindSession("/sessions/s1");

    expect(calls).toBe(1);
    expect(lost.map((record) => record.id)).toEqual([TASK_RUNNING]);
    expect(lost[0]?.status).toBe("lost");
    expect(lost[0]?.errorMessage).toBe("lost_on_session_restart");
    // The stable delegate now resolves the same record from the new session storage.
    expect((await runtime.registry.get(TASK_RUNNING))?.status).toBe("lost");
  });

  test("drainNotifications joins each event to its record; acknowledge advances the cursor", async () => {
    const storage = new InMemoryTaskStorage();
    await seedRunningTask(storage);
    const runtime = createBackgroundTaskRuntime({
      createStorage: () => storage,
      createLifecycle: () => new MockChildProcessLifecycle(),
    });
    await runtime.bindSession("/sessions/s1");

    const drain = await runtime.drainNotifications(OWNER as ULID);

    expect(drain.items).toHaveLength(1);
    expect(drain.items[0]?.event.status).toBe("lost");
    expect(drain.items[0]?.event.taskId).toBe(TASK_RUNNING);
    expect(drain.items[0]?.record.id).toBe(TASK_RUNNING);
    expect(drain.acks).toHaveLength(1);
    expect(drain.acks[0]?.taskId).toBe(TASK_RUNNING);
    // The drain alone does not advance: the cursor moves only on acknowledge (ADR-0022 §5/§6),
    // so an undelivered batch re-drains.
    expect((await runtime.drainNotifications(OWNER as ULID)).items).toHaveLength(1);

    await runtime.acknowledgeNotifications(drain.acks);
    // Acknowledged: a third drain is empty (at-least-once, not repeat-forever).
    expect((await runtime.drainNotifications(OWNER as ULID)).items).toEqual([]);
  });

  test("an ack after a rebind lands on the session that drained the events (P1)", async () => {
    const storageA = new InMemoryTaskStorage();
    const storageB = new InMemoryTaskStorage();
    await seedRunningTask(storageA);
    const warnings: string[] = [];
    const runtime = createBackgroundTaskRuntime({
      createStorage: (sessionDir) => (sessionDir === "/sessions/a" ? storageA : storageB),
      createLifecycle: () => new MockChildProcessLifecycle(),
      logger: { info: () => undefined, warn: (message) => warnings.push(message) },
    });
    await runtime.bindSession("/sessions/a");
    const drain = await runtime.drainNotifications(OWNER as ULID);
    expect(drain.acks).toHaveLength(1);

    // Rebind BEFORE the ack: the stable pipeline proxy now points at session B, but the ack must
    // stay pinned to the session the drain read from (P1). Without the sink, the ack is misrouted
    // to B (where the subscription is unknown), warns, and leaves A's cursor unadvanced.
    await runtime.bindSession("/sessions/b");
    await runtime.acknowledgeNotifications(drain.acks);

    expect(warnings.filter((message) => message.includes("could not acknowledge"))).toEqual([]);
    expect((await storageA.loadSubscription(OWNER as ULID, TASK_RUNNING))?.cursor).toBe(
      drain.acks[0]?.cursor,
    );
    expect(await storageB.loadSubscription(OWNER as ULID, TASK_RUNNING)).toBeNull();
  });

  test("a terminal transition fires the registered idle-wake handler", async () => {
    const runtime = createBackgroundTaskRuntime({
      createLifecycle: () => new MockChildProcessLifecycle(),
    });
    const wakes: string[] = [];
    runtime.pipeline.onIdleWake((_subscriberId, events) => {
      for (const event of events) wakes.push(event.status);
    });

    await runtime.registry.transition(
      {
        kind: "spawn",
        handle: { taskId: TASK_RUNNING, label: "l", status: "running" },
        record: spawnRecord(OWNER),
      },
      { clock: () => 1_000, callerId: OWNER },
    );
    await runtime.registry.transition(
      { kind: "transition", taskId: TASK_RUNNING, to: "succeeded" },
      { clock: () => 1_500, callerId: OWNER },
    );
    // The observer detaches the (async) wake, so flush microtasks before asserting.
    for (let attempt = 0; attempt < 100 && wakes.length === 0; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(wakes).toEqual(["succeeded"]);
  });

  test("warns and reports a storage-construction failure, keeping the previous delegate usable", async () => {
    const good = new InMemoryTaskStorage();
    const goodOutput = new InMemoryOutputStorage();
    const warnings: string[] = [];
    const reported: string[] = [];
    let fail = false;
    const runtime = createBackgroundTaskRuntime({
      logger: { info: () => undefined, warn: (message) => warnings.push(message) },
      createStorage: () => {
        if (fail) throw new Error("storage factory boom");
        return good;
      },
      createOutputStorage: () => goodOutput,
      createLifecycle: () => new MockChildProcessLifecycle(),
    });

    await runtime.bindSession("/sessions/good");
    await runtime.registry.transition(
      {
        kind: "spawn",
        handle: { taskId: TASK_RUNNING, label: "l", status: "running" },
        record: spawnRecord(OWNER),
      },
      { clock: () => 1_000, callerId: OWNER },
    );
    fail = true;

    const result = await runtime.bindSession("/sessions/bad", (message) => reported.push(message));

    expect(result).toEqual([]);
    expect(warnings.some((message) => message.includes("storage factory boom"))).toBe(true);
    expect(reported.some((message) => message.includes("storage factory boom"))).toBe(true);
    // The previous delegate survives: the earlier task is still readable and writable.
    expect((await runtime.registry.get(TASK_RUNNING))?.status).toBe("running");
    await runtime.outputStorage.writeOutput(TASK_RUNNING, "still here");
    expect(await runtime.outputStorage.readOutput(TASK_RUNNING)).toBe("still here");
  });

  test("treats a reconcile failure as best-effort: warns, reports, resolves, registry stays usable", async () => {
    class CorruptStorage extends InMemoryTaskStorage {
      override async *listTasks(): AsyncIterable<TaskRecord> {
        // The yield keeps this a generator; the first next() then rejects, which is what the
        // storage's "corrupt record" contract surfaces.
        yield* [] as TaskRecord[];
        throw new Error("FileTaskStorage: corrupt JSON in tasks/xyz.json");
      }
    }
    const warnings: string[] = [];
    const reported: string[] = [];
    const runtime = createBackgroundTaskRuntime({
      logger: { info: () => undefined, warn: (message) => warnings.push(message) },
      createStorage: () => new CorruptStorage(),
      createLifecycle: () => new MockChildProcessLifecycle(),
    });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const result = await runtime.bindSession("/sessions/corrupt", (message) =>
        reported.push(message),
      );

      expect(result).toEqual([]);
      expect(warnings.some((message) => message.includes("corrupt JSON"))).toBe(true);
      expect(reported.some((message) => message.includes("corrupt JSON"))).toBe(true);
      // The session still comes up usable: spawn/get bypass listTasks, so they keep working.
      await runtime.registry.transition(
        {
          kind: "spawn",
          handle: { taskId: TASK_SECOND, label: "post-reconcile", status: "running" },
          record: spawnRecord(OWNER),
        },
        { clock: () => 2_000, callerId: OWNER },
      );
      expect((await runtime.registry.get(TASK_SECOND))?.status).toBe("running");
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
//  shutdown
// ---------------------------------------------------------------------------

describe("shutdown", () => {
  test("marks every non-terminal task lost with the given reason, kills children, releases slots, and is idempotent", async () => {
    const lifecycle = new MockChildProcessLifecycle();
    const runtime = createBackgroundTaskRuntime({ createLifecycle: () => lifecycle });
    // A live child the holder is tracking (the shared SIGTERM ladder must reach it).
    const handle = runtime.lifecycle.spawn(["pi", "--x"], {} as ChildSpawnOptions);
    // One held dispatch slot keyed by the task id that owns it, exactly as the background
    // branch acquires it; shutdown releases the same token (ADR-0022 §9).
    expect(runtime.slots.tryAcquire(TASK_RUNNING)).toBe(true);
    await runtime.registry.transition(
      {
        kind: "spawn",
        handle: { taskId: TASK_RUNNING, label: "l", status: "running" },
        record: spawnRecord(OWNER),
      },
      { clock: () => 1_000, callerId: OWNER },
    );

    const released = await runtime.shutdown("session_ended_while_running");

    expect(released.map((record) => record.id)).toEqual([TASK_RUNNING]);
    expect(released[0]?.status).toBe("lost");
    expect(released[0]?.errorMessage).toBe("session_ended_while_running");
    expect(lifecycle.getKillSignals(handle)).toEqual(["SIGTERM"]);
    expect(runtime.slots.active).toBe(0);
    expect((await runtime.registry.get(TASK_RUNNING))?.status).toBe("lost");

    // Idempotent: a second shutdown has no non-terminal task left and does not re-kill.
    expect(await runtime.shutdown("session_ended_while_running")).toEqual([]);
    expect(lifecycle.getKillSignals(handle)).toEqual(["SIGTERM"]);
  });

  test("a real pump plus shutdown leaves slots.active equal to the number of genuinely live tasks", async () => {
    await withAgent(async (dir) => {
      const lifecycle = new RecordingLifecycle();
      const warnings: string[] = [];
      const runtime = createBackgroundTaskRuntime({
        createLifecycle: () => lifecycle,
        concurrency: 2,
        logger: { info: () => undefined, warn: (message) => warnings.push(message) },
      });

      const spawn = async (callId: number, task: string): Promise<DispatchHandle> =>
        asHandle(
          await dispatch(
            { agent: AGENT, task, background: true, agentScope: "project" },
            { callId, cwd: dir, depth: 0, maxDispatchDepth: 3, callerId: "run-1" },
            runtime.dispatchDeps,
          ),
        );

      const first = await spawn(1, "one");
      const second = await spawn(2, "two");
      expect(runtime.slots.active).toBe(2);

      const reclaimed = await runtime.shutdown("session_ended_while_running");
      expect(reclaimed.map((record) => record.id).sort()).toEqual(
        [first.taskId, second.taskId].sort(),
      );
      expect(runtime.slots.active).toBe(0);

      const third = await spawn(3, "three");
      const fourth = await spawn(4, "four");
      expect(runtime.slots.active).toBe(2);

      lifecycle.resolveExit(lifecycle.handleAt(0), 0, null);
      lifecycle.resolveExit(lifecycle.handleAt(1), 0, null);
      for (let attempt = 0; attempt < 100 && warnings.length < 2; attempt += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(warnings.filter((message) => message.includes("is terminal")).length).toBe(2);
      expect(runtime.slots.active).toBe(2);

      const overCap = await dispatch(
        { agent: AGENT, task: "five", background: true, agentScope: "project" },
        { callId: 5, cwd: dir, depth: 0, maxDispatchDepth: 3, callerId: "run-1" },
        runtime.dispatchDeps,
      );
      expect("taskId" in overCap).toBe(false);
      expect(runtime.slots.active).toBe(2);

      lifecycle.resolveExit(lifecycle.handleAt(2), 0, null);
      lifecycle.resolveExit(lifecycle.handleAt(3), 0, null);
      expect(third.taskId.length).toBeGreaterThan(0);
      expect(fourth.taskId.length).toBeGreaterThan(0);
    });
  });

  test("cancels shutdown's SIGKILL escalation once the child closes (no signal to a reaped handle)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const lifecycle = new MockChildProcessLifecycle();
      const runtime = createBackgroundTaskRuntime({ createLifecycle: () => lifecycle });
      const handle = runtime.lifecycle.spawn(["pi", "--x"], {} as ChildSpawnOptions);
      await runtime.registry.transition(
        {
          kind: "spawn",
          handle: { taskId: TASK_RUNNING, label: "l", status: "running" },
          record: spawnRecord(OWNER),
        },
        { clock: () => 1_000, callerId: OWNER },
      );

      await runtime.shutdown("session_ended_while_running");
      expect(lifecycle.getKillSignals(handle)).toEqual(["SIGTERM"]);

      // The child closes: the pump's exit() is what clears the escalation timer. Drive it
      // directly (the pump path is covered above) and advance well past the grace window.
      lifecycle.resolveExit(handle, 0, null);
      await runtime.lifecycle.exit(handle);
      vi.advanceTimersByTime(DISPATCH_KILL_GRACE_MS * 2);
      // The escalation must not fire against a reaped handle (A4).
      expect(lifecycle.getKillSignals(handle)).toEqual(["SIGTERM"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
//  task ownership (ADR-0023)
// ---------------------------------------------------------------------------

describe("task ownership (ADR-0023)", () => {
  /** Literal owner identity for the runtime under test; foreign owners get distinct literals. */
  const RUNTIME_OWNER: TaskOwner = { pid: 61_000, bootMs: 1_000 };

  /** Spawn one running record through `registry` (the fixture record, seeded caller). */
  async function seedInto(
    registry: ReturnType<typeof createTaskRegistry>,
    taskId: ULID,
  ): Promise<void> {
    await registry.transition(
      {
        kind: "spawn",
        handle: { taskId, label: "seeded task", status: "running" },
        record: spawnRecord(OWNER),
      },
      { clock: () => 1_000, callerId: OWNER },
    );
  }

  test("records registered through the runtime carry the runtime's owner identity", async () => {
    const storage = new InMemoryTaskStorage();
    const runtime = createBackgroundTaskRuntime({
      createStorage: () => storage,
      createLifecycle: () => new MockChildProcessLifecycle(),
      owner: RUNTIME_OWNER,
    });
    await runtime.bindSession("/sessions/owned");

    await runtime.registry.transition(
      {
        kind: "spawn",
        handle: { taskId: TASK_RUNNING, label: "l", status: "running" },
        record: spawnRecord(OWNER),
      },
      { clock: () => 1_000, callerId: OWNER },
    );

    const record = await storage.loadTask(TASK_RUNNING);
    expect(record?.ownerPid).toBe(RUNTIME_OWNER.pid);
    expect(record?.ownerBootMs).toBe(RUNTIME_OWNER.bootMs);
  });

  test("bindSession reconcile is owner-scoped: a foreign-alive record survives, a foreign-dead one is swept", async () => {
    const storage = new InMemoryTaskStorage();
    const alivePids = new Set<number>([RUNTIME_OWNER.pid, 62_000]);
    const runtime = createBackgroundTaskRuntime({
      createStorage: () => storage,
      createLifecycle: () => new MockChildProcessLifecycle(),
      owner: RUNTIME_OWNER,
      isPidAlive: (pid) => alivePids.has(pid),
    });
    // A sibling pi process wrote these into the same shared dir before this runtime bound it.
    const foreignAlive = createTaskRegistry(storage, {
      clock: () => 1_000,
      owner: { pid: 62_000, bootMs: 5 },
    });
    const foreignDead = createTaskRegistry(storage, {
      clock: () => 1_000,
      owner: { pid: 63_000, bootMs: 5 },
    });
    await seedInto(foreignAlive, TASK_FOREIGN_ALIVE);
    await seedInto(foreignDead, TASK_FOREIGN_DEAD);

    const lost = await runtime.bindSession("/sessions/shared");

    expect(lost.map((record) => record.id)).toEqual([TASK_FOREIGN_DEAD]);
    expect(lost[0]?.errorMessage).toBe("lost_on_session_restart");
    expect((await runtime.registry.get(TASK_FOREIGN_ALIVE))?.status).toBe("running");
    expect((await runtime.registry.get(TASK_FOREIGN_DEAD))?.status).toBe("lost");
  });

  test("shutdown reaps only own records — foreign (alive or dead) and legacy records survive and are never signaled", async () => {
    const lifecycle = new MockChildProcessLifecycle();
    const storage = new InMemoryTaskStorage();
    const runtime = createBackgroundTaskRuntime({
      createStorage: () => storage,
      createLifecycle: () => lifecycle,
      owner: RUNTIME_OWNER,
      isPidAlive: () => true,
    });
    await runtime.bindSession("/sessions/shared");
    // Own live child + record: the shared SIGTERM ladder MUST reach it.
    const ownHandle = runtime.lifecycle.spawn(["pi", "--x"], {} as ChildSpawnOptions);
    await runtime.registry.transition(
      {
        kind: "spawn",
        handle: { taskId: TASK_RUNNING, label: "l", status: "running" },
        record: spawnRecord(OWNER),
      },
      { clock: () => 1_000, callerId: OWNER },
    );
    // Three records another pi process (or a pre-upgrade one) wrote into the SAME shared dir.
    // They are seeded after the bind so the startup reconcile — not shutdown — is what a
    // foreign record must also survive here.
    const foreignAlive = createTaskRegistry(storage, {
      clock: () => 1_000,
      owner: { pid: 62_000, bootMs: 5 },
      isPidAlive: () => true,
    });
    const foreignDead = createTaskRegistry(storage, {
      clock: () => 1_000,
      owner: { pid: 63_000, bootMs: 5 },
      isPidAlive: () => true,
    });
    const legacy = createTaskRegistry(storage, { clock: () => 1_000 });
    await seedInto(foreignAlive, TASK_FOREIGN_ALIVE);
    await seedInto(foreignDead, TASK_FOREIGN_DEAD);
    await seedInto(legacy, TASK_LEGACY);

    const released = await runtime.shutdown("session_ended_while_running");

    // Only the own record is reaped: pre-ADR-0023 the sweep was dir-wide, so all five rows
    // ended `lost` (counterfactual for field-report pitfall #3's second cut).
    expect(released.map((record) => record.id)).toEqual([TASK_RUNNING]);
    expect(released[0]?.errorMessage).toBe("session_ended_while_running");
    expect((await runtime.registry.get(TASK_FOREIGN_ALIVE))?.status).toBe("running");
    expect((await runtime.registry.get(TASK_FOREIGN_DEAD))?.status).toBe("running");
    expect((await runtime.registry.get(TASK_LEGACY))?.status).toBe("running");
    // The ladder ran exactly once — against the own child. No foreign record was signaled.
    expect(lifecycle.getKillSignals(ownHandle)).toEqual(["SIGTERM"]);
    expect(lifecycle.spawnCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
//  dispatch path <-> tool registry (the "same registry" seam)
// ---------------------------------------------------------------------------

describe("dispatch path and tools share the holder registry", () => {
  test("a task spawned through the dispatch path is visible to ptc_task_list", async () => {
    await withAgent(async (dir) => {
      const runtime = createBackgroundTaskRuntime({
        createLifecycle: () => new MockChildProcessLifecycle(),
      });
      await runtime.bindSession(undefined);
      const handle = asHandle(
        await dispatch(
          { agent: AGENT, task: "shared registry", background: true, agentScope: "project" },
          { callId: 7, cwd: dir, depth: 0, maxDispatchDepth: 3, callerId: "run-1" },
          runtime.dispatchDeps,
        ),
      );

      const tool: AnyTool = createPtcTaskListTool(runtime.registry);
      const result = (await tool.execute(
        "call-1",
        {},
        undefined,
        undefined,
        undefined as never,
      )) as {
        details: PtcTaskListDetails;
      };

      expect(result.details.count).toBe(1);
      expect(result.details.tasks.map((record) => record.id)).toEqual([handle.taskId]);
      expect(result.details.tasks[0]?.status).toBe("running");
      expect(TERMINAL.has(result.details.tasks[0]?.status ?? "")).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
//  default durable storage: the un-injected production branch
// ---------------------------------------------------------------------------

describe("default durable storage", () => {
  test("bindSession with a real session dir persists records through FileTaskStorage", async () => {
    const sessionDir = await makeTempDir();
    try {
      // No createStorage / createOutputStorage injected: production must build FileTaskStorage
      // rooted at the session dir, not silently fall back to the in-memory adapter (A6).
      const runtime = createBackgroundTaskRuntime({
        createLifecycle: () => new MockChildProcessLifecycle(),
      });
      await runtime.bindSession(sessionDir);

      await runtime.registry.transition(
        {
          kind: "spawn",
          handle: { taskId: TASK_RUNNING, label: "durable", status: "running" },
          record: spawnRecord(OWNER),
        },
        { clock: () => 1_000, callerId: OWNER },
      );

      // ADR-0022 §3: the TaskRecord lands on disk at <sessionDir>/tasks/<taskId>.json.
      const taskRaw = await readFile(join(sessionDir, "tasks", TASK_RUNNING + ".json"), "utf8");
      const task = JSON.parse(taskRaw) as TaskRecord;
      expect(task.id).toBe(TASK_RUNNING);
      expect(task.status).toBe("running");

      // ADR-0022 §5: the owner subscription lands on disk too.
      const subRaw = await readFile(
        join(sessionDir, "subscriptions", OWNER + "-" + TASK_RUNNING + ".json"),
        "utf8",
      );
      const subscription = JSON.parse(subRaw) as { taskId: string; subscriberId: string };
      expect(subscription.taskId).toBe(TASK_RUNNING);
      expect(subscription.subscriberId).toBe(OWNER);
    } finally {
      await removeTempDir(sessionDir);
    }
  });
});

// ---------------------------------------------------------------------------
//  session rebind: an in-flight task keeps writing to its owning registry (S9)
// ---------------------------------------------------------------------------

describe("session rebind pins an in-flight task to its owning registry", () => {
  test("the terminal write lands in the original session after bindSession moves on", async () => {
    await withAgent(async (dir) => {
      const storageA = new InMemoryTaskStorage();
      const storageB = new InMemoryTaskStorage();
      const lifecycle = new RecordingLifecycle();
      const runtime = createBackgroundTaskRuntime({
        createLifecycle: () => lifecycle,
        createStorage: (sessionDir) => (sessionDir === "/sessions/a" ? storageA : storageB),
        createOutputStorage: () => new InMemoryOutputStorage(),
      });
      await runtime.bindSession("/sessions/a");

      const handle = asHandle(
        await dispatch(
          { agent: AGENT, task: "across rebind", background: true, agentScope: "project" },
          { callId: 1, cwd: dir, depth: 0, maxDispatchDepth: 3, callerId: "run-1" },
          runtime.dispatchDeps,
        ),
      );
      expect((await storageA.loadTask(handle.taskId))?.status).toBe("running");

      // Rebind to a different session while the pump is still in flight. The stable registry now
      // points at storageB, but the pump must keep writing to the registry that persisted it.
      await runtime.bindSession("/sessions/b");

      // The child answers before it closes: an exit-0 child with no assistant text is
      // `failed` (issue #70), and this test is about which registry the write lands in.
      lifecycle.pushEvent(lifecycle.handleAt(0), {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "PONG" }] },
      });
      lifecycle.resolveExit(lifecycle.handleAt(0), 0, null);
      const terminal = await waitForTerminalRecord(storageA, handle.taskId);
      expect(terminal.status).toBe("succeeded");
      // The terminal write never reaches the new session's registry.
      expect(await storageB.loadTask(handle.taskId)).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Round 7: the catch-with-side-effect logs in this file (526/594/616/645/663/683/716).
//
// A measured sweep of every catch-with-side-effect call in src/ removed each one and ran the
// suite: 7 of 15 stayed green, all seven in this file, every one a logger.warn in a catch. This
// block pins the two a test can REACH. The other five are recorded at the end as unreachable,
// with the reason, rather than given a test that cannot fail.
//
// Not a table on purpose: two sites driven through two different APIs, so a two-row table would
// be indirection for its own sake. What the table was supposed to buy -- each site with its own
// named test and its own counterfactual -- these two have individually.
// ---------------------------------------------------------------------------

describe("cleanup-path failure logs (round 7)", () => {
  test("a cursor advance that throws is reported, not swallowed", async () => {
    // background-runtime.ts:645. An ack carries the pipeline it read from, so a throwing
    // `acknowledgeEvents` is substitutable with no production seam. The sink is the REAL one
    // from a real drain, with one method replaced -- not a fabricated double.
    const storage = new InMemoryTaskStorage();
    await seedRunningTask(storage);
    const warnings: string[] = [];
    const runtime = createBackgroundTaskRuntime({
      createStorage: () => storage,
      createLifecycle: () => new MockChildProcessLifecycle(),
      logger: { info: () => undefined, warn: (m: string) => void warnings.push(m) },
    });
    await runtime.bindSession("/sessions/r7-ack");

    const drain = await runtime.drainNotifications(OWNER as ULID);
    const realAck = drain.acks[0];
    if (realAck === undefined) throw new Error("the seed produced no ack to advance");
    const realSink = realAck.sink;
    // Spreading the real pipeline and replacing ONE method, so the stub cannot drift from the
    // interface the way a hand-written double would.
    const throwingSink = {
      ...realSink,
      acknowledgeEvents: async (): Promise<void> => {
        throw new Error("injected: acknowledge blew up");
      },
    };

    await runtime.acknowledgeNotifications([{ ...realAck, sink: throwingSink }]);

    // One warn, and it carries the cause. A silent catch here would satisfy neither.
    expect(warnings.length, "the failure was reported exactly once").toBe(1);
    expect(warnings[0]).toContain("injected: acknowledge blew up");
  });

  test("a bind reporter that throws is reported, not swallowed", async () => {
    // background-runtime.ts:716. The reporter is a direct argument to `bindSession`, so this one
    // needs no seam either. Asserting the bind still completed matters as much as the log: a
    // reporter that throws must not take the session down with it.
    const warnings: string[] = [];
    const runtime = createBackgroundTaskRuntime({
      createStorage: () => {
        throw new Error("injected: storage unavailable");
      },
      createLifecycle: () => new MockChildProcessLifecycle(),
      logger: { info: () => undefined, warn: (m: string) => void warnings.push(m) },
    });
    let reported = "";

    await runtime.bindSession("/sessions/r7-bind", (message) => {
      reported = message;
      throw new Error("injected: reporter blew up");
    });

    expect(reported, "the reporter really ran, on the storage failure").toContain(
      "injected: storage unavailable",
    );
    // Two warns: the original bind failure, then the reporter's own. A catch that swallowed the
    // reporter throw would leave exactly one, which is the whole difference this test is about.
    expect(warnings.length, "the bind failure AND the reporter failure were reported").toBe(2);
    expect(warnings[1]).toContain("injected: reporter blew up");
    // And the throw was contained: bindSession returned and the runtime is still usable.
    expect((await runtime.drainNotifications(OWNER as ULID)).items).toEqual([]);
  });

  /*
   * The other five, and why no test exists for each. This is a statement about the SHAPE of the
   * class, not an omission:
   *
   *   526  #handleTransition -- `this.pipeline.notifyIdle` rejects.
   *   594  `drainNotifications` -- `this.registry.query` throws.
   *   616  `drainNotifications` -- the record's own `sink.drainPending` throws.
   *   663  `shutdown` -- `this.registry.query` throws.
   *   683  `shutdown` transitions -- `this.registry.transition` throws.
   *
   * All five run against the PRE-SESSION registry, output storage and pipeline, and those three
   * are constructed in place at `new InMemoryTaskStorage()` (line 482) with no option to
   * substitute one. `createStorage` only supplies the session-bound delegate, which is why the two
   * tests above -- both of which bind a session or use a caller-supplied object -- are the two
   * that can be driven at all.
   *
   * So the blocker for these five is a missing substitution seam in production code, not a
   * missing test. The next round should read that as "add the seam", not "write the test
   * again" -- and a test written today for any of them would be one that cannot fail, which is
   * the failure mode this whole exercise exists to find.
   */
});

// ---------------------------------------------------------------------------
// Round 8: the five cleanup-path logs that round 7 could not drive (526 / 594 / 616 / 663 / 683).
//
// All five run against the PRE-SESSION registry / pipeline, which used to be constructed in place
// at `new InMemoryTaskStorage()`. Round 7 recorded that as "blocked on a missing seam in
// production, not a missing test". `createInitialStorage` is that seam.
//
// Each of these builds a storage whose READS throw, injects it, and drives the one path that
// reports. They are separate tests on purpose: round 7's lesson is that a table going red is not
// per-site proof.
// ---------------------------------------------------------------------------

describe("pre-session cleanup-path failure logs (round 8)", () => {
  /**
   * A real `InMemoryTaskStorage` with exactly ONE method replaced by a throw.
   *
   * A Proxy over every read was the first attempt and it was the wrong instrument twice over:
   * `listTasks` is an AsyncIterable, not a promise, so the rejection surfaced as a different
   * error entirely and every assertion blamed the wrong call. Failing one NAMED method keeps each
   * test pointed at one path, and the delegate is a real store so nothing else is disturbed.
   */
  /**
   * A real `InMemoryTaskStorage` with one method that can be ARMED to throw, after seeding.
   *
   * Two things had to be learned the hard way to write this, and both cost a wrong-reason red:
   *
   *   1. `listTasks` is an AsyncIterable, not a promise. A rejected promise there hands the call
   *      site a non-iterable and the error never carries the cause -- every assertion then blamed
   *      the wrong call. It has to be a generator that throws on its first pull.
   *   2. The registry captures the storage ONCE, in the constructor, so swapping the reference
   *      afterwards changes nothing. The failure must be armed on the object the registry is
   *      already holding -- which is also why it cannot simply be injected up front: the seeding
   *      transition reads the same method and takes the setup down with it.
   */
  function armableStorage(): {
    storage: TaskStorage;
    arm: (method: string, cause: string) => void;
  } {
    const inner = new InMemoryTaskStorage();
    const bag = inner as unknown as Record<string, ((...a: unknown[]) => unknown) | undefined>;
    let armed: { method: string; cause: string } | undefined;
    const double: Record<string, unknown> = {};
    for (const name of [
      "loadTask",
      "saveTask",
      "deleteTask",
      "loadSubscription",
      "saveSubscription",
      "appendEvents",
    ]) {
      double[name] = (...args: unknown[]) => {
        if (armed !== undefined && armed.method === name) {
          return Promise.reject(new Error(armed.cause));
        }
        const impl = bag[name];
        if (impl === undefined) throw new Error("armableStorage: no such method " + name);
        return impl.apply(inner, args);
      };
    }
    // `loadEvents` is the second AsyncIterable method, and the idle wake reads through it. A
    // promise here yields "is not a function or its return value is not async iterable", which is
    // the double's artefact rather than the injected failure -- and a test that passes because of
    // its own harness is not a test.
    double.loadEvents = async function* (): AsyncIterable<TaskEvent> {
      if (armed !== undefined && armed.method === "loadEvents") throw new Error(armed.cause);
      for await (const ev of (inner.loadEvents as (...a: unknown[]) => AsyncIterable<TaskEvent>)(
        ...([] as unknown[]),
      )) {
        yield ev;
      }
    };
    double.listTasks = async function* (): AsyncIterable<TaskRecord> {
      if (armed !== undefined && armed.method === "listTasks") throw new Error(armed.cause);
      for await (const record of (inner.listTasks as () => AsyncIterable<TaskRecord>)()) {
        yield record;
      }
    };
    return {
      storage: double as unknown as TaskStorage,
      arm: (method, cause) => {
        armed = { method, cause };
      },
    };
  }

  test("a terminal wake whose read throws is reported (526)", async () => {
    // `#handleTransition` fires on a terminal transition and awaits the idle wake, which reads
    // storage. The promise is floating with an explicit catch, so the warn is the ONLY evidence
    // the failure did not become an unhandled rejection.
    //
    // The task is spawned through the runtime's OWN registry -- the pre-session one the injected
    // storage backs. Seeding a separate storage and then transitioning through `runtime.registry`
    // fails with `unknown taskId`, which is a red for entirely the wrong reason: it proves the
    // harness is wired up, not that the warn is missing.
    // Seed with a WORKING store, then swap the backing to the failing one. Injecting the failure
    // up front takes the SPAWN down with it -- the spawn reads the subscription it is about to
    // write -- and the test then fails on its own setup, which says nothing about the warn.
    const { storage: pre, arm } = armableStorage();
    const warnings: string[] = [];
    const runtime = createBackgroundTaskRuntime({
      createInitialStorage: () => pre,
      createLifecycle: () => new MockChildProcessLifecycle(),
      logger: { info: () => undefined, warn: (m: string) => void warnings.push(m) },
    });

    await runtime.registry.transition(
      {
        kind: "spawn",
        handle: { taskId: TASK_RUNNING, label: "pre-session", status: "running" },
        record: spawnRecord(OWNER),
      },
      { clock: () => 1_000, callerId: OWNER },
    );

    // Now the reads fail, and the terminal wake is all that is left to trigger them.
    arm("loadEvents", "injected: wake read failed");
    await runtime.registry.transition(
      { kind: "transition", taskId: TASK_RUNNING, to: "succeeded" },
      { clock: () => 2_000, callerId: OWNER },
    );

    // The wake is a floating promise, so the warn lands a turn later.
    await waitFor(() => warnings.length > 0);
    expect(warnings[0]).toContain("terminal notification wake");
    expect(warnings[0]).toContain("injected: wake read failed");
  });

  test("a task listing that throws during a drain is reported, and the drain returns empty (594)", async () => {
    const storage = new InMemoryTaskStorage();
    await seedRunningTask(storage);
    const warnings: string[] = [];
    const runtime = createBackgroundTaskRuntime({
      createStorage: () => storage,
      createInitialStorage: () => {
        const a = armableStorage();
        a.arm("listTasks", "injected: query read failed");
        return a.storage;
      },
      createLifecycle: () => new MockChildProcessLifecycle(),
      logger: { info: () => undefined, warn: (m: string) => void warnings.push(m) },
    });

    // Session-less on purpose: this is the PRE-session registry doing the listing.
    const drain = await runtime.drainNotifications(OWNER as ULID);

    expect(warnings.length, "the listing failure was reported").toBe(1);
    expect(warnings[0]).toContain("drainNotifications: could not list tasks");
    expect(warnings[0]).toContain("injected: query read failed");
    // Reported AND contained: the caller still gets a well-formed empty drain, not a throw.
    expect(drain.items).toEqual([]);
    expect(drain.acks).toEqual([]);
  });

  test("one record whose events cannot be read is reported without starving the rest (616)", async () => {
    // The interesting half of 616 is the CONTINUE: an unreadable record must not swallow its
    // siblings' events, so this seeds TWO records and asserts both were reported independently.
    //
    // Both records are spawned through the runtime's OWN pre-session registry -- the one the
    // injected double backs. Seeding a separate `storage` and draining from the pre-session
    // registry finds nothing to loop over, which fails the count for a reason that has nothing to
    // do with the log (the same trap 526 hit).
    const { storage: pre, arm } = armableStorage();
    const warnings: string[] = [];
    const runtime = createBackgroundTaskRuntime({
      createInitialStorage: () => pre,
      createLifecycle: () => new MockChildProcessLifecycle(),
      logger: { info: () => undefined, warn: (m: string) => void warnings.push(m) },
    });

    for (const taskId of [TASK_RUNNING, TASK_SECOND]) {
      await runtime.registry.transition(
        {
          kind: "spawn",
          handle: { taskId, label: "pre-session " + taskId, status: "running" },
          record: spawnRecord(OWNER),
        },
        { clock: () => 1_000, callerId: OWNER },
      );
    }

    arm("loadSubscription", "injected: drainPending read failed");
    const drain = await runtime.drainNotifications(OWNER as ULID);

    // One report per unreadable record, and the sweep continued rather than bailing on the first.
    expect(warnings.length, "one report per unreadable record").toBe(2);
    expect(warnings[0]).toContain("injected: drainPending read failed");
    expect(warnings[1]).toContain("injected: drainPending read failed");
    // The COUNT alone does not show the sweep continued. Two warns can equally mean one record
    // warned twice while the other was starved -- the exact regression this test exists to catch
    // -- so assert the two reports name the two DIFFERENT tasks. Added in round 9: the count-only
    // version of this assertion passed with the `continue` deleted.
    expect(
      warnings.filter((w) => w.includes(TASK_RUNNING)),
      "the first record was reported",
    ).toHaveLength(1);
    expect(
      warnings.filter((w) => w.includes(TASK_SECOND)),
      "and so was the second -- this is the does-not-starve-the-rest claim",
    ).toHaveLength(1);
    // The sweep continued past the first failure rather than bailing: BOTH records were reported.
    // No items and no acks is the correct outcome here, not a shortfall -- an unreadable record is
    // skipped without an ack, because acknowledging a cursor for events that were never delivered is
    // exactly the data loss the at-least-once design exists to prevent.
    expect(drain.items, "no events for an unreadable record").toHaveLength(0);
    expect(drain.acks, "and no ack, so the cursor does not skip undelivered events").toHaveLength(
      0,
    );
  });

  test("a task listing that throws during shutdown is reported, and the sweep continues (663)", async () => {
    const storage = new InMemoryTaskStorage();
    await seedRunningTask(storage);
    const warnings: string[] = [];
    const runtime = createBackgroundTaskRuntime({
      createStorage: () => storage,
      createInitialStorage: () => {
        const a = armableStorage();
        a.arm("listTasks", "injected: shutdown query read failed");
        return a.storage;
      },
      createLifecycle: () => new MockChildProcessLifecycle(),
      logger: { info: () => undefined, warn: (m: string) => void warnings.push(m) },
    });

    const lost = await runtime.shutdown("session_ended_while_running");

    expect(warnings.length, "the listing failure was reported").toBe(1);
    expect(warnings[0]).toContain("shutdown: could not list tasks");
    expect(warnings[0]).toContain("injected: shutdown query read failed");
    // Contained: an unlistable sweep reports and returns empty rather than failing the teardown.
    expect(lost).toEqual([]);
  });

  test("a task whose lost-marking throws is reported, and the sweep continues (683)", async () => {
    // 683 is the inner catch of the shutdown sweep, and it needs the OPPOSITE shape from 663:
    // the listing must SUCCEED and the transition must fail. So the record is seeded through the
    // pre-session store first, and only the write the sweep performs is armed afterwards.
    const { storage: pre, arm } = armableStorage();
    const warnings: string[] = [];
    const runtime = createBackgroundTaskRuntime({
      createInitialStorage: () => pre,
      createLifecycle: () => new MockChildProcessLifecycle(),
      logger: { info: () => undefined, warn: (m: string) => void warnings.push(m) },
    });

    // Put the record the sweep will find into the pre-session store it will list from.
    await runtime.registry.transition(
      {
        kind: "spawn",
        handle: { taskId: TASK_RUNNING, label: "pre-session", status: "running" },
        record: spawnRecord(OWNER),
      },
      { clock: () => 1_000, callerId: OWNER },
    );

    arm("saveTask", "injected: lost-marking write failed");
    const lost = await runtime.shutdown("session_ended_while_running");

    expect(
      warnings.some((w) => w.includes("could not mark task")),
      "the lost-marking failure was reported",
    ).toBe(true);
    expect(warnings.find((w) => w.includes("could not mark task"))).toContain(
      "injected: lost-marking write failed",
    );
    // Contained: the failure did not become a lost record, and shutdown still returned.
    expect(lost).toEqual([]);
  });
});
