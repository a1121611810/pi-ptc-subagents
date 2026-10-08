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
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  DispatchSlotCounter,
  appendDepthHint,
  buildArgv,
  childToolList,
  dispatch,
  extractChildReport,
  extractChildReportFromText,
  extractChildReportFromToolEvent,
  isReportContractOn,
  parseAgentMarkdown,
  validateChildReport,
  finishChildReportScan,
  newChildReportScan,
  scanChildReportToolEvent,
  type AgentConfigLike,
  type ChildReport,
  type ChildReportPayload,
  type DispatchDeps,
  type DispatchResult,
} from "../../src/runtime/dispatch.ts";
import { CHILD_REPORT_SHAPE, CHILD_REPORT_TOOL_NAME } from "../../src/runtime/child-report.ts";
import {
  CHILD_REPORT_DESCRIPTION,
  createChildReportTool,
} from "../../src/tools/child-report-tool.ts";
import { makeExtensionStub } from "../helpers/ptc.ts";
import {
  MockChildProcessLifecycle,
  parseAgentEvent,
  type ChildHandle,
  type ChildSpawnOptions,
  type ParsedAgentEvent,
} from "../../src/runtime/child-process-lifecycle.ts";
import { createTaskRegistry, type DispatchHandle } from "../../src/runtime/task-registry.ts";
import { InMemoryOutputStorage } from "../../src/runtime/output-storage.ts";
import { InMemoryTaskStorage, type TaskRecord, type ULID } from "../../src/runtime/task-storage.ts";
import { makeTempDir, removeTempDir } from "../helpers/ptc.ts";

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
/**
 * Every argv the fake child was launched with. ADR-0032 "Activation is load-bearing" is a claim
 * about argv, and argv is the only place it is visible from the foreground path: the background
 * path can read its own mock's recorder, this one cannot, so the mock records it here.
 */
const childArgv = vi.hoisted(() => ({ calls: [] as string[][] }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const fakeSpawn = (_command: string, args: readonly string[]): EventEmitter => {
    childArgv.calls.push([...args]);
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
  childArgv.calls = [];
  spawnFailure.error = undefined;
});

/**
 * `PI_PTC_DEPTH` is how a pi process knows it is a dispatched child (ADR-0016 Recursive
 * section), and the report tool's activation is read off exactly that. These tests set it, so
 * every one of them restores it — a leaked value would silently make a LATER test in this file
 * a child, which is the kind of ambient state `docs/testing-constraints.md` warns about.
 */
afterEach(() => {
  delete process.env.PI_PTC_DEPTH;
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

  test("the child prompt names the report tool and no longer restates the shape", async () => {
    await withAgent(async (dir) => {
      childTranscript.lines = [...COMPLIANT_TRANSCRIPT];

      await dispatch(
        { agent: "reporter", task: "check the gates", agentScope: "project" },
        { callId: 3, cwd: dir, depth: 0, maxDispatchDepth: 3 },
        { slots: new DispatchSlotCounter(4) },
      );

      const prompt = appendDepthHint("You report.", 1, 3);
      // The clause still exists, because the tool is not always there — but it is ONE sentence
      // that requires the child to call it, and it says nothing about the shape.
      expect(prompt).toContain("call the `" + CHILD_REPORT_TOOL_NAME + "` tool");

      // THE MIGRATION, asserted in both directions (ADR-0032 "the contract has exactly one
      // home"). This is the assertion ticket #100 wrote to be the thing that fails when the
      // deletion happens, and #101 is the deletion: the shape is out of the prompt, and the same
      // text is now in the tool's description. Put the shape back in the prompt and the first
      // assertion goes red; take it out of the description and the second does.
      expect(prompt).not.toContain(CHILD_REPORT_SHAPE);
      expect(prompt).not.toContain("files_touched");
      expect(CHILD_REPORT_DESCRIPTION).toContain(CHILD_REPORT_SHAPE);

      // What must never appear, in any state: an ask for usage. The host measures that, and a
      // child asked for it invents a number. See ChildReportPayload.
      expect(prompt).not.toContain("Do not report usage or token counts");
      expect(CHILD_REPORT_DESCRIPTION).toContain("Do not report usage or token counts");
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
  storage: InMemoryTaskStorage;
  deps: DispatchDeps;
}

function createBackgroundHarness(): BackgroundHarness {
  const lifecycle = new RecordingLifecycle();
  const storage = new InMemoryTaskStorage();
  return {
    lifecycle,
    storage,
    deps: {
      lifecycle,
      taskRegistry: createTaskRegistry(storage, { clock: (): number => 1000 }),
      outputStorage: new InMemoryOutputStorage(),
      slots: new DispatchSlotCounter(4),
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

/**
 * Wait for the pump's terminal write and hand back the PERSISTED record. This is where the
 * background front's report lands (#104): there is no callback seam any more, so the record is
 * the only place a background report can be observed — which is the point.
 */
async function terminalRecord(h: BackgroundHarness, taskId: string): Promise<TaskRecord> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const record = await h.storage.loadTask(taskId as ULID);
    if (record !== null && record.status === "succeeded") return record;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("task " + taskId + " never reached succeeded");
}

describe("dispatch() background persists the same report as foreground returns (parity)", () => {
  test("the same compliant transcript persists the same report and channel", async () => {
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
      const record = await terminalRecord(h, handle.taskId);

      // Compared against the pure seam, not against a captured foreground run: the two must be
      // the same function's answer to the same transcript.
      const extraction = extractChildReport(parseTranscript(COMPLIANT_TRANSCRIPT));
      expect(record.reportChannel).toBe(extraction.reportChannel);
      expect(record.reportChannel).toBe("prompt-json");
      // `usage` is the host's counter over the SAME transcript the foreground run counts, so the
      // persisted report equals the foreground result's report field for field.
      expect(record.report).toEqual(REPORT_WITH_HOST_USAGE);
    });
  });

  test("the same non-compliant transcript persists channel none and no report", async () => {
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
      const record = await terminalRecord(h, handle.taskId);

      // The explicit marker, never a silent prose fallback (ADR-0032, testing-constraints #3).
      expect(record.reportChannel).toBe("none");
      expect(record.report).toBeUndefined();
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

// ---------------------------------------------------------------------------
//  Seam 5 — the contract has exactly one home (ADR-0032, ticket #101)
// ---------------------------------------------------------------------------

/** A distinctive tail of the shape text, so a scan can find copies of the WHOLE thing. */
const SHAPE_FINGERPRINT = '"files_touched" (an array of paths you created or modified)';

/**
 * Drop comments before scanning, so a `{@link CHILD_REPORT_SHAPE}` in a docstring does not count
 * as a USE of the constant. Crude on purpose: it is a test helper, not a parser, and the only
 * thing it has to get right is "code mentions it, prose does not".
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("the contract text lives in exactly one place in src/", () => {
  test("the shape text appears once in the whole shipped source, in the vocabulary module", async () => {
    // COUNTERFACTUAL (constraint 5). This is the test that makes "the contract has exactly one
    // home" a MECHANICAL claim rather than a sentence. Two separate failures it has to catch,
    // because they look identical in review and are not:
    //
    //   * a SECOND LITERAL — someone pastes the shape into the prompt clause or a second tool
    //     description. Caught by the fingerprint scan below.
    //   * a SECOND USE — someone concatenates `CHILD_REPORT_SHAPE` into a second place, which is
    //     the same defect with no second literal to find. Caught by the reference scan, and NOT
    //     by the fingerprint one: measured, restoring the shape to the prompt clause left this
    //     assertion green on its own.
    //
    // Independent source (#4): the fingerprint is a literal lifted from ADR-0032's own wording of
    // the shape, and both scans walk every `.ts` file the package actually ships, read from disk
    // — not a list of files this test happens to know about.
    const srcRoot = fileURLToPath(new URL("../../src", import.meta.url));
    const literalHits: string[] = [];
    const referenceHits: string[] = [];
    for (const file of await sourceFiles(srcRoot)) {
      const text = await readFile(file, "utf-8");
      const name = file.slice(srcRoot.length + 1);
      if (text.includes(SHAPE_FINGERPRINT)) literalHits.push(name);
      if (stripComments(text).includes("CHILD_REPORT_SHAPE")) referenceHits.push(name);
    }
    expect(literalHits).toEqual(["runtime/child-report.ts"]);
    // Declared in the vocabulary module, read by exactly one consumer: the tool description.
    expect(referenceHits.sort()).toEqual(["runtime/child-report.ts", "tools/child-report-tool.ts"]);
  });

  test("the shape the tool declares is the shape the host validates", async () => {
    // The two ends of the channel, compared rather than trusted: the tool's declared `parameters`
    // and the host's `validateChildReport` must accept the same object. VALID_REPORT is the
    // literal from ADR-0032's four fields, not a fixture derived from either side.
    const tool = createChildReportTool(true);
    const result = await tool.execute(
      "call-1",
      VALID_REPORT as unknown as Parameters<typeof tool.execute>[1],
      undefined,
      undefined,
      {} as Parameters<typeof tool.execute>[4],
    );
    // What the host reads off the event: `result.structuredContent`, validated by the ONE
    // validator both channels share.
    const validated = extractChildReportFromToolEvent({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: CHILD_REPORT_TOOL_NAME,
      isError: false,
      result: { structuredContent: result.structuredContent },
    });
    expect(validated).toEqual(VALID_REPORT);
    expect(validateChildReport(result.structuredContent)).toEqual(VALID_REPORT);
  });

  test("a child-declared usage is dropped by the tool, not carried into the structured channel", () => {
    // `usage` is host-observed (ChildReportPayload). A child that sends one anyway must not be
    // able to hand the host a number wearing the costume of a measurement.
    const tool = createChildReportTool(true);
    return tool
      .execute(
        "call-1",
        {
          ...VALID_REPORT,
          usage: { input: 9_999_999, output: 1, cost: 99, turns: 99 },
        } as unknown as Parameters<typeof tool.execute>[1],
        undefined,
        undefined,
        {} as Parameters<typeof tool.execute>[4],
      )
      .then((result) => {
        expect(Object.hasOwn(result.structuredContent as object, "usage")).toBe(false);
      });
  });
});

// ---------------------------------------------------------------------------
//  Seam 6 — the tool channel (ADR-0032 channel 1)
// ---------------------------------------------------------------------------

/**
 * One `tool_execution_end` line in the shape pi really emits: `ToolExecutionEndEvent` carries
 * `toolCallId` / `toolName` / `result` (the full `AgentToolResult`, `structuredContent` inside
 * it) / `isError`. `pi-agent-core/dist/types.d.ts`.
 */
function reportToolLine(payload: unknown, toolName = CHILD_REPORT_TOOL_NAME): string {
  return JSON.stringify({
    type: "tool_execution_end",
    toolCallId: "call-report-1",
    toolName,
    isError: false,
    result: {
      content: [{ type: "text", text: "child report recorded (2 findings)" }],
      details: undefined,
      structuredContent: payload,
    },
  });
}

/** A transcript where the child called the report tool and then answered in prose. */
const TOOL_CHANNEL_TRANSCRIPT: readonly string[] = [
  reportToolLine(VALID_REPORT),
  assistantLine("Read the gate and wrote it up.", {
    input: 900,
    output: 260,
    cacheRead: 0,
    cacheWrite: 0,
    cost: { total: 0.0123 },
  }),
];

describe("the report tool channel", () => {
  test("a tool call carrying structuredContent yields reportChannel tool", () => {
    const extraction = extractChildReport(parseTranscript(TOOL_CHANNEL_TRANSCRIPT));

    expect(extraction.reportChannel).toBe("tool");
    expect(extraction.report).toEqual(VALID_REPORT);
  });

  test("the tool channel WINS over the prompt channel in the same transcript", () => {
    // Both present, deliberately: the prompt block is a DIFFERENT payload, so the assertion can
    // tell which one survived. Reversing the precedence keeps `reportChannel: "tool"` — the
    // string an assertion like the one above checks — and therefore still passes, while the
    // payload silently becomes the scraped one. That is why the payload is checked here and the
    // channel there.
    const other: ChildReportPayload = {
      summary: "the fenced block's own summary, which must NOT win",
      findings: [],
      files_touched: [],
    };
    const extraction = extractChildReport(
      parseTranscript([
        reportToolLine(VALID_REPORT),
        assistantLine("done\n\n```json\n" + JSON.stringify(other) + "\n```"),
      ]),
    );

    expect(extraction.reportChannel).toBe("tool");
    expect(extraction.report).toEqual(VALID_REPORT);
    expect(extraction.report?.summary).toBe(VALID_REPORT.summary);
  });

  test("a tool_execution_end for ANOTHER tool is not a report", () => {
    // A child that calls `bash` does not produce a report, and a report cannot be smuggled in
    // through some other tool's structuredContent.
    const extraction = extractChildReport(
      parseTranscript([reportToolLine(VALID_REPORT, "bash"), assistantLine("done")]),
    );

    expect(extraction.reportChannel).toBe("none");
    expect(extraction.report).toBeUndefined();
  });

  test("an ERRORED report call is not a report", () => {
    const line = JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "call-report-1",
      toolName: CHILD_REPORT_TOOL_NAME,
      isError: true,
      result: { structuredContent: VALID_REPORT },
    });
    const extraction = extractChildReport(parseTranscript([line, assistantLine("done")]));

    expect(extraction.reportChannel).toBe("none");
    expect(extraction.report).toBeUndefined();
  });

  test("a malformed structuredContent is no report, not a crash and not a half-report", () => {
    for (const bad of [undefined, null, "a string", [], { summary: "only a summary" }]) {
      const extraction = extractChildReport(
        parseTranscript([reportToolLine(bad), assistantLine("done")]),
      );
      expect(extraction.reportChannel, "channel for " + JSON.stringify(bad)).toBe("none");
      expect(extraction.report, "report for " + JSON.stringify(bad)).toBeUndefined();
    }
  });

  test("a bad tool call does not erase a good prompt report", () => {
    // The degradation is one-directional on purpose: the tool channel failing falls BACK to the
    // prompt channel, never to "nothing". The reverse would discard a valid report over a
    // malformed later call.
    const extraction = extractChildReport(
      parseTranscript([assistantLine(COMPLIANT_TEXT), reportToolLine({ summary: "junk" })]),
    );

    expect(extraction.reportChannel).toBe("prompt-json");
    expect(extraction.report).toEqual(VALID_REPORT);
  });

  test("the LAST report call wins, matching 'the last part wins' for prose", () => {
    const second: ChildReportPayload = {
      summary: "the second call's summary",
      findings: [{ what: "w", evidence: "e" }],
      files_touched: ["b.ts"],
    };
    const scan = newChildReportScan();
    scanChildReportToolEvent(
      scan,
      parseAgentEvent(reportToolLine(VALID_REPORT)) as ParsedAgentEvent,
    );
    scanChildReportToolEvent(scan, parseAgentEvent(reportToolLine(second)) as ParsedAgentEvent);

    expect(finishChildReportScan(scan)).toEqual({ report: second, reportChannel: "tool" });
  });

  test("dispatch() foreground reports the tool channel, with the host's usage stamped on", async () => {
    await withAgent(async (dir) => {
      childTranscript.lines = [...TOOL_CHANNEL_TRANSCRIPT];

      const result = asResult(
        await dispatch(
          { agent: "reporter", task: "check the gates", agentScope: "project" },
          { callId: 20, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          { slots: new DispatchSlotCounter(4) },
        ),
      );

      expect(result.status).toBe("fulfilled");
      expect(result.reportChannel).toBe("tool");
      // `usage` is the HOST's counter over the same transcript, never the child's declaration.
      expect(result.report).toEqual(REPORT_WITH_HOST_USAGE);
      expect(result.text).toBe("Read the gate and wrote it up.");
    });
  });

  test("dispatch() background persists the tool channel too (parity with foreground)", async () => {
    await withAgent(async (dir) => {
      const h = createBackgroundHarness();
      const handle = asHandle(
        await dispatch(
          { agent: "reporter", task: "check the gates", background: true, agentScope: "project" },
          { callId: 21, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          h.deps,
        ),
      );

      driveBackground(h.lifecycle, TOOL_CHANNEL_TRANSCRIPT);
      const record = await terminalRecord(h, handle.taskId);

      expect(record.reportChannel).toBe("tool");
      expect(record.report).toEqual(REPORT_WITH_HOST_USAGE);
    });
  });

  test("a transcript where the tool channel never fires still yields a prompt-json report", async () => {
    // ADR-0032's bet, made mechanical: the tool exists in the child only when this package
    // loads there (`src/index.ts` returns early on `surfaceMode === "off"`, and pi's `-ne`
    // removes extensions entirely). Whatever the child was told, the host keeps reading a
    // compliant fenced block, so the fallback is a fallback and not a decoration.
    await withAgent(async (dir) => {
      childTranscript.lines = [...COMPLIANT_TRANSCRIPT];

      const result = asResult(
        await dispatch(
          { agent: "reporter", task: "check the gates", agentScope: "project" },
          { callId: 22, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          { slots: new DispatchSlotCounter(4) },
        ),
      );

      expect(result.reportChannel).toBe("prompt-json");
      expect(result.report).toEqual(REPORT_WITH_HOST_USAGE);
    });
  });
});

// ---------------------------------------------------------------------------
//  Seam 7 — activation is load-bearing (ADR-0032, the trap this ticket exists for)
// ---------------------------------------------------------------------------

/** Write a project-scope agent whose frontmatter is exactly `frontmatter`, plus a body. */
async function withAgentFrontmatter<T>(
  frontmatter: string,
  body: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await makeTempDir();
  try {
    await mkdir(join(dir, ".pi", "agents"), { recursive: true });
    await writeFile(
      join(dir, ".pi", "agents", "reporter.md"),
      "---\nname: reporter\n" + frontmatter + "---\nYou report.\n",
      { encoding: "utf-8" },
    );
    return await body(dir);
  } finally {
    await removeTempDir(dir);
  }
}

/** The `--tools` value the foreground dispatch launched the child with, or `undefined`. */
function launchedToolList(): string | undefined {
  const call = childArgv.calls[0];
  if (call === undefined) throw new Error("no child was spawned");
  const index = call.indexOf("--tools");
  return index === -1 ? undefined : call[index + 1];
}

describe("the report tool is activated in the child and not in the parent", () => {
  test("an agent that declares NO tools still reaches the report tool", async () => {
    // THE TRAP. `buildArgv` emitted a tool-list flag only when the agent's markdown declared
    // tools of its own, so the obvious implementation leaves an agent with an absent `tools:`
    // key — the overwhelmingly common shape — receiving no flag at all, with the tool
    // registered, documented, and never called, and no error anywhere.
    //
    // Both halves of the answer are asserted here, because neither covers the other:
    //   * `defaultActive` puts the tool in front of EVERY dispatched child, including this one;
    //   * the `--tools` merge is what puts it in front of a child whose agent RESTRICTED its
    //     tools, because pi reads `--tools` as an allowlist and would filter it straight back out.
    // Drop either half and this file's argv/registration assertions go red; that is the point.
    await withAgent(async (dir) => {
      childTranscript.lines = [...COMPLIANT_TRANSCRIPT];

      await dispatch(
        { agent: "reporter", task: "t", agentScope: "project" },
        { callId: 23, cwd: dir, depth: 0, maxDispatchDepth: 3 },
        { slots: new DispatchSlotCounter(4) },
      );

      // No `--tools` flag: the child's own tool list is untouched, which is the whole reason the
      // activation is NOT done by emitting a flag here. pi reads `--tools` as an ALLOWLIST
      // (`sdk.js` -> `allowedToolNames`, filtered by `AgentSession._isAllowedTool`), so
      // `--tools ptc_child_report` alone would leave the child with exactly one tool and no
      // read / bash / edit / write.
      expect(launchedToolList()).toBeUndefined();
      expect(childToolList({})).toBeUndefined();

      // The other half, for the child process itself.
      process.env.PI_PTC_DEPTH = "1";
      const childStub = makeExtensionStub({ surfaceMode: "full" });
      const childTool = childStub.tools.get(CHILD_REPORT_TOOL_NAME);
      expect(childTool, "the child registers the report tool").toBeDefined();
      expect(childTool?.defaultActive, "and activates it").toBe(true);
    });
  });

  test("an agent that declares its own tools keeps them and gains the report tool", async () => {
    await withAgentFrontmatter("tools: read, bash\n", async (dir) => {
      childTranscript.lines = [...COMPLIANT_TRANSCRIPT];

      await dispatch(
        { agent: "reporter", task: "t", agentScope: "project" },
        { callId: 24, cwd: dir, depth: 0, maxDispatchDepth: 3 },
        { slots: new DispatchSlotCounter(4) },
      );

      // The restriction the agent asked for is preserved verbatim, and the contract's tool is
      // ADDED to it rather than replacing it. Order matters for the assertion: an implementation
      // that put the report tool first would still activate it, so the expected string is the
      // agent's own list with exactly one name appended.
      expect(launchedToolList()).toBe("read,bash," + CHILD_REPORT_TOOL_NAME);
      expect(childToolList({ tools: ["read", "bash"] })).toEqual([
        "read",
        "bash",
        CHILD_REPORT_TOOL_NAME,
      ]);
    });
  });

  test("buildArgv is where the merge lives, not discoverAgent", () => {
    // A second, argv-level reading of the same rule, with no process involved: mutate
    // `buildArgv` back to `if (agent.tools && agent.tools.length > 0)` and both of the two
    // tests above turn red on their `--tools` assertion.
    const agent: AgentConfigLike = { name: "a", source: "user", systemPrompt: "", tools: ["read"] };
    expect(buildArgv({ agent: "a", task: "t" }, agent, "/tmp/p.md")).toContain("--tools");
    const restricted = buildArgv({ agent: "a", task: "t" }, agent, "/tmp/p.md");
    expect(restricted[restricted.indexOf("--tools") + 1]).toBe("read," + CHILD_REPORT_TOOL_NAME);
  });

  test("the merge does not duplicate a name the agent already lists", () => {
    // Idempotent, because an agent may list the report tool itself once this ships. A merge that
    // appended unconditionally would hand pi an allowlist with the same name twice.
    expect(childToolList({ tools: ["read", CHILD_REPORT_TOOL_NAME] })).toEqual([
      "read",
      CHILD_REPORT_TOOL_NAME,
    ]);
  });

  test("the report tool is NOT active in the parent's ordinary surface", () => {
    // Requirement 4 of the ticket, and the reason `defaultActive` is a parameter at all. pi
    // activates a `direct` tool on registration unless this says otherwise, so a parent that
    // registered it plainly would offer every session a tool with no caller and a description
    // that instructs the model to hand over a report it has no way to send anywhere.
    const parentStub = makeExtensionStub({ surfaceMode: "full" });
    const tool = parentStub.tools.get(CHILD_REPORT_TOOL_NAME);

    // Registered — so a child pi can be told the name and find it — but never activated.
    expect(tool, "registered in the parent").toBeDefined();
    expect(tool?.defaultActive, "but not activated there").toBe(false);
    expect(parentStub.active, "and absent from the active loadout").not.toContain(
      CHILD_REPORT_TOOL_NAME,
    );
  });

  test("the two activation halves are decided by PI_PTC_DEPTH and by nothing else", () => {
    // A counterfactual for the wiring rather than for the tool: hardcode `defaultActive: true`
    // in the factory and the parent test above goes red; hardcode `false` and the child test
    // above does. The env var is the only input, and it is the one ADR-0016 already stamps.
    for (const [depth, expected] of [
      [undefined, false],
      ["0", false],
      ["1", true],
      ["2", true],
    ] as const) {
      if (depth === undefined) delete process.env.PI_PTC_DEPTH;
      else process.env.PI_PTC_DEPTH = depth;
      const stub = makeExtensionStub({ surfaceMode: "subagents" });
      expect(
        stub.tools.get(CHILD_REPORT_TOOL_NAME)?.defaultActive,
        "PI_PTC_DEPTH=" + String(depth),
      ).toBe(expected);
    }
  });

  test("the report tool declares an output schema and a usable description", () => {
    // The other end of "the shape it accepts matches the shape the host validates": pi only
    // hands a codemode script the `structuredContent` of a tool that DECLARES an output schema,
    // so an undeclared one is a report only this host could ever read.
    const tool = createChildReportTool(true);
    expect(tool.outputSchema).toBeDefined();
    // One schema, declared twice on purpose: the same value on both ends is what stops the
    // accepted shape and the carried shape from drifting apart.
    expect(tool.parameters).toBe(tool.outputSchema);
    expect(tool.description).toBe(CHILD_REPORT_DESCRIPTION);
    expect(tool.promptSnippet, "without a snippet pi omits it from the system prompt").toBeTruthy();
    expect(tool.promptGuidelines?.length ?? 0).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
//  Seam 8 — the opt-out (ADR-0032 §The opt-out, ticket #102)
// ---------------------------------------------------------------------------

describe("the agent frontmatter opt-out", () => {
  test("the switch defaults to ON — an agent that says nothing gets the contract", () => {
    // The default is the whole claim: a switch that read as off unless told otherwise would put
    // every existing agent out of the contract silently, and a report nobody expected on a
    // result that does not carry one.
    expect(parseAgentMarkdown("---\nname: a\n---\nbody")?.childReport).toBeUndefined();
    expect(isReportContractOn({})).toBe(true);
    expect(isReportContractOn({ childReport: true })).toBe(true);
    expect(appendDepthHint("b", 1, 3)).toContain(CHILD_REPORT_TOOL_NAME);
    expect(appendDepthHint("b", 1, 3, {})).toContain(CHILD_REPORT_TOOL_NAME);
  });

  test("`childReport: false` — and only that — opts out", () => {
    // The four spellings a hand-rolled YAML reader has to agree on, plus the values that must
    // NOT be able to opt an agent out by accident. A typo leaving the contract ON is the safe
    // direction and is stated as such in the parser's doc; a typo turning it off would mark a
    // child for non-compliance it was never asked about.
    for (const value of ["false", "False", "FALSE", "no", "no"]) {
      const parsed = parseAgentMarkdown("---\nname: a\nchildReport: " + value + "\n---\nbody");
      expect(parsed?.childReport, "childReport: " + value).toBe(false);
      expect(isReportContractOn(parsed as { childReport?: boolean }), value).toBe(false);
    }
    for (const value of ["true", "yes", "on", "1", "flase"]) {
      const parsed = parseAgentMarkdown("---\nname: a\nchildReport: " + value + "\n---\nbody");
      expect(parsed?.childReport, "childReport: " + value).toBe(true);
      expect(isReportContractOn(parsed as { childReport?: boolean }), value).toBe(true);
    }
    // An EMPTY value is indistinguishable from an absent one — `extractYamlString` has always
    // returned `undefined` for it, and that is the safe direction: the contract stays on.
    const empty = parseAgentMarkdown("---\nname: a\nchildReport:\n---\nbody");
    expect(empty?.childReport).toBeUndefined();
    expect(isReportContractOn(empty as { childReport?: boolean })).toBe(true);
  });

  test("the switch is a yes/no and carries no schema", () => {
    // ADR-0032: "It names a yes/no; it does not carry a schema, because a per-agent schema
    // reopens the two-copies problem." A frontmatter key that could name a shape would be a
    // second home for the contract, and `validateChildReport` would have to learn to read it.
    // The pin is behavioural: whatever an opted-out agent's markdown contains beyond the switch
    // cannot reach the report shape, because there is no report.
    const parsed = parseAgentMarkdown(
      "---\nname: a\nchildReport: false\nreportSchema: anything_at_all\nfindings: three\n---\nbody",
    );
    expect(parsed?.childReport).toBe(false);
    // The parser's whole key set, whatever the frontmatter says: there is no key here that could
    // carry a shape, so `reportSchema` and `findings` above are ignored rather than half-read.
    // Add a key that could hold one and this list grows — which is the review-visible version of
    // the two-copies problem this decision refuses to reopen.
    expect(Object.keys(parsed ?? {}).sort()).toEqual([
      "childReport",
      "description",
      "model",
      "name",
      "systemPrompt",
    ]);
  });

  test("an opted-out agent is not asked in the prompt and not given the tool", async () => {
    await withAgentFrontmatter("childReport: false\ntools: read, bash\n", async (dir) => {
      childTranscript.lines = [...PLAIN_TRANSCRIPT];

      const result = asResult(
        await dispatch(
          { agent: "reporter", task: "t", agentScope: "project" },
          { callId: 30, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          { slots: new DispatchSlotCounter(4) },
        ),
      );

      // Never asked, in either of the two places an ask can live.
      expect(launchedToolList(), "no report tool in the child's argv").toBe("read,bash");
      // Opting out is not a failure and not a refusal: the child ran, and its answer is here.
      expect(result.status).toBe("fulfilled");
      expect(result.text).toBe("Here is the answer, in prose only.");
      // The prompt half is asserted on the composed prompt rather than on the file: the tmpfile
      // is cleaned up before `dispatch()` resolves, and `appendDepthHint` with
      // `reportContract: false` is exactly what the caller handed the writer.
      expect(appendDepthHint("You report.", 1, 3, { reportContract: false })).not.toContain(
        CHILD_REPORT_TOOL_NAME,
      );
      expect(appendDepthHint("You report.", 1, 3, { reportContract: false })).not.toContain(
        "child report",
      );
      // And the control: the same prompt with the contract ON does carry it, so the assertion
      // above is about the switch and not about a clause that was never there.
      expect(appendDepthHint("You report.", 1, 3, { reportContract: true })).toContain(
        CHILD_REPORT_TOOL_NAME,
      );
    });
  });

  test("an opted-out agent that complies anyway is not re-labelled", async () => {
    // A child is free to emit a fenced block whether or not anybody asked. The host must not
    // promote it into a report the caller would read as compliance with a contract that was
    // never issued — `opted-out` is the only true statement available.
    await withAgentFrontmatter("childReport: false\n", async (dir) => {
      childTranscript.lines = [...COMPLIANT_TRANSCRIPT];

      const result = asResult(
        await dispatch(
          { agent: "reporter", task: "t", agentScope: "project" },
          { callId: 31, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          { slots: new DispatchSlotCounter(4) },
        ),
      );

      expect(result.status).toBe("fulfilled");
      expect(result.reportChannel).toBe("opted-out");
      expect(result.report).toBeUndefined();
      expect(result.text).toBe(COMPLIANT_TEXT);
    });
  });

  test("an opted-out agent is never marked for failing to give a report", async () => {
    // The requirement in its own words, and the assertion that separates this from "we just
    // return none anyway": `none` IS the non-compliance marker ADR-0032 defines, so a result
    // carrying it says the child ignored a contract. This one says nobody asked.
    await withAgentFrontmatter("childReport: false\n", async (dir) => {
      childTranscript.lines = [...PLAIN_TRANSCRIPT];

      const result = asResult(
        await dispatch(
          { agent: "reporter", task: "t", agentScope: "project" },
          { callId: 32, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          { slots: new DispatchSlotCounter(4) },
        ),
      );

      expect(result.status).toBe("fulfilled");
      expect(result.reportChannel).toBe("opted-out");
      expect(result.reportChannel).not.toBe("none");
    });
  });

  test("an opted-out BACKGROUND child persists the same value (parity)", async () => {
    await withAgentFrontmatter("childReport: false\n", async (dir) => {
      const h = createBackgroundHarness();
      const handle = asHandle(
        await dispatch(
          { agent: "reporter", task: "t", background: true, agentScope: "project" },
          { callId: 33, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          h.deps,
        ),
      );

      driveBackground(h.lifecycle, PLAIN_TRANSCRIPT);
      const record = await terminalRecord(h, handle.taskId);

      expect(record.reportChannel).toBe("opted-out");
      expect(record.report).toBeUndefined();
      // The argv half, on the background front: it uses the same buildArgv.
      expect(h.lifecycle.getRecordedArgv(h.lifecycle.spawned[0] as ChildHandle)).not.toContain(
        CHILD_REPORT_TOOL_NAME,
      );
    });
  });

  test("the contract stays on for an agent that names nothing, end to end", async () => {
    // The default is not just a parser fact: the whole pipeline behaves as under the contract.
    await withAgent(async (dir) => {
      childTranscript.lines = [...COMPLIANT_TRANSCRIPT];

      const result = asResult(
        await dispatch(
          { agent: "reporter", task: "t", agentScope: "project" },
          { callId: 34, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          { slots: new DispatchSlotCounter(4) },
        ),
      );

      expect(result.reportChannel).toBe("prompt-json");
      expect(result.report).toEqual(REPORT_WITH_HOST_USAGE);
    });
  });
});

// ---------------------------------------------------------------------------
//  Seam 9 — a refusal carries NO report (ticket #102)
// ---------------------------------------------------------------------------

describe("a refused dispatch carries no report, not an empty one", () => {
  test("every refusal names channel none, because no agent was ever under contract", async () => {
    // `opted-out` is for an AGENT that asked out. A refusal never got that far: the depth gate
    // fires before discovery, the concurrency gate before the spawn, and an unknown agent has no
    // markdown to have opted out of anything. Stating `opted-out` on a refusal would be a second
    // wrong answer — and the pin is the ABSENCE of the key, not a falsy value: an empty report is
    // a claim that a child said it had nothing, and no child ran.
    const refusals: DispatchResult[] = [
      asResult(
        await dispatch(
          { agent: "reporter", task: "t" },
          { callId: 40, cwd: process.cwd(), depth: 3, maxDispatchDepth: 3 },
          { slots: new DispatchSlotCounter(4) },
        ),
      ),
      asResult(
        await dispatch(
          { agent: "reporter", task: "t" },
          { callId: 41, cwd: process.cwd(), depth: 0, maxDispatchDepth: 3 },
          { slots: new DispatchSlotCounter(0) },
        ),
      ),
      asResult(
        await dispatch(
          { agent: "nobody-by-that-name", task: "t", agentScope: "project" },
          { callId: 42, cwd: process.cwd(), depth: 0, maxDispatchDepth: 3 },
          { slots: new DispatchSlotCounter(4) },
        ),
      ),
    ];
    for (const refusal of refusals) {
      expect(refusal.status).toBe("rejected");
      expect(refusal.reportChannel).toBe("none");
      expect(Object.hasOwn(refusal, "report"), "no report key at all").toBe(false);
    }
  });

  test("a spawn failure names channel none and carries no report", async () => {
    await withAgent(async (dir) => {
      spawnFailure.error = new Error("spawn pi ENOENT");
      const result = asResult(
        await dispatch(
          { agent: "reporter", task: "t", agentScope: "project" },
          { callId: 43, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          { slots: new DispatchSlotCounter(4) },
        ),
      );

      expect(result.started).toBe(false);
      expect(result.reportChannel).toBe("none");
      expect(Object.hasOwn(result, "report")).toBe(false);
    });
  });

  test("a missing agent argument names channel none and carries no report", async () => {
    const result = asResult(
      await dispatch(
        { agent: "  ", task: "t" },
        { callId: 44, cwd: process.cwd(), depth: 0, maxDispatchDepth: 3 },
        { slots: new DispatchSlotCounter(4) },
      ),
    );

    expect(result.reportChannel).toBe("none");
    expect(Object.hasOwn(result, "report")).toBe(false);
  });
});
