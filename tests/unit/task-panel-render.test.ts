/**
 * BG-09 unit tests for the task-panel TUI renderer (`src/tools/task-panel-render.ts`).
 *
 * SPECIFICATION tests (docs/testing-constraints.md #6): every expected value traces to a literal
 * in ADR-0022 — the 6-state machine and its colour intent (§2: running active / stopping transient
 * / succeeded success / failed error / lost dim / canceled muted), the TaskRecord 21-field schema
 * (§3), and the ADR-0015 truncation pointer (§7). Nothing is copied from the implementation.
 *
 * The theme stub returns `[<slot>]text[/]` so a test asserts the *slot* the renderer chose, not an
 * opaque ANSI snapshot. The six status rows are pinned individually, which is the counterfactual
 * guard: swapping any two slots turns a test red.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TaskRecord, TaskStatus } from "../../src/runtime/task-storage.ts";
import {
  createTaskPanelRenderers,
  type TaskPanelSurface,
} from "../../src/tools/task-panel-render.ts";

/** Deterministic theme: `fg(slot, text)` marks the chosen slot, so the test can assert colour. */
function makeTheme(): Theme {
  const wrap = (slot: string, text: string): string => `[${slot}]${text}[/]`;
  return {
    fg: wrap,
    bold: (text: string) => `*${text}*`,
  } as unknown as Theme;
}

interface RenderOptions {
  isPartial?: boolean;
  invalidate?: () => void;
  state?: Record<string, unknown>;
}

/** Render one result row through the factory and return the visible lines joined by newline. */
function renderResult(
  surface: TaskPanelSurface,
  details: unknown,
  options: RenderOptions = {},
): string {
  const renderers = createTaskPanelRenderers(surface);
  const renderResultFn = renderers.renderResult;
  if (renderResultFn === undefined) {
    throw new Error("renderResult must be defined");
  }
  const component = renderResultFn(
    { content: [], details },
    { expanded: false, isPartial: options.isPartial ?? false },
    makeTheme(),
    {
      args: {},
      invalidate: options.invalidate ?? (() => {}),
      state: options.state ?? {},
      isPartial: options.isPartial ?? false,
      isError: false,
    } as never,
  );
  return component
    .render(200)
    .map((line) => line.trimEnd())
    .join("\n");
}

/** Render one call row through the factory. */
function renderCall(surface: TaskPanelSurface, args: unknown): string {
  const renderers = createTaskPanelRenderers(surface);
  const renderCallFn = renderers.renderCall;
  if (renderCallFn === undefined) {
    throw new Error("renderCall must be defined");
  }
  return renderCallFn(args, makeTheme(), {} as never)
    .render(200)
    .map((line) => line.trimEnd())
    .join("\n");
}

const TASK_ID = "01JBZ000000000000000000001" as TaskRecord["id"];
const BASE = 1_700_000_000_000;

/** TaskRecord fixture copied field-for-field from ADR-0022 §3. */
function makeRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: TASK_ID,
    label: "research X",
    agentName: "researcher",
    depth: 0,
    status: "running",
    createdAt: BASE,
    startedAt: BASE,
    transitionAt: BASE,
    spawnSource: { kind: "ptc-program", callerId: "run-001" },
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
//  ADR-0022 §2 — status colour + glyph
// ---------------------------------------------------------------------------

/** [status, expected theme slot, expected glyph] — the ADR's "active/transition/terminal" intent. */
const STATUS_CASES: ReadonlyArray<readonly [TaskStatus, string, string]> = [
  ["running", "accent", "●"],
  ["stopping", "warning", "◐"],
  ["succeeded", "success", "✓"],
  ["failed", "error", "✗"],
  ["lost", "dim", "◌"],
  ["canceled", "muted", "⊘"],
];

describe("status colour + glyph (ADR-0022 §2)", () => {
  for (const [status, slot, glyph] of STATUS_CASES) {
    test(`${status} renders its own [${slot}] ${glyph}`, () => {
      const out = renderResult("task-list", {
        tasks: [makeRecord({ status, durationMs: 1000, finishedAt: BASE + 1000 })],
        count: 1,
      });
      expect(out).toContain(`[${slot}]${glyph}[/]`);
    });
  }
});

// ---------------------------------------------------------------------------
//  Live age vs frozen terminal duration
// ---------------------------------------------------------------------------

describe("age and frozen duration", () => {
  test("running row renders elapsed time since createdAt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE + 134_000);
    const out = renderResult("task-list", {
      tasks: [makeRecord({ status: "running", createdAt: BASE })],
      count: 1,
    });
    expect(out).toContain("2m14s");
  });

  test("stopping row also ticks its live age", () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE + 5_000);
    const out = renderResult("task-list", {
      tasks: [makeRecord({ status: "stopping", createdAt: BASE })],
      count: 1,
    });
    expect(out).toContain("5s");
  });

  test("terminal row renders the frozen durationMs, not the live age", () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE + 100_000);
    const out = renderResult("task-list", {
      tasks: [
        makeRecord({
          status: "succeeded",
          createdAt: BASE,
          durationMs: 5_000,
          finishedAt: BASE + 5_000,
        }),
      ],
      count: 1,
    });
    expect(out).toContain("5s");
    // A live-age render at now = BASE + 100s would have printed "1m40s" instead.
    expect(out).not.toContain("1m40s");
  });

  test("terminal row without durationMs falls back to finishedAt - createdAt", () => {
    const out = renderResult("task-list", {
      tasks: [makeRecord({ status: "failed", createdAt: BASE, finishedAt: BASE + 7_000 })],
      count: 1,
    });
    expect(out).toContain("7s");
  });
});

// ---------------------------------------------------------------------------
//  task-list row shape
// ---------------------------------------------------------------------------

describe("task-list row shape", () => {
  test("carries label, agent, age and outputBytes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE + 134_000);
    const out = renderResult("task-list", {
      tasks: [makeRecord({ status: "running", createdAt: BASE, outputBytes: 1234 })],
      count: 1,
    });
    expect(out).toContain("research X");
    expect(out).toContain("researcher");
    expect(out).toContain("2m14s");
    expect(out).toContain("1234B");
  });

  test("empty list renders the placeholder", () => {
    const out = renderResult("task-list", { tasks: [], count: 0 });
    expect(out).toContain("(no background tasks)");
  });
});

// ---------------------------------------------------------------------------
//  task-output: preview vs pointer vs truncation flag
// ---------------------------------------------------------------------------

describe("task-output", () => {
  test("renders the output preview and byte count when there is output", () => {
    const out = renderResult("task-output", {
      taskId: TASK_ID,
      output: "hello world",
      outputBytes: 11,
      outputTruncated: false,
    });
    expect(out).toContain("hello world");
    expect(out).toContain("11B");
    expect(out).not.toContain("truncated");
  });

  test("falls back to a pointer line naming outputFullPath when there is no preview", () => {
    const out = renderResult("task-output", {
      taskId: TASK_ID,
      output: "",
      outputBytes: 90_000,
      outputTruncated: true,
      outputFullPath: "/tmp/full-output.txt",
    });
    expect(out).toContain("/tmp/full-output.txt");
    expect(out).toContain("truncated");
  });

  test("states outputTruncated in-band next to the preview and names the full file", () => {
    const out = renderResult("task-output", {
      taskId: TASK_ID,
      output: "tail only",
      outputBytes: 90_000,
      outputTruncated: true,
      outputFullPath: "/tmp/full-output.txt",
    });
    expect(out).toContain("tail only");
    expect(out).toContain("[warning]truncated[/]");
    expect(out).toContain("/tmp/full-output.txt");
  });

  test("no output and no full path renders the placeholder", () => {
    const out = renderResult("task-output", {
      taskId: TASK_ID,
      output: "",
      outputBytes: 0,
      outputTruncated: false,
    });
    expect(out).toContain("(no output yet)");
  });
});

// ---------------------------------------------------------------------------
//  task-stop: terminal transition summary
// ---------------------------------------------------------------------------

describe("task-stop", () => {
  test("renders the running -> stopping transition and the stopReason", () => {
    const out = renderResult("task-stop", {
      task: makeRecord({ status: "stopping", stopReason: "model stop" }),
    });
    expect(out).toContain("running → stopping");
    expect(out).toContain("[warning]running → stopping[/]");
    expect(out).toContain("reason=model stop");
  });

  test("omits the reason cell when stopReason is absent", () => {
    const out = renderResult("task-stop", {
      task: makeRecord({ status: "stopping" }),
    });
    expect(out).toContain("running → stopping");
    expect(out).not.toContain("reason=");
  });
});

// ---------------------------------------------------------------------------
//  live age timer (context.invalidate on a 1s cadence)
// ---------------------------------------------------------------------------

describe("live age timer", () => {
  test("a partial list with a live record requests invalidate every second", () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    const invalidate = vi.fn();
    const state: Record<string, unknown> = {};
    renderResult(
      "task-list",
      { tasks: [makeRecord({ status: "running" })], count: 1 },
      { isPartial: true, invalidate, state },
    );
    expect(invalidate).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(3_000);
    expect(invalidate).toHaveBeenCalledTimes(3);
  });

  test("a partial list with only terminal records starts no timer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    const invalidate = vi.fn();
    renderResult(
      "task-list",
      {
        tasks: [makeRecord({ status: "succeeded", durationMs: 1000, finishedAt: BASE + 1000 })],
        count: 1,
      },
      { isPartial: true, invalidate, state: {} },
    );
    vi.advanceTimersByTime(3_000);
    expect(invalidate).toHaveBeenCalledTimes(0);
  });

  test("a settled render clears the interval", () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    const invalidate = vi.fn();
    const state: Record<string, unknown> = {};
    const tasks = [makeRecord({ status: "running" })];
    renderResult("task-list", { tasks, count: 1 }, { isPartial: true, invalidate, state });
    renderResult("task-list", { tasks, count: 1 }, { isPartial: false, invalidate, state });
    vi.advanceTimersByTime(3_000);
    expect(invalidate).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
//  renderCall
// ---------------------------------------------------------------------------

describe("renderCall", () => {
  test("task-list call row names the tool, filter and limit", () => {
    const out = renderCall("task-list", { status: ["running", "stopping"], limit: 5 });
    expect(out).toContain("PTC task list");
    expect(out).toContain("status=running,stopping");
    expect(out).toContain("limit=5");
  });

  test("task-list call row defaults the filter to all states", () => {
    const out = renderCall("task-list", {});
    expect(out).toContain("status=all");
  });

  test("task-output call row names the task id and since offset", () => {
    const out = renderCall("task-output", { taskId: TASK_ID, sinceBytes: 10 });
    expect(out).toContain("PTC task output");
    expect(out).toContain(TASK_ID);
    expect(out).toContain("since=10B");
  });

  test("task-stop call row names the task id and reason", () => {
    const out = renderCall("task-stop", { taskId: TASK_ID, reason: "user" });
    expect(out).toContain("PTC task stop");
    expect(out).toContain(TASK_ID);
    expect(out).toContain("reason=user");
  });
});

// ---------------------------------------------------------------------------
//  Failure path (pi's isError result shape)
// ---------------------------------------------------------------------------

describe("error result", () => {
  test("an isError result renders the failure text in the error slot", () => {
    const renderers = createTaskPanelRenderers("task-list");
    const renderResultFn = renderers.renderResult;
    if (renderResultFn === undefined) {
      throw new Error("renderResult must be defined");
    }
    const component = renderResultFn(
      { content: [{ type: "text", text: "ptc_task_list: registry offline" }], details: {} },
      { expanded: false, isPartial: false },
      makeTheme(),
      { args: {}, isError: true } as never,
    );
    const out = component
      .render(200)
      .map((line) => line.trimEnd())
      .join("\n");
    expect(out).toContain("[error]failed: ptc_task_list: registry offline[/]");
  });
});
