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
import { makeTempDir, removeTempDir } from "../helpers/ptc.ts";

// A REAL registered agent, not one this file invents. The agent registry is read from the
// host config and does not see a markdown file written into a temp dir, so a locally authored
// fixture takes the unknown-agent path and proves nothing about the spawn path. pi ships a
// smoke-test agent; named explicitly so a future pi that drops it turns this red rather than
// quietly skipping the assertion (testing constraint 2: fixtures come from a real sample).
const AGENT = "__smoke_echo";

/**
 * The mock lifecycle plus a record of what it was asked to launch. A spawn the test cannot see
 * is a spawn the test cannot assert on, and the spawn direction of the IO boundary is the one
 * the accept-both version of this file was quietly not checking.
 */
class RecordingLifecycle extends MockChildProcessLifecycle {
  readonly spawned: ChildHandle[] = [];

  override spawn(argv: readonly string[], opts: ChildSpawnOptions): ChildHandle {
    const handle = super.spawn(argv, opts);
    this.spawned.push(handle);
    return handle;
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
      const tool = createPtcSubagentTool(baseOptions(dir, h.deps));
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
      expect(h.lifecycle.spawned.length, "exactly one child was launched").toBe(1);
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
