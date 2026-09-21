/**
 * `ptc_workflow` (T5) — the structured PTC surface: plan, args and workflow helpers.
 *
 * Integration tests: helper semantics, the phase roll-up and the args round-trip all run through
 * the real dispatcher and a real worker, exactly as the model's call would.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { PtcToolDetails } from "../src/tools/common.ts";
import { createPtcWorkflowTool } from "../src/tools/workflow.ts";
import { captureRegisteredTools, RUN_TIMEOUT_MS, toolContext } from "./helpers/ptc.ts";

const options = { timeout: RUN_TIMEOUT_MS };

/** Text blocks of a tool result, joined the way the model receives them. */
function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

/** Call the tool exactly as pi's agent loop does, with `cwd` as the only meaningful context field. */
function call(
  tool: ToolDefinition,
  params: { meta?: unknown; script: string; args?: unknown },
  extra: { signal?: AbortSignal; cwd?: string } = {},
): Promise<AgentToolResult<PtcToolDetails>> {
  const ctx: ExtensionContext = toolContext(extra.cwd ?? process.cwd());
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
  assert.ok(tool, "ptc_workflow must be registered");
  assert.equal(tool.label, "PTC Workflow");

  const parameters = tool.parameters as unknown as {
    required?: string[];
    properties?: Record<string, { required?: string[]; properties?: Record<string, unknown> }>;
  };
  assert.deepEqual(parameters.required, ["meta", "script"]);
  assert.deepEqual(Object.keys(parameters.properties ?? {}), ["meta", "script", "args"]);
  assert.deepEqual(parameters.properties?.meta?.required, ["name", "description"]);
  assert.deepEqual(Object.keys(parameters.properties?.meta?.properties ?? {}), [
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
    assert.ok(description.includes(helper), `description must document ${helper}`);
  }
  assert.match(description, /There is no `agent\(\)` helper\./);
  assert.match(
    description,
    /tools\.<name>\(args\)/,
    "states the binding form shared with ptc_run_code",
  );
  assert.match(description, /`meta\.phases`/);
  assert.match(description, /`args`/);
});

test("args round-trips to the program's args global", options, async () => {
  const args = { task: "write the report", nested: { count: 2 }, list: [1, "two", null, true] };
  const result = await call(
    createPtcWorkflowTool(),
    { script: "return { received: args, task: args.task };", args },
    { cwd: process.cwd() },
  );
  assert.equal(
    textOf(result),
    '{\n  "received": {\n    "task": "write the report",\n    "nested": {\n      "count": 2\n    },\n    "list": [\n      1,\n      "two",\n      null,\n      true\n    ]\n  },\n  "task": "write the report"\n}',
  );
  assert.deepEqual(result.details.result, { received: args, task: "write the report" });
});

test("args is optional: a workflow with no args sees null", options, async () => {
  const result = await call(createPtcWorkflowTool(), { script: "return args === null;" });
  assert.equal(textOf(result), "true");
});

test("non-plain-JSON args are rejected before the run is dispatched", async () => {
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
    await assert.rejects(call(tool, { script: "return 1;", args }), (error: Error) => {
      assert.equal(error.name, "TypeError", label);
      assert.match(error.message, expected, label);
      return true;
    });
  }

  // An already-aborted signal proves the ordering: args validation happens before the dispatcher
  // would have reported `code run failed (abort)`.
  await assert.rejects(
    call(tool, { script: "return 1;", args: { fn: () => 1 } }, { signal: AbortSignal.abort() }),
    (error: Error) => {
      assert.match(error.message, /args\.fn is a function/);
      return true;
    },
  );
});

test(
  "log/phase narration and console output are rendered above the return value",
  options,
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
    assert.equal(
      textOf(result),
      'Phases: Research → Write\nnarrating\nprinted\n{\n  "done": true\n}',
    );
    assert.deepEqual(result.details.phases, ["Research", "Write"]);
    assert.deepEqual(result.details.narrations, ["narrating"]);
    assert.deepEqual(result.details.logs, ["printed"]);
    assert.deepEqual(result.details.warnings, []);
  },
);

test(
  "a phase title outside meta.phases warns once instead of failing the run",
  options,
  async () => {
    const result = await call(createPtcWorkflowTool(), {
      meta: { name: "drift", description: "plan drift", phases: [{ name: "Research" }] },
      script: 'phase("Research"); phase("Publish"); phase("Publish"); return "kept";',
    });
    assert.equal(
      textOf(result),
      'Phases: Research → Publish → Publish\nkept\nWarning: phase "Publish" is not listed in meta.phases (declared: Research)',
    );
    assert.deepEqual(result.details.warnings, [
      'phase "Publish" is not listed in meta.phases (declared: Research)',
    ]);
  },
);

test("without meta.phases there is no declared plan, so phase() never warns", options, async () => {
  const result = await call(createPtcWorkflowTool(), {
    meta: { name: "undeclared", description: "no plan declared" },
    script: 'phase("Anything"); return 1;',
  });
  assert.deepEqual(result.details.warnings, []);
  assert.equal(textOf(result), "Phases: Anything\n1");
});

test("parallel() maps a failed item to null and keeps its siblings", options, async () => {
  const result = await call(createPtcWorkflowTool(), {
    script:
      'const out = await parallel([async () => "a", async () => { throw new Error("boom"); }, async () => 3]); return out;',
  });
  assert.deepEqual(result.details.result, ["a", null, 3]);
});

test(
  "pipeline() threads items through stages with the same per-item null on failure",
  options,
  async () => {
    const result = await call(createPtcWorkflowTool(), {
      script:
        'const out = await pipeline([2, 4, 6], async (n) => n * 10, async (n, item) => { if (item === 4) throw new Error("skip"); return n + item; }); return out;',
    });
    assert.deepEqual(result.details.result, [22, null, 66]);
  },
);

test("scripts are type-stripped on this surface too", options, async () => {
  const result = await call(createPtcWorkflowTool(), {
    script:
      "const total: number = 40 + 2;\nconst label = (value: number): string => `total=${value}`;\nreturn label(total);",
  });
  assert.equal(textOf(result), "total=42");
});

test("the workflow surface binds all seven built-in tools", options, async () => {
  const result = await call(createPtcWorkflowTool(), {
    script: "return Object.keys(tools).sort();",
  });
  assert.deepEqual(result.details.result, ["bash", "edit", "find", "grep", "ls", "read", "write"]);
});

test(
  "a failing workflow throws R1's failure message with phase and narration in the captured output",
  options,
  async () => {
    await assert.rejects(
      call(createPtcWorkflowTool(), {
        meta: { name: "failing", description: "fails mid-run", phases: [{ name: "Research" }] },
        script:
          'phase("Research"); log("narrating"); console.log("printed"); throw new Error("boom");',
      }),
      (error: Error) => {
        assert.equal(error.name, "CodeRunFailedError");
        assert.equal(
          error.message,
          "code run failed (exception): boom\nCaptured output:\n[phase] Research\n[log] narrating\nprinted",
        );
        return true;
      },
    );
  },
);
