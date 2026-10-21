/**
 * `ptc_run_code` (T4) — the tool definition and its wiring to the T3 dispatcher.
 *
 * These are integration tests: every case except the schema/description guards runs a real
 * worker through `runPtcProgram`, exactly as the model's call would. The tool definitions come
 * either from the real extension — its factory plus the session that registers what it detected
 * (ADR-0035) — or from the same path with a config override, so a run can be pushed into a limit
 * without materializing 64 MiB of output.
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { AgentToolResult, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createSubCallUpdater,
  SUB_CALL_UPDATE_THROTTLE_MS,
  type PtcToolDetails,
} from "../src/tools/common.ts";
import { IMAGE_HOISTING_NOTE, ROUTES } from "../src/routes/registry.ts";
import { createPtcRunCodeTool } from "../src/tools/run-code.ts";
import {
  captureRegisteredTools,
  makeTempDir,
  ONE_PIXEL_PNG_BASE64,
  removeTempDir,
  RUN_TIMEOUT_MS,
  toolContext,
} from "./helpers/ptc.ts";

/** Text blocks of a tool result, joined the way the model receives them. */
function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

/**
 * Call the tool exactly as pi's agent loop does, with `cwd` as the only meaningful context field.
 *
 * The result is narrowed to this package's `details` shape: `defineTool` returns an intersection
 * whose call signature widens `details` back to `unknown`.
 */
function call(
  tool: ToolDefinition<any, any, any>,
  params: { code: string; description?: string; timeoutMs?: number },
  extra: { signal?: AbortSignal; cwd?: string } = {},
): Promise<AgentToolResult<PtcToolDetails>> {
  const ctx = toolContext(extra.cwd ?? process.cwd());
  return tool.execute(
    "call-1",
    { description: "integration test program", ...params },
    extra.signal,
    undefined,
    ctx,
  ) as Promise<AgentToolResult<PtcToolDetails>>;
}

/**
 * `Theme` that emits real ANSI SGR sequences, the way pi's own theme does.
 *
 * It has to be real ANSI, not a readable tag: the shimmer anchor is matched after stripping
 * escapes, so a marker-based fake would never match whatever the production theme emits.
 */
function ansiTheme(): Theme {
  return {
    fg: (slot: string, text: string) => {
      if (slot === "toolTitle") return `\x1b[34m${text}\x1b[39m`;
      if (slot === "accent") return `\x1b[36m${text}\x1b[39m`;
      if (slot === "dim") return `\x1b[2m${text}\x1b[22m`;
      return text;
    },
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  } as unknown as Theme;
}

test("createSubCallUpdater coalesces rapid pushes and drops a pending one on cancel", () => {
  // Two properties the live push depends on:
  //  - a wide `Promise.all` must not turn every start/end into its own repaint;
  //  - a throttled push must never land *after* the terminal result, which would revert the
  //    row to its in-flight shape.
  vi.useFakeTimers();
  try {
    const pushed: Array<Record<string, unknown>> = [];
    const updater = createSubCallUpdater({
      surface: "run_code",
      startedAt: 0,
      onUpdate: (result: unknown) => {
        pushed.push(result as Record<string, unknown>);
      },
    });

    // Leading edge fires at once.
    updater.update(() => [{ callId: 1, name: "read", args: {}, status: "running", startMs: 0 }]);
    expect(pushed).toHaveLength(1);

    // Within the throttle window the pushes coalesce; only the newest survives the timer, and
    // the dropped offer's factory is never called — that is what keeps N sequential calls from
    // costing O(N²) record copies.
    vi.advanceTimersByTime(10);
    const droppedFactory = vi.fn(() => []);
    updater.update(droppedFactory);
    expect(droppedFactory).not.toHaveBeenCalled();

    const keptFactory = vi.fn(() => [
      { callId: 1, name: "read", args: {}, status: "running" as const, startMs: 0 },
      { callId: 2, name: "bash", args: {}, status: "running" as const, startMs: 10 },
    ]);
    updater.update(keptFactory);
    expect(keptFactory).not.toHaveBeenCalled();
    expect(pushed).toHaveLength(1);

    vi.advanceTimersByTime(SUB_CALL_UPDATE_THROTTLE_MS);
    expect(pushed).toHaveLength(2);
    expect(keptFactory).toHaveBeenCalledTimes(1);
    const second = pushed[1] as { details: { subCalls: unknown[] } };
    expect(second.details.subCalls).toHaveLength(2);

    // A pending push that is cancelled never lands.
    updater.update(() => [{ callId: 3, name: "read", args: {}, status: "running", startMs: 20 }]);
    updater.cancel();
    vi.advanceTimersByTime(SUB_CALL_UPDATE_THROTTLE_MS * 5);
    expect(pushed).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});

test("renderCall wires pi's isPartial and state through to the shimmer (ADR-0020)", async () => {
  // The production seam: `run-code.ts`'s `renderCall` must hand the decorator the two
  // `ToolRenderContext` fields the shimmer's lifecycle depends on. Without `isPartial` the band
  // never settles; without `state` it restarts every tick and freezes at position 0.
  const tool = (await captureRegisteredTools()).get("ptc_run_code");
  if (!tool?.renderCall) throw new Error("ptc_run_code must expose renderCall");
  const renderCall = tool.renderCall as unknown as (
    args: unknown,
    theme: Theme,
    context: Record<string, unknown>,
  ) => { render: (width: number) => string[] };
  const args = { description: "Verify file integrity", code: "return 1;" };

  // Clock-only control: `useFakeTimers` would also stub `setTimeout`, which the worker-backed
  // tests in this file depend on.
  let clock = 0;
  const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);

  try {
    const state: Record<string, unknown> = {};
    const running = renderCall(args, ansiTheme(), { isPartial: true, state });
    expect(running.render(80)[0]).toContain("\x1b[36mV\x1b[39m");

    // Same bag, later clock, fresh component — the band must have moved on, not restarted.
    clock = 450;
    const rebuilt = renderCall(args, ansiTheme(), { isPartial: true, state });
    expect(rebuilt.render(80)[0]).toContain("\x1b[2mVer\x1b[22m\x1b[36mi\x1b[39m");

    // isPartial false is the settle path: no band, description rendered plainly.
    const settled = renderCall(args, ansiTheme(), { isPartial: false, state });
    expect(settled.render(80)[0]).toContain("\x1b[36mVerify file integrity\x1b[39m");
    expect(settled.render(80)[0]).not.toContain("\x1b[2m");
  } finally {
    nowSpy.mockRestore();
  }
});

test("the extension factory registers ptc_run_code with the documented parameter surface", async () => {
  const tool = (await captureRegisteredTools()).get("ptc_run_code");
  if (!tool) throw new Error("ptc_run_code must be registered");
  expect(tool.label).toBe("PTC Run Code");

  const parameters = tool.parameters as unknown as {
    required?: string[];
    properties?: Record<string, unknown>;
  };
  expect(parameters.required).toEqual(["code", "description"]);
  expect(Object.keys(parameters.properties ?? {})).toEqual(["code", "description", "timeoutMs"]);
  // DSH's approval-only fields are out of scope (map decision on #8, ADR-0007).
  expect(parameters.properties ?? {}).not.toHaveProperty("sandbox_permissions");
  expect(parameters.properties ?? {}).not.toHaveProperty("justification");
});

test("the description tells the model how to reach tools and what comes back", async () => {
  const description = (await captureRegisteredTools()).get("ptc_run_code")?.description ?? "";
  expect(description, "names the required code argument").toMatch(/`code`/);
  expect(description, "names the required description argument").toMatch(/`description`/);
  expect(description, "shows the binding call form").toMatch(/tools\.<name>\(args\)/);
  // DSH's own tool description: "Image-bearing subtool results are attached after the run."
  expect(description, "promises the image attachment").toMatch(/attached to/);
  expect(description, "tells the model not to spend context on base64").toMatch(
    /never return image data/,
  );
  expect(description).toMatch(/console\.log/);
  expect(description).toMatch(/return value/);
  expect(description, "states the surface has no helpers").toMatch(/has no\s+helpers/i);
  expect(description, "points at the surface that does").toMatch(/ptc_workflow/);
  expect(description).not.toMatch(/sandbox/i);
});

test("the road that replaced the reach note says the thing the note said", () => {
  // The reach note RETIRED with ADR-0061: under the new model the door is a codemode-reachable
  // tool, so the "the two-hop path is the only way" constraint it carried is gone. The fact it
  // was protecting did not go with it — a `codemode` script's tool table still has no
  // `pi_task_ptc` in it — and that fact now lives in the ROAD for creating a task, per surface.
  //
  // Measured 2026-10-16 (spike round 2): without it, a script author enumerates its own tool
  // table, finds no `pi_task_ptc`, and reads the silence as "this install does not register the
  // binding". Measured again 2026-10-20: the parent read the note and still wrote
  // `tools["pi.dispatch"]` into a script, got a TypeError, and burned three calls.
  //
  // Counterfactual: reword the road's codemode line and drop the fact — this goes red.
  const road = ROUTES.find((candidate) => candidate.id === "create-a-task");
  expect(road, "the create-a-task road exists").toBeDefined();
  const codemode = (road as { how: Record<string, string> }).how.codemode_ptc ?? "";
  expect(codemode, "names the reader").toContain("`codemode`");
  expect(codemode, "names the binding it is about").toContain("`pi_task_ptc`");
  expect(codemode, "states the absence from the tool table").toMatch(
    /does not contain `pi_task_ptc`/,
  );
  expect(codemode, "names the door that IS in the table").toContain("pi_task_codemode");
  // ADR-0052: the model-facing word is TASK. The line is read by a script author, so the
  // internal word must not be in it.
  expect(codemode, "does not say dispatch").not.toMatch(/dispatch/i);
});

test("the retired reach note is nowhere in the model-facing prose", async () => {
  // ADR-0061 retired the note. A retirement is only genuine when bringing it back turns a
  // named test red — otherwise the note is merely unfashioned, and the next person who finds it
  // in a description has no reason to know it was retired on purpose.
  //
  // Counterfactual: paste the note back into `ptc_run_code`'s description — this goes red.
  const runCode = (await captureRegisteredTools()).get("ptc_run_code")?.description ?? "";
  const workflow = (await captureRegisteredTools()).get("ptc_workflow")?.description ?? "";
  for (const [name, description] of [
    ["ptc_run_code", runCode],
    ["ptc_workflow", workflow],
  ] as const) {
    expect(description, `${name} does not carry the retired note`).not.toContain(
      "cannot call the PTC binding directly",
    );
    expect(description, `${name} does not carry the retired note's other half`).not.toContain(
      "is never in that script's own tool table",
    );
  }
});

test("both PTC descriptions carry the SAME image contract, so the sentence cannot drift between them", async () => {
  // One constant in two descriptions is only drift-proof if the test reads BOTH sides and compares
  // them. The binding contract has its own byte-comparison; the image contract sits outside the
  // contract, so the contract's guards never see it and this is the only place the two copies can
  // be checked against each other. (It used to be the reach note here; that note retired with
  // ADR-0061 and the road for creating a task carries its fact now.)
  //
  // Counterfactual: a description that reworded the contract in place — "never return image data
  // as the completion value" becoming "images are handled for you" — leaves every other assertion
  // in this file green, because they all read the CONSTANT. This one reads the rendered text, so
  // it goes red.
  const runCode = (await captureRegisteredTools()).get("ptc_run_code")?.description ?? "";
  const workflow = (await captureRegisteredTools()).get("ptc_workflow")?.description ?? "";
  expect(runCode, "ptc_run_code carries the shared contract").toContain(IMAGE_HOISTING_NOTE);
  expect(workflow, "ptc_workflow carries the shared contract").toContain(IMAGE_HOISTING_NOTE);
});

test("the binding example is scoped to a program, so a script author does not copy it into a script", async () => {
  // The counterfactual for the 2026-10-20 measurement above: the example sat directly above the
  // reach note with no scope on it, and a model copying an example does not read the paragraph
  // under it. The example now says where it applies. Both surfaces carry it, so both are checked.
  const runCode = (await captureRegisteredTools()).get("ptc_run_code")?.description ?? "";
  const workflow = (await captureRegisteredTools()).get("ptc_workflow")?.description ?? "";
  for (const [name, description] of [
    ["ptc_run_code", runCode],
    ["ptc_workflow", workflow],
  ] as const) {
    // ADR-0052: the door is dot-accessible, so the example is the dot form. The OLD name needed
    // string indexing, and the whole point of the rename is that neither plane does any more.
    const at = description.indexOf("await tools.pi_task_ptc(");
    expect(at, `${name} states the pi_task_ptc call form`).toBeGreaterThan(-1);
    // The window AROUND the example, not the sentence it sits in: the example itself contains a
    // `.` (`{ task: "..." }`), so a sentence-scoped match would stop in the middle of it. The
    // scope marker is what precedes the example, and that is what the claim is about.
    const window = description.slice(Math.max(0, at - 200), at);
    expect(window, `${name} scopes that example to a program`).toMatch(/inside the program/);
    // The old shape is gone from the model-facing text entirely: a program that still reaches for
    // `tools["pi.dispatch"]` gets a TypeError, so the description must not teach it.
    expect(description, `${name} does not teach the retired name`).not.toContain("pi.dispatch");
  }
});

test("the description documents the always-bound pi_task_ptc door (pitfalls #1/#4/#5)", async () => {
  const description = (await captureRegisteredTools()).get("ptc_run_code")?.description ?? "";
  // Pitfall #1: the door is registered under a plain identifier, so the description shows the dot
  // form — and the string-indexed form it used to need is gone.
  expect(description, "shows the dot call form").toContain("await tools.pi_task_ptc(");
  expect(description, "does not teach string indexing").not.toContain('tools["pi_task_ptc"]');
  // Pitfall #4: the run deadline bounds in-flight foreground tasks too.
  expect(description, "independent tasks compose under Promise.all").toContain(
    "independent tasks compose under `Promise.all`",
  );
  // Pitfall #5: the program reads this run's actual binding names instead of assuming a set.
  expect(description, "names the introspection global").toContain("`ptcBindings`");
});

test("the timeoutMs parameter description warns that the deadline kills in-flight dispatches", async () => {
  const tool = (await captureRegisteredTools()).get("ptc_run_code");
  if (!tool) throw new Error("ptc_run_code must be registered");
  const parameters = tool.parameters as unknown as {
    properties?: { timeoutMs?: { description?: string } };
  };
  const description = parameters.properties?.timeoutMs?.description ?? "";
  // Same fact the model needs in prose form (pitfall #4): a timed-out run takes the
  // program's in-flight foreground dispatches with it.
  expect(description).toContain("in-flight tasks");
  expect(description).toContain("terminated with it");
});

test(
  "a program calling tools.read resolves relative paths against the tool context's cwd",
  async () => {
    const dir = await makeTempDir();
    try {
      await writeFile(join(dir, "fixture.txt"), "content through ptc_run_code\n");
      const tool = (await captureRegisteredTools()).get("ptc_run_code");
      if (!tool) throw new Error("ptc_run_code must be registered");
      const result = await call(
        tool,
        {
          code: 'const file = await tools.read({ path: "fixture.txt" });\nreturn file.content[0].text;',
        },
        { cwd: dir },
      );
      expect(textOf(result)).toBe("content through ptc_run_code\n");
      expect(result.details.logs).toEqual([]);
      expect(result.details.durationMs >= 0).toBe(true);
    } finally {
      await removeTempDir(dir);
    }
  },
  RUN_TIMEOUT_MS,
);

test(
  "a program that returns nothing renders R1's no-output placeholder",
  async () => {
    const result = await call(createPtcRunCodeTool(), { code: "const unused = 1;" });
    expect(textOf(result)).toBe("(ptc_run_code completed with no output)");
    expect("result" in result.details).toBe(false);
  },
  RUN_TIMEOUT_MS,
);

test(
  "logs and the return value are rendered together, types stripped",
  async () => {
    const result = await call(createPtcRunCodeTool(), {
      code: 'const value: number = 41;\nconsole.log("seen", value);\nreturn { answer: value + 1 };',
    });
    expect(textOf(result)).toBe("seen 41\n{answer: 42}");
    expect(result.details.logs).toEqual(["seen 41"]);
    expect(result.details.result).toEqual({ answer: 42 });
  },
  RUN_TIMEOUT_MS,
);

test(
  "a binding call is pushed to the UI while the run is still in flight (ADR-0021 §4)",
  async () => {
    // US3/US21: the tree is visible *during* the run, not only once it settles. pi's `onUpdate`
    // is the channel; the live push is what makes the row show which binding is in flight.
    const dir = await makeTempDir();
    try {
      await writeFile(join(dir, "fixture.txt"), "live fixture\n");
      const tool = createPtcRunCodeTool();
      const updates: AgentToolResult<PtcToolDetails>[] = [];

      const result = (await tool.execute(
        "call-1",
        { description: "live", code: 'await tools.read({ path: "fixture.txt" });\nreturn 1;' },
        undefined,
        (partial) => {
          updates.push(partial as AgentToolResult<PtcToolDetails>);
        },
        toolContext(dir),
      )) as AgentToolResult<PtcToolDetails>;

      // At least one push landed mid-run, and it saw the binding while it was still running.
      expect(updates.length).toBeGreaterThan(0);
      const sawRunning = updates.some((update) =>
        (update.details.subCalls ?? []).some((entry) => entry.status === "running"),
      );
      expect(sawRunning).toBe(true);
      // The live push carries the tree but no completion value — nothing has completed yet.
      expect(updates[0]?.details.result).toBeUndefined();
      // The terminal result still carries the settled records.
      expect(result.details.subCalls?.map((entry) => entry.status)).toEqual(["ok"]);
    } finally {
      await removeTempDir(dir);
    }
  },
  RUN_TIMEOUT_MS,
);

test(
  "a pi_task_ptc the depth gate refuses is recorded 'rejected', not 'ok' (ADR-0021 §6)",
  async () => {
    // `pi_task_ptc` never throws for its own refusals — it resolves with a rejected
    // `DispatchResult`. Recording that as `ok` would tell the reader a dispatch succeeded when the
    // harness declined to run it. A run stamped at depth 1 with a max of 1 refuses its own
    // dispatches at the gate (childDepth 2 > 1), before any spawn — so the test is hermetic.
    const result = await call(createPtcRunCodeTool({ depth: 1, config: { maxDispatchDepth: 1 } }), {
      code: 'const r = await tools.pi_task_ptc({ agent: "x", task: "y" });\n' + "return r.status;",
    });
    expect(result.details.result).toBe("rejected");
    const dispatch = result.details.subCalls?.find((entry) => entry.name === "pi_task_ptc");
    expect(dispatch?.status).toBe("rejected");
    expect(dispatch?.errorMessage).toContain("depth limit");
    // A refusal never ran, so it has no duration to report.
    expect(dispatch?.durationMs).toBe(0);
  },
  RUN_TIMEOUT_MS,
);

test(
  "the tracked sub-calls reach the renderer's details (ADR-0021)",
  async () => {
    // The seam that makes the sub-call tree drawable at all: the dispatcher's tracker freezes
    // onto the outcome, and `renderToolResult` must copy it onto `details`. Without the copy the
    // field is always undefined and the tree never renders, however good the renderer is.
    const dir = await makeTempDir();
    try {
      await writeFile(join(dir, "fixture.txt"), "sub-call fixture\n");

      const result = await call(
        createPtcRunCodeTool(),
        {
          code:
            'const first = await tools.read({ path: "fixture.txt" });\n' +
            'const second = await tools.read({ path: "fixture.txt" });\n' +
            "return 2;",
        },
        { cwd: dir },
      );

      const subCalls = result.details.subCalls;
      expect(subCalls).toBeDefined();
      expect(subCalls).toHaveLength(2);
      // Dispatch order, name, args and terminal status all survive the trip.
      expect(subCalls?.map((entry) => entry.name)).toEqual(["read", "read"]);
      expect(subCalls?.map((entry) => entry.status)).toEqual(["ok", "ok"]);
      expect(subCalls?.[0]?.args).toEqual({ path: "fixture.txt" });
      expect(subCalls?.[0]?.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      await removeTempDir(dir);
    }
  },
  RUN_TIMEOUT_MS,
);

test(
  "a failing program throws R1's failure message with the captured output block",
  async () => {
    let caught: unknown;
    try {
      await call(createPtcRunCodeTool(), {
        code: 'console.log("before the throw");\nthrow new Error("boom");',
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error;
    expect(error.name).toBe("CodeRunFailedError");
    expect(error.message).toBe(
      "code run failed (exception): boom\nCaptured output:\nbefore the throw",
    );
  },
  RUN_TIMEOUT_MS,
);

test(
  "a failing program without logs keeps the failure message bare",
  async () => {
    let caught: unknown;
    try {
      await call(createPtcRunCodeTool(), { code: "null.everything();" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error;
    expect(error.message).toMatch(/^code run failed \(exception\): /);
    expect(error.message).not.toMatch(/Captured output:/);
  },
  RUN_TIMEOUT_MS,
);

test(
  "timeoutMs overrides the deadline and reports the requested value",
  async () => {
    await expect(
      call(createPtcRunCodeTool({ config: { graceMs: 100 } }), {
        code: "await new Promise(() => {});",
        timeoutMs: 150,
      }),
    ).rejects.toThrow(/^code run failed \(timeout\): run timed out after 150 ms$/);
  },
  RUN_TIMEOUT_MS,
);

test(
  "timeoutMs 0 falls back to the configured default instead of disabling the deadline",
  async () => {
    const result = await call(createPtcRunCodeTool(), { code: "return 1;", timeoutMs: 0 });
    expect(textOf(result)).toBe("1");
  },
  RUN_TIMEOUT_MS,
);

test(
  "an aborted signal fails the run with the abort kind before spawning work",
  async () => {
    let caught: unknown;
    try {
      await call(createPtcRunCodeTool(), { code: "return 1;" }, { signal: AbortSignal.abort() });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("code run failed (abort): run cancelled before start");
  },
  RUN_TIMEOUT_MS,
);

test(
  "an oversize run surfaces output-limit with the retained log prefix",
  async () => {
    // A small budget exercises the same code path a 64 MiB overrun would, without the payload.
    const tool = createPtcRunCodeTool({ config: { maxOutputBytes: 2048 } });
    let caught: unknown;
    try {
      await call(tool, {
        code: 'console.log("x".repeat(1500)); console.log("y".repeat(1500)); console.log("third"); return 1;',
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(
      /^code run failed \(output-limit\): .*maxOutputBytes=2048.*1 log line\(s\) retained/,
    );
    expect(message).toMatch(/Captured output:\nx{1500}/);
    expect(message, "only the fitting prefix is retained").not.toMatch(/y{1500}/);
  },
  RUN_TIMEOUT_MS,
);

test(
  "an oversized text block is truncated the way pi's built-ins truncate (ADR-0015)",
  async () => {
    const lines = 3000;
    const result = await call(createPtcRunCodeTool(), {
      code: `for (let i = 0; i < ${lines}; i++) console.log("line " + i + " " + "x".repeat(30)); return "done";`,
    });

    const text = textOf(result);
    // pi's contract: keep the tail, say what was shown, and point at the whole thing.
    // 3000 log lines plus the completion value, which is the 3001st.
    expect(text).toMatch(/\[Showing lines \d+-\d+ of 300\d/);
    expect(text).toContain("Full output:");
    expect(text).not.toContain("line 0 ");
    expect(text).toContain(`line ${lines - 1} `);

    const fullOutputPath = result.details.fullOutputPath;
    expect(fullOutputPath, "the untruncated text must have a home").toBeDefined();
    expect(existsSync(fullOutputPath as string)).toBe(true);
    try {
      const full = readFileSync(fullOutputPath as string, "utf8");
      expect(full.split("\n")).toHaveLength(lines + 1);
      expect(full).toContain("line 0 ");
      // The model read a tail of the text, not the text.
      expect(text.length).toBeLessThan(full.length);
    } finally {
      unlinkSync(fullOutputPath as string);
    }
  },
  RUN_TIMEOUT_MS,
);

test(
  "an image read inside a program is attached to the tool result (ADR-0014)",
  async () => {
    const dir = await makeTempDir();
    try {
      await writeFile(join(dir, "pixel.png"), Buffer.from(ONE_PIXEL_PNG_BASE64, "base64"));
      const result = await call(
        createPtcRunCodeTool(),
        {
          code:
            'const r = await tools.read({ path: "pixel.png" }); ' +
            'return r.content.filter((b) => b.type === "image").length;',
        },
        { cwd: dir },
      );

      // The program still receives the image — it counted it…
      expect(result.details.result).toBe(1);
      // …and so does the model, as an image block on the PTC tool result rather than as base64
      // inside the completion value.
      const images = result.content.filter((part) => part.type === "image");
      expect(images).toHaveLength(1);
      expect(images[0]).toMatchObject({ type: "image", mimeType: "image/png" });
      expect((images[0] as { data?: string }).data ?? "").not.toBe("");
      expect(result.details.imageCount).toBe(1);
      expect(textOf(result), "the text block must not smuggle the payload").not.toContain(
        "iVBORw0KGgo",
      );
    } finally {
      await removeTempDir(dir);
    }
  },
  RUN_TIMEOUT_MS,
);
