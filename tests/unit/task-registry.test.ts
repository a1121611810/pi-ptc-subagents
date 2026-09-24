/**
 * BG-02 unit tests for `src/runtime/task-registry.ts`.
 *
 * SPECIFICATION tests, not characterization (docs/testing-constraints.md #6): every expected
 * value below traces to a literal in ADR-0022 — the transition table (§2), the TaskRecord /
 * event shapes (§3/§7), the handle rule (§4), the cursor rule (§5) and the lost-reason strings
 * (§8) — or to a property/invariant the ADR states (monotonic cursor, idempotent reconcile).
 * Nothing is derived from the implementation source.
 *
 * Dependencies are injected (docs/testing-constraints.md #1 clock/IO boundary): every test uses
 * an `InMemoryTaskStorage` and a fake clock (`createFakeClock`), never a real timer and never
 * `Date.now()`. Every command's failure path has its own test: illegal transitions, unknown
 * taskId, runtime-invalid target state, duplicate spawn, bad handle, unknown subscription,
 * negative query limit, terminal reconcile.
 *
 * The counterfactual block at the bottom (docs/testing-constraints.md #5) pins that the spec
 * assertions above are falsifiable: an obviously-broken registry (permissive transition table /
 * no-op cursor) is shown to violate what the spec requires.
 */

import { describe, expect, test } from "vitest";
import {
  InMemoryTaskStorage,
  type TaskRecord,
  type TaskStatus,
  type ULID,
} from "../../src/runtime/task-storage.ts";
import {
  createTaskRegistry,
  type DispatchHandle,
  type RegistryLogger,
  type TaskRegistry,
  type TaskRegistryOptions,
  type TransitionContext,
  type TransitionResult,
} from "../../src/runtime/task-registry.ts";

// ---------------------------------------------------------------------------
//  Fixtures and harness
// ---------------------------------------------------------------------------

/** Literal ULID-shaped ids (26 Crockford chars). They are recognizable so equality reads well. */
const TASK_1 = "01JBZ000000000000000000001" as ULID;
const TASK_2 = "01JBZ000000000000000000002" as ULID;
const TASK_3 = "01JBZ000000000000000000003" as ULID;
const TASK_404 = "01JBZ000000000000000000404" as ULID;
const CALLER = "run-001";

/** A fake clock, injected into both the registry options and each TransitionContext. */
interface FakeClock {
  clock: () => number;
  set: (ms: number) => void;
  advance: (ms: number) => void;
}

function createFakeClock(start: number): FakeClock {
  let current = start;
  return {
    clock: () => current,
    set: (ms: number) => {
      current = ms;
    },
    advance: (ms: number) => {
      current += ms;
    },
  };
}

interface LoggerSpy {
  info: string[];
  warn: string[];
  logger: RegistryLogger;
}

function createLoggerSpy(): LoggerSpy {
  const info: string[] = [];
  const warn: string[] = [];
  return {
    info,
    warn,
    logger: {
      info: (msg: string) => {
        info.push(msg);
      },
      warn: (msg: string) => {
        warn.push(msg);
      },
    },
  };
}

interface Harness {
  registry: TaskRegistry;
  storage: InMemoryTaskStorage;
  clock: FakeClock;
  logger: LoggerSpy;
}

function createHarness(start = 1000): Harness {
  const storage = new InMemoryTaskStorage();
  const clock = createFakeClock(start);
  const logger = createLoggerSpy();
  const options: TaskRegistryOptions = { clock: clock.clock, logger: logger.logger };
  return { registry: createTaskRegistry(storage, options), storage, clock, logger };
}

function callContext(h: Harness, callerId: string): TransitionContext {
  return { clock: h.clock.clock, callerId };
}

/** The spawn command's record omits id/status/createdAt/transitionAt (bg-02 brief). */
type RecordInput = Omit<TaskRecord, "id" | "status" | "createdAt" | "transitionAt">;

/** 21-field shape copied from ADR-0022 §3; every field present so drops are caught. */
function fixtureRecord(overrides: Partial<RecordInput> = {}): RecordInput {
  return {
    label: "research X",
    agentName: "researcher",
    depth: 0,
    startedAt: 1_700_000_000_000,
    finishedAt: undefined,
    durationMs: undefined,
    outputRef: undefined,
    outputBytes: undefined,
    outputPreview: undefined,
    stopReason: undefined,
    errorMessage: undefined,
    exitCode: undefined,
    spawnSource: { kind: "ptc-program", callerId: CALLER },
    parentTaskId: undefined,
    sessionFile: undefined,
    ...overrides,
  };
}

function fixtureHandle(taskId: ULID, label = "research X"): DispatchHandle {
  return { taskId, label, status: "running" };
}

interface SpawnOptions {
  callerId?: string;
  label?: string;
  record?: Partial<RecordInput>;
}

async function spawnTask(
  h: Harness,
  taskId: ULID,
  options: SpawnOptions = {},
): Promise<TransitionResult> {
  const callerId = options.callerId ?? CALLER;
  return h.registry.transition(
    {
      kind: "spawn",
      handle: fixtureHandle(taskId, options.label ?? "research X"),
      record: fixtureRecord({
        spawnSource: { kind: "ptc-program", callerId },
        ...options.record,
      }),
    },
    callContext(h, callerId),
  );
}

/** Drive a fresh task into `from` so an illegal-edge test has a real source state. */
async function seedStatus(h: Harness, from: TaskStatus, taskId: ULID): Promise<void> {
  h.clock.set(1000);
  await spawnTask(h, taskId);
  if (from === "running") {
    return;
  }
  if (from === "stopping") {
    h.clock.set(1100);
    await h.registry.transition(
      { kind: "stop", taskId, reason: "seed stop" },
      callContext(h, CALLER),
    );
    return;
  }
  h.clock.set(1200);
  await h.registry.transition({ kind: "transition", taskId, to: from }, callContext(h, CALLER));
}

// ---------------------------------------------------------------------------
//  spawn (ADR-0022 §2/§3/§4/§5)
// ---------------------------------------------------------------------------

describe("TaskRegistry.spawn", () => {
  test("adopts the handle taskId, stamps running at the injected clock, and persists (§3/§4)", async () => {
    const h = createHarness(1000);
    const result = await spawnTask(h, TASK_1);

    expect(result.record.id).toBe(TASK_1);
    expect(result.record.status).toBe("running");
    expect(result.record.createdAt).toBe(1000);
    expect(result.record.startedAt).toBe(1000);
    expect(result.record.transitionAt).toBe(1000);
    expect(result.record.finishedAt).toBeUndefined();
    expect(result.record.durationMs).toBeUndefined();
    // IO boundary success path: the record is persisted, not only returned.
    expect(await h.storage.loadTask(TASK_1)).toEqual(result.record);
  });

  test("emits exactly task:<id>:running and returns its eventId as the cursor (§2)", async () => {
    const h = createHarness(1000);
    const result = await spawnTask(h, TASK_1);

    expect(result.events).toHaveLength(1);
    const event = result.events[0];
    expect(event?.type).toBe("task:01JBZ000000000000000000001:running");
    expect(event?.status).toBe("running");
    expect(event?.taskId).toBe(TASK_1);
    expect(event?.subscriptionId).toBe(CALLER);
    expect(event?.transitionAtMs).toBe(1000);
    expect(result.cursor).toBe(event?.eventId);
  });

  test("opens the caller subscription at the first event cursor and the log replays it (§5)", async () => {
    const h = createHarness(1000);
    const result = await spawnTask(h, TASK_1);

    const subscription = await h.storage.loadSubscription(CALLER as ULID, TASK_1);
    expect(subscription).not.toBeNull();
    expect(subscription?.subscriberId).toBe(CALLER);
    expect(subscription?.taskId).toBe(TASK_1);
    expect(subscription?.status).toBe("active");
    expect(subscription?.cursor).toBe(result.cursor);

    const log = await h.registry.loadEventLog(CALLER as ULID);
    expect(log.map((event) => event.type)).toEqual(["task:01JBZ000000000000000000001:running"]);
  });

  test("mints a fresh ULID when the handle id is a placeholder and writes it back (§4)", async () => {
    const h = createHarness(1000);
    const handle: DispatchHandle = { taskId: "" as ULID, label: "auto", status: "running" };
    const result = await h.registry.transition(
      { kind: "spawn", handle, record: fixtureRecord({ label: "auto" }) },
      callContext(h, CALLER),
    );

    expect(result.record.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(handle.taskId).toBe(result.record.id);
  });

  test("rejects a duplicate taskId instead of overwriting (§3 single terminal writer)", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    await expect(spawnTask(h, TASK_1)).rejects.toThrow(/already exists/);
  });

  test("rejects a handle whose status is not running", async () => {
    const h = createHarness(1000);
    const handle = {
      taskId: TASK_1,
      label: "x",
      status: "succeeded",
    } as unknown as DispatchHandle;
    await expect(
      h.registry.transition(
        { kind: "spawn", handle, record: fixtureRecord() },
        callContext(h, CALLER),
      ),
    ).rejects.toThrow(/handle.status must be "running"/);
  });

  test("records parentTaskId from the command (§3)", async () => {
    const h = createHarness(1000);
    const result = await h.registry.transition(
      {
        kind: "spawn",
        parentTaskId: TASK_2,
        handle: fixtureHandle(TASK_1),
        record: fixtureRecord(),
      },
      callContext(h, CALLER),
    );
    expect(result.record.parentTaskId).toBe(TASK_2);
  });
});

// ---------------------------------------------------------------------------
//  transition — allowed edges (ADR-0022 §2)
// ---------------------------------------------------------------------------

const ALLOWED_CASES: Array<{ from: TaskStatus; to: TaskStatus }> = [
  { from: "running", to: "stopping" },
  { from: "running", to: "succeeded" },
  { from: "running", to: "failed" },
  { from: "running", to: "canceled" },
  { from: "running", to: "lost" },
  { from: "stopping", to: "succeeded" },
  { from: "stopping", to: "failed" },
  { from: "stopping", to: "canceled" },
];

describe("TaskRegistry.transition — allowed table (ADR-0022 §2)", () => {
  test.each(ALLOWED_CASES)(
    "accepts $from -> $to and emits the new status",
    async ({ from, to }) => {
      const h = createHarness(1000);
      await seedStatus(h, from, TASK_1);
      h.clock.set(5000);
      const result = await h.registry.transition(
        { kind: "transition", taskId: TASK_1, to },
        callContext(h, CALLER),
      );

      expect(result.record.status).toBe(to);
      expect(result.record.transitionAt).toBe(5000);
      expect(result.events[0]?.status).toBe(to);
      expect(await h.storage.loadTask(TASK_1)).toEqual(result.record);
    },
  );

  test("a terminal transition sets finishedAt and durationMs; stopping does not (§3)", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);

    h.clock.set(1500);
    const stopping = await h.registry.transition(
      { kind: "stop", taskId: TASK_1, reason: "model stop" },
      callContext(h, CALLER),
    );
    expect(stopping.record.status).toBe("stopping");
    expect(stopping.record.finishedAt).toBeUndefined();
    expect(stopping.record.durationMs).toBeUndefined();

    h.clock.set(2000);
    const canceled = await h.registry.transition(
      { kind: "transition", taskId: TASK_1, to: "canceled" },
      callContext(h, CALLER),
    );
    expect(canceled.record.finishedAt).toBe(2000);
    expect(canceled.record.durationMs).toBe(1000);
  });

  test("terminal transitions use the task:<id>:-><status> emit key (§2/§8)", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    const result = await h.registry.transition(
      { kind: "transition", taskId: TASK_1, to: "canceled" },
      callContext(h, CALLER),
    );
    expect(result.events[0]?.type).toBe("task:01JBZ000000000000000000001:->canceled");
  });

  test("carries explicit errorMessage / exitCode onto the record (§3/§8)", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    const result = await h.registry.transition(
      {
        kind: "transition",
        taskId: TASK_1,
        to: "failed",
        errorMessage: "child crashed",
        exitCode: 2,
      },
      callContext(h, CALLER),
    );
    expect(result.record.errorMessage).toBe("child crashed");
    expect(result.record.exitCode).toBe(2);
    expect(result.record.stopReason).toBeUndefined();
  });

  test("generic reason maps to stopReason for canceled and errorMessage for lost (§8)", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    const canceled = await h.registry.transition(
      { kind: "transition", taskId: TASK_1, to: "canceled", reason: "handoff deferred" },
      callContext(h, CALLER),
    );
    expect(canceled.record.stopReason).toBe("handoff deferred");

    await spawnTask(h, TASK_2);
    const lost = await h.registry.transition(
      { kind: "transition", taskId: TASK_2, to: "lost", reason: "session_ended_while_running" },
      callContext(h, CALLER),
    );
    expect(lost.record.errorMessage).toBe("session_ended_while_running");
  });

  test("inlines outputPreview only when outputBytes <= 2048 (§7)", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1, {
      record: { outputBytes: 1024, outputPreview: "small preview" },
    });
    const small = await h.registry.transition(
      { kind: "transition", taskId: TASK_1, to: "succeeded" },
      callContext(h, CALLER),
    );
    expect(small.events[0]?.outputBytes).toBe(1024);
    expect(small.events[0]?.outputPreview).toBe("small preview");

    await spawnTask(h, TASK_2, {
      record: { outputBytes: 4096, outputPreview: "should not inline" },
    });
    const big = await h.registry.transition(
      { kind: "transition", taskId: TASK_2, to: "succeeded" },
      callContext(h, CALLER),
    );
    expect(big.events[0]?.outputBytes).toBe(4096);
    expect(big.events[0]?.outputPreview).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
//  transition — illegal edges and error paths (ADR-0022 §2, constraint #1)
// ---------------------------------------------------------------------------

const ILLEGAL_CASES: Array<{ from: TaskStatus; to: TaskStatus }> = [
  { from: "running", to: "running" },
  { from: "stopping", to: "stopping" },
  { from: "stopping", to: "lost" },
  { from: "succeeded", to: "running" },
  { from: "succeeded", to: "stopping" },
  { from: "canceled", to: "stopping" },
  { from: "failed", to: "succeeded" },
  { from: "lost", to: "running" },
];

describe("TaskRegistry.transition — rejection paths (ADR-0022 §2)", () => {
  test.each(ILLEGAL_CASES)(
    "rejects $from -> $to with a descriptive error and no write",
    async ({ from, to }) => {
      const h = createHarness(1000);
      await seedStatus(h, from, TASK_1);
      const before = await h.storage.loadTask(TASK_1);

      await expect(
        h.registry.transition({ kind: "transition", taskId: TASK_1, to }, callContext(h, CALLER)),
      ).rejects.toThrow(new RegExp(`illegal transition for task ${TASK_1}: ${from} -> ${to}`));

      expect(await h.storage.loadTask(TASK_1)).toEqual(before);
    },
  );

  test("an unknown taskId throws", async () => {
    const h = createHarness(1000);
    await expect(
      h.registry.transition(
        { kind: "transition", taskId: TASK_404, to: "succeeded" },
        callContext(h, CALLER),
      ),
    ).rejects.toThrow(/unknown taskId 01JBZ000000000000000000404/);
  });

  test("a runtime-invalid target state throws before any write", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    await expect(
      h.registry.transition(
        { kind: "transition", taskId: TASK_1, to: "zombie" as unknown as TaskStatus },
        callContext(h, CALLER),
      ),
    ).rejects.toThrow(/unknown target state zombie/);

    const after = await h.storage.loadTask(TASK_1);
    expect(after?.status).toBe("running");
  });

  test("stop on a terminal task throws (illegal edge)", async () => {
    const h = createHarness(1000);
    await seedStatus(h, "succeeded", TASK_1);
    await expect(
      h.registry.transition(
        { kind: "stop", taskId: TASK_1, reason: "too late" },
        callContext(h, CALLER),
      ),
    ).rejects.toThrow(/illegal transition for task/);
  });

  test("stop on an unknown taskId throws", async () => {
    const h = createHarness(1000);
    await expect(
      h.registry.transition(
        { kind: "stop", taskId: TASK_404, reason: "x" },
        callContext(h, CALLER),
      ),
    ).rejects.toThrow(/unknown taskId/);
  });
});

// ---------------------------------------------------------------------------
//  stop (ADR-0022 §8)
// ---------------------------------------------------------------------------

describe("TaskRegistry.stop", () => {
  test("transitions running -> stopping and does NOT auto-cancel (§8)", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    h.clock.set(1400);
    const result = await h.registry.transition(
      { kind: "stop", taskId: TASK_1, reason: "model stop" },
      callContext(h, CALLER),
    );

    expect(result.record.status).toBe("stopping");
    expect(result.record.stopReason).toBe("model stop");
    expect(result.record.finishedAt).toBeUndefined();
    expect(result.events[0]?.type).toBe("task:01JBZ000000000000000000001:stopping");
    expect(result.events[0]?.status).toBe("stopping");
  });
});

// ---------------------------------------------------------------------------
//  query (ADR-0022 §3)
// ---------------------------------------------------------------------------

async function seedQueryTasks(h: Harness): Promise<void> {
  h.clock.set(1000);
  await spawnTask(h, TASK_1, { record: { label: "research X" } });
  h.clock.set(2000);
  await spawnTask(h, TASK_2, { record: { label: "research Y" } });
  h.clock.set(3000);
  await spawnTask(h, TASK_3, { record: { label: "ship Z" } });
  await h.registry.transition(
    { kind: "transition", taskId: TASK_2, to: "succeeded" },
    callContext(h, CALLER),
  );
}

describe("TaskRegistry.query", () => {
  test("defaults to createdAt-desc with limit 100", async () => {
    const h = createHarness(1000);
    await seedQueryTasks(h);
    const got = await h.registry.query({});
    expect(got.map((record) => record.id)).toEqual([TASK_3, TASK_2, TASK_1]);
  });

  test("orderBy createdAt-asc reverses the default", async () => {
    const h = createHarness(1000);
    await seedQueryTasks(h);
    const got = await h.registry.query({ orderBy: "createdAt-asc" });
    expect(got.map((record) => record.id)).toEqual([TASK_1, TASK_2, TASK_3]);
  });

  test("filters by a status array", async () => {
    const h = createHarness(1000);
    await seedQueryTasks(h);
    const got = await h.registry.query({ status: ["succeeded", "lost"] });
    expect(got.map((record) => record.id)).toEqual([TASK_2]);
  });

  test("filters by exact label (no substring match)", async () => {
    const h = createHarness(1000);
    await seedQueryTasks(h);
    const got = await h.registry.query({ label: "research X" });
    expect(got.map((record) => record.id)).toEqual([TASK_1]);
  });

  test("applies the limit after ordering", async () => {
    const h = createHarness(1000);
    await seedQueryTasks(h);
    const got = await h.registry.query({ limit: 2 });
    expect(got.map((record) => record.id)).toEqual([TASK_3, TASK_2]);
  });

  test("limit 0 returns no records without throwing", async () => {
    const h = createHarness(1000);
    await seedQueryTasks(h);
    expect(await h.registry.query({ limit: 0 })).toEqual([]);
  });

  test("rejects a negative limit", async () => {
    const h = createHarness(1000);
    await expect(h.registry.query({ limit: -1 })).rejects.toThrow(
      /limit must be a non-negative integer/,
    );
  });
});

// ---------------------------------------------------------------------------
//  advanceCursor + loadEventLog (ADR-0022 §5/§7)
// ---------------------------------------------------------------------------

describe("TaskRegistry.advanceCursor", () => {
  test("persists a strictly newer cursor (§5)", async () => {
    const h = createHarness(1000);
    const spawn = await spawnTask(h, TASK_1);
    const succeeded = await h.registry.transition(
      { kind: "transition", taskId: TASK_1, to: "succeeded" },
      callContext(h, CALLER),
    );
    expect(succeeded.cursor > spawn.cursor).toBe(true);

    await h.registry.advanceCursor(CALLER as ULID, TASK_1, succeeded.cursor, succeeded.events);
    const subscription = await h.storage.loadSubscription(CALLER as ULID, TASK_1);
    expect(subscription?.cursor).toBe(succeeded.cursor);
  });

  test("advancing to a lower or equal cursor is an idempotent no-op (§5/§8)", async () => {
    const h = createHarness(1000);
    const spawn = await spawnTask(h, TASK_1);
    const succeeded = await h.registry.transition(
      { kind: "transition", taskId: TASK_1, to: "succeeded" },
      callContext(h, CALLER),
    );
    await h.registry.advanceCursor(CALLER as ULID, TASK_1, succeeded.cursor, succeeded.events);
    await h.registry.advanceCursor(CALLER as ULID, TASK_1, spawn.cursor, spawn.events);
    await h.registry.advanceCursor(CALLER as ULID, TASK_1, succeeded.cursor, succeeded.events);

    const subscription = await h.storage.loadSubscription(CALLER as ULID, TASK_1);
    expect(subscription?.cursor).toBe(succeeded.cursor);
  });

  test("an unknown subscription throws", async () => {
    const h = createHarness(1000);
    await expect(
      h.registry.advanceCursor("ghost" as ULID, TASK_1, "01JBZ0000000000000000000ZZ" as ULID, []),
    ).rejects.toThrow(/unknown subscription/);
  });
});

describe("TaskRegistry.loadEventLog", () => {
  test("returns the full per-subscriber log in emission order (§5/§7)", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    await h.registry.transition(
      { kind: "stop", taskId: TASK_1, reason: "model stop" },
      callContext(h, CALLER),
    );
    await h.registry.transition(
      { kind: "transition", taskId: TASK_1, to: "canceled" },
      callContext(h, CALLER),
    );

    const log = await h.registry.loadEventLog(CALLER as ULID);
    expect(log.map((event) => event.type)).toEqual([
      "task:01JBZ000000000000000000001:running",
      "task:01JBZ000000000000000000001:stopping",
      "task:01JBZ000000000000000000001:->canceled",
    ]);
  });

  test("since returns strictly-newer events (§5)", async () => {
    const h = createHarness(1000);
    const spawn = await spawnTask(h, TASK_1);
    await h.registry.transition(
      { kind: "transition", taskId: TASK_1, to: "succeeded" },
      callContext(h, CALLER),
    );

    const log = await h.registry.loadEventLog(CALLER as ULID, spawn.cursor);
    expect(log.map((event) => event.type)).toEqual(["task:01JBZ000000000000000000001:->succeeded"]);
  });

  test("an unknown subscription throws", async () => {
    const h = createHarness(1000);
    await expect(h.registry.loadEventLog("ghost" as ULID)).rejects.toThrow(
      /unknown subscriptionId/,
    );
  });
});

// ---------------------------------------------------------------------------
//  reconcileLostTasks (ADR-0022 §2/§8)
// ---------------------------------------------------------------------------

describe("TaskRegistry.reconcileLostTasks", () => {
  test("marks running tasks lost with lost_on_session_restart (§2/§8)", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    h.clock.set(4000);

    const reconciled = await h.registry.reconcileLostTasks();
    expect(reconciled.map((record) => record.id)).toEqual([TASK_1]);
    expect(reconciled[0]?.status).toBe("lost");
    expect(reconciled[0]?.errorMessage).toBe("lost_on_session_restart");
    expect(reconciled[0]?.finishedAt).toBe(4000);
    expect(reconciled[0]?.durationMs).toBe(3000);

    const persisted = await h.storage.loadTask(TASK_1);
    expect(persisted?.status).toBe("lost");
  });

  test("also reclaims a stopping task (restart-reconcile recovery edge)", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    await h.registry.transition(
      { kind: "stop", taskId: TASK_1, reason: "model stop" },
      callContext(h, CALLER),
    );

    const reconciled = await h.registry.reconcileLostTasks();
    expect(reconciled.map((record) => record.status)).toEqual(["lost"]);
  });

  test("is idempotent: the second run returns no records (§2)", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    const first = await h.registry.reconcileLostTasks();
    const second = await h.registry.reconcileLostTasks();
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });

  test("leaves terminal tasks untouched (§2)", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    await h.registry.transition(
      { kind: "transition", taskId: TASK_1, to: "succeeded" },
      callContext(h, CALLER),
    );
    await spawnTask(h, TASK_2);

    const reconciled = await h.registry.reconcileLostTasks();
    expect(reconciled.map((record) => record.id)).toEqual([TASK_2]);
    const succeeded = await h.storage.loadTask(TASK_1);
    expect(succeeded?.status).toBe("succeeded");
  });

  test("emits the lost event to the owner subscription (§8)", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    await h.registry.reconcileLostTasks();

    const log = await h.registry.loadEventLog(CALLER as ULID);
    expect(log.map((event) => event.type)).toEqual([
      "task:01JBZ000000000000000000001:running",
      "task:01JBZ000000000000000000001:->lost",
    ]);
  });

  test("reconcile-lost stores the Esc reason in errorMessage (§8)", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    const result = await h.registry.transition(
      { kind: "reconcile-lost", taskId: TASK_1, reason: "user_killed_via_esc" },
      callContext(h, CALLER),
    );
    expect(result.record.status).toBe("lost");
    expect(result.record.errorMessage).toBe("user_killed_via_esc");
  });

  test("reconcile-lost on a terminal task throws", async () => {
    const h = createHarness(1000);
    await seedStatus(h, "succeeded", TASK_1);
    await expect(
      h.registry.transition(
        { kind: "reconcile-lost", taskId: TASK_1, reason: "lost_on_session_restart" },
        callContext(h, CALLER),
      ),
    ).rejects.toThrow(/only running\/stopping tasks can be reconciled/);
  });
});

// ---------------------------------------------------------------------------
//  injection seams: foreign caller + logger (ADR-0022 impl spec §12)
// ---------------------------------------------------------------------------

describe("TaskRegistry injection seams", () => {
  test("a foreign caller's transition auto-creates a subscription and warns", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1, { callerId: CALLER });
    const result = await h.registry.transition(
      { kind: "transition", taskId: TASK_1, to: "succeeded" },
      { clock: h.clock.clock, callerId: "dispatcher-9" },
    );

    expect(result.record.status).toBe("succeeded");
    const subscription = await h.storage.loadSubscription("dispatcher-9" as ULID, TASK_1);
    expect(subscription).not.toBeNull();
    expect(h.logger.warn).toHaveLength(1);
    expect(h.logger.warn[0]).toContain("auto-created");
  });

  test("the injected logger records spawn and transition info lines", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    await h.registry.transition(
      { kind: "transition", taskId: TASK_1, to: "succeeded" },
      callContext(h, CALLER),
    );

    expect(h.logger.info).toHaveLength(2);
    expect(h.logger.info[0]).toContain("spawn: task 01JBZ000000000000000000001");
    expect(h.logger.info[1]).toContain("running -> succeeded");
  });
});

// ---------------------------------------------------------------------------
//  counterfactual (docs/testing-constraints.md #5)
// ---------------------------------------------------------------------------

describe("TaskRegistry counterfactual", () => {
  /** An obviously-broken registry: no transition validation, no-op cursor writes. */
  function brokenRegistry(): TaskRegistry {
    const record: TaskRecord = {
      id: TASK_1,
      label: "broken",
      agentName: "none",
      depth: 0,
      status: "running",
      createdAt: 0,
      startedAt: 0,
      transitionAt: 0,
      spawnSource: { kind: "ptc-program", callerId: CALLER },
    };
    return {
      transition: async (command) => ({
        record: {
          ...record,
          status: command.kind === "transition" ? command.to : "running",
        },
        events: [],
        cursor: "01JBZ0000000000000000000ZZ" as ULID,
      }),
      query: async () => [],
      advanceCursor: async () => undefined,
      loadEventLog: async () => [],
      reconcileLostTasks: async () => [],
    };
  }

  test("a permissive state machine resolves the running -> running edge the spec rejects", async () => {
    const h = createHarness(1000);
    const broken = brokenRegistry();
    await expect(
      broken.transition(
        { kind: "transition", taskId: TASK_1, to: "running" },
        callContext(h, CALLER),
      ),
    ).resolves.toBeDefined();
  });

  test("a no-op advanceCursor leaves the old cursor, which the spec asserts must move", async () => {
    const h = createHarness(1000);
    const spawn = await spawnTask(h, TASK_1);
    const succeeded = await h.registry.transition(
      { kind: "transition", taskId: TASK_1, to: "succeeded" },
      callContext(h, CALLER),
    );
    const broken = brokenRegistry();
    await broken.advanceCursor(CALLER as ULID, TASK_1, succeeded.cursor, succeeded.events);

    const subscription = await h.storage.loadSubscription(CALLER as ULID, TASK_1);
    expect(subscription?.cursor).toBe(spawn.cursor);
    expect(subscription?.cursor).not.toBe(succeeded.cursor);
  });
});
