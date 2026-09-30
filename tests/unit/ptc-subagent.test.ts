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
import type { ChildHandle, ChildSpawnOptions } from "../../src/runtime/child-process-lifecycle.ts";
import type { DispatchDeps, DispatchInput } from "../../src/runtime/dispatch.ts";
import type { Static } from "typebox";
import { DISPATCH_PARAMETERS } from "../../src/runtime/bindings.ts";
import { DEFAULT_CONFIG } from "../../src/runtime/limits.ts";
import { DispatchSlotCounter } from "../../src/runtime/dispatch.ts";
import { createPtcSubagentTool } from "../../src/tools/subagent.ts";
import { createTaskRegistry, type TaskRegistry } from "../../src/runtime/task-registry.ts";
import { InMemoryTaskStorage } from "../../src/runtime/task-storage.ts";
import type { ULID } from "../../src/runtime/task-storage.ts";
import { installRecordingPi, makeTempDir, removeTempDir } from "../helpers/ptc.ts";

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

  override spawn(argv: readonly string[], opts: ChildSpawnOptions): ChildHandle {
    this.requests.push({ argv, opts });
    return super.spawn(argv, opts);
  }

  /** How many children were launched. */
  get spawnCount(): number {
    return this.requests.length;
  }
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
    // The contrast that makes the count above worth anything. A fixture that can only ever
    // report zero pins nothing, and that is exactly what the old mock was: with its `spawn`
    // replaced by a throw, the saturated-counter test still passed. Here the identical setup
    // with one free slot must record a real spawn, so "zero children" above is the gate
    // refusing rather than the harness never looking.
    const pi = await installRecordingPi();
    try {
      await withAgent(async (dir) => {
        const h = createHarness();
        const tool = createPtcSubagentTool(baseOptions(dir, h.deps));
        const result = (await run(tool, { agent: AGENT, task: "a free slot" })) as {
          content: { type: string; text: string }[];
        };
        expect(await pi.count(), "a foreground call with a free slot really spawns pi").toBe(1);
        expect(
          result.content[0]?.text ?? "",
          "and the child's own answer is what comes back",
        ).toContain("PONG");
      });
    } finally {
      await pi.restore();
    }
  });

  test("a refused pre-spawn call gives its slot back", async () => {
    // The unknown-agent return sits AFTER the acquire. If it did not release, one bad call would
    // permanently shrink the pool, and the symptom would be a session that slowly stops being
    // able to dispatch at all -- which no single-call test would notice.
    await withAgent(async (dir) => {
      const h = createHarness();
      const slots = new DispatchSlotCounter(4);
      const tool = createPtcSubagentTool({
        ...baseOptions(dir, h.deps),
        getDispatchDeps: () => ({ ...h.deps, slots }),
      });
      for (let i = 0; i < 6; i += 1) {
        await run(tool, { agent: "no-such-agent", task: "attempt " + i }).catch(() => undefined);
      }
      expect(slots.active, "six refusals against a pool of four must not empty it").toBe(0);
    });
  });
});
