/**
 * P0 (foreground child errors) + P1 (observed child model) regression suite.
 *
 * The IO boundary is driven by a REAL capture, not a hand-written mock: every event this file
 * feeds a child comes from `tests/fixtures/pi-1.3.0-429-token-plan.jsonl`, four assistant
 * `message_end` events a live pi 1.3.0 emitted when a minimax Token Plan quota was exhausted
 * (docs/testing-constraints.md #2: fixtures come from real samples). The exact 429 text below is
 * transcribed from the capture rather than read back from the implementation (constraint #4), and
 * the fixture-integrity test holds the two against each other. The behaviour under test is
 * specified by ADR-0044 Decision 2 (the observed model is reported on every surface) and
 * Decision 3 (a rejected child states its own failure) in
 * docs/adr/0044-a-dispatch-inherits-the-session-model.md.
 *
 * What the incident was: pi writes `stopReason: "error"` + `errorMessage` onto the assistant
 * event, retries four times, then exits 0 with no text. The background pump has always forwarded
 * that pair (issue #70); the foreground path dropped it and reported only "dispatch produced no
 * final text", `ptc_subagent` threw `refused the call: undefined`, and the child's actual model
 * was invisible on every surface. These tests pin the three fixes:
 *   - P0: the self-reported error is the foreground `errorMessage` and reaches the refusal;
 *   - P0: a missing `errorMessage` renders a sentence, never the string "undefined";
 *   - P1: the observed provider/model reaches the result, the record, and the two model-facing texts.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  MockChildProcessLifecycle,
  type ChildHandle,
  type ChildSpawnOptions,
  type ParsedAgentEvent,
} from "../../src/runtime/child-process-lifecycle.ts";
import {
  DispatchSlotCounter,
  accumulateChildModel,
  decideCloseOutcome,
  dispatch,
  parseAgentEvent,
  PI_TRUNCATION_WARNING,
  type DispatchDeps,
  type DispatchUsage,
} from "../../src/runtime/dispatch.ts";
import { DEFAULT_CONFIG } from "../../src/runtime/limits.ts";
import { InMemoryOutputStorage } from "../../src/runtime/output-storage.ts";
import { createTaskRegistry } from "../../src/runtime/task-registry.ts";
import { InMemoryTaskStorage, type TaskRecord, type ULID } from "../../src/runtime/task-storage.ts";
import { createPtcTaskOutputTool } from "../../src/tools/ptc-task.ts";
import {
  SETTLED_FAILURE_MAX_CHARS,
  createPtcSubagentTool,
  describeSettledFailure,
} from "../../src/tools/subagent.ts";
import type { DispatchResult } from "../../src/runtime/dispatch.ts";
import { makeTempDir, removeTempDir, waitFor } from "../helpers/ptc.ts";

// ---------------------------------------------------------------------------
//  The real capture
// ---------------------------------------------------------------------------

/**
 * The live capture as a fixture: four assistant `message_end` error turns pi 1.3.0 emitted when a
 * minimax Token Plan quota was exhausted (tests/fixtures/pi-1.3.0-429-token-plan.jsonl). The
 * events are transcribed verbatim, request ids included; the integrity test below holds the
 * fixture against the literal 429 text.
 */
const FIXTURE_EVENTS: ParsedAgentEvent[] = loadFixtureEvents();

/**
 * The LAST error message of the capture, byte for byte (request id included).
 *
 * The four retries carry different request ids; the last one is the turn that ended the child,
 * and "last error wins" is the shared foreground/background rule (issue #70). Transcribing it
 * here rather than importing it from the fixture keeps the fixture and the expectation from
 * sharing one mistake: the integrity test compares the two.
 */
const FINAL_RATE_LIMIT_ERROR =
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。 (2056)"},"request_id":"0724ed1605a99518189a305242540ce5"}';

/** The real model pair the capture names, used by the P1 assertions. */
const CAPTURED_PROVIDER = "minimax-cn-512k";
const CAPTURED_MODEL = "MiniMax-M3.1-Flash-Preview";
/** The CONTRACT's session-model sample, used where a second pair makes the shape visible. */
const DS_FLASH = "deepseek/deepseek-flash";

function loadFixtureEvents(): ParsedAgentEvent[] {
  const path = fileURLToPath(new URL("../fixtures/pi-1.3.0-429-token-plan.jsonl", import.meta.url));
  const events: ParsedAgentEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    const event = parseAgentEvent(line);
    if (event === null) throw new Error("fixture line is not a parseable agent event");
    events.push(event);
  }
  return events;
}

/** A plain assistant answer, the shape a healthy child emits. */
function assistantText(text: string): ParsedAgentEvent {
  return { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } };
}

/** One assistant turn that also names the model, the shape P1 observes. */
function assistantTextWithModel(text: string, provider: string, model: string): ParsedAgentEvent {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      provider,
      model,
    },
  };
}

/** A rejected result shaped from the contract, for the pure `describeSettledFailure` tests. */
function rejectedOutcome(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    text: "",
    status: "rejected",
    started: true,
    agentName: "probe",
    durationMs: 0,
    exitCode: 0,
    reportChannel: "none",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
//  Harness: a mock child the tests push real events into
// ---------------------------------------------------------------------------

class RecordingLifecycle extends MockChildProcessLifecycle {
  readonly spawned: ChildHandle[] = [];

  override spawn(argv: readonly string[], opts: ChildSpawnOptions): ChildHandle {
    const handle = super.spawn(argv, opts);
    this.spawned.push(handle);
    return handle;
  }

  handleAt(index: number): ChildHandle {
    const handle = this.spawned[index];
    if (handle === undefined) throw new Error("RecordingLifecycle: no handle at " + String(index));
    return handle;
  }
}

interface Harness {
  lifecycle: RecordingLifecycle;
  warnings: string[];
  deps: DispatchDeps;
}

function createHarness(): Harness {
  const lifecycle = new RecordingLifecycle();
  const warnings: string[] = [];
  return {
    lifecycle,
    warnings,
    deps: {
      lifecycle,
      slots: new DispatchSlotCounter(4),
      // The registry's own logger needs `info` (spawn transitions announce there); the pump's
      // failure note goes through `warn`, which is the channel this harness asserts on.
      logger: { warn: (message: string) => warnings.push(message), info: () => {} },
    },
  };
}

/** Push the given events into the first spawned child, then close it with `exitCode`. */
async function driveChild(
  lifecycle: RecordingLifecycle,
  events: readonly ParsedAgentEvent[],
  exitCode: number,
): Promise<void> {
  await waitFor(() => lifecycle.spawned.length > 0);
  const child = lifecycle.handleAt(0);
  for (const event of events) lifecycle.pushEvent(child, event);
  lifecycle.resolveExit(child, exitCode, null);
}

/** One foreground dispatch over the real fixture-driven child. */
async function dispatchForeground(
  events: readonly ParsedAgentEvent[],
  exitCode = 0,
): Promise<{ result: DispatchResult; harness: Harness }> {
  const dir = await makeTempDir();
  try {
    const harness = createHarness();
    const settled = dispatch({ task: "probe the child" }, foregroundContext(dir), harness.deps);
    await driveChild(harness.lifecycle, events, exitCode);
    return { result: await settled, harness };
  } finally {
    await removeTempDir(dir);
  }
}

function foregroundContext(dir: string): {
  callId: number;
  cwd: string;
  depth: number;
  maxDispatchDepth: number;
} {
  return { callId: 1, cwd: dir, depth: 0, maxDispatchDepth: DEFAULT_CONFIG.maxDispatchDepth };
}

// ---------------------------------------------------------------------------
//  Fixture integrity (constraint #2/#4)
// ---------------------------------------------------------------------------

describe("the 429 fixture is the real capture", () => {
  test("it holds four assistant message_end error turns with zero usage", () => {
    expect(FIXTURE_EVENTS).toHaveLength(4);
    for (const event of FIXTURE_EVENTS) {
      expect(event.type).toBe("message_end");
      expect(event.message?.role).toBe("assistant");
      expect(event.message?.stopReason).toBe("error");
      expect(event.message?.provider).toBe(CAPTURED_PROVIDER);
      expect(event.message?.model).toBe(CAPTURED_MODEL);
      // A rate-limited turn cost nothing; the totalTokens field is what pi wrote, and it is 0.
      expect((event.message as { usage?: { totalTokens?: number } }).usage?.totalTokens).toBe(0);
    }
  });

  test("the transcribed 429 text is the fixture's LAST error, byte for byte", () => {
    // The retries differ only in request_id, so comparing the last event catches a transcription
    // that used the first retry, or that dropped/added a character.
    expect(FIXTURE_EVENTS[3]?.message?.errorMessage).toBe(FINAL_RATE_LIMIT_ERROR);
    expect(FINAL_RATE_LIMIT_ERROR.startsWith("429 ")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//  P0: decideCloseOutcome ladder (the contract's four rules, in order)
// ---------------------------------------------------------------------------

describe("decideCloseOutcome with a self-reported child error", () => {
  test("a rate-limited exit-0 child is rejected with the child's own 429 text, unwrapped", () => {
    const out = decideCloseOutcome({
      exitCode: 0,
      finalText: "",
      aborted: false,
      childError: FINAL_RATE_LIMIT_ERROR,
    });
    expect(out.status).toBe("rejected");
    expect(out.errorMessage).toBe(FINAL_RATE_LIMIT_ERROR);
  });

  test("aborted outranks the child error", () => {
    // Cancellation is ours, not the child's: ADR-0016 §4 says the caller hears "dispatch
    // cancelled", and a stale 429 from a turn that ran before the abort must not replace it.
    const out = decideCloseOutcome({
      exitCode: 0,
      finalText: "",
      aborted: true,
      childError: FINAL_RATE_LIMIT_ERROR,
    });
    expect(out.status).toBe("rejected");
    expect(out.errorMessage).toBe("dispatch cancelled");
  });

  test("exit 0 with final text is fulfilled even after an earlier errored retry", () => {
    // The last turn is what the caller receives. A child that retried past a transient error and
    // then answered is a success, and turning it into a failure would discard a real answer.
    const out = decideCloseOutcome({
      exitCode: 0,
      finalText: "PONG",
      aborted: false,
      childError: "429 transient",
    });
    expect(out).toEqual({ status: "fulfilled" });
  });

  test("a non-zero exit with a child error reports the child's cause, not the stderr inference", () => {
    const out = decideCloseOutcome({
      exitCode: 1,
      finalText: "",
      aborted: false,
      childError: FINAL_RATE_LIMIT_ERROR,
      stderr: PI_TRUNCATION_WARNING,
    });
    expect(out.status).toBe("rejected");
    expect(out.errorMessage).toBe(FINAL_RATE_LIMIT_ERROR);
  });

  test("without a child error the old ladder is unchanged", () => {
    // Counterfactual for the new branch: remove the childError check and these three still pass,
    // which is why the tests above are the ones that would go red on it.
    expect(decideCloseOutcome({ exitCode: 0, finalText: "", aborted: false })).toEqual({
      status: "rejected",
      errorMessage: "dispatch produced no final text",
    });
    expect(decideCloseOutcome({ exitCode: 1, finalText: "", aborted: false })).toEqual({
      status: "rejected",
    });
    expect(
      decideCloseOutcome({
        exitCode: 1,
        finalText: "",
        aborted: false,
        stderr: PI_TRUNCATION_WARNING,
      }).errorMessage,
    ).toContain("truncated");
  });

  test("an EMPTY child error falls through rather than becoming an empty errorMessage", () => {
    // An empty value names no cause; the contract's branch is `length > 0`.
    expect(
      decideCloseOutcome({ exitCode: 0, finalText: "", aborted: false, childError: "" })
        .errorMessage,
    ).toBe("dispatch produced no final text");
  });
});

// ---------------------------------------------------------------------------
//  P0: the foreground dispatch over the real 429 transcript
// ---------------------------------------------------------------------------

describe("foreground dispatch over the real 429 transcript", () => {
  test("the child's error, usage, and model reach the DispatchResult", async () => {
    const { result } = await dispatchForeground(FIXTURE_EVENTS);
    expect(result.status).toBe("rejected");
    expect(result.errorMessage).toBe(FINAL_RATE_LIMIT_ERROR);
    expect(result.started, "the child really ran").toBe(true);
    expect(result.exitCode, "pi exits 0 after its retry loop").toBe(0);
    expect(result.text).toBe("");
    expect(result.reportChannel).toBe("none");
    expect(result.usage?.turns, "four assistant turns were observed").toBe(4);
    // The capture's usage is all zeros; a rate-limited turn reports no tokens.
    expect(result.usage).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 4,
    });
    expect(result.observedProvider).toBe(CAPTURED_PROVIDER);
    expect(result.observedModel).toBe(CAPTURED_MODEL);
  });

  test("the new failure path leaves one operator warning naming the child's cause", async () => {
    const { harness } = await dispatchForeground(FIXTURE_EVENTS);
    expect(harness.warnings).toEqual(["foreground dispatch failed: " + FINAL_RATE_LIMIT_ERROR]);
  });

  test("the pre-existing exit-0-silent rejection stays quiet and generic", async () => {
    // The counterfactual for the new warning: a silent child that reported NO reason must keep
    // the old message and produce no warning, or the log fills with the failures that were
    // already understood.
    const silent: ParsedAgentEvent = {
      type: "message_end",
      message: { role: "assistant", stopReason: "stop", content: [] },
    };
    const { result, harness } = await dispatchForeground([silent]);
    expect(result.status).toBe("rejected");
    expect(result.errorMessage).toBe("dispatch produced no final text");
    expect(harness.warnings).toEqual([]);
  });

  test("a fulfilled close is unchanged: no error, no warning, no model claimed", async () => {
    const { result, harness } = await dispatchForeground([assistantText("PONG")]);
    expect(result.status).toBe("fulfilled");
    expect(result.text).toBe("PONG");
    expect(result.errorMessage).toBeUndefined();
    expect(harness.warnings).toEqual([]);
    // Absent means "no assistant turn named a model", not "the model is unknown": these events
    // carry no model, so the result must not invent one.
    expect(Object.hasOwn(result, "observedProvider")).toBe(false);
    expect(Object.hasOwn(result, "model")).toBe(false);
  });

  test("an abort wins over the child's own 429, on the production path", async () => {
    const dir = await makeTempDir();
    try {
      const harness = createHarness();
      const controller = new AbortController();
      const settled = dispatch(
        { task: "probe the child" },
        { ...foregroundContext(dir), signal: controller.signal },
        harness.deps,
      );
      await waitFor(() => harness.lifecycle.spawned.length > 0);
      const child = harness.lifecycle.handleAt(0);
      for (const event of FIXTURE_EVENTS) harness.lifecycle.pushEvent(child, event);
      controller.abort();
      harness.lifecycle.resolveExit(child, 0, null);
      const result = await settled;
      expect(result.status).toBe("rejected");
      expect(result.errorMessage).toBe("dispatch cancelled");
      // The operator warning is keyed to the child's SELF-REPORTED error (contract P0.4:
      // rejected && started && childError !== undefined), and this child did report one — the
      // cancellation only wins the OUTCOME. Naming the cause here is what keeps the aborted run
      // from looking like a bare cancellation when the child was already failing.
      expect(harness.warnings).toEqual(["foreground dispatch failed: " + FINAL_RATE_LIMIT_ERROR]);
    } finally {
      await removeTempDir(dir);
    }
  });

  test("a model observed without a provider is reported unqualified, not dropped", async () => {
    // The wire is observational: pi could name a model on a turn that carries no provider field.
    // Dropping the half-observation would lose the one fact the P1 fix exists to surface.
    const { result } = await dispatchForeground([
      assistantTextWithModel("PONG", "", "deepseek-flash"),
    ]);
    expect(result.status).toBe("fulfilled");
    expect(result.observedModel).toBe("deepseek-flash");
    expect(Object.hasOwn(result, "observedProvider")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  P1: the observed-model fold
// ---------------------------------------------------------------------------

describe("accumulateChildModel", () => {
  test("folds the provider and model off an assistant message_end", () => {
    const folded = accumulateChildModel(
      undefined,
      assistantTextWithModel("PONG", "deepseek", "deepseek-flash"),
    );
    expect(folded).toEqual({ provider: "deepseek", model: "deepseek-flash" });
  });

  test("last turn wins, so the model that answered is the one named", () => {
    const first = accumulateChildModel(
      undefined,
      assistantTextWithModel("first", "minimax-cn-512k", "MiniMax-M3.1-Flash-Preview"),
    );
    const second = accumulateChildModel(
      first,
      assistantTextWithModel("second", "deepseek", "deepseek-flash"),
    );
    expect(second).toEqual({ provider: "deepseek", model: "deepseek-flash" });
  });

  test("each field is updated independently, so a half-observation is preserved", () => {
    const withProvider = accumulateChildModel(undefined, {
      type: "message_end",
      message: { role: "assistant", provider: "deepseek" },
    });
    const withModel = accumulateChildModel(withProvider, {
      type: "message_end",
      message: { role: "assistant", model: "deepseek-flash" },
    });
    expect(withModel).toEqual({ provider: "deepseek", model: "deepseek-flash" });
  });

  test("non-assistant events and empty fields are no-ops", () => {
    const base = { provider: "deepseek", model: "deepseek-flash" };
    expect(accumulateChildModel(base, { type: "turn_end" })).toEqual(base);
    expect(
      accumulateChildModel(base, { type: "message_end", message: { role: "user", model: "x" } }),
    ).toEqual(base);
    expect(
      accumulateChildModel(base, {
        type: "message_end",
        message: { role: "assistant", provider: "", model: "" },
      }),
    ).toEqual(base);
    expect(accumulateChildModel(undefined, { type: "message_end" })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
//  P0: the bounded refusal diagnostic
// ---------------------------------------------------------------------------

describe("describeSettledFailure", () => {
  test("names the cause and every fact the caller would otherwise infer", () => {
    const outcome = rejectedOutcome({
      errorMessage: FINAL_RATE_LIMIT_ERROR,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 4 },
      observedProvider: CAPTURED_PROVIDER,
      observedModel: CAPTURED_MODEL,
    });
    expect(describeSettledFailure(outcome)).toBe(
      FINAL_RATE_LIMIT_ERROR +
        " (child ran, exit=0, turns=4, reportChannel=none, model=" +
        CAPTURED_PROVIDER +
        "/" +
        CAPTURED_MODEL +
        ")",
    );
  });

  test("a rejection without an errorMessage says so instead of printing undefined", () => {
    // This is the exact bug: the old throw concatenated `outcome.errorMessage`, so this case
    // produced "ptc_subagent refused the call: undefined" and told the caller nothing.
    const text = describeSettledFailure(rejectedOutcome({ exitCode: 1 }));
    expect(text).toBe(
      "the child failed without an error message (child ran, exit=1, turns=0, reportChannel=none)",
    );
    expect(text).not.toContain("undefined");
  });

  test("a pre-spawn refusal is described as the harness declining, not as a failed child", () => {
    const text = describeSettledFailure(
      rejectedOutcome({
        started: false,
        exitCode: -1,
        errorMessage: "dispatch depth limit reached",
      }),
    );
    expect(text).toBe(
      "dispatch depth limit reached (harness declined to start, exit=-1, turns=0, reportChannel=none)",
    );
  });

  test("a model known only by id is named without a provider prefix", () => {
    const text = describeSettledFailure(rejectedOutcome({ observedModel: "deepseek-flash" }));
    expect(text).toBe(
      "the child failed without an error message (child ran, exit=0, turns=0, reportChannel=none, model=deepseek-flash)",
    );
  });

  test("the diagnostic is bounded at 800 characters, keeping the tail", () => {
    expect(SETTLED_FAILURE_MAX_CHARS).toBe(800);
    const cause = "x".repeat(2_000);
    const text = describeSettledFailure(rejectedOutcome({ errorMessage: cause }));
    expect(text.length).toBe(800);
    expect(text.startsWith("…")).toBe(true);
    expect(text.endsWith("(child ran, exit=0, turns=0, reportChannel=none)")).toBe(true);
  });

  test("the round-tripped fixture outcome keeps its cause and drops nothing", () => {
    // Cross-check with the suite's main path: the diagnostic rendered from an outcome shaped by
    // the foreground fixture is the same one the refusal test expects.
    const usage: DispatchUsage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 4,
    };
    const outcome = rejectedOutcome({
      errorMessage: FINAL_RATE_LIMIT_ERROR,
      usage,
      observedProvider: CAPTURED_PROVIDER,
      observedModel: CAPTURED_MODEL,
    });
    expect(describeSettledFailure(outcome)).toContain("turns=4");
    expect(describeSettledFailure(outcome)).toContain(
      "model=" + CAPTURED_PROVIDER + "/" + CAPTURED_MODEL,
    );
  });
});

// ---------------------------------------------------------------------------
//  P0/P1: ptc_subagent, the front that throws instead of returning
// ---------------------------------------------------------------------------

describe("ptc_subagent refuses with the bounded diagnostic", () => {
  interface Thrown {
    message: string;
  }

  /** One tool call driven by the mock lifecycle; the call must REJECT. */
  async function callAndExpectThrow(
    dir: string,
    harness: Harness,
    events: readonly ParsedAgentEvent[],
    exitCode: number,
    options: { depth?: number } = {},
  ): Promise<Thrown> {
    const tool = createPtcSubagentTool({
      cwd: dir,
      depth: options.depth ?? 0,
      maxDispatchDepth: DEFAULT_CONFIG.maxDispatchDepth,
      getDispatchDeps: () => harness.deps,
    });
    const execution = tool
      .execute(
        "call-diagnostic",
        { task: "probe the child" },
        undefined,
        undefined,
        undefined as never,
      )
      .then(
        (value: unknown) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    await driveChild(harness.lifecycle, events, exitCode);
    const outcome = await execution;
    if (outcome.ok) throw new Error("ptc_subagent resolved a refused call");
    return {
      message: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
    };
  }

  async function withDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
    const dir = await makeTempDir();
    try {
      return await body(dir);
    } finally {
      await removeTempDir(dir);
    }
  }

  test("the refusal carries the 429 text, the exit code, the turn count and the model", async () => {
    await withDir(async (dir) => {
      const harness = createHarness();
      const { message } = await callAndExpectThrow(dir, harness, FIXTURE_EVENTS, 0);
      expect(message).toBe(
        "ptc_subagent refused the call: " +
          FINAL_RATE_LIMIT_ERROR +
          " (child ran, exit=0, turns=4, reportChannel=none, model=" +
          CAPTURED_PROVIDER +
          "/" +
          CAPTURED_MODEL +
          ")",
      );
      expect(message).not.toContain("undefined");
    });
  });

  test("an unlabelled non-zero close names the absence instead of 'undefined'", async () => {
    // The exact shipped bug: foreground rejected with no errorMessage (exit 1, no stderr) and the
    // front concatenated it. The fixture for it is "no events at all".
    await withDir(async (dir) => {
      const harness = createHarness();
      const { message } = await callAndExpectThrow(dir, harness, [], 1);
      expect(message).toBe(
        "ptc_subagent refused the call: the child failed without an error message " +
          "(child ran, exit=1, turns=0, reportChannel=none)",
      );
      expect(message).not.toContain("undefined");
    });
  });

  test("a pre-spawn refusal is described as the harness declining", async () => {
    // No child reaches the lifecycle here — the depth gate refuses first — so this test awaits
    // the rejection directly rather than driving a spawn that must never happen.
    await withDir(async (dir) => {
      const tool = createPtcSubagentTool({
        cwd: dir,
        depth: DEFAULT_CONFIG.maxDispatchDepth,
        maxDispatchDepth: DEFAULT_CONFIG.maxDispatchDepth,
        getDispatchDeps: () => createHarness().deps,
      });
      const outcome = await tool
        .execute("call-depth", { task: "too deep" }, undefined, undefined, undefined as never)
        .then(
          (value: unknown) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      if (outcome.ok) throw new Error("ptc_subagent resolved a refused call");
      const message =
        outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      expect(message).toBe(
        "ptc_subagent refused the call: dispatch depth limit reached " +
          "(harness declined to start, exit=-1, turns=0, reportChannel=none)",
      );
    });
  });

  test("a fulfilled call states the model the child actually ran, before its prose", async () => {
    await withDir(async (dir) => {
      const harness = createHarness();
      const tool = createPtcSubagentTool({
        cwd: dir,
        depth: 0,
        maxDispatchDepth: DEFAULT_CONFIG.maxDispatchDepth,
        getDispatchDeps: () => harness.deps,
      });
      const execution = tool.execute(
        "call-model-line",
        { task: "reply with PONG" },
        undefined,
        undefined,
        undefined as never,
      );
      await driveChild(
        harness.lifecycle,
        [assistantTextWithModel("PONG", "deepseek", "deepseek-flash")],
        0,
      );
      const result = (await execution) as { content: { type: string; text: string }[] };
      const text = result.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      expect(text).toContain("model: " + DS_FLASH);
      // Contract order: the report block first, then the model line, then the child's prose.
      const reportAt = text.indexOf("child report");
      const modelAt = text.indexOf("model: " + DS_FLASH);
      const proseAt = text.indexOf("PONG");
      expect(reportAt).toBeGreaterThanOrEqual(0);
      expect(modelAt).toBeGreaterThan(reportAt);
      expect(proseAt).toBeGreaterThan(modelAt);
    });
  });

  test("a fulfilled call with no observed model adds no model line", async () => {
    await withDir(async (dir) => {
      const harness = createHarness();
      const tool = createPtcSubagentTool({
        cwd: dir,
        depth: 0,
        maxDispatchDepth: DEFAULT_CONFIG.maxDispatchDepth,
        getDispatchDeps: () => harness.deps,
      });
      const execution = tool.execute(
        "call-no-model-line",
        { task: "reply with PONG" },
        undefined,
        undefined,
        undefined as never,
      );
      await driveChild(harness.lifecycle, [assistantText("PONG")], 0);
      const result = (await execution) as { content: { type: string; text: string }[] };
      const text = result.content.map((part) => part.text).join("\n");
      expect(text).not.toContain("model:");
      expect(text).toContain("PONG");
    });
  });
});

// ---------------------------------------------------------------------------
//  P1: the background front — TaskRecord + ptc_task_output
// ---------------------------------------------------------------------------

interface BackgroundHarness {
  storage: InMemoryTaskStorage;
  registry: ReturnType<typeof createTaskRegistry>;
  /** The pump's output seam; ptc_task_output must read the SAME store the pump wrote. */
  outputs: InMemoryOutputStorage;
  lifecycle: RecordingLifecycle;
  warnings: string[];
  deps: DispatchDeps;
}

function createBackgroundHarness(): BackgroundHarness {
  const storage = new InMemoryTaskStorage();
  const clock = (): number => 1000;
  const registry = createTaskRegistry(storage, { clock });
  const outputs = new InMemoryOutputStorage();
  const lifecycle = new RecordingLifecycle();
  const warnings: string[] = [];
  return {
    storage,
    registry,
    outputs,
    lifecycle,
    warnings,
    deps: {
      taskRegistry: registry,
      lifecycle,
      outputStorage: outputs,
      slots: new DispatchSlotCounter(4),
      clock,
      logger: { warn: (message: string) => warnings.push(message), info: () => {} },
    },
  };
}

async function waitForTerminal(storage: InMemoryTaskStorage, taskId: ULID): Promise<TaskRecord> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const record = await storage.loadTask(taskId);
    if (record !== null && record.status !== "running" && record.status !== "stopping") {
      return record;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("task " + taskId + " did not reach a terminal state");
}

/** One background dispatch over the given events; returns the terminal record. */
async function runBackground(
  events: readonly ParsedAgentEvent[],
  exitCode = 0,
): Promise<{ record: TaskRecord; harness: BackgroundHarness }> {
  const dir = await makeTempDir();
  try {
    const harness = createBackgroundHarness();
    const outcome = await dispatch(
      { task: "probe the child", background: true },
      foregroundContext(dir),
      harness.deps,
    );
    if (!("taskId" in outcome)) {
      throw new Error("the background fixture was refused: " + JSON.stringify(outcome));
    }
    await driveChild(harness.lifecycle, events, exitCode);
    return { record: await waitForTerminal(harness.storage, outcome.taskId), harness };
  } finally {
    await removeTempDir(dir);
  }
}

describe("the background record and ptc_task_output carry the observed model", () => {
  test("a failed 429 child records its cause, usage and model", async () => {
    const { record, harness } = await runBackground(FIXTURE_EVENTS);
    expect(record.status).toBe("failed");
    expect(record.errorMessage).toBe(FINAL_RATE_LIMIT_ERROR);
    expect(record.observedProvider).toBe(CAPTURED_PROVIDER);
    expect(record.observedModel).toBe(CAPTURED_MODEL);
    expect(record.usage?.turns).toBe(4);
    // The pump's existing operator warning names the task and the child's cause (issue #70).
    expect(
      harness.warnings.some(
        (line) => line.includes("background dispatch task") && line.includes("429"),
      ),
    ).toBe(true);
  });

  test("ptc_task_output states the model line for a failed child", async () => {
    const { record, harness } = await runBackground(FIXTURE_EVENTS);
    const tool = createPtcTaskOutputTool(harness.registry, harness.outputs);
    const result = (await tool.execute(
      "call-output",
      { taskId: record.id },
      undefined,
      undefined,
      undefined as never,
    )) as { content: { type: string; text: string }[] };
    const text = result.content.map((part) => part.text).join("\n");
    expect(text).toContain("model: " + CAPTURED_PROVIDER + "/" + CAPTURED_MODEL);
    expect(text).toContain("turns=4");
    expect(text).toContain("429");
    expect(text).not.toContain("model: undefined");
  });

  test("a succeeded child that named no model records no pair and renders no line", async () => {
    // Absent is the claim "no assistant turn observed", not "the model was undefined"; the render
    // must stay byte-identical to a pre-ADR-0044 record.
    const { record, harness } = await runBackground([assistantText("PONG")]);
    expect(record.status).toBe("succeeded");
    expect(Object.hasOwn(record, "provider")).toBe(false);
    expect(Object.hasOwn(record, "model")).toBe(false);
    const tool = createPtcTaskOutputTool(harness.registry, harness.outputs);
    const result = (await tool.execute(
      "call-output-2",
      { taskId: record.id },
      undefined,
      undefined,
      undefined as never,
    )) as { content: { type: string; text: string }[] };
    const text = result.content.map((part) => part.text).join("\n");
    expect(text).not.toContain("model:");
    expect(text).toContain("PONG");
  });
});
describe("the observed-model text is sanitized on every model-facing surface", () => {
  /**
   * The child's wire is untrusted input: provider/model are strings it wrote, rendered into text
   * a model reads. ADR-0044 Decision 2 promises ONE bounded model line, not whatever bytes the
   * child sent — an ANSI escape or a newline inside the pair would otherwise reach the model as
   * formatting instructions or as forged extra lines.
   */
  const INJECTED_PROVIDER = "\x1b[31mP\x1b[0m";
  const INJECTED_MODEL = "M\nX".repeat(3_000);
  const MODEL_VALUE_MAX = 200;

  /** The value half of every rendered `model: ` line. */
  function modelValues(text: string): string[] {
    return text
      .split("\n")
      .filter((line) => line.startsWith("model: "))
      .map((line) => line.slice("model: ".length));
  }

  test("ptc_subagent renders one bounded, ANSI-free model line", async () => {
    const dir = await makeTempDir();
    try {
      const harness = createHarness();
      const tool = createPtcSubagentTool({
        cwd: dir,
        depth: 0,
        maxDispatchDepth: DEFAULT_CONFIG.maxDispatchDepth,
        getDispatchDeps: () => harness.deps,
      });
      const execution = tool.execute(
        "call-sanitize-model",
        { task: "reply with PONG" },
        undefined,
        undefined,
        undefined as never,
      );
      await driveChild(
        harness.lifecycle,
        [assistantTextWithModel("PONG", INJECTED_PROVIDER, INJECTED_MODEL)],
        0,
      );
      const result = (await execution) as { content: { type: string; text: string }[] };
      const text = result.content.map((part) => part.text).join("\n");
      const values = modelValues(text);
      expect(values, "exactly one model line").toHaveLength(1);
      expect(text, "no ESC sequence anywhere in the model-facing text").not.toContain("\x1b");
      expect(text.split("\n"), "the injected newline forged no line").not.toContain("X");
      expect(values[0]?.length ?? 0).toBeLessThanOrEqual(MODEL_VALUE_MAX);
    } finally {
      await removeTempDir(dir);
    }
  });

  test("ptc_task_output renders one bounded, ANSI-free model line", async () => {
    const { record, harness } = await runBackground([
      assistantTextWithModel("PONG", INJECTED_PROVIDER, INJECTED_MODEL),
    ]);
    const tool = createPtcTaskOutputTool(harness.registry, harness.outputs);
    const result = (await tool.execute(
      "call-output-sanitize",
      { taskId: record.id },
      undefined,
      undefined,
      undefined as never,
    )) as { content: { type: string; text: string }[] };
    const text = result.content.map((part) => part.text).join("\n");
    const values = modelValues(text);
    expect(values, "exactly one model line").toHaveLength(1);
    expect(text).not.toContain("\x1b");
    expect(text.split("\n")).not.toContain("X");
    expect(values[0]?.length ?? 0).toBeLessThanOrEqual(MODEL_VALUE_MAX);
  });

  test("the refusal diagnostic's model= fact is sanitized too", () => {
    const text = describeSettledFailure(
      rejectedOutcome({
        errorMessage: "boom",
        observedProvider: INJECTED_PROVIDER,
        observedModel: INJECTED_MODEL,
      }),
    );
    expect(text).not.toContain("\x1b");
    // One line: the injected newline must not split the diagnostic into facts the caller reads
    // as separate evidence.
    expect(text).not.toContain("\n");
    const at = text.indexOf("model=");
    expect(at).toBeGreaterThanOrEqual(0);
    const value = text.slice(at + "model=".length, -1); // model= is the last fact; facts end at ")"
    expect(value.length).toBeLessThanOrEqual(MODEL_VALUE_MAX);
  });
});

describe("a canceled close still records the observed model", () => {
  test("canceling after an assistant turn keeps provider/model on the TaskRecord", async () => {
    // ADR-0044 Decision 2: the pair is written at the same terminal close that writes usage,
    // "so a failed or canceled child that did run a model still states it". Cancel is the
    // background outcome a caller can least explain without knowing which model ran.
    const dir = await makeTempDir();
    try {
      const harness = createBackgroundHarness();
      const outcome = await dispatch(
        { task: "probe the child", background: true },
        foregroundContext(dir),
        harness.deps,
      );
      if (!("taskId" in outcome)) throw new Error("the background fixture was refused");
      await waitFor(() => harness.lifecycle.spawned.length > 0);
      const child = harness.lifecycle.handleAt(0);
      harness.lifecycle.pushEvent(
        child,
        assistantTextWithModel("PONG", "deepseek", "deepseek-flash"),
      );
      await harness.registry.transition(
        { kind: "transition", taskId: outcome.taskId, to: "stopping" },
        { clock: () => 1000, callerId: "caller-cancel" },
      );
      harness.lifecycle.resolveExit(child, 0, null);
      const record = await waitForTerminal(harness.storage, outcome.taskId);
      expect(record.status).toBe("canceled");
      expect(record.observedProvider).toBe("deepseek");
      expect(record.observedModel).toBe("deepseek-flash");
    } finally {
      await removeTempDir(dir);
    }
  });
});
