/**
 * BG-06/07/08 unit tests for the three 'ptc_task_*' tools and the OutputStorage seam.
 *
 * SPECIFICATION tests (docs/testing-constraints.md #6): every expected value traces to a literal
 * in ADR-0022 or ADR-0015 — the three-tool surface (ADR-0022 "What we add" #6), the six statuses
 * (§2), the createdAt-desc default and stopReason field (§3), the idempotent late stop (§8), and
 * the 50 KB / 2000-line tail with a full-output pointer (ADR-0015 §1/§2). Nothing is copied from
 * the implementation.
 *
 * Dependencies are all injected (constraint #1 clock/IO boundary): an InMemoryTaskStorage with a
 * fake clock, an InMemoryOutputStorage, and a MockChildProcessLifecycle — no real timers and no
 * spawned process. Each tool has an explicit failure-path test (unknown taskId / invalid limit /
 * illegal stop), never a silent empty value.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { InMemoryTaskStorage, type TaskRecord, type ULID } from "../../src/runtime/task-storage.ts";
import {
  createTaskRegistry,
  type DispatchHandle,
  type TaskRegistry,
} from "../../src/runtime/task-registry.ts";
import {
  applyAdr0015Truncation,
  FileOutputStorage,
  InMemoryOutputStorage,
} from "../../src/runtime/output-storage.ts";
import { MockChildProcessLifecycle } from "../../src/runtime/child-process-lifecycle.ts";
import {
  createPtcTaskListTool,
  createPtcTaskOutputTool,
  createPtcTaskStopTool,
  type AnyTool,
  type PtcTaskListDetails,
  type PtcTaskOutputDetails,
  type PtcTaskStopDetails,
} from "../../src/tools/ptc-task.ts";

// ---------------------------------------------------------------------------
//  Fixtures and harness
// ---------------------------------------------------------------------------

/** Literal ULID-shaped ids, matching the BG-02 suite's convention (recognizable in failures). */
const TASK_1 = "01JBZ000000000000000000001" as ULID;
const TASK_2 = "01JBZ000000000000000000002" as ULID;
const TASK_3 = "01JBZ000000000000000000003" as ULID;
const TASK_404 = "01JBZ000000000000000000404" as ULID;
const CALLER = "run-001";

/** Two-line output with a concrete UTF-8 size: 5 + 1 + 5 + 1 = 12 bytes. */
const SMALL_OUTPUT = "hello\nworld\n";

const LARGE_LINE_COUNT = 2500;
/** 2500 lines ("line-0" … "line-2499"), ~24 KB — over ADR-0015's 2000-line ceiling, under 50 KB. */
const LARGE_OUTPUT = Array.from({ length: LARGE_LINE_COUNT }, (_, index) => `line-${index}`).join(
  "\n",
);

/** Temp full-output files written by ADR-0015 truncation; unlinked after each test. */
const tempFullPaths: string[] = [];

afterEach(() => {
  while (tempFullPaths.length > 0) {
    const path = tempFullPaths.pop();
    if (path !== undefined && existsSync(path)) unlinkSync(path);
  }
});

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

interface Harness {
  registry: TaskRegistry;
  storage: InMemoryTaskStorage;
  outputs: InMemoryOutputStorage;
  lifecycle: MockChildProcessLifecycle;
  clock: FakeClock;
}

function createHarness(start = 1000): Harness {
  const storage = new InMemoryTaskStorage();
  const clock = createFakeClock(start);
  return {
    registry: createTaskRegistry(storage, { clock: clock.clock }),
    storage,
    outputs: new InMemoryOutputStorage(),
    lifecycle: new MockChildProcessLifecycle(),
    clock,
  };
}

type RecordInput = Omit<TaskRecord, "id" | "status" | "createdAt" | "transitionAt">;

/** 21-field shape copied from ADR-0022 §3 (the BG-02 suite's fixture, reused verbatim). */
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

function fixtureHandle(taskId: ULID, label: string): DispatchHandle {
  return { taskId, label, status: "running" };
}

async function spawnTask(
  h: Harness,
  taskId: ULID,
  overrides: Partial<RecordInput> = {},
): Promise<TaskRecord> {
  const result = await h.registry.transition(
    {
      kind: "spawn",
      handle: fixtureHandle(taskId, overrides.label ?? "research X"),
      record: fixtureRecord(overrides),
    },
    { clock: h.clock.clock, callerId: CALLER },
  );
  return result.record;
}

/** Drive one tool the way pi's agent loop does; the task tools read no context fields. */
async function callTool<TDetails>(
  tool: AnyTool,
  params: unknown,
): Promise<{ content: Array<{ type: string; text?: string }>; details: TDetails }> {
  const result = await tool.execute("call-1", params, undefined, undefined, undefined as never);
  return result as { content: Array<{ type: string; text?: string }>; details: TDetails };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

// ---------------------------------------------------------------------------
//  ptc_task_list (ADR-0022 §3)
// ---------------------------------------------------------------------------

/** TASK_1 running @1000, TASK_2 succeeded @4000, TASK_3 running @3000 (labels distinct). */
async function seedThreeTasks(h: Harness): Promise<void> {
  h.clock.set(1000);
  await spawnTask(h, TASK_1, { label: "research X" });
  h.clock.set(2000);
  await spawnTask(h, TASK_2, { label: "research Y" });
  h.clock.set(3000);
  await spawnTask(h, TASK_3, { label: "ship Z" });
  h.clock.set(4000);
  await h.registry.transition(
    { kind: "transition", taskId: TASK_2, to: "succeeded" },
    { clock: h.clock.clock, callerId: CALLER },
  );
}

describe("ptc_task_list", () => {
  test("returns createdAt-desc records over all six states (§2/§3)", async () => {
    const h = createHarness(1000);
    await seedThreeTasks(h);
    const tool = createPtcTaskListTool(h.registry);

    const result = await callTool<PtcTaskListDetails>(tool, {});

    expect(result.details.count).toBe(3);
    expect(result.details.tasks.map((record) => record.id)).toEqual([TASK_3, TASK_2, TASK_1]);
    expect(result.details.tasks.map((record) => record.status)).toEqual([
      "running",
      "succeeded",
      "running",
    ]);
    const text = textOf(result);
    expect(text).toContain(TASK_1);
    expect(text).toContain(TASK_3);
    expect(text).toContain("succeeded");
  });

  test("filters by the status array and applies the limit after ordering (§3)", async () => {
    const h = createHarness(1000);
    await seedThreeTasks(h);
    const tool = createPtcTaskListTool(h.registry);

    const succeeded = await callTool<PtcTaskListDetails>(tool, { status: ["succeeded"] });
    expect(succeeded.details.tasks.map((record) => record.id)).toEqual([TASK_2]);

    const limited = await callTool<PtcTaskListDetails>(tool, { limit: 1 });
    expect(limited.details.tasks.map((record) => record.id)).toEqual([TASK_3]);
  });

  test("renders an explicit empty list rather than nothing", async () => {
    const h = createHarness(1000);
    const tool = createPtcTaskListTool(h.registry);

    const result = await callTool<PtcTaskListDetails>(tool, {});

    expect(result.details).toEqual({ tasks: [], count: 0 });
    expect(textOf(result)).toBe("(no background tasks)");
  });

  test("rejects a negative limit through the registry's explicit error", async () => {
    const h = createHarness(1000);
    const tool = createPtcTaskListTool(h.registry);

    await expect(callTool(tool, { limit: -1 })).rejects.toThrow(
      /limit must be a non-negative integer/,
    );
  });
});

// ---------------------------------------------------------------------------
//  ptc_task_output (ADR-0022 §3 + ADR-0015)
// ---------------------------------------------------------------------------

describe("ptc_task_output", () => {
  test("returns small output untruncated with its exact byte count", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    await h.outputs.writeOutput(TASK_1, SMALL_OUTPUT);
    const tool = createPtcTaskOutputTool(h.registry, h.outputs);

    const result = await callTool<PtcTaskOutputDetails>(tool, { taskId: TASK_1 });

    expect(result.details.taskId).toBe(TASK_1);
    expect(result.details.output).toBe(SMALL_OUTPUT);
    expect(result.details.outputBytes).toBe(12);
    // ADR-0022 §7: 12 <= 2048, so the inline preview is present and is the stored text.
    expect(result.details.outputPreview).toBe(SMALL_OUTPUT);
    expect(result.details.outputTruncated).toBe(false);
    expect(result.details.outputFullPath).toBeUndefined();
  });

  test("tails a 2500-line output to the last 2000 lines and points at the full file (ADR-0015 §1)", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    await h.outputs.writeOutput(TASK_1, LARGE_OUTPUT);
    const tool = createPtcTaskOutputTool(h.registry, h.outputs);

    const result = await callTool<PtcTaskOutputDetails>(tool, { taskId: TASK_1 });

    expect(result.details.outputBytes).toBe(Buffer.byteLength(LARGE_OUTPUT, "utf8"));
    // ADR-0022 §7: the ~24 KB output is above the 2048-byte ceiling -> no inline preview.
    expect(result.details.outputPreview).toBeUndefined();
    expect(result.details.outputTruncated).toBe(true);
    const fullPath = result.details.outputFullPath as string;
    tempFullPaths.push(fullPath);
    expect(readFileSync(fullPath, "utf8")).toBe(LARGE_OUTPUT);
    expect(result.details.output).toContain("line-500");
    expect(result.details.output).toContain("line-2499");
    expect(result.details.output).not.toContain("line-499");
    // ADR-0015 footer: totalLines=2500, outputLines=2000 -> lines 501-2500.
    expect(result.details.output).toContain("Showing lines 501-2500 of 2500.");
  });

  test("byte-caps a single over-limit line and still writes the full text (ADR-0015 §1/§2)", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    const overLimit = "z".repeat(DEFAULT_MAX_BYTES + 1);
    await h.outputs.writeOutput(TASK_1, overLimit);
    const tool = createPtcTaskOutputTool(h.registry, h.outputs);

    const result = await callTool<PtcTaskOutputDetails>(tool, { taskId: TASK_1 });

    expect(result.details.outputBytes).toBe(DEFAULT_MAX_BYTES + 1);
    expect(result.details.outputTruncated).toBe(true);
    const fullPath = result.details.outputFullPath as string;
    tempFullPaths.push(fullPath);
    expect(readFileSync(fullPath, "utf8")).toBe(overLimit);
    expect(result.details.output).toContain("Showing last");
  });

  test("sinceBytes skips a byte prefix while outputBytes reports the full size", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    await h.outputs.writeOutput(TASK_1, "abcdef");
    const tool = createPtcTaskOutputTool(h.registry, h.outputs);

    const result = await callTool<PtcTaskOutputDetails>(tool, { taskId: TASK_1, sinceBytes: 2 });

    expect(result.details.output).toBe("cdef");
    expect(result.details.outputBytes).toBe(6);
  });

  test("emits an explicit empty-output line for a known task with no bytes yet", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    const tool = createPtcTaskOutputTool(h.registry, h.outputs);

    const result = await callTool<PtcTaskOutputDetails>(tool, { taskId: TASK_1 });

    expect(result.details.output).toBe("");
    expect(result.details.outputBytes).toBe(0);
    expect(textOf(result)).toBe(`(no output yet; task ${TASK_1} is running)`);
  });

  test("rejects an unknown taskId with an explicit error", async () => {
    const h = createHarness(1000);
    const tool = createPtcTaskOutputTool(h.registry, h.outputs);

    await expect(callTool(tool, { taskId: TASK_404 })).rejects.toThrow(
      `ptc_task_output: unknown taskId ${TASK_404}`,
    );
  });

  test("rejects a sinceBytes past the end of the stored output", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    await h.outputs.writeOutput(TASK_1, "abc");
    const tool = createPtcTaskOutputTool(h.registry, h.outputs);

    await expect(callTool(tool, { taskId: TASK_1, sinceBytes: 4 })).rejects.toThrow(
      `ptc_task_output: sinceBytes 4 exceeds the 3-byte output of task ${TASK_1}`,
    );
  });
});

// ---------------------------------------------------------------------------
//  ptc_task_stop (ADR-0022 §8)
// ---------------------------------------------------------------------------

describe("ptc_task_stop", () => {
  test("drives running -> stopping, records the reason, and emits to the owner subscription (§8)", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    const killSpy = vi.spyOn(h.lifecycle, "kill");
    h.clock.set(1500);
    const tool = createPtcTaskStopTool(h.registry, h.lifecycle, { clock: h.clock.clock });

    const result = await callTool<PtcTaskStopDetails>(tool, {
      taskId: TASK_1,
      reason: "user asked",
    });

    expect(result.details.task.status).toBe("stopping");
    // ADR-0022 §8: the stop tool reports the observed source state with the post record.
    expect(result.details.fromStatus).toBe("running");
    expect(result.details.task.stopReason).toBe("user asked");
    expect(result.details.task.transitionAt).toBe(1500);
    expect(result.details.task.finishedAt).toBeUndefined();
    // ADR-0022 §8: the tool never signals the process; the dispatcher pump owns kill().
    expect(killSpy).not.toHaveBeenCalled();
    const log = await h.registry.loadEventLog(CALLER as ULID);
    expect(log.map((event) => event.type)).toEqual([
      "task:01JBZ000000000000000000001:running",
      "task:01JBZ000000000000000000001:stopping",
    ]);
  });

  test("defaults the stop reason to the §8 wording", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    const tool = createPtcTaskStopTool(h.registry, h.lifecycle, { clock: h.clock.clock });

    const result = await callTool<PtcTaskStopDetails>(tool, { taskId: TASK_1 });

    expect(result.details.task.stopReason).toBe("model stop");
  });

  test("a late stop while already stopping is idempotent (§8)", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    const tool = createPtcTaskStopTool(h.registry, h.lifecycle, { clock: h.clock.clock });
    await callTool<PtcTaskStopDetails>(tool, { taskId: TASK_1, reason: "first" });
    h.clock.set(1600);

    const second = await callTool<PtcTaskStopDetails>(tool, { taskId: TASK_1, reason: "second" });

    expect(second.details.task.status).toBe("stopping");
    expect(second.details.fromStatus).toBe("stopping");
    expect(second.details.task.stopReason).toBe("first");
    expect(second.details.task.transitionAt).toBe(1000);
    const log = await h.registry.loadEventLog(CALLER as ULID);
    expect(log.filter((event) => event.type.endsWith(":stopping"))).toHaveLength(1);
  });

  test("rejects an unknown taskId with an explicit error", async () => {
    const h = createHarness(1000);
    const tool = createPtcTaskStopTool(h.registry, h.lifecycle, { clock: h.clock.clock });

    await expect(callTool(tool, { taskId: TASK_404 })).rejects.toThrow(
      `ptc_task_stop: unknown taskId ${TASK_404}`,
    );
  });

  test("rejects a stop on a terminal task through the registry's illegal-edge error (§8)", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    await h.registry.transition(
      { kind: "transition", taskId: TASK_1, to: "succeeded" },
      { clock: h.clock.clock, callerId: CALLER },
    );
    const tool = createPtcTaskStopTool(h.registry, h.lifecycle, { clock: h.clock.clock });

    await expect(callTool(tool, { taskId: TASK_1 })).rejects.toThrow(/illegal transition for task/);
  });
});

// ---------------------------------------------------------------------------
//  OutputStorage adapters (constraint #1: success + failure path)
// ---------------------------------------------------------------------------

describe("OutputStorage", () => {
  test("InMemoryOutputStorage returns null for an unknown id and round-trips a write", async () => {
    const storage = new InMemoryOutputStorage();

    expect(await storage.readOutput(TASK_1)).toBeNull();
    await storage.writeOutput(TASK_1, "body");
    expect(await storage.readOutput(TASK_1)).toBe("body");
    expect(storage.outputRef(TASK_1)).toBe(`memory:tasks/${TASK_1}/output.log`);
  });

  test("FileOutputStorage round-trips at <base>/tasks/<id>/output.log and returns null for ENOENT", async () => {
    const base = await mkdtemp(join(tmpdir(), "pi-ptc-output-"));
    try {
      const storage = new FileOutputStorage(base);

      expect(storage.outputRef(TASK_1)).toBe(join(base, "tasks", TASK_1, "output.log"));
      expect(await storage.readOutput(TASK_1)).toBeNull();
      await storage.writeOutput(TASK_1, "file body");
      expect(await storage.readOutput(TASK_1)).toBe("file body");
      expect(readFileSync(storage.outputRef(TASK_1), "utf8")).toBe("file body");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("FileOutputStorage write rejects when a parent path is a file (failure path)", async () => {
    const base = await mkdtemp(join(tmpdir(), "pi-ptc-output-"));
    try {
      // A file where the tasks/ directory must go makes mkdir fail with ENOTDIR.
      await writeFile(join(base, "tasks"), "not a directory", "utf8");
      const storage = new FileOutputStorage(base);

      await expect(storage.writeOutput(TASK_1, "body")).rejects.toThrow(/not a directory|ENOTDIR/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
//  applyAdr0015Truncation (ADR-0015 §1/§2)
// ---------------------------------------------------------------------------

describe("applyAdr0015Truncation", () => {
  test("passes sub-limit text through untouched", () => {
    expect(applyAdr0015Truncation("short")).toEqual({ text: "short", truncated: false });
  });

  test("writes the full text before cutting the tail", () => {
    const huge = "x".repeat(DEFAULT_MAX_BYTES + 1);

    const result = applyAdr0015Truncation(huge);

    expect(result.truncated).toBe(true);
    const fullPath = result.fullPath as string;
    tempFullPaths.push(fullPath);
    expect(readFileSync(fullPath, "utf8")).toBe(huge);
  });
});

// ---------------------------------------------------------------------------
//  BG-09 renderer wiring (ADR-0022 §7)
// ---------------------------------------------------------------------------

describe("task panel renderer wiring", () => {
  test("each ptc_task_* tool registers the BG-09 renderCall/renderResult pair", () => {
    const h = createHarness(1000);
    const tools = [
      createPtcTaskListTool(h.registry),
      createPtcTaskOutputTool(h.registry, h.outputs),
      createPtcTaskStopTool(h.registry, h.lifecycle),
    ];

    for (const tool of tools) {
      // Removing the createTaskPanelRenderers spread leaves these undefined (counterfactual).
      expect(typeof tool.renderCall).toBe("function");
      expect(typeof tool.renderResult).toBe("function");
    }
  });
});
