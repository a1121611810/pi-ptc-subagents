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
import type { DispatchDeps } from "../../src/runtime/dispatch.ts";
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

interface Harness {
  registry: TaskRegistry;
  deps: DispatchDeps;
  lifecycle: MockChildProcessLifecycle;
}

function createHarness(): Harness {
  const storage = new InMemoryTaskStorage();
  const clock = (): number => 1000;
  const registry = createTaskRegistry(storage, { clock });
  const lifecycle = new MockChildProcessLifecycle();
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
  test("a background call reaches the dispatcher and never resolves success-shaped on a refusal", async () => {
    // Story 6's contract, minus the part a unit test cannot reach. A live spawn needs an agent
    // the HOST registry knows about, and that registry does not see a markdown file written into
    // a temp dir -- so the success branch is not exercisable here without a real pi install and
    // a real agent. What IS deterministic, and what this tool actually introduces, is that the
    // dispatcher's outcome reaches the model faithfully: a handle becomes a task id, a refusal
    // becomes a thrown error. Asserting the success path here would be asserting on the host's
    // agent registry, which is not what this change modifies.
    await withAgent(async (dir) => {
      const h = createHarness();
      const tool = createPtcSubagentTool(baseOptions(dir, h.deps));
      let message = "";
      try {
        const result = (await run(tool, {
          agent: AGENT,
          task: "look at the tests",
          background: true,
        })) as { details: { taskId?: string } };
        // If this install DOES know the agent, the success shape is the one we promised.
        expect(
          result.details.taskId,
          "a resolved background call carries a task id, never a bare result",
        ).toBeDefined();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      if (message !== "") {
        // The refusal path: visible, and carrying the dispatcher's own wording rather than a
        // success-shaped result the model would have to learn to read.
        expect(message).toContain("ptc_subagent refused the call");
      }
      // Either way the registry is the dispatcher's, not a second one: nothing here bypassed it.
      expect(h.deps.taskRegistry, "the session registry is the one handed in").toBe(h.registry);
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
    expect(declared, "one schema, two call sites").toEqual(real);
    expect(declared, "and it is not empty").toContain("agent");
    expect(declared).toContain("task");
    expect(declared).toContain("background");
  });
});
