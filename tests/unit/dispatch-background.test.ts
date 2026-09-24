/**
 * BG-04 unit tests for the background branch of `pi.dispatch` (ADR-0022 §1/§2/§3/§4/§9).
 *
 * SPECIFICATION tests, not characterization (docs/testing-constraints.md #4/#6): every
 * expectation traces to a literal or invariant in ADR-0022 — the DispatchHandle shape (§4),
 * the terminal transitions `succeeded` on exit 0 / `failed` otherwise (§2), the R1 session
 * flags (§1/R1), the spawn-or-reject concurrency cap that background tasks count against
 * (§9) — or to the unchanged ADR-0016 foreground contract.
 *
 * Dependencies are injected (docs/testing-constraints.md #1): the child is a
 * `MockChildProcessLifecycle` and the record store is an `InMemoryTaskStorage`, so no real
 * `pi` process is spawned; a fake clock pins every TaskRecord timestamp. The one foreground
 * test mocks `node:child_process` at the module boundary, exactly like
 * `tests/dispatch-helpers.test.ts`.
 */
import { describe, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DISPATCH_KILL_GRACE_MS,
  DispatchSlotCounter,
  dispatch,
  dispatchDepthLimitReached,
  type DispatchDeps,
  type DispatchResult,
} from "../../src/runtime/dispatch.ts";
import {
  MockChildProcessLifecycle,
  buildSpawnArgv,
  type ChildHandle,
  type ChildSpawnOptions,
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
import { InMemoryOutputStorage, type OutputStorage } from "../../src/runtime/output-storage.ts";
import { makeTempDir, removeTempDir } from "../helpers/ptc.ts";

// ---------------------------------------------------------------------------
//  node:child_process mock — only the foreground "unchanged" test drives this path
// ---------------------------------------------------------------------------

const spawnRecorder = vi.hoisted(() => ({ calls: 0 }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const fakeSpawn = (): EventEmitter => {
    spawnRecorder.calls += 1;
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      pid: number;
      killed: boolean;
      kill: (signal: string) => boolean;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.pid = 4242;
    proc.killed = false;
    proc.kill = () => true;
    // A clean close with no assistant message: the foreground result is the documented
    // "dispatch produced no final text" rejection, but the child did come up.
    queueMicrotask(() => proc.emit("close", 0));
    return proc;
  };
  return { ...actual, spawn: fakeSpawn as unknown as typeof actual.spawn };
});

// ---------------------------------------------------------------------------
//  Fixtures and harness
// ---------------------------------------------------------------------------

const AGENT = "bg-probe";
const AGENT_MD = "---\nname: bg-probe\n---\nYou probe.\n";
/** Canonical ULID literal (Crockford base32) used as a nested dispatch's parent task id. */
const PARENT_TASK = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as ULID;

/**
 * Background refusal copy (issue #68 part 4 / wayfinder T4.4): a refused *background* spawn
 * teaches the model to inspect the management surface. The foreground ADR-0016 wording is pinned
 * independently by tests/dispatch-helpers.test.ts; these literals are authored from the
 * requirement, not read back from the implementation.
 */
const BG_DEPTH_REFUSAL =
  "dispatch depth limit reached; next_step: call ptc_task_list to inspect the in-flight background tasks";
const BG_CONCURRENCY_REFUSAL =
  "dispatch concurrency limit reached; next_step: call ptc_task_list to inspect running tasks and ptc_task_stop to free a slot";

/** The terminal states from ADR-0022 §2; used to poll the pump without a real timer. */
const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "succeeded",
  "failed",
  "canceled",
  "lost",
]);

interface FakeClock {
  clock: () => number;
  set: (ms: number) => void;
}

function createFakeClock(start: number): FakeClock {
  let current = start;
  return {
    clock: () => current,
    set: (ms: number) => {
      current = ms;
    },
  };
}

/** Records every handle the background branch spawns, so tests can drive its exit. */
class RecordingLifecycle extends MockChildProcessLifecycle {
  readonly spawned: ChildHandle[] = [];

  override spawn(argv: readonly string[], opts: ChildSpawnOptions): ChildHandle {
    const handle = super.spawn(argv, opts);
    this.spawned.push(handle);
    return handle;
  }

  /** The handle at `index` or a loud failure (no unchecked-index silencing). */
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
  clock: FakeClock;
  deps: DispatchDeps;
}

function createHarness(options: { limit?: number; start?: number } = {}): Harness {
  const storage = new InMemoryTaskStorage();
  const clock = createFakeClock(options.start ?? 1000);
  const registry = createTaskRegistry(storage, { clock: clock.clock });
  const lifecycle = new RecordingLifecycle();
  const slots = new DispatchSlotCounter(options.limit ?? 8);
  return {
    storage,
    registry,
    lifecycle,
    slots,
    clock,
    deps: { taskRegistry: registry, lifecycle, slots, clock: clock.clock },
  };
}

/** Write a project-scope agent markdown into a fresh temp cwd and run `body`. */
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

/** Wait until the detached pump persists a terminal status. */
async function waitForTerminal(storage: InMemoryTaskStorage, taskId: ULID): Promise<TaskRecord> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const record = await storage.loadTask(taskId);
    if (record !== null) {
      const state = record.status;
      if (TERMINAL_STATUSES.has(state)) return record;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("task " + taskId + " did not reach a terminal state");
}

/** Wait until a synchronous predicate holds, flushing the pump's microtasks. */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not met");
}

async function allTasks(storage: InMemoryTaskStorage): Promise<TaskRecord[]> {
  const out: TaskRecord[] = [];
  for await (const record of storage.listTasks()) {
    out.push(record);
  }
  return out;
}

/** Narrow a background result to its handle or fail loudly. */
function asHandle(value: DispatchHandle | DispatchResult): DispatchHandle {
  if (!("taskId" in value)) {
    throw new Error("expected a DispatchHandle, got a DispatchResult refusal");
  }
  return value;
}

/** Narrow a background result to its DispatchResult refusal or fail loudly. */
function asResult(value: DispatchHandle | DispatchResult): DispatchResult {
  if ("taskId" in value) {
    throw new Error("expected a DispatchResult refusal, got a DispatchHandle");
  }
  return value;
}

// ---------------------------------------------------------------------------
//  happy path: handle + record + R1 session flags (ADR-0022 §1/§3/§4)
// ---------------------------------------------------------------------------

describe("dispatch background spawn", () => {
  test("returns a running DispatchHandle and registers the 21-field record (§3/§4)", async () => {
    await withAgent(async (dir) => {
      const h = createHarness({ start: 1000 });
      const result = await dispatch(
        {
          agent: AGENT,
          task: "investigate the thing",
          background: true,
          agentScope: "project",
          label: "research X",
        },
        {
          callId: 7,
          cwd: dir,
          depth: 0,
          maxDispatchDepth: 3,
          sessionDir: join(dir, "sessions"),
          callerId: "owner-1",
          // A nested background dispatch carries its own parent task id (ADR-0022 §3/reopen R-m12).
          parentTaskId: PARENT_TASK,
        },
        h.deps,
      );
      const handle = asHandle(result);

      expect(handle.status).toBe("running");
      expect(handle.label).toBe("research X");
      // createULID emits a 26-char Crockford-base32 ULID (10 time + 16 random).
      expect(handle.taskId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

      const record = await h.storage.loadTask(handle.taskId);
      expect(record).not.toBeNull();
      expect(record?.id).toBe(handle.taskId);
      expect(record?.status).toBe("running");
      expect(record?.label).toBe("research X");
      expect(record?.agentName).toBe(AGENT);
      expect(record?.depth).toBe(1);
      expect(record?.createdAt).toBe(1000);
      expect(record?.startedAt).toBe(1000);
      expect(record?.transitionAt).toBe(1000);
      expect(record?.finishedAt).toBeUndefined();
      expect(record?.spawnSource).toEqual({ kind: "ptc-program", callerId: "owner-1" });
      // The wired value, not undefined: the R-m12 wire is what stamps this field.
      expect(record?.parentTaskId).toBe(PARENT_TASK);
      expect(h.slots.active).toBe(1);
    });
  });

  test("defaults the label to the first 64 chars of the task (§1)", async () => {
    await withAgent(async (dir) => {
      const h = createHarness();
      const longTask = "x".repeat(100);
      const result = await dispatch(
        { agent: AGENT, task: longTask, background: true, agentScope: "project" },
        { callId: 1, cwd: dir, depth: 0, maxDispatchDepth: 3 },
        h.deps,
      );
      const handle = asHandle(result);
      expect(handle.label).toBe("x".repeat(64));
    });
  });

  test("passes the R1 session flags through the lifecycle opts when sessionDir is set (§1/R1)", async () => {
    await withAgent(async (dir) => {
      const h = createHarness();
      const sessionDir = join(dir, "sessions");
      const result = await dispatch(
        { agent: AGENT, task: "ping", background: true, agentScope: "project" },
        { callId: 3, cwd: dir, depth: 0, maxDispatchDepth: 3, sessionDir },
        h.deps,
      );
      const handle = asHandle(result);
      const opts = h.lifecycle.getRecordedOpts(h.lifecycle.handleAt(0));

      expect(opts.sessionDir).toBe(sessionDir);
      expect(opts.sessionId).toBe(handle.taskId);
      expect(opts.sessionName).toBe("bgdispatch:" + handle.taskId);
      expect(opts.env?.PI_PTC_DEPTH).toBe("1");
      // issue #68 part 2: the child carries its own task id so a nested dispatch can stamp
      // TaskRecord.parentTaskId instead of leaving it permanently undefined.
      expect(opts.env?.PI_PTC_TASK_ID).toBe(handle.taskId);

      const argv = h.lifecycle.getRecordedArgv(h.lifecycle.handleAt(0));
      expect(argv[0]).toBe("pi");
      expect(argv).toContain("--mode");
      expect(argv).toContain("json");
      expect(argv).toContain("-p");
      // The mock records the PRE-translation argv; the real adapter drops `--no-session` and
      // appends the R1 triple (buildSpawnArgv). The `--no-session` contract for a sessionDir is
      // pinned by child-process-lifecycle-session-argv.test.ts, so assert the translated form.
      const translated = buildSpawnArgv(argv, opts);
      expect(translated).not.toContain("--no-session");
      expect(translated).toContain("--session-dir");
      expect(argv[argv.length - 1]).toBe("Task: ping");
    });
  });

  test("omits the R1 session flags when no sessionDir is available (§1)", async () => {
    await withAgent(async (dir) => {
      const h = createHarness();
      const result = await dispatch(
        { agent: AGENT, task: "ping", background: true, agentScope: "project" },
        { callId: 4, cwd: dir, depth: 0, maxDispatchDepth: 3 },
        h.deps,
      );
      const handle = asHandle(result);
      const opts = h.lifecycle.getRecordedOpts(h.lifecycle.handleAt(0));

      expect(handle.status).toBe("running");
      expect(opts.sessionDir).toBeUndefined();
      expect(opts.sessionId).toBeUndefined();
      expect(opts.sessionName).toBeUndefined();
      expect(opts.env?.PI_PTC_TASK_ID).toBe(handle.taskId);
    });
  });
});

// ---------------------------------------------------------------------------
//  pre-spawn gates: depth + concurrency (ADR-0022 §9)
// ---------------------------------------------------------------------------

describe("dispatch background gates", () => {
  test("over maxDispatchDepth returns the foreground depth-limit shape and never spawns (§9)", async () => {
    const h = createHarness();
    const result = await dispatch(
      { agent: AGENT, task: "x", background: true },
      { callId: 1, cwd: process.cwd(), depth: 3, maxDispatchDepth: 3 },
      h.deps,
    );

    const refused = asResult(result);
    expect(refused.status).toBe("rejected");
    expect(refused.started).toBe(false);
    expect(refused.exitCode).toBe(-1);
    expect(refused.errorMessage).toBe(BG_DEPTH_REFUSAL);
    expect(h.lifecycle.spawnCount).toBe(0);
    expect(h.slots.active).toBe(0);
    expect(await allTasks(h.storage)).toEqual([]);
  });

  test("holds a concurrency slot while running and rejects the N+1th call (§9)", async () => {
    await withAgent(async (dir) => {
      const h = createHarness({ limit: 1 });
      const first = asHandle(
        await dispatch(
          { agent: AGENT, task: "one", background: true, agentScope: "project" },
          { callId: 1, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          h.deps,
        ),
      );
      // A background task counts against dispatchConcurrency for its whole lifetime, not
      // just until dispatch() returns (ADR-0022 §9).
      expect(h.slots.active).toBe(1);

      const second = await dispatch(
        { agent: AGENT, task: "two", background: true, agentScope: "project" },
        { callId: 2, cwd: dir, depth: 0, maxDispatchDepth: 3 },
        h.deps,
      );
      const refused = asResult(second);
      expect(refused.status).toBe("rejected");
      expect(refused.errorMessage).toBe(BG_CONCURRENCY_REFUSAL);
      // The teaching copy points the model at the management surface (issue #68 part 4).
      expect(refused.errorMessage).toContain("ptc_task_list");
      expect(refused.errorMessage).toContain("ptc_task_stop");
      expect(h.lifecycle.spawnCount).toBe(1);

      // Terminal transition releases the slot for the next spawn.
      h.clock.set(1500);
      h.lifecycle.resolveExit(h.lifecycle.handleAt(0), 0, null);
      const terminal = await waitForTerminal(h.storage, first.taskId);
      expect(terminal.status).toBe("succeeded");
      expect(h.slots.active).toBe(0);

      const third = await dispatch(
        { agent: AGENT, task: "three", background: true, agentScope: "project" },
        { callId: 3, cwd: dir, depth: 0, maxDispatchDepth: 3 },
        h.deps,
      );
      expect(asHandle(third).status).toBe("running");
      expect(h.slots.active).toBe(1);
    });
  });

  test("an unknown agent returns the foreground refusal shape and releases the slot", async () => {
    const h = createHarness();
    const result = await dispatch(
      { agent: "__bg_missing_agent__", task: "x", background: true },
      { callId: 9, cwd: process.cwd(), depth: 0, maxDispatchDepth: 3 },
      h.deps,
    );
    const failure = asResult(result);

    expect(failure.status).toBe("rejected");
    expect(failure.started).toBe(false);
    expect(failure.errorMessage).toContain("unknown agent: __bg_missing_agent__");
    expect(h.lifecycle.spawnCount).toBe(0);
    expect(h.slots.active).toBe(0);
  });
});

// ---------------------------------------------------------------------------
//  detached pump: exit 0 -> succeeded, exit 1 -> failed (ADR-0022 §2/§3)
// ---------------------------------------------------------------------------

describe("dispatch background pump", () => {
  test("drives succeeded on exit 0 and failed on exit 1 with the exit code and duration", async () => {
    await withAgent(async (dir) => {
      const h = createHarness({ start: 1000 });
      const ok = asHandle(
        await dispatch(
          { agent: AGENT, task: "ok", background: true, agentScope: "project" },
          { callId: 1, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          h.deps,
        ),
      );
      const bad = asHandle(
        await dispatch(
          { agent: AGENT, task: "bad", background: true, agentScope: "project" },
          { callId: 2, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          h.deps,
        ),
      );

      // The pump must not have blocked either return: both tasks are still running and no
      // exit has been resolved yet.
      expect((await h.storage.loadTask(ok.taskId))?.status).toBe("running");
      expect((await h.storage.loadTask(bad.taskId))?.status).toBe("running");

      h.clock.set(1500);
      h.lifecycle.resolveExit(h.lifecycle.handleAt(0), 0, null);
      h.lifecycle.resolveExit(h.lifecycle.handleAt(1), 1, null);

      const okRecord = await waitForTerminal(h.storage, ok.taskId);
      const badRecord = await waitForTerminal(h.storage, bad.taskId);

      expect(okRecord.status).toBe("succeeded");
      expect(okRecord.exitCode).toBe(0);
      expect(okRecord.finishedAt).toBe(1500);
      expect(okRecord.durationMs).toBe(500);
      expect(okRecord.errorMessage).toBeUndefined();

      expect(badRecord.status).toBe("failed");
      expect(badRecord.exitCode).toBe(1);
      expect(badRecord.finishedAt).toBe(1500);
      expect(badRecord.durationMs).toBe(500);

      expect(h.slots.active).toBe(0);
    });
  });

  test("logs a warning and releases the slot when the terminal transition fails", async () => {
    await withAgent(async (dir) => {
      const h = createHarness();
      const originalTransition = h.registry.transition.bind(h.registry);
      const transitionSpy = vi
        .spyOn(h.registry, "transition")
        .mockImplementation(async (command, ctx) => {
          if (command.kind === "resolve-exit") {
            throw new Error("simulated terminal transition failure");
          }
          return await originalTransition(command, ctx);
        });
      const warnings: string[] = [];
      const deps: DispatchDeps = {
        ...h.deps,
        logger: {
          info: (): void => undefined,
          warn: (msg: string): void => {
            warnings.push(msg);
          },
        },
      };

      const handle = asHandle(
        await dispatch(
          { agent: AGENT, task: "boom", background: true, agentScope: "project" },
          { callId: 5, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          deps,
        ),
      );
      h.lifecycle.resolveExit(h.lifecycle.handleAt(0), 0, null);
      await waitFor(() => h.slots.active === 0);

      // The failure path is observable, not silent (docs/testing-constraints.md #3).
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("background dispatch pump for task " + handle.taskId);
      expect(h.slots.active).toBe(0);
      // The simulated registry refused the terminal write, so the record stays running.
      expect((await h.storage.loadTask(handle.taskId))?.status).toBe("running");
      transitionSpy.mockRestore();
    });
  });
});

// ---------------------------------------------------------------------------
//  stop signal ladder: SIGTERM -> grace -> SIGKILL (issue #68 §1, ADR-0022 §8)
// ---------------------------------------------------------------------------

describe("background stop signal ladder", () => {
  test("a model stop while the child is live delivers SIGTERM, then SIGKILL after the grace window", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await withAgent(async (dir) => {
        const h = createHarness({ start: 1000 });
        const callerId = "owner-1";
        const handle = asHandle(
          await dispatch(
            { agent: AGENT, task: "long", background: true, agentScope: "project" },
            { callId: 1, cwd: dir, depth: 0, maxDispatchDepth: 3, callerId },
            h.deps,
          ),
        );
        const child = h.lifecycle.handleAt(0);

        await h.registry.transition(
          { kind: "stop", taskId: handle.taskId, reason: "model stop" },
          { clock: h.clock.clock, callerId },
        );

        // ADR-0022 §8: the pump observes stopping and delivers SIGTERM at once.
        expect(h.lifecycle.getKillSignals(child)).toEqual(["SIGTERM"]);
        // The escalation reuses the foreground abort path's 5000ms grace (DISPATCH_KILL_GRACE_MS).
        vi.advanceTimersByTime(DISPATCH_KILL_GRACE_MS - 1);
        expect(h.lifecycle.getKillSignals(child)).toEqual(["SIGTERM"]);
        vi.advanceTimersByTime(1);
        expect(h.lifecycle.getKillSignals(child)).toEqual(["SIGTERM", "SIGKILL"]);

        h.lifecycle.resolveExit(child, null, "SIGKILL");
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("a child that closes within the grace window receives no SIGKILL", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await withAgent(async (dir) => {
        const h = createHarness({ start: 1000 });
        const callerId = "owner-1";
        const handle = asHandle(
          await dispatch(
            { agent: AGENT, task: "quick", background: true, agentScope: "project" },
            { callId: 1, cwd: dir, depth: 0, maxDispatchDepth: 3, callerId },
            h.deps,
          ),
        );
        const child = h.lifecycle.handleAt(0);

        await h.registry.transition(
          { kind: "stop", taskId: handle.taskId, reason: "model stop" },
          { clock: h.clock.clock, callerId },
        );
        expect(h.lifecycle.getKillSignals(child)).toEqual(["SIGTERM"]);

        h.clock.set(1100);
        h.lifecycle.resolveExit(child, 0, null);
        const record = await waitForTerminal(h.storage, handle.taskId);
        // ADR-0022 §8 line 184: stopping -> canceled even on a clean child exit.
        expect(record.status).toBe("canceled");

        // The close cleared the escalation timer, so no SIGKILL can fire against a reaped handle.
        vi.advanceTimersByTime(DISPATCH_KILL_GRACE_MS * 2);
        expect(h.lifecycle.getKillSignals(child)).toEqual(["SIGTERM"]);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("a stop that arrives after the child exited sends no signal", async () => {
    await withAgent(async (dir) => {
      const h = createHarness({ start: 1000 });
      const callerId = "owner-1";
      let releaseWrite!: () => void;
      const writeGate = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      let writeStarted = false;
      const deps: DispatchDeps = {
        ...h.deps,
        outputStorage: {
          readOutput: async () => null,
          writeOutput: async () => {
            writeStarted = true;
            await writeGate;
          },
          outputRef: (taskId) => "memory:tasks/" + taskId + "/output.log",
        },
      };
      const handle = asHandle(
        await dispatch(
          { agent: AGENT, task: "late", background: true, agentScope: "project" },
          { callId: 1, cwd: dir, depth: 0, maxDispatchDepth: 3, callerId },
          deps,
        ),
      );
      const child = h.lifecycle.handleAt(0);

      h.lifecycle.resolveExit(child, 0, null);
      // The pump marks the child exited, then parks on the gated output write, so the stop below
      // observes an already-exited child.
      await waitFor(() => writeStarted);

      await h.registry.transition(
        { kind: "stop", taskId: handle.taskId, reason: "too late" },
        { clock: h.clock.clock, callerId },
      );
      expect(h.lifecycle.getKillSignals(child)).toEqual([]);

      releaseWrite();
      const record = await waitForTerminal(h.storage, handle.taskId);
      // The stop still wins the terminal decision (R-M1), but no signal was sent.
      expect(record.status).toBe("canceled");
      expect(h.lifecycle.getKillSignals(child)).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
//  background failure-path reap escalates too (R-M5)
// ---------------------------------------------------------------------------

describe("background failure-path reap", () => {
  test("uses the shared kill ladder: SIGTERM, then SIGKILL after the grace window", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await withAgent(async (dir) => {
        const h = createHarness();
        // Registration failure after the child is up drives the failure-path catch.
        vi.spyOn(h.registry, "transition").mockRejectedValueOnce(
          new Error("registration exploded"),
        );
        const result = await dispatch(
          { agent: AGENT, task: "boom", background: true, agentScope: "project" },
          { callId: 1, cwd: dir, depth: 0, maxDispatchDepth: 3, callerId: "owner-1" },
          h.deps,
        );
        const refused = asResult(result);
        expect(refused.status).toBe("rejected");
        expect(refused.started).toBe(true);

        const child = h.lifecycle.handleAt(0);
        expect(h.lifecycle.getKillSignals(child)).toEqual(["SIGTERM"]);
        vi.advanceTimersByTime(DISPATCH_KILL_GRACE_MS);
        expect(h.lifecycle.getKillSignals(child)).toEqual(["SIGTERM", "SIGKILL"]);
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
//  foreground unchanged (ADR-0016)
// ---------------------------------------------------------------------------

describe("dispatch foreground", () => {
  test("a call without background keeps the DispatchResult path and ignores the background seams", async () => {
    await withAgent(async (dir) => {
      const h = createHarness();
      spawnRecorder.calls = 0;
      const result = await dispatch(
        { agent: AGENT, task: "ping", agentScope: "project" },
        { callId: 3, cwd: dir, depth: 0, maxDispatchDepth: 3 },
        h.deps,
      );

      // Exact DispatchResult outcome produced by the mocked clean close with no assistant text.
      expect(result.status).toBe("rejected");
      expect(result.errorMessage).toBe("dispatch produced no final text");
      expect(result.exitCode).toBe(0);
      expect(result.started).toBe(true);
      expect("taskId" in result).toBe(false);

      // The background seams were never touched and no TaskRecord was written.
      expect(spawnRecorder.calls).toBe(1);
      expect(h.lifecycle.spawnCount).toBe(0);
      expect(h.slots.active).toBe(0);
      expect(await allTasks(h.storage)).toEqual([]);
    });
  });

  test("the depth gate is still the first check for a foreground call", async () => {
    const h = createHarness();
    const result = await dispatch(
      { agent: AGENT, task: "x" },
      { callId: 4, cwd: process.cwd(), depth: 3, maxDispatchDepth: 3 },
      h.deps,
    );
    expect(result).toEqual(dispatchDepthLimitReached());
    expect(h.lifecycle.spawnCount).toBe(0);
    expect(await allTasks(h.storage)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
//  output persistence: the pump writes through OutputStorage (ADR-0022 §3/§7)
// ---------------------------------------------------------------------------

describe("background output persistence", () => {
  test("persists the drained text and projects outputRef/outputBytes/outputPreview at <= 2048 bytes", async () => {
    await withAgent(async (dir) => {
      const h = createHarness({ start: 1000 });
      const outputStorage = new InMemoryOutputStorage();
      const deps: DispatchDeps = { ...h.deps, outputStorage };
      const handle = asHandle(
        await dispatch(
          { agent: AGENT, task: "small", background: true, agentScope: "project" },
          { callId: 1, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          deps,
        ),
      );
      h.lifecycle.pushEvent(h.lifecycle.handleAt(0), {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "PONG" }] },
      });
      h.clock.set(1500);
      h.lifecycle.resolveExit(h.lifecycle.handleAt(0), 0, null);
      const record = await waitForTerminal(h.storage, handle.taskId);

      expect(record.status).toBe("succeeded");
      // ADR-0022 §7: preview is inlined only when outputBytes <= 2048; "PONG" is 4 bytes.
      expect(record.outputBytes).toBe(4);
      expect(record.outputPreview).toBe("PONG");
      expect(record.outputRef).toBe(outputStorage.outputRef(handle.taskId));
      expect(await outputStorage.readOutput(handle.taskId)).toBe("PONG");
    });
  });

  test("omits outputPreview above the 2048-byte ceiling but still persists the bytes", async () => {
    await withAgent(async (dir) => {
      const h = createHarness({ start: 1000 });
      const outputStorage = new InMemoryOutputStorage();
      const deps: DispatchDeps = { ...h.deps, outputStorage };
      const handle = asHandle(
        await dispatch(
          { agent: AGENT, task: "big", background: true, agentScope: "project" },
          { callId: 2, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          deps,
        ),
      );
      const big = "x".repeat(2049);
      h.lifecycle.pushEvent(h.lifecycle.handleAt(0), {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: big }] },
      });
      h.clock.set(1500);
      h.lifecycle.resolveExit(h.lifecycle.handleAt(0), 0, null);
      const record = await waitForTerminal(h.storage, handle.taskId);

      expect(record.status).toBe("succeeded");
      // 2049 > the 2048-byte Map+preview ceiling (ADR-0022 §3/§7): no inline preview.
      expect(record.outputBytes).toBe(2049);
      expect(record.outputPreview).toBeUndefined();
      expect(record.outputRef).toBe(outputStorage.outputRef(handle.taskId));
      expect(await outputStorage.readOutput(handle.taskId)).toBe(big);
    });
  });

  test("logs a warning and still writes the terminal record when output persistence fails", async () => {
    await withAgent(async (dir) => {
      const h = createHarness({ start: 1000 });
      const failing: OutputStorage = {
        readOutput: async () => null,
        writeOutput: async () => {
          throw new Error("disk full");
        },
        outputRef: () => "memory:tasks/failing/output.log",
      };
      const warnings: string[] = [];
      const deps: DispatchDeps = {
        ...h.deps,
        outputStorage: failing,
        logger: {
          info: (): void => undefined,
          warn: (message: string): void => {
            warnings.push(message);
          },
        },
      };
      const handle = asHandle(
        await dispatch(
          { agent: AGENT, task: "persist-fail", background: true, agentScope: "project" },
          { callId: 3, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          deps,
        ),
      );
      h.lifecycle.pushEvent(h.lifecycle.handleAt(0), {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "PONG" }] },
      });
      h.clock.set(1500);
      h.lifecycle.resolveExit(h.lifecycle.handleAt(0), 0, null);
      const record = await waitForTerminal(h.storage, handle.taskId);

      // The terminal state is never swallowed (testing-constraints #3); the record keeps
      // the bytes/preview but has no outputRef because the write failed.
      expect(record.status).toBe("succeeded");
      expect(record.outputBytes).toBe(4);
      expect(record.outputPreview).toBe("PONG");
      expect(record.outputRef).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("output persistence for task " + handle.taskId);
    });
  });
});
