/**
 * Enablement policy (T7, #21): PTC bindings mirror the session's active built-in tools.
 *
 * These cases drive the real worker through the real dispatcher — the policy is read at
 * execute time from `getBindingSourceNames`, so a restricted session must observe fewer
 * bindings (or none), and never more than it has enabled.
 */
import { expect, test } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  BUILTIN_BINDING_NAMES,
  DEFAULT_BINDING_NAMES,
  DISPATCH_BINDING_NAME,
  OPT_IN_BINDING_NAMES,
} from "../src/runtime/bindings.ts";
import {
  resolveBindingNames,
  resolveDepthFromEnv,
  resolveParentTaskIdFromEnv,
} from "../src/tools/common.ts";
import type { PtcToolDetails } from "../src/tools/common.ts";
import { createPtcRunCodeTool } from "../src/tools/run-code.ts";
import { createPtcWorkflowTool } from "../src/tools/workflow.ts";
import { RUN_TIMEOUT_MS, makeTempDir, removeTempDir, toolContext } from "./helpers/ptc.ts";

/**
 * Both registered PTC tools, because both carry a `description` the model reads and both describe
 * `tools.<name>`.
 *
 * Round 2 reworded `ptc_workflow`'s description for exactly the reason this file exists, and pinned
 * only `ptc_run_code`'s. Measured consequence of that half-pin: restoring the round-2 wording —
 * "mirror the session's enabled tools", the shape ADR-0040 §What this costs calls out as the defect —
 * left every suite green. A pin that names one of two identical-shaped surfaces is not a pin on the
 * property; it is a pin on an accident of which one somebody remembered.
 */
const PTC_TOOL_DESCRIPTIONS = [
  { tool: "ptc_run_code", description: createPtcRunCodeTool().description },
  { tool: "ptc_workflow", description: createPtcWorkflowTool().description },
] as const;

test.each(PTC_TOOL_DESCRIPTIONS)(
  "$tool's description never OFFERS a binding the default surface withholds",
  ({ tool, description }) => {
    // The registered `description` is what the model actually reads, and it is STATIC — it cannot
    // know whether this run granted an opt-in. So it may describe only what is bound by default.
    // Naming an unbound binding as something to CALL is an invitation to a call that fails; the
    // per-run truth lives on `ptcBindings`, which the description already points at. This is the
    // same failure `resolveBindingNames`'s own doc names — a surface that drops a binding while the
    // prose still advertises it — one layer out, where no test looked.
    expect(description).toMatch(/ptcBindings/); // the per-run escape hatch must stay advertised

    for (const name of OPT_IN_BINDING_NAMES) {
      // (1) never offered in callable form. The contract's shape notes are written as
      // `` `bash` rejects …`` without the `tools.` prefix and are deliberately NOT caught here:
      // they describe how a bound binding behaves, and a run that opted in still gets that shape.
      expect(description, `\`${name}\` must not be offered as a callable example`).not.toMatch(
        new RegExp(`tools\\.${name}\\b`),
      );

      // (2) never listed as part of what a default session has. The defect was prose, so pinning it
      // needs a prose-aware rule; scoping to a line that talks about the default session is what
      // makes it non-degenerate without reaching every mention of the word.
      const defaultSessionLines = description
        .split("\n")
        .filter((line) => /default session/.test(line));
      for (const line of defaultSessionLines) {
        expect(line, `\`${name}\` must not be listed as bound in a default session`).not.toContain(
          name,
        );
      }
    }

    // The floor, so deleting a tool from the table above cannot silently un-pin it — the failure
    // mode this file already lived through once, in the other direction.
    expect(description.length, `${tool} must have a description to pin`).toBeGreaterThan(0);
  },
);

test.each(PTC_TOOL_DESCRIPTIONS)(
  "$tool's description states that the bound set excludes what the install has not opted in",
  ({ tool, description }) => {
    // **The pin for the defect that actually shipped.** Round 2 reworded `ptc_workflow`'s
    // description from "the bound names mirror the session's enabled tools" to the narrowing
    // sentence, and the checks above do NOT catch the difference: the old wording neither offers
    // `tools.bash` nor claims a `default session` list, so it sails through both. Measured before
    // this line existed — restoring it left every suite green, which is how the hole survived the
    // round that introduced it.
    //
    // So the property is pinned directly, on the sentence that carries it, rather than inferred
    // from the absence of an offer. A description that stops narrowing now reds here instead of
    // quietly telling the model its bindings are whatever the session has enabled.
    const narrowing = description.split("\n").filter((line) => /opted in/.test(line));
    expect(
      narrowing.length,
      `${tool} must say the bound set excludes bindings the install has not opted in (ADR-0040 §What this costs: both model-facing surfaces had to change)`,
    ).toBeGreaterThan(0);
  },
);

test.each(PTC_TOOL_DESCRIPTIONS)(
  "every binding $tool's description shows as callable really is bound by default",
  ({ tool, description }) => {
    // The positive half, so the rule above cannot be satisfied by deleting the prose wholesale.
    //
    // Anchored on the opening paren, deliberately. The description contains prose about names that
    // is not an offer — a dotted path with no call after it, for instance. An offer is a CALL, so
    // it is `tools.<name>(`; anything without the paren is prose about a name, which the negative
    // test above already governs.
    const offered = [...description.matchAll(/tools\.([a-z][a-z0-9_]*)\s*\(/g)].map((m) => m[1]);
    for (const name of offered) {
      expect(
        [...DEFAULT_BINDING_NAMES, DISPATCH_BINDING_NAME],
        `${tool} offers tools.${name}(…), which is not bound by default`,
      ).toContain(name);
    }

    // **`ptc_workflow` offers nothing concrete, and saying so is the assertion.** Its description
    // refers the model to `ptc_run_code` for the binding list rather than repeating it, so the
    // "at least one offer" floor that keeps this test non-vacuous does not hold there — asserted
    // naively across both tools it turned this red on a fact about the product, and the obvious
    // "fix" of dropping the floor would have made the whole test an assertion-free body over an
    // empty set, which is F4 in `test-discipline.md` wearing a green tick.
    //
    // So the shape is stated instead of assumed, and both branches assert something: a tool that
    // defers MUST offer nothing (paste a concrete `tools.bash(` into it and this reds, before the
    // negative test above gets a chance), and a tool that does not defer MUST offer at least one.
    // Which branch a tool is in is visible in the failure, so a description that quietly stops
    // deferring does not silently opt out of the check.
    //
    // **One exemption, and it is the door.** ADR-0052 made the PTC door dot-accessible
    // (`tools.pi_task_ptc(...)`), so the door's call form is now something the regex can see --
    // before the rename the same sentence was written `tools["pi.dispatch"](...)` and was
    // structurally invisible to it. The door is not part of the NARROWING set the rule is about:
    // it is always bound, so naming it costs no availability promise. The narrowing set is what
    // must not be enumerated twice, and that is what the exemption leaves guarded — pasting
    // `tools.read(` into the workflow description still turns this red.
    const deferringOffers = offered.filter((name) => name !== DISPATCH_BINDING_NAME);
    const defers = description.includes("exactly as in `ptc_run_code`");
    if (defers) {
      expect(
        deferringOffers,
        `${tool} defers the binding list to ptc_run_code, so it must not offer names of its own`,
      ).toEqual([]);
    } else {
      expect(
        offered.length,
        `${tool} does not defer, so it must offer at least one callable example`,
      ).toBeGreaterThan(0);
    }
  },
);

test("resolveBindingNames intersects the active set with the built-in factories", () => {
  expect([...resolveBindingNames(undefined)]).toEqual([...DEFAULT_BINDING_NAMES]);
  expect([...resolveBindingNames([])]).toEqual([]);
  expect([...resolveBindingNames(["read", "grep"])]).toEqual(["read", "grep"]);
  expect([...resolveBindingNames(["read", "teleport", "bash"])]).toEqual(["read"]);
});

test("resolveBindingNames withholds an opt-in binding until it is granted (#73)", () => {
  // The session has `bash` enabled, and it is still withheld: enabled is not granted. These two
  // are different questions — the first is what pi has, the second is what this operator agreed to
  // hand a model-written program — and collapsing them is the whole defect this ticket fixes.
  expect(BUILTIN_BINDING_NAMES).toContain("bash");
  expect([...resolveBindingNames([...BUILTIN_BINDING_NAMES])]).not.toContain("bash");

  // Granted, it comes back in BUILTIN order — and the intersection still applies, so a session
  // without `bash` enabled does not gain it back from the opt-in.
  expect([...resolveBindingNames([...BUILTIN_BINDING_NAMES], ["bash"])]).toEqual([
    ...BUILTIN_BINDING_NAMES,
  ]);
  expect([...resolveBindingNames(["read"], ["bash"])]).toEqual(["read"]);
  expect([...resolveBindingNames(undefined, ["bash"])]).toEqual([...BUILTIN_BINDING_NAMES]);
});

test("resolveDepthFromEnv parses PI_PTC_DEPTH (positive integer; invalid or absent → 0)", () => {
  expect(resolveDepthFromEnv({ PI_PTC_DEPTH: "3" })).toBe(3);
  expect(resolveDepthFromEnv({ PI_PTC_DEPTH: "1" })).toBe(1);
  expect(resolveDepthFromEnv({})).toBe(0);
  expect(resolveDepthFromEnv({ PI_PTC_DEPTH: "x" })).toBe(0);
  expect(resolveDepthFromEnv({ PI_PTC_DEPTH: "2n" })).toBe(0);
  expect(resolveDepthFromEnv({ PI_PTC_DEPTH: "-2" })).toBe(0);
  expect(resolveDepthFromEnv({ PI_PTC_DEPTH: "0" })).toBe(0);
});

test("resolveParentTaskIdFromEnv parses PI_PTC_TASK_ID (26-char ULID; invalid or absent → undefined)", () => {
  // The ULID spec's own canonical example is an independent literal (Crockford base32, no I/L/O/U).
  const VALID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  expect(resolveParentTaskIdFromEnv({ PI_PTC_TASK_ID: VALID })).toBe(VALID);
  expect(resolveParentTaskIdFromEnv({})).toBeUndefined();
  expect(resolveParentTaskIdFromEnv({ PI_PTC_TASK_ID: "" })).toBeUndefined();
  expect(resolveParentTaskIdFromEnv({ PI_PTC_TASK_ID: "not-a-ulid" })).toBeUndefined();
  // 25 chars (truncated).
  expect(
    resolveParentTaskIdFromEnv({ PI_PTC_TASK_ID: "01ARZ3NDEKTSV4RRFFQ69G5FA" }),
  ).toBeUndefined();
  // Lowercase is not the canonical ULID encoding.
  expect(
    resolveParentTaskIdFromEnv({ PI_PTC_TASK_ID: "01arz3ndektsv4rrffq69g5fav" }),
  ).toBeUndefined();
  // 'I' is outside the Crockford alphabet.
  expect(
    resolveParentTaskIdFromEnv({ PI_PTC_TASK_ID: "01ARZ3NDEKTSV4RRFFQ69G5FAI" }),
  ).toBeUndefined();
});

function executeTool(
  tool: ToolDefinition<any, any, any>,
  code: string,
  cwd: string,
): Promise<AgentToolResult<PtcToolDetails>> {
  return tool.execute(
    "call-policy",
    { code, description: "binding policy test" },
    undefined,
    undefined,
    toolContext(cwd),
  ) as Promise<AgentToolResult<PtcToolDetails>>;
}

function textOf(result: AgentToolResult<PtcToolDetails>): string {
  return result.content
    .map((part) => {
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .join("\n");
}

test(
  "a restricted session can only reach its active tools",
  async () => {
    const dir = await makeTempDir();
    try {
      await writeFile(join(dir, "data.txt"), "policy-marker\n", "utf8");
      const tool = createPtcRunCodeTool({ getBindingSourceNames: () => ["read"] });

      const allowed = await executeTool(
        tool,
        `const r = await tools.read({ path: "data.txt" }); return r.content.map((p) => p.text ?? "").join("").trim();`,
        dir,
      );
      expect(textOf(allowed)).toBe("policy-marker");

      // The shipped surface always binds the PTC door (ADR-0016), so the curated built-in
      // list is what the restriction removes from the error message.
      await expect(
        executeTool(tool, `return await tools.write({ path: "x.txt", content: "nope" });`, dir),
      ).rejects.toThrow(/no binding named "write".*available bindings: read, pi_task_ptc/);
    } finally {
      await removeTempDir(dir);
    }
  },
  RUN_TIMEOUT_MS,
);

test(
  "an empty active set still binds the dispatch surface, and Node and console still work",
  async () => {
    const dir = await makeTempDir();
    try {
      const tool = createPtcRunCodeTool({ getBindingSourceNames: () => [] });

      await expect(
        executeTool(tool, `return await tools.read({ path: "data.txt" });`, dir),
      ).rejects.toThrow(/available bindings: pi_task_ptc/);

      const bare = await executeTool(tool, `console.log("no-tools"); return 40 + 2;`, dir);
      expect(bare.details.result).toBe(42);
      expect(textOf(bare)).toMatch(/no-tools/);
    } finally {
      await removeTempDir(dir);
    }
  },
  RUN_TIMEOUT_MS,
);

/**
 * The end-to-end half of #73: the gate is observed by a REAL program running in a REAL worker, not
 * only by the table object.
 *
 * Both halves run the same program against the same tool with the same fully-enabled session. The
 * only difference is whether an opt-in was granted. That is what makes this a counterfactual rather
 * than two unrelated tests: a session with every pi builtin enabled is the strongest case for bash
 * being available, so if the gate can be defeated anywhere it is defeated here. The success half
 * matters as much as the refusal — an implementation that simply broke `tools.bash` would pass a
 * refusal-only test, and would ship a PTC surface with no shell for the programs that asked for one.
 */
test(
  "bash is refused in a fully-enabled session until it is opted in, then it really runs",
  async () => {
    const dir = await makeTempDir();
    try {
      const enabled = () => [...BUILTIN_BINDING_NAMES];

      const withheld = createPtcRunCodeTool({ getBindingSourceNames: enabled });
      await expect(
        executeTool(withheld, `return await tools.bash({ command: "echo pwned" });`, dir),
      ).rejects.toThrow(/no binding named "bash"/);

      // The refusal must name what IS available, or a program that legitimately wanted a shell has
      // no way to learn that the way to get one is a config key rather than a different tool.
      await expect(
        executeTool(withheld, `return await tools.bash({ command: "echo pwned" });`, dir),
      ).rejects.toThrow(/available bindings: read, edit, write, grep, find, ls, pi_task_ptc/);

      const granted = createPtcRunCodeTool({
        getBindingSourceNames: enabled,
        getOptInBindings: () => ["bash"],
      });
      const ran = await executeTool(
        granted,
        `return await tools.bash({ command: "echo granted" });`,
        dir,
      );
      expect(textOf(ran)).toMatch(/granted/);
    } finally {
      await removeTempDir(dir);
    }
  },
  RUN_TIMEOUT_MS,
);
