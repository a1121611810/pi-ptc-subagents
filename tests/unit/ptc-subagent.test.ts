/**
 * `ptc_subagent` (ADR-0025, ticket #90). The top-level front over the same `dispatch()` the
 * `pi.dispatch` binding uses, so a session whose orchestration is pi's `codemode` can still
 * start a managed subagent.
 *
 * No real `pi` process is spawned here: `MockChildProcessLifecycle` and an in-memory task
 * storage stand in, the same seam `tests/unit/dispatch-background.test.ts` uses, so the
 * lifecycle assertions are about OUR wiring rather than about a child's timing.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
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
import { createPtcSubagentTool, SUBAGENT_OUTPUT_SCHEMA } from "../../src/tools/subagent.ts";
import { createTaskRegistry, type TaskRegistry } from "../../src/runtime/task-registry.ts";
import { InMemoryTaskStorage } from "../../src/runtime/task-storage.ts";
import type { ULID } from "../../src/runtime/task-storage.ts";
import { installRecordingPi, makeTempDir, removeTempDir, waitFor } from "../helpers/ptc.ts";

// The agent these tests dispatch, named so nothing here can silently start depending on what a
// given pi build happens to ship.
//
// HISTORY, and the reason this comment is longer than the code: this used to be pi's own
// `__smoke_echo`, on the claim that "the agent registry is read from the host config and does not
// see a markdown file written into a temp dir". That claim was FALSE and it cost a release: the
// suite was green on macOS and three assertions went red on the ubuntu runner, because pi does not
// ship `__smoke_echo` there. `discoverAgent` resolves `projectDir` as `<cwd>/.pi/agents`
// (dispatch.ts `resolveAgentDirs`), and every test already runs with `cwd` = its own temp dir --
// so the registry does see a temp-dir markdown, as long as the call is made at PROJECT scope.
// The default scope is `"user"` (dispatch.ts:1044), which is the real `~/.pi/agent/agents`:
// machine state this suite has no business reading. See `provisionAgent` in `withAgent`.
const AGENT = "ptc-self-test-agent";
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
    await provisionAgent(dir);
    return await body(dir);
  } finally {
    await removeTempDir(dir);
  }
}

/**
 * Write the agent fixture into `<dir>/.pi/agents`, the exact path `discoverAgent` reads at
 * project scope (`resolveAgentDirs`: `projectDir = <cwd>/.pi/agents`).
 *
 * Controlled, not ambient. Every precondition these tests depend on is now either provisioned
 * here or passed in: the agent, the cwd, and the lifecycle. The one that was not is what broke the
 * release.
 */
async function provisionAgent(dir: string): Promise<void> {
  const agentsDir = path.join(dir, ".pi", "agents");
  await mkdir(agentsDir, { recursive: true });
  await writeFile(
    path.join(agentsDir, AGENT + ".md"),
    `---
name: ${AGENT}
---
You are a self-test fixture.
`,
    "utf-8",
  );
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

/**
 * The tool result as the codemode-facing tests read it. `run` is generic over the tool's own return
 * type and pi types `structuredContent` as an opaque `JsonValue`, so the channel under test is
 * spelled out here rather than cast at each use site.
 */
interface ObservedResult {
  content: { type: string; text: string }[];
  details: { taskId?: string; status?: string; exitCode?: number };
  structuredContent?: Record<string, unknown>;
}

const observed = (result: unknown): ObservedResult => result as ObservedResult;

/** The projection, or a loud failure -- a missing channel must not read as an empty one. */
function structuredOf(result: ObservedResult): Record<string, unknown> {
  const structured = result.structuredContent;
  if (structured === undefined) {
    throw new Error("ptc_subagent returned no structuredContent");
  }
  return structured;
}

/** The assistant text the mock child "produced". `PONG` is the repo's own child-answer literal. */
const FOREGROUND_ANSWER = "PONG";
/** The code the mock foreground child closes with, handed in by this file, not read back. */
const FOREGROUND_EXIT_CODE = 0;

/** One background call through the real front, with its harness so a test can reach the registry. */
async function dispatchBackground(dir: string): Promise<{ result: ObservedResult; h: Harness }> {
  const h = createHarness();
  const tool = createPtcSubagentTool(baseOptions(dir, h.deps));
  const result = await run(tool, {
    agent: AGENT,
    agentScope: "project",
    task: "look at the tests",
    background: true,
  });
  // Asserted here rather than in each test: without a child there is no background outcome at all,
  // and "structuredContent is absent because nothing was dispatched" is a false pass.
  expect(h.lifecycle.spawnCount, "the background fixture really launched a child").toBe(1);
  return { result: observed(result), h };
}

/**
 * One FOREGROUND call driven to a clean, answering close: push the assistant text, then close with
 * `FOREGROUND_EXIT_CODE`. Both halves are required -- `decideCloseOutcome` only returns `fulfilled`
 * for exit 0 WITH final text, and a `rejected` outcome never reaches either success return.
 */
async function dispatchForeground(dir: string): Promise<ObservedResult> {
  return dispatchForegroundSaying(dir, FOREGROUND_ANSWER);
}

/**
 * The same call, with the child's final assistant text supplied and the host's usage counters
 * supplied alongside it.
 *
 * Both are real inputs to the foreground path: the LAST text part becomes both `text` and the
 * report source (`extractChildReportFromText`), and `usage` is accumulated off `message_end` and
 * stamped onto the report at settle. Driving them together is what lets the report tests read a
 * report that went through extraction rather than one handed to the renderer directly.
 */
async function dispatchForegroundSaying(
  dir: string,
  text: string,
  usage?: { input: number; output: number; cost: number },
): Promise<ObservedResult> {
  const h = createHarness();
  const tool = createPtcSubagentTool(baseOptions(dir, h.deps));
  const settled = run(tool, { agent: AGENT, agentScope: "project", task: "answer, then stop" });
  await waitFor(() => h.lifecycle.spawnCount > 0);
  const child = h.lifecycle.handleAt(0);
  h.lifecycle.pushEvent(child, {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      // `cost.total` is the shape pi's assistant usage block actually carries (dispatch.ts reads
      // `m.usage.cost?.total`), so this is the real message, not a convenient one.
      ...(usage === undefined ? {} : { usage: { ...usage, cost: { total: usage.cost } } }),
    },
  });
  h.lifecycle.resolveExit(child, FOREGROUND_EXIT_CODE, null);
  return observed(await settled);
}

/**
 * A compliant child's final message: its prose, then the fenced ```json block the prompt channel
 * reads (ADR-0032). The fence is the contract's whole trigger — `extractChildReportFromText` takes
 * the LAST fenced block and nothing else, so this is the shape the fallback channel is specified
 * against, not prose that happens to contain JSON.
 */
function childSaying(prose: string, report: unknown): string {
  return `${prose}\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\``;
}

/** The declared report a compliant child emits: a literal over ADR-0032's three declared fields. */
const CHILD_REPORT_LITERAL = {
  summary: "The concurrency gate precedes agent discovery, so nothing is spawned.",
  findings: [
    {
      what: "the slot acquire happens before discoverAgent",
      evidence:
        "dispatchConcurrencyLimitReached() returns from the acquire branch, above discovery",
    },
    {
      what: "the background refusal reuses the foreground wording",
      evidence: "backgroundDispatchConcurrencyLimitReached() spreads the foreground error object",
    },
  ],
  files_touched: ["src/runtime/dispatch.ts", "tests/unit/ptc-subagent.test.ts"],
} as const;

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
        agentScope: "project",
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
        await run(tool, { agent: "no-such-agent", agentScope: "project", task: "anything" });
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
        await run(tool, { agent: AGENT, agentScope: "project", task: "one level too deep" });
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
          await run(tool, { agent: AGENT, agentScope: "project", task: "no slot is free" });
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
      const settled = run(tool, { agent: AGENT, agentScope: "project", task: "a free slot" }).catch(
        () => undefined,
      );
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
          { agent: AGENT, agentScope: "project", task: "live set probe " + i },
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
          { agent: AGENT, agentScope: "project", task: "never gets to spawn" },
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
        { agent: AGENT, agentScope: "project", task: "writer restored" },
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
          { agent: AGENT, agentScope: "project", task: "never gets to spawn", background: true },
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
        { agent: AGENT, agentScope: "project", task: "exit will reject" },
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

/**
 * The `structuredContent` channel: what a codemode script receives INSTEAD of the text block once
 * the tool declares an `outputSchema` (`ToolDefinition.outputSchema`). This tool is the only way a
 * session that has handed orchestration to pi's `codemode` can start a subagent at all, so before
 * this channel existed the script had to regex the ULID out of `"Started background task 01JABC..."`.
 *
 * Every absence claim below is asserted with `Object.hasOwn`, never with `=== undefined`. That is
 * the defect this suite exists to catch: `JsonValue` has no `undefined`, so a key set to
 * `undefined` compiles fine in spirit, reads identically to "absent" through the obvious check,
 * and then vanishes at `JSON.stringify` -- on the far side of the very boundary being tested.
 */
describe("ptc_subagent structuredContent", () => {
  test("a background call hands the script a pollable id and no exit code", async () => {
    await withAgent(async (dir) => {
      const { result, h } = await dispatchBackground(dir);
      const structured = structuredOf(result);
      expect(structured.task_id, "the id is a value, not prose the script has to parse").toBe(
        result.details.taskId,
      );
      expect(structured.status, "and the script is told this is a handle").toBe("background");
      expect(
        Object.hasOwn(structured, "exit_code"),
        "a handle has nothing to report yet, so the key is ABSENT rather than undefined",
      ).toBe(false);
      // Independent sources for the id itself, not "whatever the tool wrote". `PARENT_TASK` is this
      // file's canonical 26-char Crockford-base32 ULID literal, so the shape is a stated invariant
      // rather than a copy of the implementation; and the registry proves the id names a task that
      // really exists in this session, which no locally-invented string could.
      const record = await h.registry.get(structured.task_id as ULID);
      expect(record?.agentName, "the id names a task the session registry really holds").toBe(
        AGENT,
      );
      expect(String(structured.task_id), "and it is a ULID, like PARENT_TASK above").toMatch(
        /^[0-9A-HJKMNP-TV-Z]{26}$/,
      );
    });
  });

  test("a call that already finished hands the script the exit code and no task id", async () => {
    await withAgent(async (dir) => {
      const structured = structuredOf(await dispatchForeground(dir));
      expect(structured.status, "the dispatcher's own status, not the word 'background'").toBe(
        "fulfilled",
      );
      // Presence and value are separate assertions on purpose: `0` is falsy, so a script cannot
      // tell "exited 0" from "nothing to report" by truthiness -- which is exactly why the
      // background test above pins absence with `hasOwn`.
      expect(
        Object.hasOwn(structured, "exit_code"),
        "a finished call has something to report, so the key is present",
      ).toBe(true);
      expect(structured.exit_code, "and it is the code this file closed the child with").toBe(
        FOREGROUND_EXIT_CODE,
      );
      expect(Object.hasOwn(structured, "task_id"), "and there is nothing to poll").toBe(false);
    });
  });

  test("the two outcomes are told apart from the projection alone, with no text in reach", async () => {
    await withAgent(async (dir) => {
      const handle = structuredOf((await dispatchBackground(dir)).result);
      const finished = structuredOf(await dispatchForeground(dir));
      // The property the change exists for. A codemode script gets this object INSTEAD of the text
      // block, so its routing decision has to be readable from here -- with key sets, because
      // `exit_code: 0` and "no exit_code" are the same observation to any truthiness test.
      // `report_channel` is on BOTH, and that is the point: it is the total field, present even
      // where nothing was reported, so a script can tell "ignored the contract" from "still
      // running" without a text block. It is on neither branch's DISCRIMINATING key.
      expect(Object.keys(handle).sort(), "a handle is {task_id, status, report_channel}").toEqual([
        "report_channel",
        "status",
        "task_id",
      ]);
      expect(
        Object.keys(finished).sort(),
        "a finished call is {status, exit_code, report_channel}",
      ).toEqual(["exit_code", "report_channel", "status"]);
      expect("task_id" in handle, "so a script branches on task_id for 'poll me'").toBe(true);
      expect("task_id" in finished, "and on its absence for 'already done'").toBe(false);
      // Not on `status`, which would also discriminate. The two branches differ in WHICH key they
      // carry, and that is the claim: the id is the thing a script acts on next.
      expect(Object.keys(handle).sort().join(",")).not.toBe(Object.keys(finished).sort().join(","));
    });
  });

  test("every key the tool emits is declared in its outputSchema", async () => {
    // Nothing in pi enforces this. `structuredContent` is never validated against `outputSchema`
    // -- there is no warning and no error -- so a key added to the projection without a schema
    // entry reaches a script undeclared and no gate in this repo complains. This is the only place
    // the two can be held together.
    await withAgent(async (dir) => {
      // A Set, because the two outcomes legitimately share `status` -- comparing two concatenated
      // lists would make this test fail on the shared key alone and hide a real drift.
      //
      // The third outcome is a child that COMPLIED: only its projection carries `report`, so a
      // sweep over the other two would never see that key emitted and could not catch it going
      // undeclared.
      const emitted = [
        ...new Set([
          ...Object.keys(structuredOf((await dispatchBackground(dir)).result)),
          ...Object.keys(structuredOf(await dispatchForeground(dir))),
          ...Object.keys(
            structuredOf(
              await dispatchForegroundSaying(dir, childSaying("done", CHILD_REPORT_LITERAL)),
            ),
          ),
        ]),
      ].sort();
      const declared = Object.keys(SUBAGENT_OUTPUT_SCHEMA.properties ?? {}).sort();
      expect(emitted, "every emitted key is a declared one").toEqual(declared);
      // And the projection stays LEAN -- five keys, none of them the `details` spelling, and no
      // field that exists only to say "this does not apply". `report_channel` is the exception
      // that proves the rule: it exists ONLY to say that `report` does not apply, and it is here
      // because ADR-0032 makes an unstated degradation a defect.
      expect(declared).toEqual(["exit_code", "report", "report_channel", "status", "task_id"]);
      expect(declared, "snake_case, like pi's own builtins").not.toContain("taskId");
      expect(declared).not.toContain("exitCode");
    });
  });

  test("the projection survives the JSON round trip the sandbox makes", async () => {
    await withAgent(async (dir) => {
      const handle = structuredOf((await dispatchBackground(dir)).result);
      const finished = structuredOf(await dispatchForeground(dir));
      // The sandbox receives what `JSON.stringify` produced. `toEqual` would not notice an
      // `undefined`-valued key -- it ignores undefined properties -- so this uses `toStrictEqual`,
      // which does: an explicit `exit_code: undefined` on the handle is exactly what would vanish
      // here and leave the script with a projection its schema does not describe.
      expect(JSON.parse(JSON.stringify(handle))).toStrictEqual(handle);
      expect(JSON.parse(JSON.stringify(finished))).toStrictEqual(finished);
      // The key sets, again by length and by hasOwn: the round trip above compares VALUES, and a
      // dropped key is a shape change a value comparison can report as equal.
      expect(Object.keys(JSON.parse(JSON.stringify(handle)))).toHaveLength(3);
      expect(Object.keys(JSON.parse(JSON.stringify(finished)))).toHaveLength(3);
    });
  });

  test("a refusal still throws, and hands a script no result to mistake for a handle", async () => {
    await withAgent(async (dir) => {
      const h = createHarness();
      const tool = createPtcSubagentTool(baseOptions(dir, h.deps));
      let result: unknown = undefined;
      let message = "";
      try {
        result = await run(tool, {
          agent: "no-such-agent",
          agentScope: "project",
          task: "anything",
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message, "the refusal is still an error rather than a result").toContain(
        "ptc_subagent",
      );
      // Its own test because a `rejected` DispatchResult is the one outcome neither success
      // projection covers, and resolving it as `{ structuredContent: { status: "rejected" } }`
      // would look like an improvement. A script would then see a THIRD shape -- a status with
      // neither task_id nor exit_code -- that the two-branch discrimination above never sees.
      expect(result, "no result object escaped the throw").toBeUndefined();
    });
  });
});

/**
 * ADR-0032 §Rendering on the surface that actually has a reader.
 *
 * `surface mode: subagents` registers no `codemode`, so nothing reads `structuredContent` and the
 * report's only reader is the text block. These tests go through `execute()` rather than calling
 * the renderer directly, because the claim is about what the MODEL gets: the rendered block first,
 * the child's own prose after it, and -- on the other path -- a visibly marked gap rather than a
 * report-shaped silence.
 *
 * Both directions of the IO boundary are covered (#1): a child that complies with the contract and
 * a child that does not. `docs/testing-constraints.md` #3 says the second must not be silent, and
 * an unmarked gap is exactly that.
 */
describe("ptc_subagent renders the child report into the text the model reads", () => {
  test("a compliant child's report is rendered above its prose, which survives intact", async () => {
    await withAgent(async (dir) => {
      const prose = "I read the dispatcher and traced the gate; here is what I found.";
      const result = await dispatchForegroundSaying(dir, childSaying(prose, CHILD_REPORT_LITERAL), {
        input: 1200,
        output: 340,
        cost: 0.0123,
      });
      const text = result.content[0]?.text ?? "";

      // Conclusion first, reasoning second (ADR-0032 §Rendering): the block opens the text.
      expect(text.startsWith("child report"), "the block comes before the prose").toBe(true);
      expect(text, "and the child's own words are still there").toContain(prose);
      expect(
        text.indexOf("child report"),
        "the report is not appended after the prose it summarises",
      ).toBeLessThan(text.indexOf(prose));

      // The four sections, in the order the ADR fixes them.
      expect(text).toContain("summary");
      expect(text).toContain("findings");
      expect(text).toContain("files");
      expect(text).toContain("usage");
      expect(text.indexOf("summary")).toBeLessThan(text.indexOf("findings"));
      expect(text.indexOf("findings")).toBeLessThan(text.indexOf("files"));
      expect(text.indexOf("files")).toBeLessThan(text.indexOf("usage"));

      // Every finding with its own evidence -- the claim AND the thing supporting it, which is
      // the part a summary-only render would drop.
      for (const finding of CHILD_REPORT_LITERAL.findings) {
        expect(text, "the claim is in the rendered text").toContain(finding.what);
        expect(text, "and so is the evidence it rested on").toContain(finding.evidence);
      }
      for (const file of CHILD_REPORT_LITERAL.files_touched) {
        expect(text, "and the paths the child touched").toContain(file);
      }
      // The summary is the child's own sentence, not a truncation of something longer.
      expect(text).toContain(CHILD_REPORT_LITERAL.summary);
    });
  });

  test("the rendered usage is the host's measurement, never a child-declared one", async () => {
    // `ChildReportPayload` is what the child declares and `ChildReport.usage` is what the host
    // observed; the split exists because a model cannot know its own token count. So the fixture
    // CHILD_REPORT_LITERAL deliberately carries NO usage key -- and the rendered row still shows
    // one, with the numbers this file fed to the host's own `message_end` accumulation.
    expect(
      Object.hasOwn(CHILD_REPORT_LITERAL, "usage"),
      "the child's declared payload has no usage field at all",
    ).toBe(false);
    await withAgent(async (dir) => {
      const text =
        (
          await dispatchForegroundSaying(dir, childSaying("done", CHILD_REPORT_LITERAL), {
            input: 1200,
            output: 340,
            cost: 0.0123,
          })
        ).content[0]?.text ?? "";
      expect(text).toContain("in 1200");
      expect(text).toContain("out 340");
      expect(text).toContain("cost 0.0123");
      expect(text, "one message_end is one turn").toContain("1 turn");
    });
  });

  test("a child that ignored the contract is marked as such, not rendered as an empty report", async () => {
    // COUNTERFACTUAL (constraint 5). Render `report: undefined` as an empty report -- sections
    // with `Array(0)` findings, a zeroed usage row -- and this test goes red on every assertion
    // below, because none of those words says the report is missing. The model would read "the
    // child found nothing", which is a completely different claim from "the child told us
    // nothing", and the difference is the whole point of the surface.
    await withAgent(async (dir) => {
      const prose = "I looked at the file and it seems fine to me.";
      const text = (await dispatchForegroundSaying(dir, prose)).content[0]?.text ?? "";

      expect(text, "the child's prose is still handed over intact").toContain(prose);
      expect(text, "the gap is visible").toContain("child report");
      expect(text, "and names the channel that delivered nothing").toContain("channel: none");
      expect(text, "and says so in words").toContain("no child report was returned");
      expect(text, "no summary row — that is what an empty report would print").not.toContain(
        "summary",
      );
      expect(text, "no findings row").not.toContain("findings");
      expect(text, "no files row").not.toContain("files");
      expect(text, "no usage row").not.toContain("usage");
    });
  });

  test("the structured channel carries the report whole, alongside the same text", async () => {
    // The two channels are declared to agree on KEYS (ADR-0028 "Keys agree; values are raw"), and
    // nothing in pi checks that they do -- so the one place it can be checked is here. The
    // projection's report keys are the four section labels the rendered block draws, and vice
    // versa: a fifth key in the projection, or a fifth section in the text, is drift.
    await withAgent(async (dir) => {
      const result = await dispatchForegroundSaying(
        dir,
        childSaying("done", CHILD_REPORT_LITERAL),
        { input: 1200, output: 340, cost: 0.0123 },
      );
      const structured = structuredOf(result);
      const report = structured.report as
        | { summary: string; findings: unknown[]; files_touched: string[]; usage: unknown }
        | undefined;
      const text = result.content[0]?.text ?? "";

      expect(report, "a compliant child's report reaches the machine channel").toBeDefined();
      // FULL length, not the rendered view: the 20-finding bound is a rendering bound and a
      // program is not a display surface (ADR-0032 §Rendering). Asserting the count here is what
      // stops that decision from quietly becoming a lossy projection.
      expect(report?.findings, "every finding, not the rendered twenty").toHaveLength(
        CHILD_REPORT_LITERAL.findings.length,
      );
      expect(report?.summary).toBe(CHILD_REPORT_LITERAL.summary);
      expect(report?.files_touched).toEqual([...CHILD_REPORT_LITERAL.files_touched]);

      // Keys agree: every projection key is a section the model was shown.
      for (const key of Object.keys(report ?? {})) {
        expect(text, "section " + key + " is drawn in the text").toContain(key);
      }
      // And the host's usage, not the child's: `usage` came from this file's `message_end`.
      expect(report?.usage).toEqual({ input: 1200, output: 340, cost: 0.0123, turns: 1 });
    });
  });

  test("a non-compliant child gets no `report` key rather than an empty one", async () => {
    // `JsonValue` has no `undefined`, so a key set to `undefined` would compile in spirit and
    // vanish at `JSON.stringify` on the far side of the sandbox boundary. Absence is asserted
    // with `hasOwn` for exactly that reason -- the same discipline the handle/finished pair above.
    await withAgent(async (dir) => {
      const structured = structuredOf(await dispatchForegroundSaying(dir, "no report here"));
      expect(
        Object.hasOwn(structured, "report"),
        "no report means the key is ABSENT, not present-and-empty",
      ).toBe(false);
      // The other two keys are untouched by this, so "absent" is about the report and not about
      // the whole projection having vanished.
      expect(structured.status).toBe("fulfilled");
      expect(structured.exit_code).toBe(FOREGROUND_EXIT_CODE);
      // ...and the channel is what says WHY it is absent. Without this key the two ways a
      // `report` can be missing -- the child ignored the contract, or a handle has not finished --
      // are the same value, which is the silent degradation ADR-0032 exists to prevent.
      expect(structured.report_channel).toBe("none");
    });
  });

  test("report_channel says why a report is absent, on every branch that can omit it", async () => {
    // Three outcomes, one of them compliant. Two of them omit `report`, and without the channel
    // they are the same value to a caller -- which is the silent degradation ADR-0032 forbids.
    // Counterfactual: dropping `report_channel`, or leaving it off the handle branch, turns this
    // red; so does an implementation that claims a channel it did not use.
    await withAgent(async (dir) => {
      const nonCompliant = structuredOf(await dispatchForegroundSaying(dir, "no report here"));
      expect(Object.hasOwn(nonCompliant, "report")).toBe(false);
      expect(nonCompliant.report_channel).toBe("none");

      const handleStructured = structuredOf((await dispatchBackground(dir)).result);
      expect(Object.hasOwn(handleStructured, "report")).toBe(false);
      expect(handleStructured.report_channel).toBe("none");
      // What IS different between the two non-compliant outcomes, so this pair is not vacuous.
      expect(Object.hasOwn(handleStructured, "task_id")).toBe(true);

      const compliant = structuredOf(
        await dispatchForegroundSaying(dir, childSaying("done", CHILD_REPORT_LITERAL)),
      );
      expect(Object.hasOwn(compliant, "report")).toBe(true);
      expect(compliant.report_channel).toBe("prompt-json");
    });
  });
});
