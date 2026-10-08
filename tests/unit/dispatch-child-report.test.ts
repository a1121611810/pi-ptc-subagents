/**
 * ADR-0032 child report — the prompt channel (channel 2, the fallback) end to end.
 *
 * Four seams, in the order the ticket names them:
 *   1. the pure extraction over a literal JSONL transcript, with no spawn at all;
 *   2. the real `dispatch()` foreground path resolving a `DispatchResult`;
 *   3. the detached background pump, for the same transcript (foreground/background parity);
 *   4. `reportChannel` being TOTAL — present on every result shape, refusals included.
 *
 * SPECIFICATION tests (docs/testing-constraints.md #4/#6): the report payload is a literal
 * authored from ADR-0032's four fields, the transcript lines are the `message_end` assistant
 * shape pi really emits (the captured pi 0.87.1 sample documented on
 * `childAssistantError` in src/runtime/dispatch.ts), and every expectation is either that
 * literal, a named invariant, or a value read back out of the fixture. Nothing is asserted
 * against what the implementation happened to produce.
 *
 * Dependencies are injected (#1): the foreground path drives a `node:child_process` mock whose
 * stdout carries the transcript, the background path drives a `MockChildProcessLifecycle`, and
 * both use in-memory task storage — no `pi` process, no home directory, no ambient agent.
 */
import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  DispatchSlotCounter,
  appendDepthHint,
  dispatch,
  extractChildReport,
  extractChildReportFromText,
  type ChildReport,
  type ChildReportPayload,
  type ChildReportExtraction,
  type DispatchDeps,
  type DispatchResult,
} from "../../src/runtime/dispatch.ts";
import {
  MockChildProcessLifecycle,
  parseAgentEvent,
  type ChildHandle,
  type ChildSpawnOptions,
  type ParsedAgentEvent,
} from "../../src/runtime/child-process-lifecycle.ts";
import { createTaskRegistry, type DispatchHandle } from "../../src/runtime/task-registry.ts";
import { InMemoryOutputStorage } from "../../src/runtime/output-storage.ts";
import { InMemoryTaskStorage } from "../../src/runtime/task-storage.ts";
import { makeTempDir, removeTempDir, waitFor } from "../helpers/ptc.ts";

// ---------------------------------------------------------------------------
//  node:child_process mock — the ONLY thing the foreground path spawns through
// ---------------------------------------------------------------------------

/**
 * The transcript the fake child writes to stdout. Set before `dispatch()`; every line is one
 * real JSONL event, flushed before `close`.
 */
const childTranscript = vi.hoisted(() => ({ lines: [] as string[] }));
/** When set, the fake child reports this as an async spawn failure instead of a clean close. */
const spawnFailure = vi.hoisted(() => ({ error: undefined as Error | undefined }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const fakeSpawn = (): EventEmitter => {
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
    const failure = spawnFailure.error;
    setImmediate(() => {
      if (failure !== undefined) {
        // Node reports an async spawn failure (ENOENT and friends) as `error` before `close`.
        proc.emit("error", failure);
        proc.emit("close", -2);
        return;
      }
      for (const line of childTranscript.lines) {
        proc.stdout.emit("data", Buffer.from(line + "\n", "utf-8"));
      }
      proc.emit("close", 0);
    });
    return proc;
  };
  return { ...actual, spawn: fakeSpawn as unknown as typeof actual.spawn };
});

// ---------------------------------------------------------------------------
//  Fixtures
// ---------------------------------------------------------------------------

/**
 * The report a compliant child emits, as a literal -- the three fields the child DECLARES.
 * `files_touched` is snake_case because that is the wire text a model produces. Round-tripping
 * this exact object is the contract's invariant. It is a ChildReportPayload, not a ChildReport:
 * `usage` is host-observed and arrives later, which is the point of the split.
 */
const VALID_REPORT: ChildReportPayload = {
  summary: "A saturated counter refuses before any agent is discovered, so nothing is spawned.",
  findings: [
    {
      what: "the concurrency gate precedes discoverAgent",
      evidence: "the slot acquire returns dispatchConcurrencyLimitReached() before discovery",
    },
    {
      what: "the refusal reuses the foreground wording verbatim",
      evidence:
        "backgroundDispatchConcurrencyLimitReached() spreads dispatchConcurrencyLimitReached()",
    },
  ],
  files_touched: ["src/runtime/dispatch.ts", "tests/unit/dispatch-child-report.test.ts"],
};

/**
 * What the CALLER receives: the child's three declared fields plus the usage the HOST measured.
 *
 * These are different sources on purpose. A child cannot know its own token count, so anything it
 * wrote under `usage` would be a fabricated number wearing the costume of a measurement
 * (`docs/testing-constraints.md` #4). The host already counts usage off the child's `message_end`
 * blocks, and that counter is the independent source the expected value points at.
 */
const HOST_USAGE = { input: 900, output: 260, cost: 0.0123, turns: 1 };
const REPORT_WITH_HOST_USAGE: ChildReport = { ...VALID_REPORT, usage: HOST_USAGE };

/** The child prose that must survive extraction untouched. */
const PROSE_HEAD = "I read the dispatch gates and here is what I found.";
const PROSE_TAIL =
  "If you want the fallback covered end to end, the prompt channel is the one to test.";

const REPORT_BLOCK = "```json\n" + JSON.stringify(VALID_REPORT, null, 2) + "\n```";

/** A child's final message with the report block fenced between prose on both sides. */
const COMPLIANT_TEXT = PROSE_HEAD + "\n\n" + REPORT_BLOCK + "\n\n" + PROSE_TAIL;

/** One real `message_end` / assistant JSONL line, built from the shape pi emits. */
function assistantLine(text: string, usage?: Record<string, unknown>): string {
  return JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text }],
      ...(usage === undefined ? {} : { usage }),
    },
  });
}

/** A whole transcript: a thinking turn with no report, then the final compliant answer. */
const COMPLIANT_TRANSCRIPT: readonly string[] = [
  assistantLine("Still reading the gate."),
  assistantLine(COMPLIANT_TEXT, {
    input: 900,
    output: 260,
    cacheRead: 0,
    cacheWrite: 0,
    cost: { total: 0.0123 },
  }),
];

/** The same transcript shape, but the child never emitted a fence. */
const PLAIN_TRANSCRIPT: readonly string[] = [assistantLine("Here is the answer, in prose only.")];

/** Narrow a background result to its handle, or fail loudly. */
function asHandle(value: DispatchHandle | DispatchResult): DispatchHandle {
  if (!("taskId" in value)) {
    throw new Error("expected a DispatchHandle, got a DispatchResult refusal");
  }
  return value;
}

/** Narrow a dispatch result to a DispatchResult, or fail loudly. */
function asResult(value: DispatchHandle | DispatchResult): DispatchResult {
  if ("taskId" in value) {
    throw new Error("expected a DispatchResult, got a DispatchHandle");
  }
  return value;
}

/** Parse literal JSONL lines the way the real adapter does; a blank line yields nothing. */
function parseTranscript(lines: readonly string[]): ParsedAgentEvent[] {
  const out: ParsedAgentEvent[] = [];
  for (const line of lines) {
    const event = parseAgentEvent(line);
    if (event !== null) out.push(event);
  }
  return out;
}

/** Write a project-scope agent into a fresh temp cwd and run `body` against it. */
async function withAgent<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await makeTempDir();
  try {
    await mkdir(join(dir, ".pi", "agents"), { recursive: true });
    await writeFile(
      join(dir, ".pi", "agents", "reporter.md"),
      "---\nname: reporter\n---\nYou report.\n",
      { encoding: "utf-8" },
    );
    return await body(dir);
  } finally {
    await removeTempDir(dir);
  }
}

beforeEach(() => {
  childTranscript.lines = [];
  spawnFailure.error = undefined;
});

// ---------------------------------------------------------------------------
//  Seam 1 — the pure extraction, driven by literal JSONL, no spawn
// ---------------------------------------------------------------------------

describe("child report extraction (ADR-0032 prompt channel)", () => {
  test("prose on both sides of the fence still yields the report", () => {
    const extraction = extractChildReportFromText(COMPLIANT_TEXT);

    expect(extraction.reportChannel).toBe("prompt-json");
    // Round trip: the object the child wrote comes back field for field.
    expect(extraction.report).toEqual(VALID_REPORT);
    // Prose is a sibling of the report, never consumed by it.
    expect(extraction.report?.summary).toBe(VALID_REPORT.summary);
  });

  test("the transcript's last assistant message is the one read", () => {
    const extraction = extractChildReport(parseTranscript(COMPLIANT_TRANSCRIPT));

    expect(extraction.reportChannel).toBe("prompt-json");
    expect(extraction.report).toEqual(VALID_REPORT);
  });

  test("two fenced blocks yields the second, not the first", () => {
    const first = {
      summary: "the abandoned first attempt",
      findings: [],
      files_touched: ["never-written.md"],
    };
    const text =
      "```json\n" +
      JSON.stringify(first) +
      "\n```\n\nActually, here is the real one:\n\n" +
      REPORT_BLOCK;

    const extraction = extractChildReportFromText(text);

    expect(extraction.reportChannel).toBe("prompt-json");
    expect(extraction.report?.summary).toBe(VALID_REPORT.summary);
    expect(extraction.report?.files_touched).not.toContain("never-written.md");
  });

  test("a truncated block yields reportChannel none and no report", () => {
    // The fence is opened and never closed: the body runs to the end of the text and is not
    // valid JSON. A parser that "helpfully" closed the fence would find no JSON here either.
    const truncated =
      PROSE_HEAD + "\n\n```json\n" + JSON.stringify(VALID_REPORT, null, 2).slice(0, 40);

    const extraction = extractChildReportFromText(truncated);

    expect(extraction.reportChannel).toBe("none");
    expect(extraction.report).toBeUndefined();
  });

  test("a malformed block yields reportChannel none and no report", () => {
    const extraction = extractChildReportFromText(
      PROSE_HEAD + "\n\n```json\n{ summary: nope }\n```",
    );

    expect(extraction.reportChannel).toBe("none");
    expect(extraction.report).toBeUndefined();
  });

  test("a valid block with extra unknown keys still yields the report", () => {
    const withExtras = {
      ...VALID_REPORT,
      confidence: "high",
      findings: [VALID_REPORT.findings[0], { ...VALID_REPORT.findings[1], certainty: 0.9 }],
    };
    const text = "```json\n" + JSON.stringify(withExtras) + "\n```";

    const extraction = extractChildReportFromText(text);

    expect(extraction.reportChannel).toBe("prompt-json");
    expect(extraction.report).toEqual(VALID_REPORT);
  });

  test("a child-declared usage is DISCARDED, not carried through", () => {
    // The child cannot know its token count. A block that declares one is reporting a number it
    // invented, and a report that carried it would be a measurement-shaped fabrication — exactly
    // what docs/testing-constraints.md #4 forbids. The host stamps its own at settle time, so the
    // extraction hands back the three child-declared fields and nothing else.
    const lying = { ...VALID_REPORT, usage: { input: 1, output: 1, cost: 0, turns: 99 } };
    const text = "```json\n" + JSON.stringify(lying) + "\n```";

    const extraction = extractChildReportFromText(text);

    expect(extraction.reportChannel).toBe("prompt-json");
    expect(extraction.report).toEqual(VALID_REPORT);
    expect(extraction.report).not.toHaveProperty("usage");
    // Counterfactual: an implementation that passed the child's block through whole turns this red.
    expect(JSON.stringify(extraction.report)).not.toContain("99");
  });

  test("a report is still valid when the child omits usage entirely", () => {
    const text = "```json\n" + JSON.stringify(VALID_REPORT) + "\n```";

    const extraction = extractChildReportFromText(text);

    expect(extraction.reportChannel).toBe("prompt-json");
    expect(extraction.report).toEqual(VALID_REPORT);
  });

  test("each missing required key yields reportChannel none and no report", () => {
    const dropped: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["summary", { ...VALID_REPORT, summary: undefined }],
      ["findings", { ...VALID_REPORT, findings: undefined }],
      ["files_touched", { ...VALID_REPORT, files_touched: undefined }],
    ];

    for (const [key, payload] of dropped) {
      const text = "```json\n" + JSON.stringify(payload) + "\n```";
      const extraction = extractChildReportFromText(text);

      expect(extraction.reportChannel, "channel for a report missing " + key).toBe("none");
      expect(extraction.report, "report for a payload missing " + key).toBeUndefined();
    }
  });

  test("a mistyped required key yields reportChannel none and no report", () => {
    const mistyped = {
      ...VALID_REPORT,
      findings: [{ what: "ok", evidence: 7 }],
    };
    const text = "```json\n" + JSON.stringify(mistyped) + "\n```";

    const extraction = extractChildReportFromText(text);

    expect(extraction.reportChannel).toBe("none");
    expect(extraction.report).toBeUndefined();
  });

  test("COUNTERFACTUAL: prose carrying the shape inline is not a report", () => {
    // An implementation that scraped the first JSON-looking substring out of the reply and
    // called it a report goes RED here: no fence means no report, and `report` is strictly
    // undefined rather than a summary rebuilt from the prose.
    const inline =
      'My answer is {"summary": "I read the gates", "findings": [], ' +
      '"files_touched": [], "usage": {"input": 0, "output": 0, "cost": 0, "turns": 1}} ' +
      "but I did not fence it.";

    const extraction = extractChildReportFromText(inline);

    expect(extraction.reportChannel).toBe("none");
    expect(extraction.report).toBeUndefined();
  });

  test("COUNTERFACTUAL: a reply with no fence yields no report even when it reads like one", () => {
    const noFence = parseTranscript(PLAIN_TRANSCRIPT);

    const extraction = extractChildReport(noFence);

    expect(extraction.reportChannel).toBe("none");
    expect(extraction.report).toBeUndefined();
  });

  test("an empty transcript yields no report", () => {
    const extraction = extractChildReport([]);

    expect(extraction.reportChannel).toBe("none");
    expect(extraction.report).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
//  Seam 2 — the real dispatch(), foreground
// ---------------------------------------------------------------------------

describe("dispatch() foreground carries the child report", () => {
  test("a compliant transcript resolves fulfilled with the report, the prose intact", async () => {
    await withAgent(async (dir) => {
      childTranscript.lines = [...COMPLIANT_TRANSCRIPT];

      const result = asResult(
        await dispatch(
          { agent: "reporter", task: "check the gates", agentScope: "project" },
          { callId: 1, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          { slots: new DispatchSlotCounter(4) },
        ),
      );

      expect(result.status).toBe("fulfilled");
      expect(result.reportChannel).toBe("prompt-json");
      expect(result.report).toEqual(REPORT_WITH_HOST_USAGE);
      // ADR-0032: prose is preserved alongside the report, never replaced by it.
      expect(result.text).toBe(COMPLIANT_TEXT);
      expect(result.text.startsWith(PROSE_HEAD)).toBe(true);
      expect(result.text.endsWith(PROSE_TAIL)).toBe(true);
    });
  });

  test("a non-compliant transcript resolves fulfilled with its prose and channel none", async () => {
    await withAgent(async (dir) => {
      childTranscript.lines = [...PLAIN_TRANSCRIPT];

      const result = asResult(
        await dispatch(
          { agent: "reporter", task: "check the gates", agentScope: "project" },
          { callId: 2, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          { slots: new DispatchSlotCounter(4) },
        ),
      );

      // ADR-0032 "none is an ordinary outcome": discarding a completed child's answer over a
      // formatting failure would be worse than handing it over marked as untrusted.
      expect(result.status).toBe("fulfilled");
      expect(result.text).toBe("Here is the answer, in prose only.");
      expect(result.reportChannel).toBe("none");
      expect(result.report).toBeUndefined();
    });
  });

  test("the child prompt carries the contract clause", async () => {
    await withAgent(async (dir) => {
      childTranscript.lines = [...COMPLIANT_TRANSCRIPT];

      await dispatch(
        { agent: "reporter", task: "check the gates", agentScope: "project" },
        { callId: 3, cwd: dir, depth: 0, maxDispatchDepth: 3 },
        { slots: new DispatchSlotCounter(4) },
      );

      const prompt = appendDepthHint("You report.", 1, 3);
      expect(prompt).toContain("fenced ```json block");

      // The shape IS here, and that is a deliberate TEMPORARY state, not ADR-0032's end state.
      // The report tool that becomes the shape's one home does not exist until #101; until it
      // does, this clause is the only place a child can learn what to emit. #101's job is to
      // DELETE the shape from here, and this assertion is written to be the thing that fails
      // when that deletion happens — so the migration cannot be forgotten silently.
      expect(prompt).toContain("files_touched");

      // What must never appear, in either state: an ask for usage. The host measures that, and a
      // child asked for it invents a number. See ChildReportPayload.
      expect(prompt).toContain("Do not report usage or token counts");
    });
  });
});

// ---------------------------------------------------------------------------
//  Seam 3 — background parity
// ---------------------------------------------------------------------------

/** Records the handles the background branch spawns so the test can drive its events. */
class RecordingLifecycle extends MockChildProcessLifecycle {
  readonly spawned: ChildHandle[] = [];

  override spawn(argv: readonly string[], opts: ChildSpawnOptions): ChildHandle {
    const handle = super.spawn(argv, opts);
    this.spawned.push(handle);
    return handle;
  }
}

interface BackgroundHarness {
  lifecycle: RecordingLifecycle;
  deps: DispatchDeps;
  reports: Map<string, ChildReportExtraction>;
}

function createBackgroundHarness(): BackgroundHarness {
  const lifecycle = new RecordingLifecycle();
  const reports = new Map<string, ChildReportExtraction>();
  const storage = new InMemoryTaskStorage();
  return {
    lifecycle,
    reports,
    deps: {
      lifecycle,
      taskRegistry: createTaskRegistry(storage, { clock: (): number => 1000 }),
      outputStorage: new InMemoryOutputStorage(),
      slots: new DispatchSlotCounter(4),
      onChildReport: (taskId, extraction): void => {
        reports.set(taskId, extraction);
      },
    },
  };
}

/** Feed a literal transcript into the pump's child, then close it cleanly. */
function driveBackground(lifecycle: RecordingLifecycle, lines: readonly string[]): void {
  const handle = lifecycle.spawned[0];
  if (handle === undefined) throw new Error("no background child was spawned");
  for (const line of lines) {
    const event = parseAgentEvent(line);
    if (event !== null) lifecycle.pushEvent(handle, event);
  }
  lifecycle.resolveExit(handle, 0, null);
}

describe("dispatch() background yields the same report as foreground (parity)", () => {
  test("the same compliant transcript produces the same report and channel", async () => {
    await withAgent(async (dir) => {
      const h = createBackgroundHarness();
      const handle = asHandle(
        await dispatch(
          { agent: "reporter", task: "check the gates", background: true, agentScope: "project" },
          { callId: 4, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          h.deps,
        ),
      );

      driveBackground(h.lifecycle, COMPLIANT_TRANSCRIPT);
      await waitFor(() => h.reports.has(handle.taskId));

      const extraction = h.reports.get(handle.taskId) as ChildReportExtraction;
      // Compared against the pure seam, not against a captured foreground run: the two must be
      // the same function's answer to the same transcript.
      expect(extraction).toEqual(extractChildReport(parseTranscript(COMPLIANT_TRANSCRIPT)));
      expect(extraction.reportChannel).toBe("prompt-json");
      expect(extraction.report).toEqual(VALID_REPORT);
    });
  });

  test("the same non-compliant transcript produces channel none and no report", async () => {
    await withAgent(async (dir) => {
      const h = createBackgroundHarness();
      const handle = asHandle(
        await dispatch(
          { agent: "reporter", task: "check the gates", background: true, agentScope: "project" },
          { callId: 5, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          h.deps,
        ),
      );

      driveBackground(h.lifecycle, PLAIN_TRANSCRIPT);
      await waitFor(() => h.reports.has(handle.taskId));

      const extraction = h.reports.get(handle.taskId) as ChildReportExtraction;
      expect(extraction.reportChannel).toBe("none");
      expect(extraction.report).toBeUndefined();
    });
  });

  test("the background refusal shapes name channel none", async () => {
    await withAgent(async (dir) => {
      const h = createBackgroundHarness();
      const refused = asResult(
        await dispatch(
          {
            agent: "reporter",
            task: "check the gates",
            background: true,
            agentScope: "project",
          },
          { callId: 6, cwd: dir, depth: 3, maxDispatchDepth: 3 },
          h.deps,
        ),
      );

      expect(refused.status).toBe("rejected");
      expect(refused.reportChannel).toBe("none");
      expect(refused.report).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
//  Seam 4 — reportChannel is TOTAL (docs/testing-constraints.md #3: no silent failure)
// ---------------------------------------------------------------------------

describe("reportChannel is present on every result shape", () => {
  test("fulfilled with a report", async () => {
    await withAgent(async (dir) => {
      childTranscript.lines = [...COMPLIANT_TRANSCRIPT];

      const result = asResult(
        await dispatch(
          { agent: "reporter", task: "t", agentScope: "project" },
          { callId: 7, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          { slots: new DispatchSlotCounter(4) },
        ),
      );

      expect(result.status).toBe("fulfilled");
      expect(result.reportChannel).toBe("prompt-json");
      expect(result.report).toBeDefined();
    });
  });

  test("fulfilled without a report", async () => {
    await withAgent(async (dir) => {
      childTranscript.lines = [...PLAIN_TRANSCRIPT];

      const result = asResult(
        await dispatch(
          { agent: "reporter", task: "t", agentScope: "project" },
          { callId: 8, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          { slots: new DispatchSlotCounter(4) },
        ),
      );

      expect(result.status).toBe("fulfilled");
      expect(result.reportChannel).toBe("none");
      expect(result.report).toBeUndefined();
    });
  });

  test("depth refusal", async () => {
    const result = asResult(
      await dispatch(
        { agent: "reporter", task: "t" },
        { callId: 9, cwd: process.cwd(), depth: 3, maxDispatchDepth: 3 },
        { slots: new DispatchSlotCounter(4) },
      ),
    );

    expect(result.status).toBe("rejected");
    expect(result.started).toBe(false);
    expect(result.reportChannel).toBe("none");
    expect(result.report).toBeUndefined();
  });

  test("concurrency refusal", async () => {
    const result = asResult(
      await dispatch(
        { agent: "reporter", task: "t" },
        { callId: 10, cwd: process.cwd(), depth: 0, maxDispatchDepth: 3 },
        // A zero-width cap refuses at the gate, before discovery or spawn.
        { slots: new DispatchSlotCounter(0) },
      ),
    );

    expect(result.status).toBe("rejected");
    expect(result.reportChannel).toBe("none");
    expect(result.report).toBeUndefined();
  });

  test("unknown agent", async () => {
    await withAgent(async (dir) => {
      const result = asResult(
        await dispatch(
          { agent: "nobody-by-that-name", task: "t", agentScope: "project" },
          { callId: 11, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          { slots: new DispatchSlotCounter(4) },
        ),
      );

      expect(result.status).toBe("rejected");
      expect(result.agentName).toBe("nobody-by-that-name");
      expect(result.reportChannel).toBe("none");
      expect(result.report).toBeUndefined();
    });
  });

  test("spawn failure", async () => {
    await withAgent(async (dir) => {
      spawnFailure.error = new Error("spawn pi ENOENT");

      const result = asResult(
        await dispatch(
          { agent: "reporter", task: "t", agentScope: "project" },
          { callId: 12, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          { slots: new DispatchSlotCounter(4) },
        ),
      );

      expect(result.status).toBe("rejected");
      expect(result.started).toBe(false);
      expect(result.reportChannel).toBe("none");
      expect(result.report).toBeUndefined();
    });
  });

  test("missing agent argument", async () => {
    const result = asResult(
      await dispatch(
        { agent: "   ", task: "t" },
        { callId: 13, cwd: process.cwd(), depth: 0, maxDispatchDepth: 3 },
        { slots: new DispatchSlotCounter(4) },
      ),
    );

    expect(result.status).toBe("rejected");
    expect(result.agentName).toBe("");
    expect(result.reportChannel).toBe("none");
    expect(result.report).toBeUndefined();
  });
});
