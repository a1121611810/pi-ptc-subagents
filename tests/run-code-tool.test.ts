/**
 * `ptc_run_code` (T4) — the tool definition and its wiring to the T3 dispatcher.
 *
 * These are integration tests: every case except the schema/description guards runs a real
 * worker through `runPtcProgram`, exactly as the model's call would. The tool definitions come
 * either from the extension factory (the registration path pi uses) or from the factory with a
 * config override, so a run can be pushed into a limit without materializing 64 MiB of output.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
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

test("the description tells the model how to reach tools and what comes back", () => {
  const description = captureRegisteredTools().get("ptc_run_code")?.description ?? "";
  expect(description, "names the required code argument").toMatch(/`code`/);
  expect(description, "names the required description argument").toMatch(/`description`/);
  expect(description, "shows the binding call form").toMatch(/tools\.<name>\(args\)/);
  expect(description).toMatch(/console\.log/);
  expect(description).toMatch(/return value/);
  expect(description, "states the surface has no helpers").toMatch(/has no\s+helpers/i);
  expect(description, "points at the surface that does").toMatch(/ptc_workflow/);
  expect(description).not.toMatch(/sandbox/i);
});

test(
  "a program calling tools.read resolves relative paths against the tool context's cwd",
  async () => {
    const dir = await makeTempDir();
    try {
      await writeFile(join(dir, "fixture.txt"), "content through ptc_run_code\n");
      const tool = captureRegisteredTools().get("ptc_run_code");
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

test("logs and the return value are rendered together, types stripped", async () => {
  const result = await call(createPtcRunCodeTool(), {
    code: 'const value: number = 41;\nconsole.log("seen", value);\nreturn { answer: value + 1 };',
  });
  expect(textOf(result)).toBe('seen 41\n{\n  "answer": 42\n}');
  expect(result.details.logs).toEqual(["seen 41"]);
  expect(result.details.result).toEqual({ answer: 42 });
}, RUN_TIMEOUT_MS);

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

test("a failing program without logs keeps the failure message bare", async () => {
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
}, RUN_TIMEOUT_MS);

test("timeoutMs overrides the deadline and reports the requested value", async () => {
  await expect(
    call(createPtcRunCodeTool({ config: { graceMs: 100 } }), {
      code: "await new Promise(() => {});",
      timeoutMs: 150,
    }),
  ).rejects.toThrow(/^code run failed \(timeout\): run timed out after 150 ms$/);
}, RUN_TIMEOUT_MS);

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
      await call(
        createPtcRunCodeTool(),
        { code: "return 1;" },
        { signal: AbortSignal.abort() },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      "code run failed (abort): run cancelled before start",
    );
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