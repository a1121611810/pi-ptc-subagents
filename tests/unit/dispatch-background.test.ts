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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DISPATCH_KILL_GRACE_MS,
  DispatchSlotCounter,
  dispatch,
  dispatchDepthLimitReached,
  type DispatchDeps,
  type DispatchInput,
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
import { createPtcTaskOutputTool } from "../../src/tools/ptc-task.ts";
import { makeTempDir, removeTempDir, waitFor } from "../helpers/ptc.ts";

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
  test("returns a running DispatchHandle and registers the ADR-0022 §3 record (§3/§4)", async () => {
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

  test("a strict tier narrows the background child's tool list too (ADR-0041)", async () => {
    // The silent half-feature, asserted where the background path is already owned. Both spawn
    // paths call the same argv builder with the same input, so this passes for free today --
    // which is precisely why it needs saying out loud: "passes for free" is what a future edit
    // to one path stops being. The e2e smoke file cannot reach this row, because a background
    // dispatch needs a task registry and this file deliberately runs with none.
    await withAgent(async (dir) => {
      const h = createHarness();
      const result = await dispatch(
        {
          agent: AGENT,
          task: "investigate",
          background: true,
          agentScope: "project",
          readOnly: "strict",
        },
        { callId: 9, cwd: dir, depth: 0, maxDispatchDepth: 3 },
        h.deps,
      );
      expect(asHandle(result).status).toBe("running");
      const argv = h.lifecycle.getRecordedArgv(h.lifecycle.handleAt(0));
      expect(argv[argv.indexOf("--tools") + 1]).toBe("read,grep,find,ls,ptc_child_report");
    });
  });

  test("the background path appends the lenient clause, not just the foreground one (ADR-0041)", async () => {
    /*
     * Written because a mutation found the gap, not because the suite went red: stubbing the
     * background path's `readOnly` passthrough left every other test in the repository green.
     * The argv assertion in the test above cannot see it either -- argv comes from a builder both
     * paths share, while the PROMPT is materialised separately on each, and only this file has a
     * background harness.
     *
     * Counterfactual: pass `readOnly: undefined` at the background `appendDepthHint` call site
     * and this is the single test that turns red.
     */
    await withAgent(async (dir) => {
      const h = createHarness();
      const result = await dispatch(
        {
          agent: AGENT,
          task: "investigate",
          background: true,
          agentScope: "project",
          readOnly: "lenient",
        },
        { callId: 10, cwd: dir, depth: 0, maxDispatchDepth: 3 },
        h.deps,
      );
      expect(asHandle(result).status).toBe("running");
      const opts = h.lifecycle.getRecordedOpts(h.lifecycle.handleAt(0));
      const prompt = await readFile(opts.promptFile!, "utf8");
      expect(prompt).toContain("You were dispatched read-only");

      // **The clause's CONTENT, not its greeting.** Four assertions in this repository used to
      // check only `You were dispatched read-only` — the first four words — and a mutation audit
      // measured that the clause could then be weakened to "do not create or delete files" (drop
      // `modify` — the write most likely to happen) or replaced wholesale by "do not write
      // files", with the WHOLE suite green and `tsc` clean. ADR-0041 §Decision makes this clause
      // the entire effect of the lenient tier, so an unpinned clause is an unpinned tier.
      //
      // Each of the three claims below is a separate promise the clause makes, so each is asserted
      // separately: a failure names which promise went missing.
      expect(prompt, "it names all three writes it forbids, not just the greeting").toContain(
        "create, modify or delete files",
      );
      expect(prompt, "and that running commands counts as writing").toContain("run commands");
      expect(
        prompt,
        "and it says the tools are still there — without that the child would read the clause " +
          "as a narrowing that silently failed",
      ).toContain("all still available");

      // And the tier it did NOT apply: a lenient child keeps the full toolset.
      const argv = h.lifecycle.getRecordedArgv(h.lifecycle.handleAt(0));
      expect(argv, "lenient must not narrow the background child either").not.toContain("--tools");
    });
  });

  test("the why reaches the background child's prompt (ADR-0042)", async () => {
    /*
     * The background half of the two-call-site rule. `appendDepthHint` is called once on each
     * path, and the foreground and background prompts are materialised separately — the argv
     * builder they share cannot see this. Wiring only one side leaves a child that looks
     * correctly configured and silently lacks the caller's reason.
     *
     * Counterfactual: drop `why: input.why` from the background call site and this is the
     * single test that turns red.
     */
    await withAgent(async (dir) => {
      const h = createHarness();
      const result = await dispatch(
        {
          agent: AGENT,
          task: "investigate",
          why: "we are preparing a release",
          background: true,
          agentScope: "project",
        },
        { callId: 11, cwd: dir, depth: 0, maxDispatchDepth: 3 },
        h.deps,
      );
      expect(asHandle(result).status).toBe("running");
      const opts = h.lifecycle.getRecordedOpts(h.lifecycle.handleAt(0));
      const prompt = await readFile(opts.promptFile!, "utf8");
      expect(prompt).toContain("<pi-ptc-why>");
      expect(prompt).toContain("we are preparing a release");
    });
  });

  test("the background record carries the suppression the handle cannot (ADR-0043)", async () => {
    /*
     * Foreground/background parity, on the one fact where the two fronts have different shapes. A
     * background dispatch returns a `DispatchHandle`, which has no result to carry
     * `whySuppressed` — so the TaskRecord is the only place a background caller can learn its
     * `why` was dropped, and it is read back by `ptc_task_output`.
     *
     * Counterfactual: drop the `whySuppressed` spread from the spawn record and this is the single
     * test that turns red; the prompt assertion here would still pass, because the block really is
     * suppressed. That is the whole reason the record is asserted separately.
     */
    await withAgent(async (dir) => {
      const h = createHarness();
      const result = await dispatch(
        {
          agent: AGENT,
          task: "investigate",
          why: "we are preparing a release",
          background: true,
          agentScope: "project",
        },
        { callId: 12, cwd: dir, depth: 0, maxDispatchDepth: 3 },
        { ...h.deps, whyEnabled: false },
      );
      const handle = asHandle(result);
      expect(handle.status).toBe("running");
      const opts = h.lifecycle.getRecordedOpts(h.lifecycle.handleAt(0));
      const prompt = await readFile(opts.promptFile!, "utf8");
      expect(prompt).not.toContain("<pi-ptc-why>");
      const record = await h.storage.loadTask(handle.taskId);
      if (record === null) throw new Error("the background record was not persisted");
      expect(record.whySuppressed).toBe(true);
      // The value itself must not be anywhere on the record — ADR-0042 declined to persist it and
      // ADR-0043 amends only the EVENT, not the content.
      expect(JSON.stringify(record)).not.toContain("we are preparing a release");
    });
  });

  test("a background dispatch with no why persists no suppression key at all (ADR-0043)", async () => {
    // The absence is a claim. A record that always carried the key would make "you passed nothing"
    // and "your value was dropped" the same event, and a poller could not tell them apart.
    await withAgent(async (dir) => {
      const h = createHarness();
      const result = await dispatch(
        { agent: AGENT, task: "investigate", background: true, agentScope: "project" },
        { callId: 13, cwd: dir, depth: 0, maxDispatchDepth: 3 },
        { ...h.deps, whyEnabled: false },
      );
      const record = await h.storage.loadTask(asHandle(result).taskId);
      if (record === null) throw new Error("the background record was not persisted");
      expect(record.whySuppressed).toBeUndefined();
      expect(Object.hasOwn(record, "whySuppressed")).toBe(false);
    });
  });

  test("the record carries the tier that took effect, for a background child too (ADR-0041)", async () => {
    /*
     * The background half of "The tier that took effect is reported" (user story 17: background
     * honours the tier exactly as foreground does, and this field must not be a foreground-only
     * promise). It cannot live in `tests/e2e/subagent-smoke.test.ts`: a background dispatch
     * needs a task registry and that file deliberately runs with none.
     *
     * The record is the ONLY place it can go, because a background dispatch returns a
     * `DispatchHandle` and there is no `DispatchResult` to carry it — so this row also pins the
     * decision, not just the value.
     *
     * Expectations are the two ADR-0041 tier literals, read off the record the spawn wrote —
     * there is no third, because the boolean short spelling was removed when the schema became a
     * string enum. COUNTERFACTUAL: write the tier only at the terminal
     * transition instead of at spawn, and this row is red on the `running` read below — which is
     * also the failure it is for, since a task polled while it is still running is exactly when
     * a caller has no other place to look.
     */
    await withAgent(async (dir) => {
      for (const [request, expected] of [
        ["strict", "strict"],
        ["lenient", "lenient"],
      ] as const) {
        const h = createHarness();
        const handle = asHandle(
          await dispatch(
            {
              agent: AGENT,
              task: "investigate",
              background: true,
              agentScope: "project",
              readOnly: request,
            },
            { callId: 40, cwd: dir, depth: 0, maxDispatchDepth: 3 },
            h.deps,
          ),
        );
        // Read while the child is STILL RUNNING: the tier is a fact about the request, not about
        // how it ended, so it is already there.
        const running = await h.storage.loadTask(handle.taskId);
        expect(running?.status).toBe("running");
        expect(running?.readOnlyTier, `${JSON.stringify(request)} on a running task`).toBe(
          expected,
        );

        // And it survives the terminal transition, because a failed read-only child was still
        // dispatched read-only.
        h.lifecycle.pushEvent(h.lifecycle.handleAt(0), {
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "answer" }],
          },
        });
        h.clock.set(1500);
        h.lifecycle.resolveExit(h.lifecycle.handleAt(0), 1, null);
        const failed = await waitForTerminal(h.storage, handle.taskId);
        expect(failed.status).toBe("failed");
        expect(failed.readOnlyTier, "the tier is not a succeeded-only field").toBe(expected);
      }
    });
  });

  test("a background dispatch asked for no tier records no tier, on either spelling", async () => {
    /*
     * The absence half, and the row that makes the field's PRESENCE mean something on this front:
     * a record that always carried `"strict"` would satisfy the row above.
     *
     * `Object.hasOwn`, matching the report rows in this file: an explicitly-`undefined` key and an
     * absent key are different things, and only the absent one keeps `undefined` from reading as
     * "no tier was asked for, outcome unknown".
     *
     * The two spellings left are an omitted key and an explicit `null`, which pi's validator
     * maps to an absent value. `false` is NOT one of them any more: under a string enum it is a
     * wrong-typed value, so it is refused rather than quietly honoured — the boundary table in
     * `tests/bindings.test.ts` is where that is pinned.
     *
     * COUNTERFACTUAL: stamp the tier unconditionally at spawn (`readOnlyTier: readOnlyTier ?? undefined`
     * written as a plain property) and this turns red on the hasOwn assertion.
     */
    await withAgent(async (dir) => {
      for (const request of [undefined, null] as const) {
        const h = createHarness();
        const handle = asHandle(
          await dispatch(
            {
              agent: AGENT,
              task: "investigate",
              background: true,
              agentScope: "project",
              // Cast: `null` is not in `DispatchInput["readOnly"]`, and the fact that the wire can
              // carry it anyway is why the read-point guard has an `unknown` parameter at all.
              ...(request === undefined ? {} : { readOnly: request as unknown }),
            } as DispatchInput,
            { callId: 41, cwd: dir, depth: 0, maxDispatchDepth: 3 },
            h.deps,
          ),
        );
        const record = await h.storage.loadTask(handle.taskId);
        expect(record).not.toBeNull();
        expect(
          Object.hasOwn(record as object, "readOnlyTier"),
          `${String(request)} asks for no tier, so no tier is recorded`,
        ).toBe(false);
      }
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

      // Terminal transition releases the slot for the next spawn. The child answers first:
      // a silent exit-0 child is `failed` (issue #70), and this test is about the slot, not
      // about the terminal verdict.
      h.lifecycle.pushEvent(h.lifecycle.handleAt(0), {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "PONG" }] },
      });
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

  test("an unusable agent refuses before any slot is minted, with the actionable message", async () => {
    const h = createHarness();
    // The wire can deliver anything, and `""` is the shape that used to read as "absent" and now
    // reads as "malformed" — which makes it the case that proves the split held on this front too.
    const result = asResult(
      await dispatch(
        { agent: "", task: "x", background: true } as unknown as Parameters<typeof dispatch>[0],
        { callId: 10, cwd: process.cwd(), depth: 0, maxDispatchDepth: 3 },
        h.deps,
      ),
    );

    expect(result.status).toBe("rejected");
    expect(result.started).toBe(false);
    // Counterfactual: the old "unknown agent: undefined" shape fails both of these.
    expect(result.errorMessage ?? "").toContain("agent, when given, must be a non-empty string");
    expect(result.errorMessage ?? "").toContain("registered agents:");
    expect(result.errorMessage ?? "").toContain("name: <agent-name>");
    expect(h.lifecycle.spawnCount).toBe(0);
    expect(h.slots.active).toBe(0);
  });

  test("an ABSENT agent spawns the generalist on the background front too", async () => {
    await withAgent(async (dir) => {
      const h = createHarness({ start: 1000 });
      /*
       * The two fronts must answer an omission the same way. One refusing while the other
       * dispatched would be worse than both refusing, because nothing in the call tells the model
       * which front it reached (ADR-0021 section 6, one vocabulary for the whole sub-call tree).
       *
       * `withAgent` deliberately leaves a definition in scope: the generalist has to win on the
       * ABSENCE of a name, not because the directory happened to be empty.
       */
      const result = await dispatch(
        { task: "x", background: true, agentScope: "project" },
        { callId: 10, cwd: dir, depth: 0, maxDispatchDepth: 3 },
        h.deps,
      );

      expect("taskId" in result, "the generalist spawns rather than refusing").toBe(true);
      const handle = asHandle(result);
      expect(h.lifecycle.spawnCount).toBe(1);
      const record = await h.storage.loadTask(handle.taskId);
      // No definition was resolved, so the record says so rather than borrowing the name of the
      // one that happens to be sitting in scope.
      expect(record?.agentName).toBe("");
    });
  });

  test("an unknown background agent lists what is registered under the effective scope", async () => {
    await withAgent(async (dir) => {
      const h = createHarness();
      const result = asResult(
        await dispatch(
          { agent: "__bg_missing_agent__", task: "x", background: true, agentScope: "project" },
          { callId: 11, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          h.deps,
        ),
      );

      expect(result.status).toBe("rejected");
      expect(result.started).toBe(false);
      expect(result.errorMessage ?? "").toContain("unknown agent: __bg_missing_agent__");
      // The fixture agent from the temp project dir must appear, with both lookup paths.
      expect(result.errorMessage ?? "").toContain("registered agents: [" + AGENT + "]");
      expect(result.errorMessage ?? "").toContain(join(dir, ".pi", "agents"));
      expect(h.lifecycle.spawnCount).toBe(0);
      expect(h.slots.active).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
//  detached pump: the child report lands on the persisted record (ADR-0032)
// ---------------------------------------------------------------------------

/**
 * A child's final message carrying a compliant report: prose, a fenced JSON block (ADR-0032's
 * prompt channel), prose. The report body is the same literal shape the pure-extraction suite
 * asserts, so the two are the same value read by two paths rather than two shapes.
 */
const REPORT_TEXT =
  "Two findings below.\n\n```json\n" +
  JSON.stringify({
    summary: "the depth gate is checked before the agent is discovered",
    findings: [
      { what: "depth precedes discovery", evidence: "the gate returns before discoverAgent" },
    ],
    files_touched: ["src/runtime/dispatch.ts"],
  }) +
  "\n```\n\nThat is all of it.";

/** Host-measured usage: the usage block the child emitted, which is the only source for `usage`. */
const REPORT_USAGE = {
  input: 900,
  output: 260,
  // Non-zero on purpose: the report's four-field view drops these two, so an accumulator that
  // round-tripped the derived view instead of the block would lose exactly them and still look
  // right against a zeros-only fixture.
  cacheRead: 7,
  cacheWrite: 11,
  cost: { total: 0.0123 },
};

describe("dispatch background pump persists the child report", () => {
  test("a compliant child leaves its report and channel on the record, with host-measured usage", async () => {
    await withAgent(async (dir) => {
      const h = createHarness({ start: 1000 });
      const handle = asHandle(
        await dispatch(
          { agent: AGENT, task: "report", background: true, agentScope: "project" },
          { callId: 30, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          h.deps,
        ),
      );

      h.lifecycle.pushEvent(h.lifecycle.handleAt(0), {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: REPORT_TEXT }],
          usage: REPORT_USAGE,
        },
      });
      h.clock.set(1500);
      h.lifecycle.resolveExit(h.lifecycle.handleAt(0), 0, null);

      const record = await waitForTerminal(h.storage, handle.taskId);
      expect(record.status).toBe("succeeded");
      expect(record.reportChannel).toBe("prompt-json");
      expect(record.report?.summary).toBe(
        "the depth gate is checked before the agent is discovered",
      );
      expect(record.report?.findings).toEqual([
        { what: "depth precedes discovery", evidence: "the gate returns before discoverAgent" },
      ]);
      expect(record.report?.files_touched).toEqual(["src/runtime/dispatch.ts"]);
      // The host's counter over the child's own usage block — the same numbers the foreground
      // path accumulates, and the only admissible source (ADR-0032: usage is observed, never
      // declared). `cacheRead`/`cacheWrite` are not part of the report's usage shape.
      expect(record.report?.usage).toEqual({ input: 900, output: 260, cost: 0.0123, turns: 1 });
      // The prose is still there beside it: the report is a sibling of the text, never a
      // replacement for it (ADR-0032).
      expect(record.outputPreview).toBe(REPORT_TEXT);
    });
  });

  test("a child that ignored the contract is marked non-compliant in the persisted output", async () => {
    await withAgent(async (dir) => {
      const h = createHarness({ start: 1000 });
      const handle = asHandle(
        await dispatch(
          { agent: AGENT, task: "prose only", background: true, agentScope: "project" },
          { callId: 31, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          h.deps,
        ),
      );

      h.lifecycle.pushEvent(h.lifecycle.handleAt(0), {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Here is the answer, in prose only." }],
        },
      });
      h.clock.set(1500);
      h.lifecycle.resolveExit(h.lifecycle.handleAt(0), 0, null);

      const record = await waitForTerminal(h.storage, handle.taskId);
      expect(record.status).toBe("succeeded");
      // The explicit marker, never a silent prose fallback (ADR-0032; testing-constraints #3).
      expect(record.reportChannel).toBe("none");
      expect(Object.hasOwn(record, "report")).toBe(false);
      // The answer is still kept — a child is not discarded over a formatting failure.
      expect(record.outputPreview).toBe("Here is the answer, in prose only.");
    });
  });

  test("a running task has no report before the child closes", async () => {
    await withAgent(async (dir) => {
      const h = createHarness({ start: 1000 });
      const handle = asHandle(
        await dispatch(
          { agent: AGENT, task: "long", background: true, agentScope: "project" },
          { callId: 32, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          h.deps,
        ),
      );

      // The child is mid-turn: it has emitted a message, but it has not finished, so nothing
      // about the report has been decided yet.
      h.lifecycle.pushEvent(h.lifecycle.handleAt(0), {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: REPORT_TEXT }],
          usage: REPORT_USAGE,
        },
      });
      const record = await h.storage.loadTask(handle.taskId);
      expect(record?.status).toBe("running");
      // "Not yet" and "reported nothing" are different claims, so both keys are ABSENT rather
      // than present-and-empty.
      expect(Object.hasOwn(record as object, "report")).toBe(false);
      expect(Object.hasOwn(record as object, "reportChannel")).toBe(false);
    });
  });

  /**
   * The failure this ticket exists to prevent, end to end through the real pump: a child whose
   * final message DID carry a report and then exited non-zero persists no report at all.
   *
   * Counterfactual: writing the extraction unconditionally — the obvious implementation, since
   * the pump has the report in hand either way — turns this red, as does writing an empty or
   * `null` one. The registry's `to === "succeeded"` gate is what the assertion pins.
   */
  test("a failed child carries no report, even though its final message carried one", async () => {
    await withAgent(async (dir) => {
      const h = createHarness({ start: 1000 });
      const handle = asHandle(
        await dispatch(
          { agent: AGENT, task: "dies after answering", background: true, agentScope: "project" },
          { callId: 33, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          h.deps,
        ),
      );

      h.lifecycle.pushEvent(h.lifecycle.handleAt(0), {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: REPORT_TEXT }],
          usage: REPORT_USAGE,
        },
      });
      h.clock.set(1500);
      h.lifecycle.resolveExit(h.lifecycle.handleAt(0), 1, null);

      const record = await waitForTerminal(h.storage, handle.taskId);
      expect(record.status).toBe("failed");
      expect(Object.hasOwn(record, "report")).toBe(false);
      expect(Object.hasOwn(record, "reportChannel")).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
//  detached pump: exit 0 -> succeeded, exit 1 -> failed (ADR-0022 §2/§3)
// ---------------------------------------------------------------------------

describe("dispatch background pump", () => {
  test("drives succeeded on exit 0 with text and failed on exit 1 with the exit code and duration", async () => {
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

      // ADR-0022 §2 (amended, issue #70): exiting 0 is not enough on its own — the child has to
      // have produced assistant text. The healthy child answers "PONG"; the failing one is
      // killed mid-flight and never gets a word out.
      h.lifecycle.pushEvent(h.lifecycle.handleAt(0), {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "PONG" }] },
      });

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

  /**
   * Issue #70, end to end through the real pump: a child that exits 0 having said nothing is
   * recorded as `failed`, not `succeeded`. The fixture is the real 429 run from the report —
   * pi writes an assistant `message_end` with an empty `content`, retries, and exits clean.
   *
   * Counterfactual: routing the pump back to `exitCode === 0 ? "succeeded" : "failed"` turns
   * this red, and it is the assertion the *model* sees: before the fix `ptc_task_output`
   * answered "(no output yet; task X is succeeded)".
   */
  test("a silent child that exits 0 is failed, not succeeded, and says why (issue #70)", async () => {
    await withAgent(async (dir) => {
      const h = createHarness({ start: 1000 });
      const handle = asHandle(
        await dispatch(
          { agent: AGENT, task: "silent", background: true, agentScope: "project" },
          { callId: 20, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          h.deps,
        ),
      );

      // The real pi 0.87.1 shape: a retried-out turn leaves an assistant message with no text.
      h.lifecycle.pushEvent(h.lifecycle.handleAt(0), {
        type: "message_end",
        message: { role: "assistant", content: [] },
      });
      h.clock.set(1500);
      h.lifecycle.resolveExit(h.lifecycle.handleAt(0), 0, null);

      const record = await waitForTerminal(h.storage, handle.taskId);
      expect(record.status).toBe("failed");
      expect(record.exitCode).toBe(0);
      expect(record.errorMessage).toBe("dispatch produced no final text");
      expect(record.outputBytes).toBe(0);
      expect(h.slots.active).toBe(0);
    });
  });

  /**
   * The other half of issue #70: the provider's own reason reaches the record, so the model is
   * told *why* rather than only *that*. The string is the captured 429 body from the report.
   *
   * Counterfactual: deleting `childAssistantError` (or not threading `childError` into the
   * transition) turns this red.
   */
  test("the child's own error is written to the record so the model is told why (issue #70)", async () => {
    await withAgent(async (dir) => {
      const h = createHarness({ start: 1000 });
      const handle = asHandle(
        await dispatch(
          { agent: AGENT, task: "rate-limited", background: true, agentScope: "project" },
          { callId: 21, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          h.deps,
        ),
      );
      const providerError =
        '429 {"type":"error","error":{"type":"rate_limit_error","message":"已达到 Token Plan 用量上限"}}';

      h.lifecycle.pushEvent(h.lifecycle.handleAt(0), {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: providerError,
          content: [],
        },
      });
      h.clock.set(1500);
      h.lifecycle.resolveExit(h.lifecycle.handleAt(0), 0, null);

      const record = await waitForTerminal(h.storage, handle.taskId);
      expect(record.status).toBe("failed");
      expect(record.errorMessage).toBe(providerError);
    });
  });

  /**
   * pi 1.2.0's print-mode truncation close, end to end through the real pump: the child exits 1
   * with partial text and pi's stderr warning (`dist/modes/print-mode.js:126`), and the record
   * names the cause in the foreground's own words. The stderr is planted through the mock
   * adapter's `setStderr` seam — the same buffer the foreground close handler reads — so this
   * drives the pump's ACTUAL capture, not the registry's handling of a hand-built command (that
   * half lives in `task-registry.test.ts`).
   *
   * Counterfactual: deleting the `lifecycle.stderr(handle)` call in the background pump turns
   * this red — the record reverts to an unlabelled `failed`, which is exactly the pi 1.2.0
   * regression this exists to prevent.
   */
  test("a truncated child's stderr warning reaches the record through the real pump", async () => {
    await withAgent(async (dir) => {
      const h = createHarness({ start: 1000 });
      const handle = asHandle(
        await dispatch(
          { agent: AGENT, task: "truncated", background: true, agentScope: "project" },
          { callId: 23, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          h.deps,
        ),
      );

      // pi 1.2.0 prints the partial text to stdout AND the warning to stderr, then exits 1.
      h.lifecycle.pushEvent(h.lifecycle.handleAt(0), {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "partial answer" }] },
      });
      h.lifecycle.setStderr(
        h.lifecycle.handleAt(0),
        "Response was truncated: the model reached its output token limit.\n",
      );
      h.clock.set(1500);
      h.lifecycle.resolveExit(h.lifecycle.handleAt(0), 1, null);

      const record = await waitForTerminal(h.storage, handle.taskId);
      expect(record.status).toBe("failed");
      expect(record.exitCode).toBe(1);
      expect(record.errorMessage).toBe(
        "child response was truncated at the model's output token limit (pi exited non-zero)",
      );
      expect(h.slots.active).toBe(0);
    });
  });

  /**
   * The exit-0 half of the invariant, and the reason the pump computes its diagnostic behind an
   * `exitCode !== 0` guard. The foreground's `decideCloseOutcome` answers an exit-0 close with
   * "dispatch produced no final text" whatever the stderr says, so if the pump computed the
   * diagnostic for an exit-0 close the two fronts would hand the model two different
   * explanations of the same child.
   *
   * Counterfactual: dropping the guard in the pump turns this red.
   */
  test("an exit-0 close with a truncation warning in stderr is NOT labelled a truncation", async () => {
    await withAgent(async (dir) => {
      const h = createHarness({ start: 1000 });
      const handle = asHandle(
        await dispatch(
          {
            agent: AGENT,
            task: "truncated but exited clean",
            background: true,
            agentScope: "project",
          },
          { callId: 40, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          h.deps,
        ),
      );

      h.lifecycle.setStderr(
        h.lifecycle.handleAt(0),
        "Response was truncated: the model reached its output token limit.",
      );
      h.clock.set(1500);
      // exit 0 with no assistant text: the foreground calls this "no final text".
      h.lifecycle.resolveExit(h.lifecycle.handleAt(0), 0, null);

      const record = await waitForTerminal(h.storage, handle.taskId);
      expect(record.status).toBe("failed");
      expect(record.errorMessage).toBe("dispatch produced no final text");
    });
  });
  /**
   * The counterfactual pair: the same close with stderr that does NOT name truncation stays
   * unlabelled. A predicate that reported truncation for any non-zero close would pass the
   * test above while lying about every other failure mode.
   */
  test("an unrelated non-zero close with stderr stays unlabelled through the real pump", async () => {
    await withAgent(async (dir) => {
      const h = createHarness({ start: 1000 });
      const handle = asHandle(
        await dispatch(
          { agent: AGENT, task: "auth-failure", background: true, agentScope: "project" },
          { callId: 24, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          h.deps,
        ),
      );
      h.lifecycle.setStderr(
        h.lifecycle.handleAt(0),
        "Authentication failed for \"deepseek\". Run '/login deepseek' to re-authenticate.",
      );
      h.clock.set(1500);
      h.lifecycle.resolveExit(h.lifecycle.handleAt(0), 1, null);

      const record = await waitForTerminal(h.storage, handle.taskId);
      expect(record.status).toBe("failed");
      expect(record.errorMessage).toBeUndefined();
    });
  });

  /**
   * A healthy child ends its turn with `stopReason: "stop"`, not `"error"`. Reading the
   * stopReason loosely would flip every successful child to `failed`; this guards against that
   * over-correction, and fails if `childAssistantError` stops checking the value.
   */
  test("a normal stopReason is not mistaken for a failure (issue #70)", async () => {
    await withAgent(async (dir) => {
      const h = createHarness({ start: 1000 });
      const handle = asHandle(
        await dispatch(
          { agent: AGENT, task: "healthy", background: true, agentScope: "project" },
          { callId: 22, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          h.deps,
        ),
      );
      h.lifecycle.pushEvent(h.lifecycle.handleAt(0), {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "PONG" }],
        },
      });
      h.clock.set(1500);
      h.lifecycle.resolveExit(h.lifecycle.handleAt(0), 0, null);

      const record = await waitForTerminal(h.storage, handle.taskId);
      expect(record.status).toBe("succeeded");
      expect(record.errorMessage).toBeUndefined();
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
      // The foreground branch now honours the INJECTED lifecycle, so nothing real is spawned and
      // the test drives the mock's exit. Before the seam it spawned a real child through the module
      // level lifecycle, which is why this test used to take half a second and needed a real pi.
      const settled = dispatch(
        { agent: AGENT, task: "ping", agentScope: "project" },
        { callId: 3, cwd: dir, depth: 0, maxDispatchDepth: 3 },
        h.deps,
      );
      await waitFor(() => h.lifecycle.spawnCount > 0);
      h.lifecycle.resolveExit(h.lifecycle.handleAt(0), 0, null);
      const result = await settled;

      // Exact DispatchResult outcome produced by the mocked clean close with no assistant text.
      expect(result.status).toBe("rejected");
      expect(result.errorMessage).toBe("dispatch produced no final text");
      expect(result.exitCode).toBe(0);
      expect(result.started).toBe(true);
      expect("taskId" in result).toBe(false);

      // One child, launched through the INJECTED lifecycle. That is the change round 5 made:
      // the foreground branch used to read the module-level lifecycle only, so this line used
      // to read 1 with the mock at 0, and a test could not assert that a saturated counter
      // launches nothing without watching a real process on PATH. The seam is now honest for
      // both fronts.
      expect(h.lifecycle.spawnCount).toBe(1);
      expect(spawnRecorder.calls, "the module-level lifecycle was not used").toBe(0);
      // The slot is back: finalize is the one release, and this call reached it.
      expect(h.slots.active).toBe(0);
      // The BACKGROUND seams really are still untouched, which is what this test is for.
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

  test("ptc_task_output projects the tier back off the record (ADR-0041)", async () => {
    /*
     * The last leg of the chain, and the only one this file can own: the record field is written
     * in `dispatch.ts`, and `ptc_task_output` is what hands it back to a model or a script. The
     * test for that projection lives in `tests/unit/ptc-task-tools.test.ts`, which this change
     * does not own, so it is pinned HERE instead — with the same registry, the same output
     * storage and a REAL background dispatch in front of it, rather than a hand-built record.
     *
     * Both spellings, because they are different surfaces: `details` is camelCase like the
     * record it reads, `structuredContent` is snake_case like every other key on it (ADR-0028).
     * Getting that second one wrong is invisible to a script that only reads the first.
     *
     * COUNTERFACTUAL: drop the `read_only_tier` spread in `createPtcTaskOutputTool`'s
     * structuredContent literal and only the snake_case assertion turns red; drop the `details`
     * spread and only the camelCase one does. Two edits, two independent pins.
     */
    await withAgent(async (dir) => {
      const h = createHarness({ start: 1000 });
      const outputStorage = new InMemoryOutputStorage();
      const deps: DispatchDeps = { ...h.deps, outputStorage };
      const handle = asHandle(
        await dispatch(
          {
            agent: AGENT,
            task: "survey",
            background: true,
            agentScope: "project",
            readOnly: "strict",
          },
          { callId: 2, cwd: dir, depth: 0, maxDispatchDepth: 3 },
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

      const tool = createPtcTaskOutputTool(h.registry, outputStorage);
      const result = (await tool.execute(
        "call-1",
        { taskId: record.id },
        undefined,
        undefined,
        undefined as never,
        // `as unknown as`, not `as`: pi 0.86.0's `AgentToolResult` has no `structuredContent`
        // at all, so a direct cast to a type that REQUIRES one is TS2352 on the declared floor.
        // Measured by `pnpm run compat:pi 0.86.0` — this file was the only failure in the whole
        // floor leg, and `as` was the whole of it.
      )) as unknown as
        | {
            details: { readOnlyTier?: string; output: string };
            structuredContent: { read_only_tier?: string };
          }
        | undefined;
      expect(result, "the tool returned a result").toBeDefined();
      expect(result?.details.readOnlyTier, "details keeps the record's camelCase spelling").toBe(
        "strict",
      );
      expect(
        result?.structuredContent.read_only_tier,
        "the codemode projection is snake_case, like every other key on it",
      ).toBe("strict");
      // And the child's prose is still there: the tier is a sibling of the output, never a
      // replacement for it.
      expect(result?.details.output).toContain("PONG");
    });
  });

  test("ptc_task_output carries no tier key for a task dispatched without one", async () => {
    // The absence half, and the row that makes the presence one mean something: a projection that
    // always emitted `read_only_tier` would satisfy the test above. `Object.hasOwn`, because an
    // explicitly-undefined key vanishes at the JSON boundary anyway and a script would then be
    // holding a projection its own schema does not describe.
    await withAgent(async (dir) => {
      const h = createHarness({ start: 1000 });
      const outputStorage = new InMemoryOutputStorage();
      const deps: DispatchDeps = { ...h.deps, outputStorage };
      const handle = asHandle(
        await dispatch(
          { agent: AGENT, task: "survey", background: true, agentScope: "project" },
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

      const tool = createPtcTaskOutputTool(h.registry, outputStorage);
      const result = (await tool.execute(
        "call-2",
        { taskId: record.id },
        undefined,
        undefined,
        undefined as never,
        // Same floor reason as the cast above: `structuredContent` does not exist on
        // pi 0.86.0's `AgentToolResult`.
      )) as unknown as { details: object; structuredContent: object } | undefined;
      expect(Object.hasOwn(result?.structuredContent ?? {}, "read_only_tier")).toBe(false);
      expect(Object.hasOwn(result?.details ?? {}, "readOnlyTier")).toBe(false);
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

// ---------------------------------------------------------------------------
//  host-observed usage, on every close (issue #199)
// ---------------------------------------------------------------------------

/**
 * The six-field accumulator the host keeps over a child's assistant `message_end` blocks, for the
 * same `REPORT_USAGE` literal the report fixtures above hand their children: input 900, output 260,
 * cost 0.0123, one turn — plus the two cache counters the report's four-field view does not carry.
 * Written out by hand rather than read back out of the accumulator, so the expectation has an
 * independent source (testing-constraints #4).
 */
const RECORD_USAGE = {
  input: 900,
  output: 260,
  cacheRead: 7,
  cacheWrite: 11,
  cost: 0.0123,
  turns: 1,
};

/** The four fields the record's own carrier shares with `report.usage` (ADR-0032's derived view). */
const REPORT_VIEW_USAGE = { input: 900, output: 260, cost: 0.0123, turns: 1 };

const OPTOUT_AGENT = "bg-probe-optout";
const OPTOUT_AGENT_MD =
  "---\nname: bg-probe-optout\nchildReport: false\n---\nYou probe, having asked for nothing.\n";

/**
 * A project-scope cwd holding ONLY the opted-out agent. Deliberately not folded into `withAgent`:
 * that fixture's dir also backs the "registered agents: [bg-probe]" assertion, and a second
 * definition there would rewrite a list a different test pins.
 */
async function withOptOutAgent<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await makeTempDir();
  try {
    await mkdir(join(dir, ".pi", "agents"), { recursive: true });
    await writeFile(join(dir, ".pi", "agents", OPTOUT_AGENT + ".md"), OPTOUT_AGENT_MD, {
      encoding: "utf-8",
    });
    return await body(dir);
  } finally {
    await removeTempDir(dir);
  }
}

/**
 * Emit one assistant message carrying the fixture usage block, then close the child. `text`
 * omitted means an empty assistant message — the shape pi writes for a turn that produced no
 * content at all.
 */
function driveClose(
  h: Harness,
  index: number,
  close: { code: number | null; text?: string },
): void {
  const handle = h.lifecycle.handleAt(index);
  h.lifecycle.pushEvent(handle, {
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: close.text === undefined ? [] : [{ type: "text", text: close.text }],
      usage: REPORT_USAGE,
    },
  });
  h.clock.set(1500);
  h.lifecycle.resolveExit(handle, close.code, null);
}

/** A record as persisted BEFORE the usage carrier existed: no `usage` key at all, report intact. */
function legacySucceededRecord(id: ULID): TaskRecord {
  return {
    id,
    label: "legacy",
    agentName: AGENT,
    depth: 1,
    status: "succeeded",
    createdAt: 1000,
    startedAt: 1000,
    finishedAt: 1500,
    durationMs: 500,
    transitionAt: 1500,
    outputRef: "memory:tasks/" + id + "/output.log",
    outputBytes: 4,
    outputPreview: "PONG",
    exitCode: 0,
    spawnSource: { kind: "ptc-program", callerId: "owner-legacy" },
    report: {
      summary: "a report from before the carrier existed",
      findings: [{ what: "usage lived in the report", evidence: "report.usage: input=900" }],
      files_touched: ["src/runtime/dispatch.ts"],
      usage: { input: 900, output: 260, cost: 0.0123, turns: 1 },
    },
    reportChannel: "prompt-json",
  };
}

/**
 * Run `ptc_task_output` over one task and hand back both of its read surfaces: `text` is
 * `content[0].text`, the render the model actually reads (report block, usage line, prose after
 * it), and `details` is the TUI's structure. Comparing `details.output` alone compares the
 * child's PROSE — a difference in the block rendered above it never reaches that field.
 */
async function readBackOutput(
  tool: ReturnType<typeof createPtcTaskOutputTool>,
  taskId: ULID,
): Promise<{
  text: string;
  details: { output: string; taskId: string };
}> {
  const result = (await tool.execute(
    "call-1",
    { taskId },
    undefined,
    undefined,
    undefined as never,
  )) as unknown as
    | {
        content: Array<{ type: string; text?: string }>;
        details: { output: string; taskId: string };
      }
    | undefined;
  if (result === undefined) throw new Error("ptc_task_output returned no result");
  const text = result.content[0]?.text;
  if (text === undefined) throw new Error("ptc_task_output returned no text block");
  return { text, details: result.details };
}

/**
 * The block `ptc_task_output` returned for {@link legacySucceededRecord}'s report BEFORE #199 —
 * the base-commit `renderChildReport`'s `prompt-json` branch, quoted rather than rebuilt from
 * today's code. A record carrying no `usage` (one written before the field existed) has to still
 * produce exactly this, which is what makes the change additive for old records.
 */
const LEGACY_PROMPT_JSON_BLOCK =
  '<child-report channel="prompt-json">\n' +
  "summary: a report from before the carrier existed\n" +
  "findings (1):\n" +
  "  1. usage lived in the report — evidence: report.usage: input=900\n" +
  "files_touched: src/runtime/dispatch.ts\n" +
  "usage: input=900 output=260 cost=0.0123 turns=1\n" +
  "</child-report>";

describe("background pump: host-observed usage survives every close (issue #199)", () => {
  /**
   * The `none` channel — a child that answered in prose and ignored the report contract. It is
   * `succeeded` with no report at all, so before this ticket it was also the case that vanishing
   * number: the one place its cost could have been written was a report that does not exist.
   */
  test("a child that answered in prose only (channel none) still accounts for its usage", async () => {
    await withAgent(async (dir) => {
      const h = createHarness({ start: 1000 });
      const handle = asHandle(
        await dispatch(
          { agent: AGENT, task: "prose only", background: true, agentScope: "project" },
          { callId: 40, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          h.deps,
        ),
      );
      driveClose(h, 0, { code: 0, text: "Here is the answer, in prose only." });

      const record = await waitForTerminal(h.storage, handle.taskId);
      expect(record.status).toBe("succeeded");
      // The non-compliance marker stays exactly what it was: no report is fabricated.
      expect(record.reportChannel).toBe("none");
      expect(Object.hasOwn(record, "report")).toBe(false);
      // ...and the cost is still accounted for, which is the whole of this ticket.
      expect(record.usage).toEqual(RECORD_USAGE);
    });
  });

  test("an opted-out child still accounts for its usage", async () => {
    await withOptOutAgent(async (dir) => {
      const h = createHarness({ start: 1000 });
      const handle = asHandle(
        await dispatch(
          { agent: OPTOUT_AGENT, task: "no report asked", background: true, agentScope: "project" },
          { callId: 41, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          h.deps,
        ),
      );
      driveClose(h, 0, { code: 0, text: "An answer nobody asked to have summarised." });

      const record = await waitForTerminal(h.storage, handle.taskId);
      expect(record.status).toBe("succeeded");
      // Nobody asked, so there is no report and no compliance claim — `opted-out` says exactly
      // that, and it is not a reason for the spend to go unrecorded.
      expect(record.reportChannel).toBe("opted-out");
      expect(Object.hasOwn(record, "report")).toBe(false);
      expect(record.usage).toEqual(RECORD_USAGE);
    });
  });

  test("a child that ran and closed failed still accounts for its usage", async () => {
    await withAgent(async (dir) => {
      const h = createHarness({ start: 1000 });
      const handle = asHandle(
        await dispatch(
          { agent: AGENT, task: "dies after answering", background: true, agentScope: "project" },
          { callId: 42, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          h.deps,
        ),
      );
      driveClose(h, 0, { code: 1, text: "half an answer before it died" });

      const record = await waitForTerminal(h.storage, handle.taskId);
      expect(record.status).toBe("failed");
      // The report pair is still absent (ADR-0032: a child that did not finish has not reported),
      // which is precisely why the counter needs its own carrier.
      expect(Object.hasOwn(record, "report")).toBe(false);
      expect(Object.hasOwn(record, "reportChannel")).toBe(false);
      expect(record.usage).toEqual(RECORD_USAGE);
    });
  });

  test("a canceled child still accounts for its usage", async () => {
    await withAgent(async (dir) => {
      const h = createHarness({ start: 1000 });
      const callerId = "owner-1";
      const handle = asHandle(
        await dispatch(
          { agent: AGENT, task: "long", background: true, agentScope: "project" },
          { callId: 43, cwd: dir, depth: 0, maxDispatchDepth: 3, callerId },
          h.deps,
        ),
      );
      await h.registry.transition(
        { kind: "stop", taskId: handle.taskId, reason: "model stop" },
        { clock: h.clock.clock, callerId },
      );
      driveClose(h, 0, { code: 0, text: "text that arrived after the stop" });

      const record = await waitForTerminal(h.storage, handle.taskId);
      // ADR-0022 §8: the stop wins the terminal decision, so this close resolves `canceled`
      // rather than `succeeded` (the same edge `background stop signal ladder` pins).
      expect(record.status).toBe("canceled");
      expect(Object.hasOwn(record, "report")).toBe(false);
      // Tokens were spent before the signal landed, and a canceled task still cost them.
      expect(record.usage).toEqual(RECORD_USAGE);
    });
  });

  test("both carriers exist and the four shared fields agree", async () => {
    await withAgent(async (dir) => {
      const h = createHarness({ start: 1000 });
      const handle = asHandle(
        await dispatch(
          { agent: AGENT, task: "report", background: true, agentScope: "project" },
          { callId: 44, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          h.deps,
        ),
      );
      driveClose(h, 0, { code: 0, text: REPORT_TEXT });

      const record = await waitForTerminal(h.storage, handle.taskId);
      expect(record.status).toBe("succeeded");
      expect(record.reportChannel).toBe("prompt-json");
      // Each carrier against the same observed block, independently...
      expect(record.usage).toEqual(RECORD_USAGE);
      expect(record.report?.usage).toEqual(REPORT_VIEW_USAGE);
      // ...and against each other. A second accumulator instance would not fail either assertion
      // above on its own — it would need the two to drift first — so this is the invariant that
      // would make one child carry two different truths, stated on its own.
      expect(record.report?.usage?.input).toBe(record.usage?.input);
      expect(record.report?.usage?.output).toBe(record.usage?.output);
      expect(record.report?.usage?.cost).toBe(record.usage?.cost);
      expect(record.report?.usage?.turns).toBe(record.usage?.turns);
    });
  });

  /**
   * A refusal never started a child, so there is nothing that could have spent anything. The
   * assertion is the empty record list rather than a missing field on a record: "no usage" here
   * means "no record", and a task row must not be invented to carry a zero.
   */
  test("a refusal (depth gate / unknown agent) leaves no record for a usage to live on", async () => {
    const h = createHarness();
    const gated = asResult(
      await dispatch(
        { agent: AGENT, task: "x", background: true },
        { callId: 45, cwd: process.cwd(), depth: 3, maxDispatchDepth: 3 },
        h.deps,
      ),
    );
    const unknown = asResult(
      await dispatch(
        { agent: "__bg_missing_agent__", task: "x", background: true },
        { callId: 46, cwd: process.cwd(), depth: 0, maxDispatchDepth: 3 },
        h.deps,
      ),
    );

    expect(gated.status).toBe("rejected");
    expect(gated.started).toBe(false);
    expect(unknown.status).toBe("rejected");
    expect(unknown.started).toBe(false);
    expect(h.lifecycle.spawnCount).toBe(0);
    expect(await allTasks(h.storage)).toEqual([]);
  });

  test("a live child has no usage yet, and the N+1th refusal adds no record that could", async () => {
    await withAgent(async (dir) => {
      const h = createHarness({ limit: 1 });
      const first = asHandle(
        await dispatch(
          { agent: AGENT, task: "one", background: true, agentScope: "project" },
          { callId: 47, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          h.deps,
        ),
      );
      // The child has answered and the host has counted, but the record has not been written by
      // a close yet — the counter is a close-time write, not a spawn-time or live one.
      h.lifecycle.pushEvent(h.lifecycle.handleAt(0), {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "PONG" }],
          usage: REPORT_USAGE,
        },
      });
      const live = await h.storage.loadTask(first.taskId);
      expect(live?.status).toBe("running");
      expect(Object.hasOwn(live as object, "usage")).toBe(false);

      const refused = asResult(
        await dispatch(
          { agent: AGENT, task: "two", background: true, agentScope: "project" },
          { callId: 48, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          h.deps,
        ),
      );
      expect(refused.errorMessage).toBe(BG_CONCURRENCY_REFUSAL);
      expect(await allTasks(h.storage)).toHaveLength(1);
      expect(h.lifecycle.spawnCount).toBe(1);

      h.clock.set(1500);
      h.lifecycle.resolveExit(h.lifecycle.handleAt(0), 1, null);
      const closed = await waitForTerminal(h.storage, first.taskId);
      expect(closed.status).toBe("failed");
      expect(closed.usage).toEqual(RECORD_USAGE);
    });
  });

  test("a legacy record with no usage field reads and renders exactly as one with it", async () => {
    // A record written before this field existed, side by side with an otherwise identical one
    // that carries it. Differential oracle (testing-constraints #4 source 5): the two inputs
    // differ in exactly one key, so any difference in what the record layer hands back — or in
    // what the model-facing render says — is that key leaking.
    const h = createHarness({ start: 1000 });
    const outputStorage = new InMemoryOutputStorage();
    const legacyId = "01JBZ0000000000000000000L1" as ULID;
    const carrierId = "01JBZ0000000000000000000L2" as ULID;
    const legacy = legacySucceededRecord(legacyId);
    await h.storage.saveTask(legacy);
    await h.storage.saveTask({ ...legacy, id: carrierId, usage: RECORD_USAGE });
    await outputStorage.writeOutput(legacyId, "PONG");
    await outputStorage.writeOutput(carrierId, "PONG");

    const tool = createPtcTaskOutputTool(h.registry, outputStorage);
    const legacyRead = await readBackOutput(tool, legacyId);
    const carrierRead = await readBackOutput(tool, carrierId);

    // The render, not just `details.output`: that field is the child's PROSE, which both records
    // were given identically ("PONG"), so it cannot see the block above it growing a zeroed
    // `usage: input=0 output=0 cost=0 turns=0` line. The legacy record's text is pinned to the
    // pre-#199 block verbatim — a literal with an independent source, not a value read back out
    // of today's renderer.
    expect(legacyRead.text).toBe(`${LEGACY_PROMPT_JSON_BLOCK}\nPONG`);
    // ...and byte-identically to the same record carrying the carrier, which is the claim in the
    // test's name: the missing key changes nothing a model can read.
    expect(legacyRead.text).toBe(carrierRead.text);
    expect(legacyRead.details.output).toBe(carrierRead.details.output);
    expect(legacyRead.details.output).toContain("PONG");
    // The legacy record gains NOTHING on the way through — no synthesized accumulator, and no
    // other field rewritten.
    const reloaded = await h.storage.loadTask(legacyId);
    expect(Object.hasOwn(reloaded as object, "usage")).toBe(false);
    expect(reloaded).toEqual(legacy);
  });
});
