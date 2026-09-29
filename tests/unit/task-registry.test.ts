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
 * taskId, runtime-invalid target state, duplicate spawn, bad handle, negative query limit,
 * terminal reconcile.
 *
 * The counterfactual requirement (docs/testing-constraints.md #5) is met by the REAL registry
 * assertions, not a local stub: the ILLEGAL_CASES rejection table rejects a permissive state
 * machine, and the write-order failure-injection tests reject a no-op event/record writer. See
 * the note at the bottom of the file.
 */

import { describe, expect, test, vi } from "vitest";
import { spawnSync } from "node:child_process";
import {
  InMemoryTaskStorage,
  type TaskEvent,
  type TaskRecord,
  type TaskStatus,
  type ULID,
} from "../../src/runtime/task-storage.ts";
import {
  createTaskRegistry,
  isPidAlive,
  type DispatchHandle,
  type RegistryLogger,
  type TaskOwner,
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

/**
 * Materialize the per-subscriber event buffer through the storage seam the registry writes into.
 * Replaces the deleted `TaskRegistry.loadEventLog` inspection helper (R-m11).
 */
async function collectEvents(
  storage: InMemoryTaskStorage,
  subscriberId: string,
  since?: ULID,
): Promise<TaskEvent[]> {
  const events: TaskEvent[] = [];
  for await (const event of storage.loadEvents(subscriberId as ULID, since)) {
    events.push(event);
  }
  return events;
}

/** The spawn command's record omits id/status/createdAt/transitionAt (bg-02 brief). */
type RecordInput = Omit<TaskRecord, "id" | "status" | "createdAt" | "transitionAt">;

/**
 * Spawn record: 15 keys — the ADR-0022 §3 fields minus the four the registry owns (`id`,
 * `status`, `createdAt`, `transitionAt`), each present (as `undefined` where optional) so a
 * dropped field is caught. The ADR-0023 owner fields are left unset: the registry stamps them
 * on the spawn command, so setting them here would let a bug in that stamping go unseen.
 */
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
  await h.registry.transition(
    {
      kind: "transition",
      taskId,
      to: from,
      // ADR-0022 §8: the lost edge carries one of the three auditable reasons.
      ...(from === "lost" ? { reason: "lost_on_session_restart" } : {}),
    },
    callContext(h, CALLER),
  );
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

    const log = await collectEvents(h.storage, CALLER);
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

  /**
   * R-M1 / issue #68: a stop that lands while the idempotent read-then-write check is in flight
   * must not emit a second `stopping` event. The registry's own serialization + idempotent
   * `#stop` is the guard; the tool no longer owns the check.
   */
  test("two concurrent stop commands emit exactly one stopping event (§8)", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);

    const [first, second] = await Promise.all([
      h.registry.transition(
        { kind: "stop", taskId: TASK_1, reason: "one" },
        callContext(h, CALLER),
      ),
      h.registry.transition(
        { kind: "stop", taskId: TASK_1, reason: "two" },
        callContext(h, CALLER),
      ),
    ]);

    expect(first.record.status).toBe("stopping");
    expect(second.record.status).toBe("stopping");
    const log = await collectEvents(h.storage, CALLER);
    expect(log.filter((event) => event.type.endsWith(":stopping"))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
//  resolve-exit: the terminal decision lives inside the single writer (R-M1, #68)
// ---------------------------------------------------------------------------

describe("TaskRegistry.resolve-exit", () => {
  test("running + exit 0 resolves succeeded and running + exit 1 resolves failed", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    await spawnTask(h, TASK_2);

    const ok = await h.registry.transition(
      { kind: "resolve-exit", taskId: TASK_1, exitCode: 0 },
      callContext(h, CALLER),
    );
    const bad = await h.registry.transition(
      { kind: "resolve-exit", taskId: TASK_2, exitCode: 1 },
      callContext(h, CALLER),
    );

    expect(ok.record.status).toBe("succeeded");
    expect(ok.record.exitCode).toBe(0);
    expect(ok.fromStatus).toBe("running");
    expect(bad.record.status).toBe("failed");
    expect(bad.record.exitCode).toBe(1);
  });

  /**
   * ADR-0022 §8 line 184: "ptc_task_stop ... running -> stopping -> canceled". A stop that
   * lands before the terminal write therefore resolves canceled even when the child exited 0.
   */
  test("stopping + exit 0 resolves canceled, never succeeded (ADR-0022 §8)", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    await h.registry.transition(
      { kind: "stop", taskId: TASK_1, reason: "model stop" },
      callContext(h, CALLER),
    );

    const resolved = await h.registry.transition(
      { kind: "resolve-exit", taskId: TASK_1, exitCode: 0 },
      callContext(h, CALLER),
    );

    expect(resolved.record.status).toBe("canceled");
    expect(resolved.record.stopReason).toBe("model stop");
    expect(resolved.fromStatus).toBe("stopping");
  });

  test("carries outputRef/outputBytes/outputPreview onto the terminal record (§3/§7)", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);

    const resolved = await h.registry.transition(
      {
        kind: "resolve-exit",
        taskId: TASK_1,
        exitCode: 0,
        outputRef: "memory:tasks/x/output.log",
        outputBytes: 4,
        outputPreview: "PONG",
      },
      callContext(h, CALLER),
    );

    expect(resolved.record.outputRef).toBe("memory:tasks/x/output.log");
    expect(resolved.record.outputBytes).toBe(4);
    expect(resolved.record.outputPreview).toBe("PONG");
  });

  test("rejects a resolve-exit on a terminal task with an explicit error (no silent overwrite)", async () => {
    const h = createHarness(1000);
    await seedStatus(h, "succeeded", TASK_1);

    await expect(
      h.registry.transition(
        { kind: "resolve-exit", taskId: TASK_1, exitCode: 0 },
        callContext(h, CALLER),
      ),
    ).rejects.toThrow(/resolve-exit: task .* is terminal \(succeeded\)/);

    expect((await h.storage.loadTask(TASK_1))?.status).toBe("succeeded");
  });
});

// ---------------------------------------------------------------------------
//  transition observer (issue #68 §1)
// ---------------------------------------------------------------------------

describe("TaskRegistry.onTransition", () => {
  test("fires synchronously after the transition is persisted and passes the post record + event", async () => {
    const h = createHarness(1000);
    const order: string[] = [];
    const originalAppend = h.storage.appendEvents.bind(h.storage);
    vi.spyOn(h.storage, "appendEvents").mockImplementation(async (subscriptionId, events) => {
      order.push("persist");
      await originalAppend(subscriptionId, events);
    });
    const seen: Array<{ status: string; type: string }> = [];
    h.registry.onTransition((record, event) => {
      order.push("observe");
      seen.push({ status: record.status, type: event.type });
    });

    await spawnTask(h, TASK_1);

    // RED source: the observer must not run before the event is persisted.
    expect(order).toEqual(["persist", "observe"]);
    expect(seen).toEqual([{ status: "running", type: "task:01JBZ000000000000000000001:running" }]);
  });

  test("does not fire for an illegal transition", async () => {
    const h = createHarness(1000);
    const seen: string[] = [];
    h.registry.onTransition((_record, event) => {
      seen.push(event.type);
    });
    await spawnTask(h, TASK_1);

    await expect(
      h.registry.transition(
        { kind: "transition", taskId: TASK_1, to: "running" },
        callContext(h, CALLER),
      ),
    ).rejects.toThrow(/illegal transition/);

    expect(seen).toEqual(["task:01JBZ000000000000000000001:running"]);
  });

  test("unsubscribe is idempotent and stops delivery", async () => {
    const h = createHarness(1000);
    const seen: string[] = [];
    const unsubscribe = h.registry.onTransition((_record, event) => {
      seen.push(event.type);
    });
    unsubscribe();
    unsubscribe();

    await spawnTask(h, TASK_1);

    expect(seen).toEqual([]);
  });

  test("an observer that throws does not break the transition and is warned", async () => {
    const h = createHarness(1000);
    h.registry.onTransition(() => {
      throw new Error("observer exploded");
    });

    const result = await spawnTask(h, TASK_1);

    expect(result.record.status).toBe("running");
    expect(await h.storage.loadTask(TASK_1)).not.toBeNull();
    expect(h.logger.warn.some((line) => line.includes("observer exploded"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//  lost requires a LostReason (R-M4, ADR-0022 §8)
// ---------------------------------------------------------------------------

const LOST_REASONS = [
  "session_ended_while_running",
  "user_killed_via_esc",
  "lost_on_session_restart",
] as const;

describe("TaskRegistry lost reasons (ADR-0022 §8)", () => {
  test('a to:"lost" transition with no reason is rejected with a descriptive error', async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);

    await expect(
      h.registry.transition(
        { kind: "transition", taskId: TASK_1, to: "lost" },
        callContext(h, CALLER),
      ),
    ).rejects.toThrow(/to "lost" requires a LostReason/);

    expect((await h.storage.loadTask(TASK_1))?.status).toBe("running");
  });

  test.each(LOST_REASONS)("round-trips the %s reason into errorMessage", async (reason) => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);

    const result = await h.registry.transition(
      { kind: "transition", taskId: TASK_1, to: "lost", reason },
      callContext(h, CALLER),
    );

    expect(result.record.status).toBe("lost");
    expect(result.record.errorMessage).toBe(reason);
  });
});

// ---------------------------------------------------------------------------
//  spawn write order: a partial failure must not leave a running orphan (R-m7)
// ---------------------------------------------------------------------------

describe("TaskRegistry.spawn write order", () => {
  test("an event-log write failure leaves no running record (IO failure path)", async () => {
    const h = createHarness(1000);
    vi.spyOn(h.storage, "appendEvents").mockRejectedValueOnce(new Error("event log write failed"));

    await expect(spawnTask(h, TASK_1)).rejects.toThrow(/event log write failed/);

    expect(await h.storage.loadTask(TASK_1)).toBeNull();
  });

  test("a subscription write failure leaves no running record (IO failure path)", async () => {
    const h = createHarness(1000);
    vi.spyOn(h.storage, "saveSubscription").mockRejectedValueOnce(
      new Error("subscription write failed"),
    );

    await expect(spawnTask(h, TASK_1)).rejects.toThrow(/subscription write failed/);

    expect(await h.storage.loadTask(TASK_1)).toBeNull();
  });

  test("a terminal event-log write failure leaves the record non-terminal (B8 IO failure path)", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    vi.spyOn(h.storage, "appendEvents").mockRejectedValueOnce(new Error("event append failed"));

    await expect(
      h.registry.transition(
        { kind: "transition", taskId: TASK_1, to: "succeeded" },
        callContext(h, CALLER),
      ),
    ).rejects.toThrow(/event append failed/);

    // B8: the event must be written BEFORE the terminal record, so a failed append cannot leave
    // a succeeded record whose event never exists. The task is still running and retryable.
    expect((await h.storage.loadTask(TASK_1))?.status).toBe("running");
    const events = await collectEvents(h.storage, CALLER);
    expect(events.map((event) => event.status)).toEqual(["running"]);
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
//  get (ADR-0022 §3 read side)
// ---------------------------------------------------------------------------

describe("TaskRegistry.get", () => {
  test("returns the persisted record by id", async () => {
    const h = createHarness(1000);
    await seedQueryTasks(h);

    const record = await h.registry.get(TASK_1);

    expect(record?.id).toBe(TASK_1);
    expect(record?.label).toBe("research X");
    expect(record?.status).toBe("running");
  });

  test("returns null for an unknown id and for an empty id", async () => {
    const h = createHarness(1000);

    expect(await h.registry.get("01JBZ000000000000000000404" as ULID)).toBeNull();
    expect(await h.registry.get("" as ULID)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  per-subscriber event buffer (ADR-0022 §5/§7)
//
//  `TaskRegistry.advanceCursor` / `loadEventLog` were deleted (R-m11): neither had a production
//  caller and the former duplicated `DefaultNotificationPipeline.acknowledgeEvents`, the single
//  production cursor writer. Event-buffer order is asserted through the storage seam the registry
//  writes into; cursor advancement is covered by the notification-pipeline suite.
// ---------------------------------------------------------------------------

describe("per-subscriber event buffer (ADR-0022 §5/§7)", () => {
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

    const log = await collectEvents(h.storage, CALLER);
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

    const log = await collectEvents(h.storage, CALLER, spawn.cursor);
    expect(log.map((event) => event.type)).toEqual(["task:01JBZ000000000000000000001:->succeeded"]);
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

    const log = await collectEvents(h.storage, CALLER);
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
//  task ownership (ADR-0023)
// ---------------------------------------------------------------------------

describe("TaskRegistry task ownership (ADR-0023)", () => {
  /**
   * Owner identities are literals from the ADR-0023 model (pid + runtime-start bootMs). The
   * ownership oracle is the ADR rule "reap a non-terminal record only when its owner pid is
   * dead", driven through the injected `isPidAlive` seam — never the real process table — so
   * each row of the matrix is decided by the alive-set, not by test-process timing.
   */
  const OWNER_A: TaskOwner = { pid: 7_001, bootMs: 100_000 };
  const OWNER_B: TaskOwner = { pid: 8_002, bootMs: 200_000 };

  interface OwnerHarness {
    storage: InMemoryTaskStorage;
    clock: FakeClock;
    /** Registry owned by A — the "parent process" stand-in. */
    registryA: TaskRegistry;
    /** Registry owned by B — a "sibling pi process" binding the SAME storage. */
    registryB: TaskRegistry;
    /** Registry with no configured owner — stamps legacy ownerless records. */
    legacy: TaskRegistry;
  }

  function createOwnerHarness(alivePids: readonly number[]): OwnerHarness {
    const storage = new InMemoryTaskStorage();
    const clock = createFakeClock(1000);
    const alive = new Set<number>(alivePids);
    const isAlive = (pid: number): boolean => alive.has(pid);
    const base = { clock: clock.clock, isPidAlive: isAlive };
    return {
      storage,
      clock,
      registryA: createTaskRegistry(storage, { ...base, owner: OWNER_A }),
      registryB: createTaskRegistry(storage, { ...base, owner: OWNER_B }),
      legacy: createTaskRegistry(storage, base),
    };
  }

  async function spawnWith(
    registry: TaskRegistry,
    clock: FakeClock,
    taskId: ULID,
    callerId = CALLER,
  ): Promise<void> {
    await registry.transition(
      {
        kind: "spawn",
        handle: fixtureHandle(taskId),
        record: fixtureRecord({ spawnSource: { kind: "ptc-program", callerId } }),
      },
      { clock: clock.clock, callerId },
    );
  }

  /** Drive a seeded task into `stopping` so the reconcile's recovery source set is exercised. */
  async function stopWith(
    registry: TaskRegistry,
    clock: FakeClock,
    taskId: ULID,
    callerId = CALLER,
  ): Promise<void> {
    await registry.transition(
      { kind: "stop", taskId, reason: "matrix stop" },
      { clock: clock.clock, callerId },
    );
  }

  test("a spawned record carries its creator's owner identity (record creation)", async () => {
    const h = createOwnerHarness([OWNER_A.pid, OWNER_B.pid]);
    await spawnWith(h.registryA, h.clock, TASK_1);

    const record = await h.storage.loadTask(TASK_1);
    // SPECIFICATION (ADR-0023): the registered record is stamped with the creator runtime's
    // identity — the literal OWNER_A the registry was constructed with. Counterfactual (#5):
    // a registry that stopped stamping would leave both fields undefined and this fails.
    expect(record?.ownerPid).toBe(OWNER_A.pid);
    expect(record?.ownerBootMs).toBe(OWNER_A.bootMs);
  });

  test("a registry without an owner keeps stamping ownerless (legacy) records", async () => {
    const h = createOwnerHarness([]);
    await spawnWith(h.legacy, h.clock, TASK_1);

    const record = await h.storage.loadTask(TASK_1);
    // The pre-ADR-0023 persisted shape: no owner fields. This is what an upgrade finds on disk.
    expect(record?.ownerPid).toBeUndefined();
    expect(record?.ownerBootMs).toBeUndefined();
  });

  test("startup reconcile matrix (running): own and foreign-alive stay, foreign-dead and legacy are swept", async () => {
    const h = createOwnerHarness([OWNER_A.pid, OWNER_B.pid]);
    await spawnWith(h.registryB, h.clock, TASK_1); // own record (B's in-flight task)
    await spawnWith(h.registryA, h.clock, TASK_2); // foreign record, owner A's pid alive
    await spawnWith(h.legacy, h.clock, TASK_3); // legacy record, no owner
    h.clock.set(4000);

    const reconciled = await h.registryB.reconcileLostTasks();

    // THE counterfactual for field-report pitfall #3: pre-ADR-0023 the sweep was dir-wide, so
    // TASK_2 (a live sibling's record) and even TASK_1 (the reconciler's own in-flight task)
    // were flipped to lost; only the legacy TASK_3 row may be swept now.
    expect(reconciled.map((record) => record.id)).toEqual([TASK_3]);
    expect(reconciled[0]?.status).toBe("lost");
    expect(reconciled[0]?.errorMessage).toBe("lost_on_session_restart");
    expect((await h.storage.loadTask(TASK_1))?.status).toBe("running");
    expect((await h.storage.loadTask(TASK_2))?.status).toBe("running");
    expect((await h.storage.loadTask(TASK_3))?.status).toBe("lost");
  });

  test("startup reconcile matrix (stopping): the same ownership rule on the recovery edge", async () => {
    const h = createOwnerHarness([OWNER_A.pid, OWNER_B.pid]);
    await spawnWith(h.registryB, h.clock, TASK_1);
    await spawnWith(h.registryA, h.clock, TASK_2);
    await spawnWith(h.legacy, h.clock, TASK_3);
    await stopWith(h.registryB, h.clock, TASK_1);
    await stopWith(h.registryA, h.clock, TASK_2);
    await stopWith(h.legacy, h.clock, TASK_3);
    h.clock.set(4000);

    const reconciled = await h.registryB.reconcileLostTasks();

    expect(reconciled.map((record) => record.id)).toEqual([TASK_3]);
    expect((await h.storage.loadTask(TASK_1))?.status).toBe("stopping");
    expect((await h.storage.loadTask(TASK_2))?.status).toBe("stopping");
    expect((await h.storage.loadTask(TASK_3))?.status).toBe("lost");
  });

  test("a record whose foreign owner pid is dead is swept (owner process died pre-completion)", async () => {
    const h = createOwnerHarness([OWNER_B.pid]); // owner A's process is gone
    await spawnWith(h.registryA, h.clock, TASK_2);
    await stopWith(h.registryA, h.clock, TASK_2); // caught mid-stopping at owner death
    h.clock.set(4000);

    const reconciled = await h.registryB.reconcileLostTasks();

    expect(reconciled.map((record) => record.id)).toEqual([TASK_2]);
    expect(reconciled[0]?.status).toBe("lost");
    expect(reconciled[0]?.errorMessage).toBe("lost_on_session_restart");
  });

  test("a foreign record with our pid but an older bootMs reads as foreign-alive (accepted limitation)", async () => {
    const h = createOwnerHarness([OWNER_B.pid]);
    const reloaded = createTaskRegistry(h.storage, {
      clock: h.clock.clock,
      isPidAlive: (pid) => pid === OWNER_B.pid,
      owner: { pid: OWNER_B.pid, bootMs: 1 }, // same process, an older runtime instance
    });
    await spawnWith(reloaded, h.clock, TASK_1);
    h.clock.set(4000);

    const reconciled = await h.registryB.reconcileLostTasks();

    expect(reconciled).toEqual([]);
    expect((await h.storage.loadTask(TASK_1))?.status).toBe("running");
  });

  test("the default isPidAlive probe reads a live pid as alive and a reaped child pid as dead", () => {
    // Both sides of the IO boundary (constraint #1) against the REAL probe: our own pid is
    // alive (happy path); a fully-reaped child is ESRCH (failure path). EPERM (exists but
    // foreign-owned) has no portable test here; its branch is documented on the probe.
    expect(isPidAlive(process.pid)).toBe(true);
    const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    expect(exited.status).toBe(0);
    expect(exited.pid).toBeGreaterThan(0);
    expect(isPidAlive(exited.pid)).toBe(false);
  });

  test("a probe error other than ESRCH/EPERM rejects reconcileLostTasks and leaves the record running (ADR-0023)", async () => {
    // ADR-0023 contract on the default probe: ESRCH → dead, EPERM → alive, ANY OTHER error
    // rethrows so a probe glitch can neither silently reap nor silently preserve records.
    // The seam is TaskRegistryOptions.isPidAlive; a throwing probe stands in for e.g. EINVAL.
    // The record is owner-stamped so the probe is actually consulted (ownerless records are
    // reapable without probing). Counterfactual: a reconcile that swallowed probe errors
    // would resolve and flip the record to lost — both assertions below would fail.
    const storage = new InMemoryTaskStorage();
    const clock = createFakeClock(1000);
    const registry = createTaskRegistry(storage, {
      clock: clock.clock,
      owner: OWNER_A,
      isPidAlive: (): boolean => {
        throw new Error("probe exploded");
      },
    });
    await registry.transition(
      { kind: "spawn", handle: fixtureHandle(TASK_1), record: fixtureRecord() },
      { clock: clock.clock, callerId: CALLER },
    );

    await expect(registry.reconcileLostTasks()).rejects.toThrow("probe exploded");

    expect((await storage.loadTask(TASK_1))?.status).toBe("running");
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
//  counterfactual coverage (docs/testing-constraints.md #5)
// ---------------------------------------------------------------------------
//
// There is deliberately no locally-defined "broken registry" here: asserting a stub's own
// behaviour is self-referential and stays green under any production regression. The wrong
// implementations are rejected by the REAL DefaultTaskRegistry assertions above:
//   - a permissive state machine (allowing running -> running) is rejected by the
//     ILLEGAL_CASES table in "TaskRegistry.transition — rejection paths" (line 447);
//   - a no-op cursor/event writer is rejected by the per-subscriber event-buffer
//     assertions and by the spawn/terminal write-order failure-injection tests.
