/**
 * `ptc_subagent` (ADR-0025, ticket #90). The top-level front over the same `dispatch()` the
 * `pi.dispatch` binding uses, so a session whose orchestration is pi's `codemode` can still
 * start a managed subagent.
 *
 * No real `pi` process is spawned here: `MockChildProcessLifecycle` and an in-memory task
 * storage stand in, the same seam `tests/unit/dispatch-background.test.ts` uses, so the
 * lifecycle assertions are about OUR wiring rather than about a child's timing.
 */
import { describe, expect, test } from "vitest";
import { MockChildProcessLifecycle } from "../../src/runtime/child-process-lifecycle.ts";
import type {
  ChildExitValue,
  ChildHandle,
  ChildSpawnOptions,
} from "../../src/runtime/child-process-lifecycle.ts";
import type { DispatchDeps, DispatchInput } from "../../src/runtime/dispatch.ts";
import type { Static } from "typebox";
import { DISPATCH_PARAMETERS } from "../../src/runtime/bindings.ts";
import { DEFAULT_CONFIG } from "../../src/runtime/limits.ts";
import { createBackgroundTaskRuntime } from "../../src/runtime/background-runtime.ts";
import { DispatchSlotCounter, dispatch, setPromptFileWriter } from "../../src/runtime/dispatch.ts";
import { createPtcSubagentTool } from "../../src/tools/subagent.ts";
import { createTaskRegistry, type TaskRegistry } from "../../src/runtime/task-registry.ts";
import { InMemoryTaskStorage } from "../../src/runtime/task-storage.ts";
import type { ULID } from "../../src/runtime/task-storage.ts";
import { installRecordingPi, makeTempDir, removeTempDir, waitFor } from "../helpers/ptc.ts";

// A REAL registered agent, not one this file invents. The agent registry is read from the
// host config and does not see a markdown file written into a temp dir, so a locally authored
// fixture takes the unknown-agent path and proves nothing about the spawn path. pi ships a
// smoke-test agent; named explicitly so a future pi that drops it turns this red rather than
// quietly skipping the assertion (testing constraint 2: fixtures come from a real sample).
const AGENT = "__smoke_echo";
/** A canonical ULID: this process is itself a background task in the spawn test below. */
const PARENT_TASK = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as ULID;

/**
 * The mock lifecycle plus a record of what it was asked to launch. A spawn the test cannot see
 * is a spawn the test cannot assert on, and the spawn direction of the IO boundary is the one
 * the accept-both version of this file was quietly not checking.
 */
class RecordingLifecycle extends MockChildProcessLifecycle {
  /**
   * The spawn REQUESTS, not just the handles. A handle on its own cannot tell a correct call
   * from one that dropped the parent task id or ran in the wrong directory -- both of which
   * stayed green in review round 2, for the same reason the tautology in S5 did: the observation
   * sat next to the code rather than on what the code did.
   */
  readonly requests: { argv: readonly string[]; opts: ChildSpawnOptions }[] = [];

  /** Armed by {@link failNextExit}; consumed by the first `exit()` that runs after it. */
  private exitFailure: Error | undefined;

  /**
   * Make the next `exit()` reject, so the caller's failure handling is observable. The base mock
   * has no rejecting-exit control, which is why the constraint-3 log on the foreground `exit()` had
   * no test: there was no way to make that call fail. Round 6 finding 2.
   */
  failNextExit(error: Error): void {
    this.exitFailure = error;
  }

  override spawn(argv: readonly string[], opts: ChildSpawnOptions): ChildHandle {
    this.requests.push({ argv, opts });
    const handle = super.spawn(argv, opts);
    this.spawned.push(handle);
    return handle;
  }

  /** One-shot: the next `exit()` rejects with this error, then the mock behaves normally. */
  override exit(handle: ChildHandle): Promise<ChildExitValue> {
    const failure = this.exitFailure;
    if (failure !== undefined) {
      this.exitFailure = undefined;
      return Promise.reject(failure);
    }
    return super.exit(handle);
  }

  readonly spawned: ChildHandle[] = [];

  /** The handle for spawn `index`, or a loud failure (no unchecked-index silencing). */
  handleAt(index: number): ChildHandle {
    const handle = this.spawned[index];
    if (handle === undefined) {
      throw new Error("RecordingLifecycle: no spawned handle at index " + String(index));
    }
    return handle;
  }

  /** How many children were launched. */
  get spawnCount(): number {
    return this.requests.length;
  }
}

/** The extra surface the runtime's tracking adapter adds on top of the adapter contract. */
interface ChildProcessLifecycleWithLive {
  liveHandles(): readonly unknown[];
  isLive(handle: unknown): boolean;
}

interface Harness {
  registry: TaskRegistry;
  deps: DispatchDeps;
  lifecycle: RecordingLifecycle;
}

function createHarness(): Harness {
  const storage = new InMemoryTaskStorage();
  const clock = (): number => 1000;
  const registry = createTaskRegistry(storage, { clock });
  const lifecycle = new RecordingLifecycle();
  const slots = new DispatchSlotCounter(8);
  return { registry, lifecycle, deps: { taskRegistry: registry, lifecycle, slots, clock } };
}

/** A scratch cwd for the dispatch's `cwd`, with nothing in it -- the agent comes from the host registry. */
async function withAgent<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await makeTempDir();
  try {
    return await body(dir);
  } finally {
    await removeTempDir(dir);
  }
}

/**
 * pi's Tool.execute takes five arguments; a two-argument call type-checks against a stub and
 * fails against the real signature, so every call in this file goes through one helper.
 */
/**
 * Compile-time: the binding's schema and its `DispatchInput` type describe the SAME shape.
 * A runtime comparison of the two schema objects cannot see drift -- the tool is handed the same
 * object, so it is an identity check -- but this one cannot: adding a field to the type without
 * adding it to the schema, or the reverse, fails the build rather than the suite.
 */
type SchemaKeys = keyof Static<typeof DISPATCH_PARAMETERS>;
type TypeKeys = keyof DispatchInput;
export type _SchemaMatchesType = [SchemaKeys] extends [TypeKeys]
  ? [TypeKeys] extends [SchemaKeys]
    ? true
    : never
  : never;
const _schemaMatchesType: _SchemaMatchesType = true;
void _schemaMatchesType;

async function run<T>(
  tool: { execute: (...args: never[]) => Promise<T> },
  params: unknown,
): Promise<T> {
  return await tool.execute(
    "call" as never,
    params as never,
    undefined as never,
    undefined as never,
    undefined as never,
  );
}

const baseOptions = (dir: string, deps: DispatchDeps) => ({
  cwd: dir,
  depth: 0,
  maxDispatchDepth: DEFAULT_CONFIG.maxDispatchDepth,
  getDispatchDeps: () => deps,
});

describe("ptc_subagent", () => {
  test("a background call spawns a child and hands back a task id the model can use", async () => {
    // Spec testing decision: the IO boundary has BOTH directions, and the spawn direction is
    // the one that matters here. The earlier version wrapped the call in try/catch and
    // branched on the outcome -- an accept-both that stayed green when execute was made to
    // refuse unconditionally, i.e. when the tool could never spawn anything.
    //
    // The agent is a real registered one rather than a file this test writes, because the host
    // registry does not see a markdown in a temp dir. The CHILD is the mock lifecycle, so no
    // real pi is launched and the spawn is recorded rather than inferred.
    await withAgent(async (dir) => {
      const h = createHarness();
      const tool = createPtcSubagentTool({
        ...baseOptions(dir, h.deps),
        parentTaskId: PARENT_TASK,
      });
      const result = (await run(tool, {
        agent: AGENT,
        task: "look at the tests",
        background: true,
      })) as {
        content: { type: string; text: string }[];
        details: { taskId?: string; status?: string };
      };
      const taskId = result.details.taskId;
      expect(taskId, "a background call resolves with a task id").toBeDefined();
      expect(
        result.content[0]?.text ?? "",
        "the model is told the id, not left to find it in a details object",
      ).toContain(taskId as string);
      expect(result.details.status, "and told this is a background task").toBe("background");
      expect(h.lifecycle.spawnCount, "exactly one child was launched").toBe(1);
      // WHAT was launched, not merely that something was. Both mutations below -- dropping the
      // parent task id, and running the child in process.cwd() instead of the call's cwd --
      // were green in review round 2, because the recording kept the handle and dropped the
      // request.
      expect(
        h.lifecycle.requests[0]?.opts.cwd,
        "the child runs in the call's cwd, not the extension host's",
      ).toBe(dir);
      // The parent's link lives on the TaskRecord, not the child's env: the env carries the
      // child's OWN id, which is how the pump finds itself later.
      const record = await h.registry.get(taskId as ULID);
      expect(
        record?.parentTaskId,
        "a subagent-spawned child is nested under this process's own task",
      ).toBe(PARENT_TASK);
    });
  });

  test("a refused call throws with the dispatcher's own message, never silently", async () => {
    // IO boundary, failure direction (constraint 1 and 3). An unregistered agent is the
    // refusal the dispatcher already knows how to word; this test pins that the front
    // surfaces it as a visible error rather than resolving to something success-shaped.
    await withAgent(async (dir) => {
      const h = createHarness();
      const tool = createPtcSubagentTool(baseOptions(dir, h.deps));
      let message = "";
      try {
        await run(tool, { agent: "no-such-agent", task: "anything" });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message, "the refusal names the tool").toContain("ptc_subagent");
      expect(message, "and names the agent that was asked for").toContain("no-such-agent");
    });
  });

  test("a depth-exhausted call is refused rather than spawning one more pi", async () => {
    // maxDispatchDepth is the dispatcher's rule, not this tool's. Proving the front inherits
    // it is what stops the two call sites drifting into different recursion policies.
    await withAgent(async (dir) => {
      const h = createHarness();
      const tool = createPtcSubagentTool({
        ...baseOptions(dir, h.deps),
        depth: DEFAULT_CONFIG.maxDispatchDepth,
      });
      let message = "";
      try {
        await run(tool, { agent: AGENT, task: "one level too deep" });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message, "the depth ceiling is reported").toContain("ptc_subagent");
      expect(
        h.registry.query !== undefined,
        "the registry is wired, so a spawn would have been recorded",
      ).toBe(true);
    });
  });

  test("the argument schema is the binding's, not a second copy", async () => {
    // Spec decision 5. If a field is added to the binding and not here, the top-level tool
    // would silently accept calls the binding cannot serve.
    const { DISPATCH_PARAMETERS } = await import("../../src/runtime/bindings.ts");
    const tool = createPtcSubagentTool(baseOptions(".", {}));
    const declared = Object.keys((tool.parameters as { properties?: object }).properties ?? {});
    const real = Object.keys((DISPATCH_PARAMETERS as { properties?: object }).properties ?? {});
    // Identity, on purpose: the tool IS handed the binding's schema object, so a comparison of
    // the two key LISTS can only ever agree. That is the point -- the tool cannot drift from the
    // binding. The check with teeth is the compile-time one above, which compares the schema to
    // the `DispatchInput` TYPE rather than the schema to itself.
    expect(
      (tool.parameters as unknown) === (DISPATCH_PARAMETERS as unknown),
      "the tool is handed the binding schema, not a copy of it",
    ).toBe(true);
    expect(declared).toEqual(real);
    expect(declared, "and it is not empty").toContain("agent");
    expect(declared).toContain("task");
    expect(declared).toContain("background");
  });
});

describe("ptc_subagent and the dispatch cap", () => {
  test("a saturated counter refuses a foreground call instead of spawning one", async () => {
    // The defect this closes: the only slot acquire lived at the dispatcher's program call site,
    // which ptc_subagent bypasses. Measured before the fix -- with every slot held the call
    // reached lifecycle.spawn and reported a spawn failure, never a concurrency refusal.
    //
    // "No child was launched" is observed through `installRecordingPi`, not through
    // `h.lifecycle`. Round 4 measured the mock version of that line to be vacuous: the
    // FOREGROUND branch of `dispatch()` spawns through the module-level `DISPATCH_LIFECYCLE`
    // and never reads `deps.lifecycle`, so the mock recorded nothing either way and making
    // its `spawn` throw left this test green. The background test above can still use the mock
    // -- `dispatchBackground` really does honour `deps.lifecycle` -- but this one cannot, and
    // there is no test-side seam that would make it able to.
    const pi = await installRecordingPi();
    try {
      await withAgent(async (dir) => {
        const h = createHarness();
        const slots = new DispatchSlotCounter(1);
        slots.tryAcquire("someone-else");
        const tool = createPtcSubagentTool({
          ...baseOptions(dir, h.deps),
          getDispatchDeps: () => ({ ...h.deps, slots }),
        });
        let message = "";
        try {
          await run(tool, { agent: AGENT, task: "no slot is free" });
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        expect(message, "the gate, not a spawn failure").toContain(
          "dispatch concurrency limit reached",
        );
        expect(
          (await pi.settle()).length,
          "and no child was launched -- waited for the log to settle, because a spawn that " +
            "happened anyway would land in it after this call returned",
        ).toBe(0);
        expect(slots.active, "a refusal must not consume a slot").toBe(1);
      });
    } finally {
      await pi.restore();
    }
  });

  test("the same foreground call with a free slot does launch a child", async () => {
    // The contrast that makes the count above worth anything. A fixture that can only ever report
    // zero pins nothing, and that is exactly what the old mock was: with its `spawn` replaced by a
    // throw, the saturated-counter test still passed. Here the identical setup with one free slot
    // must record a real spawn, so "zero children" above is the gate refusing rather than the
    // harness never looking.
    //
    // Round 5 made this possible without a PATH: the foreground branch now honours the injected
    // lifecycle, so the mock is the thing under observation instead of a wrapper around a real child.
    await withAgent(async (dir) => {
      const h = createHarness();
      const tool = createPtcSubagentTool(baseOptions(dir, h.deps));
      const settled = run(tool, { agent: AGENT, task: "a free slot" }).catch(() => undefined);
      await waitFor(() => h.lifecycle.spawnCount > 0);
      // Exit 0 with no assistant text, so the dispatch REJECTS ("no final text") and the tool
      // throws. That is irrelevant here and deliberately not asserted: this test is about whether a
      // child was launched, and the rejection is what proves the mock was driven rather than left
      // hanging.
      h.lifecycle.resolveExit(h.lifecycle.handleAt(0), 0, null);
      await settled;
      expect(h.lifecycle.spawnCount, "a foreground call with a free slot really spawns").toBe(1);
    });
  });

  test("a closed foreground child does not stay in the session's live set", async () => {
    // Round 5 finding 1, and the reason this test uses a REAL session runtime.
    //
    // `MockChildProcessLifecycle` has no live set, so a mock-driven test is structurally incapable
    // of seeing this class of bug: the leak lived in `TrackingLifecycle`, which only the runtime
    // constructs. Measured before the fix: three foreground dispatches left three live handles,
    // and `shutdown()` then arms a SIGTERM->SIGKILL ladder against every one of them with an
    // `isDone` that is permanently true -- the A4 hazard the reap-cancel exists to prevent.
    //
    // So: the real runtime, with only the child-process adapter faked. Registry, slots and the
    // tracking wrapper are all production.
    await withAgent(async (dir) => {
      const adapter = new RecordingLifecycle();
      const runtime = createBackgroundTaskRuntime({ createLifecycle: () => adapter });
      // `dispatchDeps.lifecycle` is typed as the adapter contract; the tracking wrapper the runtime
      // installs is a superset, and the whole point is to observe the part the contract does not
      // declare -- which is exactly why a mock could not have caught this.
      const live = runtime.dispatchDeps.lifecycle as unknown as ChildProcessLifecycleWithLive;

      for (let i = 0; i < 3; i += 1) {
        const settled = dispatch(
          { agent: AGENT, task: "live set probe " + i },
          { callId: i, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          runtime.dispatchDeps,
        ).catch(() => undefined);
        await waitFor(() => adapter.spawnCount > i);
        adapter.resolveExit(adapter.handleAt(i), 0, null);
        await settled;
      }

      expect(adapter.spawnCount, "the three children really were launched").toBe(3);
      // Polled, not sampled: `finalize` is synchronous and the prune is fire-and-forget, so the
      // delete lands a turn or two after `dispatch()` resolves. Sampling once would be a race that
      // passes by luck; polling is what makes this a claim about the steady state.
      await waitFor(() => live.liveHandles().length === 0);
      expect(
        live.liveHandles(),
        "every closed foreground child was retired from the session's live set",
      ).toEqual([]);
    });
  });

  test("a throw between the slot acquire and the spawn gives the slot back", async () => {
    // Round 5 finding 2: the round-4 R4-1 row is marked FIXED and nothing held it. Removing the
    // `slots.release()` in the catch left all 872 tests green.
    //
    // The two obvious ways to make the prompt writer throw both fail as tests. A TMPDIR pointed at
    // a file breaks EVERY temp-dir-using test in tests/unit/ at once, so it cannot isolate this
    // path; and the writer was module-level, so nothing could be aimed at one call. Hence the seam.
    //
    // The severity driver, which is why this is not a tidy-up: this counter is the SESSION one.
    // Eight such failures and the session can never dispatch again, with no error anywhere.
    await withAgent(async (dir) => {
      const h = createHarness();
      const slots = new DispatchSlotCounter(4);
      let threw = false;
      setPromptFileWriter(() => Promise.reject(new Error("injected: mkdtemp failed")));
      try {
        await dispatch(
          { agent: AGENT, task: "never gets to spawn" },
          { callId: 1, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          { ...h.deps, slots },
        ).catch(() => {
          threw = true;
        });
      } finally {
        setPromptFileWriter(undefined);
      }
      expect(threw, "the injected failure really happened").toBe(true);
      expect(slots.active, "the slot came back, so the next dispatch can still have one").toBe(0);
    });
  });

  test("the same call succeeds once the writer is restored", async () => {
    // The other half, and the one that catches a fix which releases by never acquiring: if the
    // seam were left overridden, every later dispatch in this file would fail for a reason that has
    // nothing to do with what these tests are about.
    await withAgent(async (dir) => {
      const h = createHarness();
      const slots = new DispatchSlotCounter(1);
      const settled = dispatch(
        { agent: AGENT, task: "writer restored" },
        { callId: 1, cwd: dir, depth: 0, maxDispatchDepth: 3 },
        { ...h.deps, slots },
      ).catch(() => undefined);
      await waitFor(() => h.lifecycle.spawnCount > 0);
      h.lifecycle.resolveExit(h.lifecycle.handleAt(0), 0, null);
      await settled;
      expect(h.lifecycle.spawnCount, "the real writer ran and a child was launched").toBe(1);
    });
  });

  test("a throw between the KEYED slot acquire and the spawn gives the reservation back", async () => {
    // Round 6 finding 1, and the mirror of the test above. The background catch's release is the
    // worse of the two to lose: the reservation is keyed by task id, and the only two things that
    // ever release it are the pump's terminal transition and `shutdown` -- neither of which fires
    // for a task that died on the spawn/registration/IO path. Drop the release and the reservation
    // is gone for the life of the session.
    //
    // Measured before this test existed: removing `slots.release(taskId)` from that catch left the
    // whole 875-test suite green.
    await withAgent(async (dir) => {
      const h = createHarness();
      const slots = new DispatchSlotCounter(4);
      setPromptFileWriter(() => Promise.reject(new Error("injected: mkdtemp failed")));
      let outcome: unknown;
      try {
        outcome = await dispatch(
          { agent: AGENT, task: "never gets to spawn", background: true },
          { callId: 1, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          { ...h.deps, slots },
        );
      } finally {
        setPromptFileWriter(undefined);
      }

      // ADR-0016 section 3: the binding never throws, so a failure is a settled rejection, not a
      // raise. Asserting the shape is part of the claim -- a throw here would be a different bug.
      const rejected = outcome as { status?: string; errorMessage?: string; taskId?: string };
      expect(rejected.status, "a settled rejection, not a throw").toBe("rejected");
      expect(rejected.errorMessage).toContain("injected");
      expect(rejected.taskId, "and no handle, because nothing was spawned").toBeUndefined();
      expect(
        slots.active,
        "the KEYED reservation came back; nothing else would ever release it",
      ).toBe(0);
    });
  });

  test("a failing exit() is reported, not swallowed", async () => {
    // Round 6 finding 2. The `logger.warn` I added when I changed a silent `.catch` to a reported
    // one had no witness: reverting it left 875 tests green, which makes a log no test observes
    // indistinguishable from the silent catch it replaced. Constraint 3 is about exactly that shape.
    await withAgent(async (dir) => {
      const h = createHarness();
      h.lifecycle.failNextExit(new Error("injected: exit blew up"));
      const warnings: string[] = [];
      const settled = dispatch(
        { agent: AGENT, task: "exit will reject" },
        { callId: 1, cwd: dir, depth: 0, maxDispatchDepth: 3 },
        {
          ...h.deps,
          logger: { info: () => undefined, warn: (m: string) => void warnings.push(m) },
        },
      ).catch(() => undefined);
      await waitFor(() => h.lifecycle.spawnCount > 0);
      h.lifecycle.resolveExit(h.lifecycle.handleAt(0), 0, null);
      await settled;
      await waitFor(() => warnings.length > 0);
      expect(warnings.join("\n")).toContain("exit() failed for a foreground child");
      expect(warnings.join("\n")).toContain("injected: exit blew up");
    });
  });
});
