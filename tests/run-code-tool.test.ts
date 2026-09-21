/**
 * `ptc_run_code` (T4) — the tool definition and its wiring to the T3 dispatcher.
 *
 * These are integration tests: every case except the schema/description guards runs a real
 * worker through `runPtcProgram`, exactly as the model's call would. The tool definitions come
 * either from the extension factory (the registration path pi uses) or from the factory with a
 * config override, so a run can be pushed into a limit without materializing 64 MiB of output.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { PtcToolDetails } from "../src/tools/common.ts";
import { createPtcRunCodeTool } from "../src/tools/run-code.ts";
import {
  captureRegisteredTools,
  makeTempDir,
  removeTempDir,
  RUN_TIMEOUT_MS,
  toolContext,
} from "./helpers/ptc.ts";

const options = { timeout: RUN_TIMEOUT_MS };

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
  const ctx: ExtensionContext = toolContext(extra.cwd ?? process.cwd());
  return tool.execute(
    "call-1",
    { description: "integration test program", ...params },
    extra.signal,
    undefined,
    ctx,
  ) as Promise<AgentToolResult<PtcToolDetails>>;
}

test("the extension factory registers ptc_run_code with the documented parameter surface", () => {
  const tool = captureRegisteredTools().get("ptc_run_code");
  assert.ok(tool, "ptc_run_code must be registered");
  assert.equal(tool.label, "PTC Run Code");

  const parameters = tool.parameters as unknown as {
    required?: string[];
    properties?: Record<string, unknown>;
  };
  assert.deepEqual(parameters.required, ["code", "description"]);
  assert.deepEqual(Object.keys(parameters.properties ?? {}), ["code", "description", "timeoutMs"]);
  // DSH's approval-only fields are out of scope (map decision on #8, ADR-0007).
  assert.equal("sandbox_permissions" in (parameters.properties ?? {}), false);
  assert.equal("justification" in (parameters.properties ?? {}), false);
});

test("the description tells the model how to reach tools and what comes back", () => {
  const description = captureRegisteredTools().get("ptc_run_code")?.description ?? "";
  assert.match(description, /`code`/, "names the required code argument");
  assert.match(description, /`description`/, "names the required description argument");
  assert.match(description, /tools\.<name>\(args\)/, "shows the binding call form");
  assert.match(description, /console\.log/);
  assert.match(description, /return value/);
  assert.match(description, /has no\s+helpers/i, "states the surface has no helpers");
  assert.match(description, /ptc_workflow/, "points at the surface that does");
  assert.doesNotMatch(description, /sandbox/i);
});

test(
  "a program calling tools.read resolves relative paths against the tool context's cwd",
  options,
  async () => {
    const dir = await makeTempDir();
    try {
      await writeFile(join(dir, "fixture.txt"), "content through ptc_run_code\n");
      const tool = captureRegisteredTools().get("ptc_run_code");
      assert.ok(tool);
      const result = await call(
        tool,
        {
          code: 'const file = await tools.read({ path: "fixture.txt" });\nreturn file.content[0].text;',
        },
        { cwd: dir },
      );
      assert.equal(textOf(result), "content through ptc_run_code\n");
      assert.deepEqual(result.details.logs, []);
      assert.equal(result.details.durationMs >= 0, true);
    } finally {
      await removeTempDir(dir);
    }
  },
);

test("a program that returns nothing renders R1's no-output placeholder", options, async () => {
  const result = await call(createPtcRunCodeTool(), { code: "const unused = 1;" });
  assert.equal(textOf(result), "(ptc_run_code completed with no output)");
  assert.equal("result" in result.details, false);
});

test("logs and the return value are rendered together, types stripped", options, async () => {
  const result = await call(createPtcRunCodeTool(), {
    code: 'const value: number = 41;\nconsole.log("seen", value);\nreturn { answer: value + 1 };',
  });
  assert.equal(textOf(result), 'seen 41\n{\n  "answer": 42\n}');
  assert.deepEqual(result.details.logs, ["seen 41"]);
  assert.deepEqual(result.details.result, { answer: 42 });
});

test(
  "a failing program throws R1's failure message with the captured output block",
  options,
  async () => {
    await assert.rejects(
      call(createPtcRunCodeTool(), {
        code: 'console.log("before the throw");\nthrow new Error("boom");',
      }),
      (error: Error) => {
        assert.equal(error.name, "CodeRunFailedError");
        assert.equal(
          error.message,
          "code run failed (exception): boom\nCaptured output:\nbefore the throw",
        );
        return true;
      },
    );
  },
);

test("a failing program without logs keeps the failure message bare", options, async () => {
  await assert.rejects(
    call(createPtcRunCodeTool(), { code: "null.everything();" }),
    (error: Error) => {
      assert.match(error.message, /^code run failed \(exception\): /);
      assert.doesNotMatch(error.message, /Captured output:/);
      return true;
    },
  );
});

test("timeoutMs overrides the deadline and reports the requested value", options, async () => {
  const tool = createPtcRunCodeTool({ config: { graceMs: 100 } });
  await assert.rejects(
    call(tool, { code: "await new Promise(() => {});", timeoutMs: 150 }),
    (error: Error) => {
      assert.match(error.message, /^code run failed \(timeout\): run timed out after 150 ms$/);
      return true;
    },
  );
});

test(
  "timeoutMs 0 falls back to the configured default instead of disabling the deadline",
  options,
  async () => {
    const result = await call(createPtcRunCodeTool(), { code: "return 1;", timeoutMs: 0 });
    assert.equal(textOf(result), "1");
  },
);

test(
  "an aborted signal fails the run with the abort kind before spawning work",
  options,
  async () => {
    await assert.rejects(
      call(createPtcRunCodeTool(), { code: "return 1;" }, { signal: AbortSignal.abort() }),
      (error: Error) => {
        assert.equal(error.message, "code run failed (abort): run cancelled before start");
        return true;
      },
    );
  },
);

test("an oversize run surfaces output-limit with the retained log prefix", options, async () => {
  // A small budget exercises the same code path a 64 MiB overrun would, without the payload.
  const tool = createPtcRunCodeTool({ config: { maxOutputBytes: 2048 } });
  await assert.rejects(
    call(tool, {
      code: 'console.log("x".repeat(1500)); console.log("y".repeat(1500)); console.log("third"); return 1;',
    }),
    (error: Error) => {
      assert.match(
        error.message,
        /^code run failed \(output-limit\): .*maxOutputBytes=2048.*1 log line\(s\) retained/,
      );
      assert.match(error.message, /Captured output:\nx{1500}/);
      assert.doesNotMatch(error.message, /y{1500}/, "only the fitting prefix is retained");
      return true;
    },
  );
});
