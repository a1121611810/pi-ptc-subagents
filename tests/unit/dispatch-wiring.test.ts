/**
 * Gap 2 + Gap 4 (BG-12) wiring tests.
 *
 * Gap 2: the dispatcher must own ONE per-run `DispatchSlotCounter` and thread it into the
 * `pi.dispatch` binding through the `DispatchDeps` mechanism, so a background task holds a
 * slot for its whole lifetime (ADR-0022 §9) and the dispatcher must not double-acquire it.
 *
 * Gap 4: the run id (callerId / subscriber) and the session dir must travel
 * BindingContext -> dispatch binding -> DispatchContext (ADR-0022 §5 / R1).
 *
 * The first test drives the REAL `createBuiltinBindings` dispatch binding with a mock
 * lifecycle, an in-memory registry and an in-memory output store, so no `pi` process and no
 * task-output fs is touched. The other two run the real dispatcher with a stand-in
 * `pi.dispatch` binding that records the context it was handed.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  DISPATCH_BINDING_NAME,
  createBuiltinBindings,
  type BindingContext,
} from "../../src/runtime/bindings.ts";
import { DispatchSlotCounter, type DispatchDeps } from "../../src/runtime/dispatch.ts";
import {
  MockChildProcessLifecycle,
  type ChildHandle,
  type ChildSpawnOptions,
} from "../../src/runtime/child-process-lifecycle.ts";
import {
  createTaskRegistry,
  type DispatchHandle,
  type TaskRegistry,
} from "../../src/runtime/task-registry.ts";
import { InMemoryOutputStorage } from "../../src/runtime/output-storage.ts";
import {
  InMemoryTaskStorage,
  type TaskRecord,
  type TaskStatus,
  type ULID,
} from "../../src/runtime/task-storage.ts";
import { runPtcProgram } from "../../src/runtime/dispatcher.ts";
import { createPtcRunCodeTool } from "../../src/tools/run-code.ts";
import { createBackgroundTaskRuntime } from "../../src/runtime/background-runtime.ts";
import {
  installRecordingPi,
  makeBindings,
  makeTempDir,
  removeTempDir,
  toolContext,
} from "../helpers/ptc.ts";

const AGENT = "wiring-probe";
const AGENT_MD = "---\nname: wiring-probe\n---\nYou are wired.\n";
/** Canonical ULID literal (Crockford base32) used as the parent task id. */
const PARENT_TASK = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as ULID;
/**
 * The cap's refusal message, written out rather than imported from
 * `src/runtime/dispatch.ts`: a test that reads the production constant cannot notice the
 * constant changing, and this is the string the model is told (constraint 4 -- the expected
 * value is a literal, not the thing under test).
 */
const LIMIT_MESSAGE = "dispatch concurrency limit reached";

const TERMINAL: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "succeeded",
  "failed",
  "canceled",
  "lost",
]);

class RecordingLifecycle extends MockChildProcessLifecycle {
  readonly spawned: ChildHandle[] = [];

  override spawn(argv: readonly string[], opts: ChildSpawnOptions): ChildHandle {
    const handle = super.spawn(argv, opts);
    this.spawned.push(handle);
    return handle;
  }
}

function firstHandle(lifecycle: RecordingLifecycle): ChildHandle {
  const handle = lifecycle.spawned[0];
  if (handle === undefined) throw new Error("RecordingLifecycle: no spawned handle");
  return handle;
}

async function waitForTerminal(storage: InMemoryTaskStorage, taskId: ULID): Promise<TaskRecord> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const record = await storage.loadTask(taskId);
    if (record !== null && TERMINAL.has(record.status)) return record;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("task " + taskId + " did not reach a terminal state");
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

describe("bindings.ts forwards DispatchContext + DispatchDeps (Gap 2 + Gap 4)", () => {
  test("a background dispatch through the real binding holds the injected counter and carries callerId/sessionDir", async () => {
    await withAgent(async (dir) => {
      const storage = new InMemoryTaskStorage();
      const registry: TaskRegistry = createTaskRegistry(storage, { clock: () => 1000 });
      const lifecycle = new RecordingLifecycle();
      const outputStorage = new InMemoryOutputStorage();
      const slots = new DispatchSlotCounter(4);
      const deps: DispatchDeps = {
        taskRegistry: registry,
        lifecycle,
        slots,
        clock: () => 1000,
        outputStorage,
      };
      const table = createBuiltinBindings({ cwd: dir, includeDispatch: true });
      const binding = table.get(DISPATCH_BINDING_NAME);
      if (binding === undefined) throw new Error("pi.dispatch binding is missing");

      const result = await binding.execute(
        { agent: AGENT, task: "wired", background: true, agentScope: "project" },
        {
          callId: 9,
          depth: 0,
          maxDispatchDepth: 3,
          callerId: "run-1",
          sessionDir: "/sessions/s1",
          dispatchDeps: deps,
        },
      );
      if (result === null || typeof result !== "object" || !("taskId" in result)) {
        throw new Error("expected a DispatchHandle from the background binding");
      }
      const handle = result as DispatchHandle;

      // The real binding reached the injected deps: one child, one held slot (ADR-0022 §9).
      expect(lifecycle.spawnCount).toBe(1);
      expect(slots.active).toBe(1);
      const opts = lifecycle.getRecordedOpts(firstHandle(lifecycle));
      expect(opts.sessionDir).toBe("/sessions/s1");
      expect(opts.sessionId).toBe(handle.taskId);
      expect(opts.sessionName).toBe("bgdispatch:" + handle.taskId);

      const record = await storage.loadTask(handle.taskId);
      expect(record?.spawnSource).toEqual({ kind: "ptc-program", callerId: "run-1" });

      // Terminal transition releases the slot (ADR-0022 §9). The child answers first: an
      // exit-0 child with no assistant text is `failed` (issue #70).
      lifecycle.pushEvent(firstHandle(lifecycle), {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "PONG" }] },
      });
      lifecycle.resolveExit(firstHandle(lifecycle), 0, null);
      const terminal = await waitForTerminal(storage, handle.taskId);
      expect(terminal.status).toBe("succeeded");
      expect(slots.active).toBe(0);
    });
  });
});

describe("dispatcher.ts threads the per-run counter + session identity (Gap 2 + Gap 4)", () => {
  test("passes callerId=runId, the session dir and one shared DispatchSlotCounter", async () => {
    const contexts: BindingContext[] = [];
    const bindings = makeBindings({
      [DISPATCH_BINDING_NAME]: async (_args, context) => {
        contexts.push(context);
        return { ok: true };
      },
    });
    const outcome = await runPtcProgram({
      code:
        "const r1 = await tools['pi.dispatch']({agent:'a',task:'t1'});\n" +
        "const r2 = await tools['pi.dispatch']({agent:'a',task:'t2'});\n" +
        "return [r1.ok, r2.ok];",
      surface: "run_code",
      cwd: process.cwd(),
      bindings,
      runId: "run-42",
      sessionDir: "/sessions/s7",
    });

    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toEqual([true, true]);
    expect(contexts).toHaveLength(2);
    expect(contexts[0]?.callerId).toBe("run-42");
    expect(contexts[1]?.callerId).toBe("run-42");
    expect(contexts[0]?.sessionDir).toBe("/sessions/s7");
    expect(contexts[1]?.sessionDir).toBe("/sessions/s7");

    const firstSlots = contexts[0]?.dispatchDeps?.slots;
    const secondSlots = contexts[1]?.dispatchDeps?.slots;
    expect(firstSlots).toBeInstanceOf(DispatchSlotCounter);
    // ONE counter per run, shared across every dispatch call (ADR-0022 §9).
    expect(secondSlots).toBe(firstSlots);
    // Foreground calls resolve before release, so the counter is back to 0 (ADR-0016 §2).
    expect((firstSlots as DispatchSlotCounter).active).toBe(0);
  });

  test("does not pre-acquire a slot for a background dispatch; the background branch owns it", async () => {
    let activeDuringBackgroundCall = -1;
    const bindings = makeBindings({
      [DISPATCH_BINDING_NAME]: async (_args, context) => {
        const slots = context.dispatchDeps?.slots;
        activeDuringBackgroundCall = slots instanceof DispatchSlotCounter ? slots.active : -2;
        return { taskId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", label: "l", status: "running" };
      },
    });
    const outcome = await runPtcProgram({
      code:
        "const h = await tools['pi.dispatch']({agent:'a',task:'t',background:true});\n" +
        "return h.taskId;",
      surface: "run_code",
      cwd: process.cwd(),
      bindings,
    });

    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    // The dispatcher skipped tryAcquire for the background call, so the shared counter was
    // at 0 while the binding ran; dispatchBackground acquires it for the child's lifetime.
    expect(activeDuringBackgroundCall).toBe(0);
  });

  test("an injected session counter wins over the per-run default for a background branch", async () => {
    await withAgent(async (dir) => {
      const storage = new InMemoryTaskStorage();
      const registry: TaskRegistry = createTaskRegistry(storage, { clock: () => 1000 });
      const lifecycle = new RecordingLifecycle();
      const outputStorage = new InMemoryOutputStorage();
      const injected = new DispatchSlotCounter(4);
      const bindings = createBuiltinBindings({ cwd: dir, includeDispatch: true });

      const outcome = await runPtcProgram({
        code:
          "const h = await tools['pi.dispatch']({agent:'" +
          AGENT +
          "',task:'injected',background:true,agentScope:'project'});\n" +
          "return h.taskId;",
        surface: "run_code",
        cwd: dir,
        bindings,
        runId: "run-injected",
        // ADR-0022 §9 / BG-14: a session-supplied counter must not be clobbered by the per-run
        // default. Removing the `?? dispatchSlots` fix leaves this counter at 0.
        dispatchDeps: {
          taskRegistry: registry,
          lifecycle,
          slots: injected,
          clock: () => 1000,
          outputStorage,
        },
      });

      expect(outcome.error).toBeUndefined();
      expect(injected.active).toBe(1);
      // The injected slot is the one the background branch acquired, and the terminal
      // transition releases it (ADR-0022 §9). The child answers first: an exit-0 child with
      // no assistant text is `failed` (issue #70).
      lifecycle.pushEvent(firstHandle(lifecycle), {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "PONG" }] },
      });
      lifecycle.resolveExit(firstHandle(lifecycle), 0, null);
      const taskId = outcome.value as ULID;
      const terminal = await waitForTerminal(storage, taskId);
      expect(terminal.status).toBe("succeeded");
      expect(injected.active).toBe(0);
    });
  });

  test("omits sessionDir when the run has none, still carrying the run id", async () => {
    const contexts: BindingContext[] = [];
    const bindings = makeBindings({
      [DISPATCH_BINDING_NAME]: async (_args, context) => {
        contexts.push(context);
        return { ok: true };
      },
    });
    const outcome = await runPtcProgram({
      code: "return (await tools['pi.dispatch']({agent:'a',task:'t'})).ok;",
      surface: "run_code",
      cwd: process.cwd(),
      bindings,
      runId: "run-43",
    });

    expect(outcome.value).toBe(true);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.sessionDir).toBeUndefined();
    expect(contexts[0]?.callerId).toBe("run-43");
  });
});

// ---------------------------------------------------------------------------
//  parentTaskId end-to-end wire (reopen R-m12)
// ---------------------------------------------------------------------------

describe("parentTaskId reaches the nested TaskRecord (reopen R-m12)", () => {
  test("the real dispatch binding stamps BindingContext.parentTaskId onto the record", async () => {
    await withAgent(async (dir) => {
      const storage = new InMemoryTaskStorage();
      const registry: TaskRegistry = createTaskRegistry(storage, { clock: () => 1000 });
      const lifecycle = new RecordingLifecycle();
      const slots = new DispatchSlotCounter(4);
      const table = createBuiltinBindings({ cwd: dir, includeDispatch: true });
      const binding = table.get(DISPATCH_BINDING_NAME);
      if (binding === undefined) throw new Error("pi.dispatch binding is missing");

      const result = await binding.execute(
        { agent: AGENT, task: "nested", background: true, agentScope: "project" },
        {
          callId: 11,
          depth: 0,
          maxDispatchDepth: 3,
          callerId: "run-parent",
          parentTaskId: PARENT_TASK,
          dispatchDeps: { taskRegistry: registry, lifecycle, slots, clock: () => 1000 },
        },
      );
      if (result === null || typeof result !== "object" || !("taskId" in result)) {
        throw new Error("expected a DispatchHandle from the background binding");
      }
      const handle = result as DispatchHandle;

      const record = await storage.loadTask(handle.taskId);
      expect(record?.parentTaskId).toBe(PARENT_TASK);
      lifecycle.resolveExit(firstHandle(lifecycle), 0, null);
      await waitForTerminal(storage, handle.taskId);
    });
  });

  test("runPtcProgram threads parentTaskId through a nested background dispatch", async () => {
    await withAgent(async (dir) => {
      const storage = new InMemoryTaskStorage();
      const registry: TaskRegistry = createTaskRegistry(storage, { clock: () => 1000 });
      const lifecycle = new RecordingLifecycle();
      const slots = new DispatchSlotCounter(4);
      const outcome = await runPtcProgram({
        code:
          "const h = await tools['pi.dispatch']({agent:'" +
          AGENT +
          "',task:'nested',background:true,agentScope:'project'});\n" +
          "return h.taskId;",
        surface: "run_code",
        cwd: dir,
        bindings: createBuiltinBindings({ cwd: dir, includeDispatch: true }),
        runId: "run-nested",
        parentTaskId: PARENT_TASK,
        dispatchDeps: { taskRegistry: registry, lifecycle, slots, clock: () => 1000 },
      });

      expect(outcome.error).toBeUndefined();
      const taskId = outcome.value as ULID;
      const record = await storage.loadTask(taskId);
      expect(record?.parentTaskId).toBe(PARENT_TASK);
      lifecycle.resolveExit(firstHandle(lifecycle), 0, null);
      await waitForTerminal(storage, taskId);
    });
  });

  test("the ptc_run_code tool forwards PtcToolOptions.parentTaskId to runPtcProgram", async () => {
    await withAgent(async (dir) => {
      const lifecycle = new RecordingLifecycle();
      const runtime = createBackgroundTaskRuntime({ createLifecycle: () => lifecycle });
      const tool = createPtcRunCodeTool({
        getBindingSourceNames: () => [],
        getDispatchDeps: () => runtime.dispatchDeps,
        parentTaskId: PARENT_TASK,
      });

      const result = (await tool.execute(
        "call-parent",
        {
          code:
            "const h = await tools['pi.dispatch']({agent:'" +
            AGENT +
            "',task:'nested',background:true,agentScope:'project'});\n" +
            "return h.taskId;",
          description: "nested dispatch parent wire",
        },
        undefined,
        undefined,
        toolContext(dir),
      )) as { details: { result?: unknown } };

      const taskId = result.details.result as ULID;
      const record = await runtime.registry.get(taskId);
      expect(record?.parentTaskId).toBe(PARENT_TASK);
      lifecycle.resolveExit(firstHandle(lifecycle), 0, null);
    });
  });
});

// ---------------------------------------------------------------------------
//  ONE acquire per foreground dispatch (reopen the round-3 concurrency finding)
// ---------------------------------------------------------------------------

/**
 * What one foreground `pi.dispatch` call returned, flattened to the three fields the
 * admission question is about. `started: false` plus the concurrency message is the gate
 * refusing; anything with `started: true` really put a child on the machine.
 */
interface AdmissionRecord {
  started: boolean;
  status: string;
  error: string;
}

describe("the per-run counter is charged once per foreground dispatch (reopen round 3)", () => {
  /**
   * The gap this closes, stated as a counterfactual rather than as a claim.
   *
   * Round 3 moved the dispatch cap INTO `dispatch()` and removed the duplicate acquire at
   * the dispatcher's own call site, and the ledger recorded "the dispatcher's duplicate went
   * away" as FIXED. Round 4 measured that row as unpinned: re-adding a foreground-only
   * acquire+release at the dispatcher's call site left the whole suite green, and so did
   * restoring the pre-fix split. Nothing could see it because the two halves that would have
   * seen it each look somewhere else -- the dispatcher-level tests hand `runPtcProgram` a
   * stand-in `pi.dispatch` binding, so they never reach `dispatch()`'s acquire at all, and
   * `tests/unit/ptc-subagent.test.ts` calls `dispatch()` with no dispatcher in the picture.
   *
   * So this is the black-box shape neither of those files can be: a REAL program, the REAL
   * dispatch binding, the run's own counter sized by `dispatchConcurrency`, and a burst
   * wider than the cap. The number of children that actually came up is the assertion.
   *
   * The foreground branch spawns through the module-level `DISPATCH_LIFECYCLE` and never
   * reads `deps.lifecycle`, so no lifecycle double can be injected from here (that is the
   * seam the round-4 review asked about, and it is a production-side gap, not a test-side
   * one). `installRecordingPi` observes the same fact from outside: `dispatch()` spawns the
   * command `"pi"` with the inherited environment, so a real `pi`-named program first on
   * PATH records the spawns the production path really performs.
   *
   * A duplicate acquire cannot show up in this test as a *smaller* number than the cap alone
   * would allow -- it shows up as exactly half of it: two slots per call means two admitted
   * calls out of a pool of four. Measured: HEAD admits 4, the duplicate admits 2.
   */
  test("a burst wider than dispatchConcurrency admits exactly that many foreground children", async () => {
    // Long enough that every admitted child is still running when the sixth call asks for a
    // slot, so the count is an admission measurement rather than a race against startup.
    const pi = await installRecordingPi({ holdMs: 1_500 });
    try {
      await withAgent(async (dir) => {
        const outcome = await runPtcProgram({
          code:
            "const call = (i) => tools['pi.dispatch']({agent:'" +
            AGENT +
            "',task:'wave ' + i,agentScope:'project'});\n" +
            "const rs = await Promise.all([0,1,2,3,4,5].map((i) => call(i)));\n" +
            "return rs.map((r) => ({started: r.started === true, status: String(r.status)," +
            " error: String(r.errorMessage === undefined ? '' : r.errorMessage)}));",
          surface: "run_code",
          cwd: dir,
          bindings: createBuiltinBindings({ cwd: dir, includeDispatch: true }),
          config: { dispatchConcurrency: 4 },
        });

        expect(outcome.error, "the run itself completed").toBeUndefined();
        const results = outcome.value as unknown as AdmissionRecord[];
        expect(results, "all six calls answered").toHaveLength(6);

        const admitted = results.filter((r) => r.started);
        const refused = results.filter((r) => r.error.includes(LIMIT_MESSAGE));
        expect(
          admitted.length,
          "four of six concurrent foreground calls got a child; two did not",
        ).toBe(4);
        expect(
          refused.length,
          "the other two were refused by the gate, with the dispatcher's own message",
        ).toBe(2);
        expect(
          results.every((r) => (r.started ? r.error === "" : r.error === LIMIT_MESSAGE)),
          "every call is one of those two outcomes: none failed some other way",
        ).toBe(true);
        expect(
          admitted.map((r) => r.status),
          "each admitted child ran to completion and returned its text",
        ).toEqual(["fulfilled", "fulfilled", "fulfilled", "fulfilled"]);

        // The same number, counted on the machine rather than inferred from the results: this
        // is the observation a double could not make. Four children, four DIFFERENT tasks --
        // so it is four calls that spawned, not one call spawned four times.
        const spawns = await pi.spawns();
        expect(spawns.length, "exactly four children were actually launched").toBe(4);
        expect(
          new Set(spawns.map((argv) => argv[argv.length - 1])).size,
          "each from a different dispatch, so no single call spawned twice",
        ).toBe(4);
      });
    } finally {
      await pi.restore();
    }
  }, 60_000);
});
