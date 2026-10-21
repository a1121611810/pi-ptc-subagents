/**
 * ADR-0053: every dispatch is a task. The foreground front included.
 *
 * The ticket's five acceptance criteria, one test each, plus the two seams the change had to
 * open to be testable at all:
 *
 *   1. a foreground dispatch creates a task record, and the result names it;
 *   2. the foreground child's output is persisted under `<sessionDir>/tasks/<id>/output.log`;
 *   3. the child's report is readable AFTER the call returned (today it is not readable at all);
 *   4. a request refused by a gate leaves no record — the gate is above the record;
 *   5. the concurrency slot is keyed by the task id, so ending one of two concurrent tasks does
 *      not release the other's slot;
 *   6. the task face is in the model's face exactly when the session has a task record.
 *
 * SPECIFICATION tests (docs/testing-constraints.md #4/#6): every expected value is a literal
 * from the ticket or the spec, a real file path, or a value read back out of the fixture — never
 * something the implementation happened to produce.
 *
 * Dependencies are injected (#1): the child is a `MockChildProcessLifecycle`, the record store is
 * an `InMemoryTaskStorage` (or a `FileTaskStorage` for the resumed-session case), and the output
 * store is an `InMemoryOutputStorage` (or a `FileOutputStorage` for the on-disk path case), so
 * no `pi` process is ever spawned and no home directory is touched.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  DispatchSlotCounter,
  dispatch,
  setPromptFileWriter,
  type DispatchDeps,
} from "../../src/runtime/dispatch.ts";
import {
  MockChildProcessLifecycle,
  type ChildHandle,
} from "../../src/runtime/child-process-lifecycle.ts";
import { createTaskRegistry, type TaskRegistry } from "../../src/runtime/task-registry.ts";
import { InMemoryTaskStorage, type TaskRecord, type ULID } from "../../src/runtime/task-storage.ts";
import { FileOutputStorage, InMemoryOutputStorage } from "../../src/runtime/output-storage.ts";
import { createBackgroundTaskRuntime } from "../../src/runtime/background-runtime.ts";
import { createPtcTaskListTool, createPtcTaskOutputTool } from "../../src/tools/ptc-task.ts";
import { makeTempDir, removeTempDir, waitFor } from "../helpers/ptc.ts";

const AGENT = "foreground-probe";
const AGENT_MD = "---\nname: foreground-probe\n---\nYou answer.\n";

/** The child's answer, a literal — not a value the implementation produced. */
const ANSWER = "PONG";

/**
 * The child's report, in the shape ADR-0032's prompt channel parses: a fenced ```json block with
 * exactly `summary` / `findings` / `files_touched`. The three field values are literals.
 */
const REPORT_BLOCK =
  "Here is the answer.\n\n" +
  "```json\n" +
  JSON.stringify({
    summary: "the probe answered",
    findings: [{ what: "it answered", evidence: "the transcript says PONG" }],
    files_touched: [],
  }) +
  "\n```";

/** Records every handle the foreground branch spawns, so a test can drive its exit. */
class RecordingLifecycle extends MockChildProcessLifecycle {
  readonly spawned: ChildHandle[] = [];

  override spawn(
    argv: readonly string[],
    opts: Parameters<MockChildProcessLifecycle["spawn"]>[1],
  ): ChildHandle {
    const handle = super.spawn(argv, opts);
    this.spawned.push(handle);
    return handle;
  }

  /** The handle at `index`, or a loud failure (no unchecked-index silencing). */
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
  outputStorage: InMemoryOutputStorage;
  deps: DispatchDeps;
}

function createHarness(options: { limit?: number } = {}): Harness {
  const storage = new InMemoryTaskStorage();
  const registry = createTaskRegistry(storage, { clock: () => 1_000 });
  const lifecycle = new RecordingLifecycle();
  const slots = new DispatchSlotCounter(options.limit ?? 8);
  const outputStorage = new InMemoryOutputStorage();
  return {
    storage,
    registry,
    lifecycle,
    slots,
    outputStorage,
    deps: { taskRegistry: registry, lifecycle, slots, outputStorage, clock: () => 1_000 },
  };
}

/** Write a project-scope agent markdown into a fresh temp cwd and run `body`. */
async function withAgent<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await makeTempDir();
  try {
    await mkdir(join(dir, ".pi", "agents"), { recursive: true });
    await writeFile(join(dir, ".pi", "agents", AGENT + ".md"), AGENT_MD, { encoding: "utf-8" });
    // The prompt temp file is not what these tests are about, and the real writer costs an fs
    // round trip PER DISPATCH (mkdtemp + writeFile, then an unlink + rmdir on the way out).
    // This file drives nine dispatches, and under the full suite's parallel load that IO is the
    // difference between finishing inside vitest's default budget and not. The seam is the
    // repo's own (`setPromptFileWriter`), and the fake points at a path that does not exist, so
    // the dispatch's best-effort cleanup finds nothing to remove and touches nothing.
    setPromptFileWriter(async () => ({
      dir: join(dir, "prompt-dir"),
      filePath: join(dir, "prompt-dir", "prompt.md"),
    }));
    try {
      return await body(dir);
    } finally {
      setPromptFileWriter(undefined);
    }
  } finally {
    await removeTempDir(dir);
  }
}

/** Every record the storage holds, in whatever order it lists them. */
async function allTasks(storage: InMemoryTaskStorage): Promise<TaskRecord[]> {
  const out: TaskRecord[] = [];
  for await (const record of storage.listTasks()) out.push(record);
  return out;
}

/** Drive one foreground child to a clean close with `text` as its answer. */
function answerChild(lifecycle: RecordingLifecycle, index: number, text: string): void {
  lifecycle.pushEvent(lifecycle.handleAt(index), {
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] },
  });
  lifecycle.resolveExit(lifecycle.handleAt(index), 0, null);
}

// ---------------------------------------------------------------------------
//  1. every dispatch creates a task record, and the result names it
// ---------------------------------------------------------------------------

describe("ADR-0053: a foreground dispatch is a task", () => {
  test("the dispatch leaves one task record behind, and the result carries its id and label", async () => {
    await withAgent(async (dir) => {
      const h = createHarness();
      const settled = dispatch(
        { agent: AGENT, task: "ping", agentScope: "project", label: "probe the thing" },
        { callId: 1, cwd: dir, depth: 0, maxDispatchDepth: 3 },
        h.deps,
      );
      await waitFor(() => h.lifecycle.spawnCount > 0);
      answerChild(h.lifecycle, 0, ANSWER);
      const result = await settled;

      // The result names the record, so the caller can look the child up afterwards.
      // Expected values: the label the caller passed, and a non-empty id.
      expect(result.status, "the child answered, so the dispatch fulfilled").toBe("fulfilled");
      expect(result.text).toBe(ANSWER);
      expect(result.recordLabel, "the label the caller passed is the record's label").toBe(
        "probe the thing",
      );
      expect(typeof result.recordId, "the result names the record it created").toBe("string");
      expect(result.recordId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

      // The record itself: the registry is the dispatch's only trace (spec decision 4).
      const records = await allTasks(h.storage);
      expect(records, "the foreground dispatch left exactly one record").toHaveLength(1);
      const record = records[0];
      expect(record?.id, "the record's id is the id the result handed back").toBe(result.recordId);
      expect(record?.status, "a child that answered and exited 0 succeeded").toBe("succeeded");
      expect(record?.label).toBe("probe the thing");
      expect(record?.agentName).toBe(AGENT);
      expect(record?.outputBytes, "the record accounts for the output it stored").toBe(
        ANSWER.length,
      );
    });
  });

  test("the record is still there after the call returned — a finished task is not deleted", async () => {
    await withAgent(async (dir) => {
      const h = createHarness();
      const settled = dispatch(
        { agent: AGENT, task: "ping", agentScope: "project" },
        { callId: 1, cwd: dir, depth: 0, maxDispatchDepth: 3 },
        h.deps,
      );
      await waitFor(() => h.lifecycle.spawnCount > 0);
      answerChild(h.lifecycle, 0, ANSWER);
      const result = await settled;

      // A SECOND read, after the dispatch is over: the record survives its own completion.
      const later = await h.registry.get(result.recordId as ULID);
      expect(later, "the finished record is still on the registry").not.toBeNull();
      expect(later?.status).toBe("succeeded");
      expect(later?.finishedAt, "a finished record says when it finished").toBe(1_000);
    });
  });
});

// ---------------------------------------------------------------------------
//  2 + 3. the child's output and report are persisted, and readable afterwards
// ---------------------------------------------------------------------------

describe("ADR-0053: the foreground child's output is on disk", () => {
  test("the output lands at <sessionDir>/tasks/<id>/output.log, and ptc_task_output reads it back", async () => {
    await withAgent(async (dir) => {
      const sessionDir = join(dir, "session");
      const h = createHarness();
      const outputStorage = new FileOutputStorage(sessionDir);
      const deps: DispatchDeps = { ...h.deps, outputStorage };
      const settled = dispatch(
        { agent: AGENT, task: "ping", agentScope: "project" },
        { callId: 1, cwd: dir, depth: 0, maxDispatchDepth: 3 },
        deps,
      );
      await waitFor(() => h.lifecycle.spawnCount > 0);
      answerChild(h.lifecycle, 0, ANSWER);
      const result = await settled;

      // The path is the one the ticket names, spelled out: <sessionDir>/tasks/<id>/output.log.
      const path = join(sessionDir, "tasks", String(result.recordId), "output.log");
      expect(await readFile(path, "utf8"), "the child's answer is on disk").toBe(ANSWER);

      // And the model-facing tool reads the SAME bytes, so the model is not told about a
      // second, different copy of the output.
      const tool = createPtcTaskOutputTool(h.registry, outputStorage);
      const rendered = await tool.execute(
        "call-1",
        { taskId: String(result.recordId) },
        undefined,
        undefined,
        undefined as never,
      );
      const text = rendered.content.map((part) => (part as { text?: string }).text ?? "").join("");
      expect(text, "the task-output tool shows the persisted output").toContain(ANSWER);
    });
  });

  test("the child's REPORT is readable after the call returned", async () => {
    await withAgent(async (dir) => {
      const h = createHarness();
      const settled = dispatch(
        { agent: AGENT, task: "ping", agentScope: "project" },
        { callId: 1, cwd: dir, depth: 0, maxDispatchDepth: 3 },
        h.deps,
      );
      await waitFor(() => h.lifecycle.spawnCount > 0);
      answerChild(h.lifecycle, 0, REPORT_BLOCK);
      const result = await settled;

      // The report reached the RESULT (the foreground front always reported it)...
      expect(result.report?.summary, "the result carries the child's report").toBe(
        "the probe answered",
      );

      // ...and it is ALSO on the record, so the model can read it back later. Before this
      // ticket the foreground path left no record at all, so this read could not happen.
      const record = await h.registry.get(result.recordId as ULID);
      expect(record?.report?.summary, "the record carries the same report").toBe(
        "the probe answered",
      );
      expect(record?.reportChannel, "the report's channel is stated").toBe("prompt-json");

      const tool = createPtcTaskOutputTool(h.registry, h.outputStorage);
      const rendered = await tool.execute(
        "call-1",
        { taskId: String(result.recordId) },
        undefined,
        undefined,
        undefined as never,
      );
      const text = rendered.content.map((part) => (part as { text?: string }).text ?? "").join("");
      expect(text, "the task-output tool renders the report").toContain("the probe answered");
    });
  });
});

// ---------------------------------------------------------------------------
//  4. a refused request leaves no record
// ---------------------------------------------------------------------------

describe("ADR-0053: the gate is above the record", () => {
  test("a call refused by the depth gate creates no record", async () => {
    await withAgent(async (dir) => {
      const h = createHarness();
      const result = await dispatch(
        { agent: AGENT, task: "ping", agentScope: "project" },
        { callId: 1, cwd: dir, depth: 3, maxDispatchDepth: 3 },
        h.deps,
      );

      expect(result.status).toBe("rejected");
      expect(result.errorMessage).toBe("dispatch depth limit reached");
      expect(await allTasks(h.storage), "the depth gate is above the record too").toEqual([]);
    });
  });

  test("ADR-0056: the cap is a queue, so a request over it leaves a QUEUED record, not none", async () => {
    await withAgent(async (dir) => {
      // A counter with no room: the request cannot start now, so it WAITS. ADR-0056 replaced
      // the refusal with the queue, so the record it leaves says `queued` — the queue IS the
      // set of queued records.
      const h = createHarness({ limit: 0 });
      let settled = false;
      const queued = dispatch(
        { agent: AGENT, task: "ping", agentScope: "project" },
        { callId: 1, cwd: dir, depth: 0, maxDispatchDepth: 3 },
        h.deps,
      ).then((result) => {
        settled = true;
        return result;
      });

      const deadline = Date.now() + 2_000;
      let records: TaskRecord[] = [];
      while (Date.now() < deadline) {
        records = await allTasks(h.storage);
        if (records.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      expect(records, "the queued request left one record behind").toHaveLength(1);
      expect(records[0]?.status, "and the record says it is queued").toBe("queued");
      expect(settled, "the request is waiting, not refused").toBe(false);
      expect(h.lifecycle.spawnCount, "and no child was launched").toBe(0);
      // The queue is unbounded and has no timeout, so the request keeps waiting. The test
      // leaves it waiting: a counter with no room can never hand it a slot.
      void queued;
    });
  });
});

// ---------------------------------------------------------------------------
//  5. the slot is keyed by the task id
// ---------------------------------------------------------------------------

describe("ADR-0053: the concurrency slot is keyed by the task id", () => {
  test("ending one of two concurrent tasks does not release the other's slot", async () => {
    await withAgent(async (dir) => {
      // Two room, so BOTH tasks are admitted. If the two shared one token the second would be
      // refused — and if a release freed the other's slot, the third and fourth would both fit.
      const h = createHarness({ limit: 2 });
      const first = dispatch(
        { agent: AGENT, task: "one", agentScope: "project" },
        { callId: 1, cwd: dir, depth: 0, maxDispatchDepth: 3 },
        h.deps,
      );
      const second = dispatch(
        { agent: AGENT, task: "two", agentScope: "project" },
        { callId: 2, cwd: dir, depth: 0, maxDispatchDepth: 3 },
        h.deps,
      );
      await waitFor(() => h.lifecycle.spawnCount > 1);
      expect(h.slots.active, "two concurrent tasks hold two slots, not one shared token").toBe(2);

      // The FIRST task ends. Its own slot goes back; the second task's does not.
      answerChild(h.lifecycle, 0, ANSWER);
      await first;
      expect(h.slots.active, "the second task's slot is still held").toBe(1);

      // A third call takes the free slot...
      const third = dispatch(
        { agent: AGENT, task: "three", agentScope: "project" },
        { callId: 3, cwd: dir, depth: 0, maxDispatchDepth: 3 },
        h.deps,
      );
      await waitFor(() => h.lifecycle.spawnCount > 2);
      expect(h.slots.active, "the free slot was taken").toBe(2);

      // ...and a fourth does not fit, which is only true if the second task still holds one.
      // ADR-0056: "does not fit" is a QUEUE now, not a refusal.
      let fourthSettled = false;
      const fourth = dispatch(
        { agent: AGENT, task: "four", agentScope: "project" },
        { callId: 4, cwd: dir, depth: 0, maxDispatchDepth: 3 },
        h.deps,
      ).then((result) => {
        fourthSettled = true;
        return result;
      });
      const deadline = Date.now() + 2_000;
      let queuedRecords: TaskRecord[] = [];
      while (Date.now() < deadline) {
        queuedRecords = (await allTasks(h.storage)).filter((record) => record.status === "queued");
        if (queuedRecords.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(queuedRecords, "the fourth call queued instead of being refused").toHaveLength(1);
      expect(fourthSettled, "the queued call is waiting for a slot, not settled").toBe(false);
      expect(h.slots.active, "a queued task holds no slot").toBe(2);

      answerChild(h.lifecycle, 1, ANSWER);
      answerChild(h.lifecycle, 2, ANSWER);
      await second;
      await third;
      // The freed slots let the queued call run, and it finishes too.
      await waitFor(() => h.lifecycle.spawnCount > 3);
      answerChild(h.lifecycle, 3, ANSWER);
      const fourthResult = await fourth;
      expect(fourthResult.status, "the queued call ran once a slot freed").toBe("fulfilled");
    });
  });
});

// ---------------------------------------------------------------------------
//  6. the task face follows the record
// ---------------------------------------------------------------------------

describe("ADR-0053: the task face is a consequence of the record", () => {
  test("before the first dispatch the face is out of the model's face, and after it is in", async () => {
    await withAgent(async (dir) => {
      const h = createHarness();
      const list = createPtcTaskListTool(h.registry);

      // Before anything was dispatched there is nothing to list, read or stop.
      expect(list.exposure, "the face is hidden before the first dispatch").toBe("hidden");

      const settled = dispatch(
        { agent: AGENT, task: "ping", agentScope: "project" },
        { callId: 1, cwd: dir, depth: 0, maxDispatchDepth: 3 },
        h.deps,
      );
      await waitFor(() => h.lifecycle.spawnCount > 0);
      answerChild(h.lifecycle, 0, ANSWER);
      await settled;

      expect(list.exposure, "the face is in the model's face once a record exists").toBe("direct");
    });
  });

  test("a session that already had records shows the face from its first request", async () => {
    const dir = await makeTempDir();
    try {
      // A session dir that already holds a record from an earlier run.
      const sessionDir = join(dir, "session");
      const storage = new InMemoryTaskStorage();
      const registry = createTaskRegistry(storage, { clock: () => 1_000 });
      await registry.transition(
        {
          kind: "spawn",
          handle: {
            taskId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" as ULID,
            label: "earlier",
            status: "running",
          },
          record: {
            label: "earlier",
            agentName: AGENT,
            depth: 0,
            startedAt: 1_000,
            finishedAt: undefined,
            durationMs: undefined,
            outputRef: undefined,
            outputBytes: undefined,
            outputPreview: undefined,
            stopReason: undefined,
            errorMessage: undefined,
            exitCode: undefined,
            spawnSource: { kind: "ptc-program", callerId: "run-earlier" },
          },
        },
        { clock: () => 1_000, callerId: "run-earlier" },
      );

      // The runtime binds that session, and the face must be visible from the first request —
      // the session HAS a task record, before anything is dispatched in it.
      const runtime = createBackgroundTaskRuntime({
        createStorage: () => storage,
        createInitialStorage: () => storage,
      });
      await runtime.bindSession(sessionDir);
      const list = createPtcTaskListTool(runtime.registry);
      expect(list.exposure, "a resumed session shows the face").toBe("direct");
    } finally {
      await removeTempDir(dir);
    }
  });

  test("a session with no records hides the face, once it is bound", async () => {
    const dir = await makeTempDir();
    try {
      const runtime = createBackgroundTaskRuntime();
      const list = createPtcTaskListTool(runtime.registry);
      // Before a session is bound the tools must still REGISTER as active — pi reads the
      // exposure at registration and a tool registered as hidden never enters the active set.
      expect(list.exposure, "the tools register active before a session is bound").toBe("direct");

      await runtime.bindSession(join(dir, "session"));
      expect(list.exposure, "a bound session with no records hides the face").toBe("hidden");
    } finally {
      await removeTempDir(dir);
    }
  });
});
