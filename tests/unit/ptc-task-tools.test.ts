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
 *
 * The "codemode projection" describe adds the third result surface: `outputSchema` /
 * `structuredContent` (pi 1.0.0). Its key names come from the same authority as the `details`
 * assertions — the text `formatTaskLine` prints plus ADR-0022 §3 — and the omit-an-optional-key
 * cases are asserted with `Object.hasOwn`, because `toBeUndefined` passes just as happily for
 * `{k: undefined}` as for `{}` and only the first one is not a `JsonValue`.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import {
  InMemoryTaskStorage,
  type TaskEvent,
  type TaskRecord,
  type ULID,
} from "../../src/runtime/task-storage.ts";
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
  DEFAULT_STOP_REASON,
  MAX_RENDERED_REPORT_FINDINGS,
  type AnyTool,
  type PtcTaskListDetails,
  type PtcTaskOutputDetails,
  type PtcTaskStopDetails,
} from "../../src/tools/ptc-task.ts";
import type { ChildReport } from "../../src/runtime/child-report.ts";
// Aliased on import: the describe block below is about the RENDERER, and a local alias keeps the
// assertions reading as renderer assertions rather than reaching through a tool-execution harness.
import { renderChildReport as renderChildReportForTest } from "../../src/tools/ptc-task.ts";

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

/**
 * Materialize the per-subscriber event buffer through the storage seam the registry writes into
 * (R-m11 removed `TaskRegistry.loadEventLog`; the tool assertions below only need the emitted
 * event order, not a registry inspection helper).
 */
async function eventLog(h: Harness, subscriberId: string): Promise<TaskEvent[]> {
  const events: TaskEvent[] = [];
  for await (const event of h.storage.loadEvents(subscriberId as ULID)) {
    events.push(event);
  }
  return events;
}

type RecordInput = Omit<TaskRecord, "id" | "status" | "createdAt" | "transitionAt">;

/**
 * Spawn record: 15 keys — the ADR-0022 §3 fields minus the four the registry owns (`id`,
 * `status`, `createdAt`, `transitionAt`). The ADR-0023 owner fields are left unset; no
 * `ptc_task_*` tool reads them.
 */
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

/**
 * Drive one tool the way pi's agent loop does; the task tools read no context fields.
 * The result carries `structuredContent` (pi 1.0.0's codemode projection) next to `content` and
 * `details` — pi types it `JsonValue | undefined` and documents it as "Not sent to the model", so
 * widening this cast observes it without changing what any existing assertion sees.
 */
async function callTool<TDetails>(
  tool: AnyTool,
  params: unknown,
): Promise<{
  content: Array<{ type: string; text?: string }>;
  details: TDetails;
  structuredContent?: unknown;
}> {
  const result = await tool.execute("call-1", params, undefined, undefined, undefined as never);
  return result as {
    content: Array<{ type: string; text?: string }>;
    details: TDetails;
    structuredContent?: unknown;
  };
}

/** The `structuredContent` of one successful call — the value pi hands a codemode script. */
async function callStructured<T>(tool: AnyTool, params: unknown): Promise<T> {
  return (await callTool(tool, params)).structuredContent as T;
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

  test("reads the record through registry.get, not a MAX_SAFE_INTEGER query scan (§3 O(1) read)", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    await h.outputs.writeOutput(TASK_1, "hi");
    const getSpy = vi.spyOn(h.registry, "get");
    const querySpy = vi.spyOn(h.registry, "query");
    const tool = createPtcTaskOutputTool(h.registry, h.outputs);

    await callTool<PtcTaskOutputDetails>(tool, { taskId: TASK_1 });

    expect(getSpy).toHaveBeenCalledWith(TASK_1);
    expect(querySpy).not.toHaveBeenCalled();
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

  test("paging that truncates still writes the FULL stored output to the temp file (ADR-0015 §2)", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    await h.outputs.writeOutput(TASK_1, LARGE_OUTPUT);
    const tool = createPtcTaskOutputTool(h.registry, h.outputs);
    // Skip "line-0\n" (7 bytes). The page is still 2499 lines, over the 2000-line ceiling, so it
    // truncates and must point at a temp file holding the WHOLE stored output — the guide says
    // "the complete text is written" (docs/usage/bgdispatch.md:310-312).
    const skip = Buffer.byteLength("line-0\n", "utf8");

    const result = await callTool<PtcTaskOutputDetails>(tool, { taskId: TASK_1, sinceBytes: skip });

    // (a) the returned text is the truncated PAGE (lines 500-2499 of the page).
    expect(result.details.outputBytes).toBe(Buffer.byteLength(LARGE_OUTPUT, "utf8"));
    expect(result.details.outputTruncated).toBe(true);
    expect(result.details.output).toContain("line-500");
    expect(result.details.output).toContain("line-2499");
    expect(result.details.output).not.toContain("line-499");
    // (b) the pointer names the complete stored output, not the page. Counterfactual (#5):
    // truncating the slice and writing it here makes this red (the file would be the page).
    const fullPath = result.details.outputFullPath as string;
    tempFullPaths.push(fullPath);
    expect(readFileSync(fullPath, "utf8")).toBe(LARGE_OUTPUT);
  });

  test("rejects a sinceBytes offset that splits a UTF-8 character (R-m16)", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    // 'a' is 1 byte, 'é' is 2 bytes: 3 bytes total, a codepoint boundary at offset 1 only.
    await h.outputs.writeOutput(TASK_1, "aé");
    const tool = createPtcTaskOutputTool(h.registry, h.outputs);

    const onBoundary = await callTool<PtcTaskOutputDetails>(tool, {
      taskId: TASK_1,
      sinceBytes: 1,
    });
    expect(onBoundary.details.output).toBe("é");
    // outputBytes still reports the FULL stored byte length.
    expect(onBoundary.details.outputBytes).toBe(3);

    await expect(callTool(tool, { taskId: TASK_1, sinceBytes: 2 })).rejects.toThrow(
      /splits a UTF-8 character/,
    );
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
//  ptc_task_output — the persisted child report (ADR-0032)
// ---------------------------------------------------------------------------

/** The literal report a background child is persisted with (ADR-0032's four fields + host usage). */
const PERSISTED_REPORT: ChildReport = {
  summary: "the depth gate is checked before the agent is discovered",
  findings: [
    { what: "depth precedes discovery", evidence: "the gate returns before discoverAgent" },
    { what: "the refusal text names the next step", evidence: "the message ends with next_step:" },
  ],
  files_touched: ["src/runtime/dispatch.ts", "docs/usage/bgdispatch.md"],
  usage: { input: 900, output: 260, cost: 0.0123, turns: 1 },
};

describe("ptc_task_output shows the persisted child report (ADR-0032)", () => {
  test("renders the report and the child's prose, report first", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    h.clock.set(1500);
    // The record reaches `succeeded` through the registry, carrying the report the pump wrote.
    await h.registry.transition(
      {
        kind: "resolve-exit",
        taskId: TASK_1,
        exitCode: 0,
        outputRef: h.outputs.outputRef(TASK_1),
        outputBytes: 12,
        outputPreview: SMALL_OUTPUT,
        report: PERSISTED_REPORT,
        reportChannel: "prompt-json",
      },
      { clock: h.clock.clock, callerId: CALLER },
    );
    await h.outputs.writeOutput(TASK_1, SMALL_OUTPUT);
    const tool = createPtcTaskOutputTool(h.registry, h.outputs);

    const result = await callTool<PtcTaskOutputDetails>(tool, { taskId: TASK_1 });
    const text = textOf(result);

    // ADR-0032 rendering: conclusion first, reasoning second — the block precedes the prose.
    expect(text.indexOf('<child-report channel="prompt-json">')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf(PERSISTED_REPORT.summary)).toBeLessThan(text.indexOf("hello"));
    // Every field the model needs, from the same values the pump stamped.
    expect(text).toContain("depth precedes discovery");
    expect(text).toContain("the gate returns before discoverAgent");
    expect(text).toContain("src/runtime/dispatch.ts, docs/usage/bgdispatch.md");
    expect(text).toContain("usage: input=900 output=260 cost=0.0123 turns=1");
    // Prose is preserved beside the report, never replaced by it.
    expect(result.details.output).toBe(SMALL_OUTPUT);
    expect(text).toContain("world");
    // And the same value reaches `details` and the codemode projection, not just the text.
    expect(result.details.report).toEqual(PERSISTED_REPORT);
    expect(result.details.reportChannel).toBe("prompt-json");
    const structured = await callStructured<{
      report?: ChildReport;
      report_channel?: string;
    }>(tool, { taskId: TASK_1 });
    expect(structured.report).toEqual(PERSISTED_REPORT);
    expect(structured.report_channel).toBe("prompt-json");
  });

  test("bounds the rendered findings at 20 and states the withheld count in-band", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    h.clock.set(1500);
    const findings = Array.from({ length: 23 }, (_, index) => ({
      what: `finding-${String(index)}`,
      evidence: `evidence-${String(index)}`,
    }));
    await h.registry.transition(
      {
        kind: "resolve-exit",
        taskId: TASK_1,
        exitCode: 0,
        outputBytes: 12,
        report: { ...PERSISTED_REPORT, findings },
        reportChannel: "prompt-json",
      },
      { clock: h.clock.clock, callerId: CALLER },
    );
    await h.outputs.writeOutput(TASK_1, SMALL_OUTPUT);
    const tool = createPtcTaskOutputTool(h.registry, h.outputs);

    const text = textOf(await callTool<PtcTaskOutputDetails>(tool, { taskId: TASK_1 }));

    expect(MAX_RENDERED_REPORT_FINDINGS).toBe(20);
    expect(text).toContain("finding-19");
    expect(text).not.toContain("finding-20");
    // The withheld count is stated, not silently dropped — a shortened list must not read as
    // "these were all of them".
    expect(text).toContain("+3 more findings not shown");
  });

  test("a non-compliant child reads as the explicit none marker, not as a silent prose answer", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    h.clock.set(1500);
    await h.registry.transition(
      {
        kind: "resolve-exit",
        taskId: TASK_1,
        exitCode: 0,
        outputBytes: 12,
        reportChannel: "none",
      },
      { clock: h.clock.clock, callerId: CALLER },
    );
    await h.outputs.writeOutput(TASK_1, SMALL_OUTPUT);
    const tool = createPtcTaskOutputTool(h.registry, h.outputs);

    const result = await callTool<PtcTaskOutputDetails>(tool, { taskId: TASK_1 });
    const text = textOf(result);

    expect(text).toContain('<child-report channel="none">');
    expect(text).toContain("did not comply with the report contract");
    expect(result.details.reportChannel).toBe("none");
    expect(result.details.report).toBeUndefined();
    // The answer is still handed over; the marker says it is unbacked, not that it is missing.
    expect(result.details.output).toBe(SMALL_OUTPUT);
  });

  test("a running task renders no report block and reports no channel", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    const tool = createPtcTaskOutputTool(h.registry, h.outputs);

    const result = await callTool<PtcTaskOutputDetails>(tool, { taskId: TASK_1 });

    // "Has not reported yet" is not "reported nothing": a running task says neither.
    expect(textOf(result)).not.toContain("<child-report");
    expect(result.details.reportChannel).toBeUndefined();
    expect(result.details.report).toBeUndefined();
    const structured = await callStructured<Record<string, unknown>>(tool, { taskId: TASK_1 });
    // Absent, never `undefined` — `structuredContent` must stay a JsonValue (constraint in this
    // file's header: the optional keys are omitted, not set).
    expect(Object.hasOwn(structured, "report")).toBe(false);
    expect(Object.hasOwn(structured, "report_channel")).toBe(false);
  });

  test("a failed task renders no report block either", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    h.clock.set(1500);
    await h.registry.transition(
      {
        kind: "resolve-exit",
        taskId: TASK_1,
        exitCode: 1,
        outputBytes: 0,
        reportChannel: "prompt-json",
        report: PERSISTED_REPORT,
      },
      { clock: h.clock.clock, callerId: CALLER },
    );
    const tool = createPtcTaskOutputTool(h.registry, h.outputs);

    const result = await callTool<PtcTaskOutputDetails>(tool, { taskId: TASK_1 });

    // The registry already refused to persist the report on a failed record, so the tool has
    // nothing to render. Asserted here anyway: the read surface is where a model would notice.
    expect((await h.registry.get(TASK_1))?.status).toBe("failed");
    expect(textOf(result)).not.toContain("<child-report");
    expect(result.details.report).toBeUndefined();
    expect(result.details.reportChannel).toBeUndefined();
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
    // ADR-0022 §8: the tool drives only running -> stopping; the dispatcher pump owns the
    // SIGTERM -> grace -> SIGKILL ladder. The stopping transition asserted above is the tool's
    // whole observable effect, and the tool itself must never signal the process.
    expect(killSpy).not.toHaveBeenCalled();
    const log = await eventLog(h, CALLER);
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
    const log = await eventLog(h, CALLER);
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

  test("two concurrent stops emit exactly one stopping event and report the atomic fromStatus (§8)", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    const killSpy = vi.spyOn(h.lifecycle, "kill");
    const tool = createPtcTaskStopTool(h.registry, h.lifecycle, { clock: h.clock.clock });

    const [first, second] = await Promise.all([
      callTool<PtcTaskStopDetails>(tool, { taskId: TASK_1, reason: "one" }),
      callTool<PtcTaskStopDetails>(tool, { taskId: TASK_1, reason: "two" }),
    ]);

    expect(first.details.task.status).toBe("stopping");
    expect(second.details.task.status).toBe("stopping");
    expect([first.details.fromStatus, second.details.fromStatus].sort()).toEqual([
      "running",
      "stopping",
    ]);
    const log = await eventLog(h, CALLER);
    expect(log.filter((event) => event.type.endsWith(":stopping"))).toHaveLength(1);
    // The tool still never signals; the dispatcher pump owns the ladder.
    expect(killSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
//  codemode projection: `outputSchema` + `structuredContent` (pi 1.0.0)
// ---------------------------------------------------------------------------

/**
 * The three declared output shapes, written out as literals rather than imported: the source of
 * truth for the key names is the text `formatTaskLine` prints for the model (`id`, `status`,
 * agent, `depth=`, label, `<bytes>B`, `error=<message>`) and ADR-0022 §3's field list — the same
 * authority the `details` assertions above use, so a shape change has to be argued for here.
 */
interface ListRowShape {
  id: string;
  status: string;
  agent: string;
  depth: number;
  label: string;
  output_bytes?: number;
  error_message?: string;
}
interface ListShape {
  tasks: ListRowShape[];
  count: number;
}
interface OutputShape {
  task_id: string;
  status: string;
  output: string;
  output_bytes: number;
  output_preview?: string;
  output_truncated: boolean;
  output_full_path?: string;
}
interface StopShape {
  task_id: string;
  status: string;
  from_status: string;
  stop_reason?: string;
}

/** What a naive mirror of `details` would carry that the projection must not (ADR-0022 §3). */
const MIRROR_ONLY_KEYS = ["outputRef", "outputPreview", "ownerPid", "ownerBootMs"];

describe("codemode projection (outputSchema / structuredContent)", () => {
  test("ptc_task_list projects the filterable fields and leaves the record's fat behind", async () => {
    const h = createHarness(1000);
    // A record carrying the two optional fields plus everything a mirror of `details` would drag
    // in: a 12-byte preview, its storage ref, and the ADR-0023 owner identity.
    h.clock.set(1000);
    await spawnTask(h, TASK_1, {
      label: "research X",
      outputBytes: 12,
      errorMessage: "spawn failed",
      outputPreview: SMALL_OUTPUT,
      outputRef: "memory:tasks/x/output.log",
      ownerPid: 4242,
      ownerBootMs: 1_700_000_000_001,
    });
    h.clock.set(2000);
    await spawnTask(h, TASK_2, { label: "research Y" });
    const tool = createPtcTaskListTool(h.registry);

    const structured = await callStructured<ListShape>(tool, {});

    // toStrictEqual, not toEqual: toEqual treats `{a: undefined}` and `{}` as equal, which is
    // exactly the mistake this projection exists to avoid (see the Object.hasOwn cases below).
    expect(structured).toStrictEqual({
      count: 2,
      tasks: [
        { id: TASK_2, status: "running", agent: "researcher", depth: 0, label: "research Y" },
        {
          id: TASK_1,
          status: "running",
          agent: "researcher",
          depth: 0,
          label: "research X",
          output_bytes: 12,
          error_message: "spawn failed",
        },
      ],
    });
    // The lean-projection rule, checked on the row that DOES carry those four fields: `details`
    // keeps them, the projection must not. Mirroring `details` makes this loop fail on key one.
    const fat = structured.tasks[1] as ListRowShape;
    for (const key of MIRROR_ONLY_KEYS) {
      expect(Object.hasOwn(fat, key)).toBe(false);
    }
    // `content` and `details` are untouched by all of this.
    const full = await callTool<PtcTaskListDetails>(tool, {});
    const record = full.details.tasks.find((entry) => entry.id === TASK_1);
    expect(record?.outputPreview).toBe(SMALL_OUTPUT);
    expect(record?.outputRef).toBe("memory:tasks/x/output.log");
    expect(record?.ownerPid).toBe(4242);
    expect(textOf(full)).toContain("error=spawn failed");
  });

  test("a running task's row omits output_bytes and error_message as keys, not as undefined", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    const tool = createPtcTaskListTool(h.registry);

    const row = (await callStructured<ListShape>(tool, {})).tasks[0] as ListRowShape;

    // `JsonObject` is `{ [key: string]: JsonValue }` and `undefined` is not a `JsonValue`, so a key
    // set to undefined is a type error and a key serialized into the sandbox is a lie. Object.hasOwn
    // is the only assertion that tells the two apart — `toBeUndefined` passes for both.
    expect(Object.hasOwn(row, "output_bytes")).toBe(false);
    expect(Object.hasOwn(row, "error_message")).toBe(false);
    expect(Object.keys(row).sort()).toEqual(["agent", "depth", "id", "label", "status"]);
  });

  test("ptc_task_output projects the truncation facts plus the record's status", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    await h.outputs.writeOutput(TASK_1, SMALL_OUTPUT);
    const tool = createPtcTaskOutputTool(h.registry, h.outputs);

    const structured = await callStructured<OutputShape>(tool, { taskId: TASK_1 });

    expect(structured).toStrictEqual({
      task_id: TASK_1,
      status: "running",
      output: SMALL_OUTPUT,
      output_bytes: 12,
      output_preview: SMALL_OUTPUT,
      output_truncated: false,
    });
    // 12 <= 2048, so ADR-0022 §7's inline preview is present; nothing was cut, so there is no
    // full-output file to point at.
    expect(Object.hasOwn(structured, "output_full_path")).toBe(false);
  });

  test("a truncated read carries output_full_path and drops output_preview as a key", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    await h.outputs.writeOutput(TASK_1, LARGE_OUTPUT);
    const tool = createPtcTaskOutputTool(h.registry, h.outputs);

    const structured = await callStructured<OutputShape>(tool, { taskId: TASK_1 });
    const fullPath = structured.output_full_path as string;
    tempFullPaths.push(fullPath);

    expect(structured.task_id).toBe(TASK_1);
    expect(structured.status).toBe("running");
    expect(structured.output_bytes).toBe(Buffer.byteLength(LARGE_OUTPUT, "utf8"));
    expect(structured.output_truncated).toBe(true);
    expect(structured.output_full_path).toBe(fullPath);
    // ~24 KB is over the 2048-byte preview ceiling, so the key is absent rather than empty.
    expect(Object.hasOwn(structured, "output_preview")).toBe(false);
    expect(structured.output).toContain("line-2499");
  });

  test("ptc_task_stop projects task_id, status, from_status and stop_reason", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    h.clock.set(1500);
    const tool = createPtcTaskStopTool(h.registry, h.lifecycle, { clock: h.clock.clock });

    const structured = await callStructured<StopShape>(tool, { taskId: TASK_1 });

    expect(structured).toStrictEqual({
      task_id: TASK_1,
      status: "stopping",
      from_status: "running",
      stop_reason: "model stop",
    });
    // The default reason is a real ADR-0022 §8 string, not an empty stand-in.
    expect(structured.stop_reason).toBe(DEFAULT_STOP_REASON);
  });

  test("a late stop on a reasonless record omits stop_reason as a key", async () => {
    const h = createHarness(1000);
    await spawnTask(h, TASK_1);
    // Reach `stopping` without a reason through the generic transition edge (the registry's
    // `reason` -> stopReason rule only fires when a reason is supplied), so the late-arrival stop
    // below returns a record that genuinely has no stopReason. The reachable half of the omit rule.
    await h.registry.transition(
      { kind: "transition", taskId: TASK_1, to: "stopping" },
      { clock: h.clock.clock, callerId: CALLER },
    );
    const tool = createPtcTaskStopTool(h.registry, h.lifecycle, { clock: h.clock.clock });

    const structured = await callStructured<StopShape>(tool, { taskId: TASK_1, reason: "second" });

    expect(structured.status).toBe("stopping");
    expect(structured.from_status).toBe("stopping");
    expect(Object.hasOwn(structured, "stop_reason")).toBe(false);
    expect(Object.keys(structured).sort()).toEqual(["from_status", "status", "task_id"]);
  });

  test("every projection survives a JSON round trip — the sandbox receives JSON, not objects", async () => {
    const h = createHarness(1000);
    h.clock.set(1000);
    await spawnTask(h, TASK_1, { outputBytes: 12, errorMessage: "spawn failed" });
    h.clock.set(2000);
    await spawnTask(h, TASK_2);
    await h.outputs.writeOutput(TASK_1, SMALL_OUTPUT);
    const list = createPtcTaskListTool(h.registry);
    const output = createPtcTaskOutputTool(h.registry, h.outputs);
    const stop = createPtcTaskStopTool(h.registry, h.lifecycle, { clock: h.clock.clock });

    const listValue = await callStructured<ListShape>(list, {});
    const outputValue = await callStructured<OutputShape>(output, { taskId: TASK_1 });
    const stopValue = await callStructured<StopShape>(stop, { taskId: TASK_1, reason: "done" });

    // A key whose value is `undefined` survives `toStrictEqual` above and VANISHES here, so this
    // round trip is what actually proves the projections are real JSON.
    expect(JSON.parse(JSON.stringify(listValue))).toStrictEqual(listValue);
    expect(JSON.parse(JSON.stringify(outputValue))).toStrictEqual(outputValue);
    expect(JSON.parse(JSON.stringify(stopValue))).toStrictEqual(stopValue);
    // The bare row keeps its five keys across the trip — nothing was silently dropped. It is
    // `tasks[0]` because the projection is newest-first and TASK_2 spawned last.
    const bare = (JSON.parse(JSON.stringify(listValue)) as ListShape).tasks[0] as ListRowShape;
    expect(Object.keys(bare).sort()).toEqual(["agent", "depth", "id", "label", "status"]);
  });

  test("a failing call has no result and so no structuredContent to project (constraint #1)", async () => {
    const h = createHarness(1000);
    const output = createPtcTaskOutputTool(h.registry, h.outputs);
    const stop = createPtcTaskStopTool(h.registry, h.lifecycle, { clock: h.clock.clock });
    await spawnTask(h, TASK_1);

    // The declared schemas describe successful results only; pi's `toScriptValue` falls back to
    // the text content (and then throws it) when there is no `structuredContent`, so a failure
    // must reject rather than resolve with a half-filled projection.
    await expect(callTool(output, { taskId: TASK_404 })).rejects.toThrow(
      `ptc_task_output: unknown taskId ${TASK_404}`,
    );
    await expect(callTool(stop, { taskId: TASK_404 })).rejects.toThrow(
      `ptc_task_stop: unknown taskId ${TASK_404}`,
    );
    await expect(callTool(output, { taskId: TASK_1, sinceBytes: 1.5 })).rejects.toThrow(
      /sinceBytes must be a non-negative integer/,
    );
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

  test("writes an explicit fullText while truncating a smaller display page", () => {
    const page = "p".repeat(DEFAULT_MAX_BYTES + 1);
    const full = "F".repeat(DEFAULT_MAX_BYTES * 2);

    const result = applyAdr0015Truncation(page, full);

    expect(result.truncated).toBe(true);
    const fullPath = result.fullPath as string;
    tempFullPaths.push(fullPath);
    // The pointer's file is the complete body, never the displayed page. Counterfactual (#5):
    // dropping the second argument writes the page and makes this red.
    expect(readFileSync(fullPath, "utf8")).toBe(full);
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

describe("ptc_task_output renders an opted-out background child correctly (ADR-0032)", () => {
  // Review round 1, finding 4: an opted-out agent resolves `succeeded` with `reportChannel:
  // "opted-out"` and NO report. That is an ordinary outcome — nobody was asked — but it was
  // falling into the "names a channel but carries no report" anomaly branch and being announced
  // to the model as an anomaly. `tools/render.ts` had the same defect and was fixed in 29b3a9a;
  // this is the other renderer, and it was missed.
  //
  // Counterfactual: delete the opted-out branch and this goes red.
  function recordFor(channel: string, report?: unknown): TaskRecord {
    return { reportChannel: channel, report } as unknown as TaskRecord;
  }

  test("opted-out says nobody was asked, rather than reporting a missing report", () => {
    const rendered = renderChildReportForTest(recordFor("opted-out"));

    expect(rendered).toContain('channel="opted-out"');
    expect(rendered).toContain("opts out of the report contract");
    expect(rendered).toContain("nothing is missing");
    expect(rendered).not.toContain("but carries no report");
  });

  test("none still reads as non-compliance, and does not borrow opted-out's wording", () => {
    const rendered = renderChildReportForTest(recordFor("none"));

    expect(rendered).toContain("did not comply");
    expect(rendered).not.toContain("opts out of the report contract");
  });

  test("the anomaly branch is still reachable for a channel that arrived with nothing", () => {
    // So the fix above did not simply delete the anomaly branch to make the common case quiet.
    const rendered = renderChildReportForTest(recordFor("tool"));

    expect(rendered).toContain("but carries no report");
    expect(rendered).not.toContain("opts out of the report contract");
    expect(rendered).not.toContain("did not comply");
  });
});
