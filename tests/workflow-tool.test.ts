/**
 * `ptc_workflow` (T5) — the structured PTC surface: plan, args and workflow helpers.
 *
 * Integration tests: helper semantics, the phase roll-up and the args round-trip all run through
 * the real dispatcher and a real worker, exactly as the model's call would.
 */
import { expect, test } from "vitest";
import type {
  AgentToolResult,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { PtcToolDetails } from "../src/tools/common.ts";
import { createPtcWorkflowTool } from "../src/tools/workflow.ts";
import { captureRegisteredTools, RUN_TIMEOUT_MS, toolContext } from "./helpers/ptc.ts";

/** Text blocks of a tool result, joined the way the model receives them. */
function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

/** Call the tool exactly as pi's agent loop does, with `cwd` as the only meaningful context field. */
function call(
  tool: ToolDefinition<any, any, any>,
  params: { meta?: unknown; script: string; args?: unknown },
  extra: { signal?: AbortSignal; cwd?: string } = {},
): Promise<AgentToolResult<PtcToolDetails>> {
  const ctx: ExtensionToolContext = toolContext(extra.cwd ?? process.cwd());
  const meta = params.meta ?? { name: "test workflow", description: "integration test workflow" };
  return tool.execute(
    "call-1",
    { meta, script: params.script, ...(params.args === undefined ? {} : { args: params.args }) },
    extra.signal,
    undefined,
    ctx,
  ) as Promise<AgentToolResult<PtcToolDetails>>;
}

test("the extension factory registers ptc_workflow with the documented parameter surface", () => {
  const tool = captureRegisteredTools().get("ptc_workflow");
  if (!tool) throw new Error("ptc_workflow must be registered");
  expect(tool.label).toBe("PTC Workflow");

  const parameters = tool.parameters as unknown as {
    required?: string[];
    properties?: Record<string, { required?: string[]; properties?: Record<string, unknown> }>;
  };
  expect(parameters.required).toEqual(["meta", "script"]);
  expect(Object.keys(parameters.properties ?? {})).toEqual(["meta", "script", "args"]);
  expect(parameters.properties?.meta?.required).toEqual(["name", "description"]);
  expect(Object.keys(parameters.properties?.meta?.properties ?? {})).toEqual([
    "name",
    "description",
    "phases",
  ]);
});

test("the description lists the four helpers and says there is no agent()", () => {
  const description = captureRegisteredTools().get("ptc_workflow")?.description ?? "";
  for (const helper of [
    "log(message)",
    "phase(title)",
    "parallel(thunks)",
    "pipeline(items, ...stages)",
  ]) {
    expect(description, `description must document ${helper}`).toContain(helper);
  }
  expect(description).toMatch(/There is no `agent\(\)` helper\./);
  expect(description, "states the binding form shared with ptc_run_code").toMatch(
    /tools\.<name>\(args\)/,
  );
  // Pitfalls #1/#5: same guidance as ptc_run_code — string-indexed dispatch name, per-run
  // binding manifest.
  expect(description, "shows the string-indexed dispatch form").toContain('tools["pi.dispatch"]');
  expect(description, "names the introspection global").toContain("ptcBindings");
  expect(description).toMatch(/`meta\.phases`/);
  expect(description).toMatch(/`args`/);
});

test(
  "args round-trips to the program's args global",
  async () => {
    const args = { task: "write the report", nested: { count: 2 }, list: [1, "two", null, true] };
    const result = await call(
      createPtcWorkflowTool(),
      { script: "return { received: args, task: args.task };", args },
      { cwd: process.cwd() },
    );
    expect(textOf(result)).toBe(
      [
        "{",
        '  received: {task: "write the report", nested: {count: 2}, list: [1, "two", null, true]}',
        '  task: "write the report"',
        "}",
      ].join("\n"),
    );
    expect(result.details.result).toEqual({ received: args, task: "write the report" });
  },
  RUN_TIMEOUT_MS,
);

test(
  "args is optional: a workflow with no args sees null",
  async () => {
    const result = await call(createPtcWorkflowTool(), { script: "return args === null;" });
    expect(textOf(result)).toBe("true");
  },
  RUN_TIMEOUT_MS,
);

test(
  "non-plain-JSON args are rejected before the run is dispatched",
  async () => {
    const tool = createPtcWorkflowTool();
    const cyclic: Record<string, unknown> = { name: "cycle" };
    cyclic.self = cyclic;

    const cases: Array<[string, unknown, RegExp]> = [
      ["function entry", { fn: () => 1 }, /args\.fn is a function/],
      ["undefined entry", { missing: undefined }, /args\.missing is undefined/],
      ["symbol entry", { flag: Symbol("nope") }, /args\.flag is a symbol/],
      ["cycle", cyclic, /args\.self\.self is a circular reference/],
      ["class instance", { when: new Date(0) }, /args\.when is a Date/],
      ["non-finite number", { ratio: Number.NaN }, /args\.ratio is NaN/],
      ["nested function", { nested: { deep: [() => 1] } }, /args\.nested\.deep\[0\] is a function/],
      ["array payload", [1, 2], /args must be a plain JSON object, received an array/],
    ];
    for (const [label, args, expected] of cases) {
      let caught: unknown;
      try {
        await call(tool, { script: "return 1;", args });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      const error = caught as Error;
      expect(error.name, label).toBe("TypeError");
      expect(error.message, label).toMatch(expected);
    }

    // An already-aborted signal proves the ordering: args validation happens before the dispatcher
    // would have reported `code run failed (abort)`.
    let caught: unknown;
    try {
      await call(
        tool,
        { script: "return 1;", args: { fn: () => 1 } },
        { signal: AbortSignal.abort() },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/args\.fn is a function/);
  },
  RUN_TIMEOUT_MS,
);

test(
  "log/phase narration and console output are rendered above the return value",
  async () => {
    const result = await call(createPtcWorkflowTool(), {
      meta: {
        name: "phased",
        description: "phase roll-up",
        phases: [{ name: "Research" }, { name: "Write" }],
      },
      script:
        'log("narrating"); phase("Research"); console.log("printed"); phase("Write"); return { done: true };',
    });
    expect(textOf(result)).toBe("Phases: Research → Write\nnarrating\nprinted\n{done: true}");
    expect(result.details.phases).toEqual(["Research", "Write"]);
    expect(result.details.narrations).toEqual(["narrating"]);
    expect(result.details.logs).toEqual(["printed"]);
    expect(result.details.warnings).toEqual([]);
  },
  RUN_TIMEOUT_MS,
);

test(
  "a phase title outside meta.phases warns once instead of failing the run",
  async () => {
    const result = await call(createPtcWorkflowTool(), {
      meta: { name: "drift", description: "plan drift", phases: [{ name: "Research" }] },
      script: 'phase("Research"); phase("Publish"); phase("Publish"); return "kept";',
    });
    expect(textOf(result)).toBe(
      'Phases: Research → Publish → Publish\nkept\nWarning: phase "Publish" is not listed in meta.phases (declared: Research)',
    );
    expect(result.details.warnings).toEqual([
      'phase "Publish" is not listed in meta.phases (declared: Research)',
    ]);
  },
  RUN_TIMEOUT_MS,
);

test(
  "without meta.phases there is no declared plan, so phase() never warns",
  async () => {
    const result = await call(createPtcWorkflowTool(), {
      meta: { name: "undeclared", description: "no plan declared" },
      script: 'phase("Anything"); return 1;',
    });
    expect(result.details.warnings).toEqual([]);
    expect(textOf(result)).toBe("Phases: Anything\n1");
  },
  RUN_TIMEOUT_MS,
);

test(
  "parallel() maps a failed item to null and keeps its siblings",
  async () => {
    const result = await call(createPtcWorkflowTool(), {
      script:
        'const out = await parallel([async () => "a", async () => { throw new Error("boom"); }, async () => 3]); return out;',
    });
    expect(result.details.result).toEqual(["a", null, 3]);
  },
  RUN_TIMEOUT_MS,
);

test(
  "pipeline() threads items through stages with the same per-item null on failure",
  async () => {
    const result = await call(createPtcWorkflowTool(), {
      script:
        'const out = await pipeline([2, 4, 6], async (n) => n * 10, async (n, item) => { if (item === 4) throw new Error("skip"); return n + item; }); return out;',
    });
    expect(result.details.result).toEqual([22, null, 66]);
  },
  RUN_TIMEOUT_MS,
);

test(
  "scripts are type-stripped on this surface too",
  async () => {
    const result = await call(createPtcWorkflowTool(), {
      script:
        "const total: number = 40 + 2;\nconst label = (value: number): string => `total=${value}`;\nreturn label(total);",
    });
    expect(textOf(result)).toBe("total=42");
  },
  RUN_TIMEOUT_MS,
);

test(
  "the workflow surface binds every builtin tool and `pi.dispatch` (ADR-0016)",
  async () => {
    const result = await call(createPtcWorkflowTool(), {
      script: "return Object.keys(tools).sort();",
    });
    expect(result.details.result).toEqual([
      "bash",
      "edit",
      "find",
      "grep",
      "ls",
      "pi.dispatch",
      "read",
      "write",
    ]);
  },
  RUN_TIMEOUT_MS,
);

test(
  "a failing workflow throws R1's failure message with phase and narration in the captured output",
  async () => {
    let caught: unknown;
    try {
      await call(createPtcWorkflowTool(), {
        meta: { name: "failing", description: "fails mid-run", phases: [{ name: "Research" }] },
        script:
          'phase("Research"); log("narrating"); console.log("printed"); throw new Error("boom");',
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error;
    expect(error.name).toBe("CodeRunFailedError");
    expect(error.message).toBe(
      "code run failed (exception): boom\nCaptured output:\n[phase] Research\n[log] narrating\nprinted",
    );
  },
  RUN_TIMEOUT_MS,
);
