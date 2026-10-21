/**
 * The route registry: the ONE home for the model-facing prose (ticket #243).
 *
 * ## What this file guards
 *
 * The registry exists because a sentence that two surfaces need, written twice, drifts. The
 * inventory that motivated it found three such pairs already drifting in this package. So this
 * file pins three properties, and each one has a counterfactual:
 *
 * 1. **A tool's prose comes from the registry.** The registered description, snippet and
 *    guidelines are the registry's entry, rendered. Counterfactual: write the description
 *    literally in the tool file again — this goes red, because the rendered tool no longer
 *    equals the rendered registry.
 * 2. **No tool file holds a copy of the registry's prose.** Counterfactual: paste a registry
 *    paragraph into a tool file "just this once" — this goes red, because the source now
 *    contains the sentence the registry already owns.
 * 3. **A sentence two surfaces carry is ONE constant.** The three duplicates the inventory
 *    found, plus the sentences the package already shared, are asserted on BOTH sides. The
 *    counterfactual is the drift itself: reword one side in place and the other side's
 *    assertion goes red.
 *
 * ## The expectations come from where
 *
 * The expected values are the registry's own entries and the tool definitions the factories
 * build — two different code paths. The comparison is between what the TOOL renders and what
 * the REGISTRY says, so neither side can be wrong alone. The source scan's expected value is
 * the file system itself: the sentence must not be there.
 */
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  AGENT_OPTIONAL_CLAUSE,
  CHILD_REPORT_DESCRIPTION,
  IMAGE_HOISTING_NOTE,
  PROGRAM_BODY_DESCRIPTION,
  PTC_CHILD_SEARCH_NOTE,
  PTC_TASK_TOOL_GUIDELINES,
  PTC_TOOL_GUIDELINES,
  PTC_TRUNCATED_NO_NEW_TASK,
  PTC_TRUNCATED_SECTION_LINE,
  PTC_TRUNCATION_SECTION_LINES,
  renderDescription,
  ROUTES,
  TASK_DOOR_RESULT_NOTE,
  TASK_STOP_SEMANTICS,
  TOOLS,
  WHY_SUPPRESSED_DESCRIPTION,
  type DescriptionParagraph,
  type DescriptionSlot,
  type ToolEntry,
  type ToolName,
} from "../../src/routes/registry.ts";
import { BINDING_CONTRACT } from "../../src/tools/binding-contract.ts";
import { createPtcRunCodeTool } from "../../src/tools/run-code.ts";
import { createPtcWorkflowTool } from "../../src/tools/workflow.ts";
import { createPtcSubagentTool } from "../../src/tools/subagent.ts";
import {
  createPtcTaskListTool,
  createPtcTaskOutputTool,
  createPtcTaskStopTool,
} from "../../src/tools/ptc-task.ts";
import { createChildReportTool } from "../../src/tools/child-report-tool.ts";
import { createWebDsSearchTool } from "../../src/tools/web-ds-search.ts";
import { createSearchQuota } from "../../src/search/quota.ts";
import { describeRegisteredAgentRoster } from "../../src/runtime/dispatch.ts";
import { createTaskRegistry } from "../../src/runtime/task-registry.ts";
import { InMemoryTaskStorage } from "../../src/runtime/task-storage.ts";
import { InMemoryOutputStorage } from "../../src/runtime/output-storage.ts";
import { MockChildProcessLifecycle } from "../../src/runtime/child-process-lifecycle.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..");

/** The model's copy of a tool's prose, as pi's tool definition carries it. */
interface ToolProse {
  readonly description: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
}

/** Read the three fields off a tool definition without caring about its parameter types. */
function proseOf(tool: {
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: readonly string[];
}): ToolProse {
  return {
    description: tool.description ?? "",
    ...(tool.promptSnippet === undefined ? {} : { promptSnippet: tool.promptSnippet }),
    ...(tool.promptGuidelines === undefined ? {} : { promptGuidelines: tool.promptGuidelines }),
  };
}

/** The registry's own paragraphs — the text it owns, with no slot in it. */
function ownParagraphs(entry: ToolEntry): string[] {
  return entry.description
    .filter((part): part is Extract<DescriptionParagraph, { kind: "text" }> => part.kind === "text")
    .map((part) => part.text);
}

/** Every text block of a tool's description, in the order the model reads them. */
function blocks(description: string): string[] {
  return description.split("\n\n");
}

/**
 * The sentences inside one paragraph.
 *
 * A copy of a whole paragraph is the drift this file exists to catch; a copy of ONE SENTENCE is
 * the same drift with less of it, and it is just as invisible when the model reads the two
 * surfaces. So the scan looks for both: the paragraph, and each of its sentences.
 *
 * The split is deliberately crude — a period followed by a space and a capital letter, or a
 * period at the end. A period inside an abbreviation ("e.g.") does not split, because the next
 * character is not a capital; that is a false negative in the splitter, not in the guard, and the
 * paragraph-level check still covers the whole text.
 */
function sentencesOf(paragraph: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let index = 0; index < paragraph.length; index += 1) {
    const char = paragraph[index];
    if (char !== "." && char !== "!" && char !== "?") continue;
    const rest = paragraph.slice(index + 1);
    if (rest.startsWith(" ") && /^[A-Z`]/.test(rest.slice(1))) {
      out.push(paragraph.slice(start, index + 1));
      start = index + 2;
    }
  }
  if (start < paragraph.length) out.push(paragraph.slice(start));
  return out;
}

/** What one build produced: the prose each tool renders, and the slots that were filled. */
interface BuiltTools {
  readonly prose: ReadonlyMap<ToolName, ToolProse>;
  readonly filled: ReadonlyMap<ToolName, Partial<Record<DescriptionSlot, string>>>;
}

/**
 * Build one tool of each kind, so the registry can be compared against what the package
 * actually registers.
 *
 * The factories are used rather than the extension's registration, because two of these tools
 * are registered only where the session cannot see them (`web_ds_search` lives in the child;
 * `pi_task_codemode` is the codemode door). The prose is the same either way, and the
 * factories are the seam that builds it.
 *
 * The agent directories are EMPTY temp dirs, wired through the `homeDir` seam rather than by
 * mutating `process.env` — a test that could see the developer's real agents would pass or
 * fail depending on whose machine it ran on.
 */
async function buildTools(childCanSearch = false): Promise<BuiltTools> {
  const root = await mkdtemp(join(tmpdir(), "ptc-registry-"));
  const home = join(root, "home");
  const project = join(root, "project");
  await mkdir(join(home, ".pi", "agent", "agents"), { recursive: true });
  await mkdir(join(project, ".pi", "agents"), { recursive: true });
  try {
    const registry = createTaskRegistry(new InMemoryTaskStorage(), { clock: () => 1_000 });
    const outputs = new InMemoryOutputStorage();
    const lifecycle = new MockChildProcessLifecycle();
    const agentOptions = {
      cwd: project,
      depth: 0,
      maxDispatchDepth: 3,
      homeDir: home,
    };
    const roster = describeRegisteredAgentRoster({
      cwd: project,
      agentScope: "both",
      homeDir: home,
    });
    const prose = new Map<ToolName, ToolProse>([
      ["ptc_run_code", proseOf(createPtcRunCodeTool({ childCanSearch }))],
      ["ptc_workflow", proseOf(createPtcWorkflowTool({ childCanSearch }))],
      ["pi_task_codemode", proseOf(createPtcSubagentTool(agentOptions))],
      ["ptc_task_list", proseOf(createPtcTaskListTool(registry))],
      ["ptc_task_output", proseOf(createPtcTaskOutputTool(registry, outputs))],
      ["ptc_task_stop", proseOf(createPtcTaskStopTool(registry, lifecycle))],
      ["ptc_child_report", proseOf(createChildReportTool(true))],
      [
        "web_ds_search",
        proseOf(
          createWebDsSearchTool({
            deps: { quota: createSearchQuota({ maxCallsPerSession: 0 }), maxCallsPerSession: 0 },
            unavailable: false,
          }),
        ),
      ],
    ]);
    const filled = new Map<ToolName, Partial<Record<DescriptionSlot, string>>>([
      [
        "ptc_run_code",
        {
          bindingContract: BINDING_CONTRACT,
          ...(childCanSearch ? { childSearchNote: PTC_CHILD_SEARCH_NOTE } : {}),
        },
      ],
      ["ptc_workflow", { bindingContract: BINDING_CONTRACT }],
      ["pi_task_codemode", { agentRoster: roster }],
      ["ptc_task_list", {}],
      ["ptc_task_output", {}],
      ["ptc_task_stop", {}],
      ["ptc_child_report", {}],
      ["web_ds_search", {}],
    ]);
    return { prose, filled };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("the route registry holds the model-facing prose", () => {
  test("a tool's description, snippet and guidelines ARE the registry's entry", async () => {
    // The forcing point the ticket names: the tool's three blocks must be a CALL to the
    // registry, not a copy of it.
    //
    // Counterfactual: write the description literally in the tool file again (a copy the
    // registry never sees) — the rendered tool stops equalling the rendered registry, and this
    // goes red. The other direction is guarded too: the registry's own paragraphs are checked
    // to be present, so a renderer that silently dropped one cannot make the comparison vacuous.
    const built = await buildTools();
    for (const [name, entry] of Object.entries(TOOLS) as [ToolName, ToolEntry][]) {
      const prose = built.prose.get(name);
      expect(prose, `${name} is built by a factory`).toBeDefined();
      const registered = prose as ToolProse;
      expect(registered.promptSnippet, `${name}'s snippet`).toBe(entry.snippet);
      expect(registered.promptGuidelines, `${name}'s guidelines`).toEqual([...entry.guidelines]);
      // The comparison is EXACT, not a containment: a tool that added a sentence of its own
      // would still contain every registry paragraph, and would still be prose in two places —
      // the registry's and the tool's. So the tool's description must BE the registry's rendering.
      expect(
        registered.description,
        `${name}'s description is the registry's rendering, word for word`,
      ).toBe(renderDescription(entry, built.filled.get(name) ?? {}));
      for (const paragraph of ownParagraphs(entry)) {
        expect(registered.description, `${name} carries the registry's paragraph`).toContain(
          paragraph,
        );
      }
    }
  });

  test("the registry's paragraphs are in the order the model reads them", async () => {
    // The order is part of the prose: the binding contract sits between "how to call" and
    // "what comes back", and a description whose paragraphs were reordered reads differently.
    //
    // Counterfactual: swap two paragraphs in the registry — the indices stop increasing and
    // this goes red.
    const built = await buildTools();
    for (const [name, entry] of Object.entries(TOOLS) as [ToolName, ToolEntry][]) {
      const description = (built.prose.get(name) as ToolProse).description;
      let previous = -1;
      for (const paragraph of ownParagraphs(entry)) {
        const at = description.indexOf(paragraph, previous + 1);
        expect(at, `${name} keeps the registry's paragraph order`).toBeGreaterThan(previous);
        previous = at;
      }
    }
  });

  test("no tool file holds a copy of the registry's prose", () => {
    // The one-home property, mechanically: the sentence lives in the registry, so the module
    // that used to hold it must not hold it any more.
    //
    // Counterfactual: paste a registry paragraph into `src/tools/subagent.ts` — the source now
    // contains a sentence the registry already owns, and this goes red.
    const files = [
      "src/tools/common.ts",
      "src/tools/run-code.ts",
      "src/tools/workflow.ts",
      "src/tools/subagent.ts",
      "src/tools/ptc-task.ts",
      "src/tools/child-report-tool.ts",
      "src/tools/web-ds-search.ts",
      "src/tools/binding-contract.ts",
      "src/mode/dispatch-section.ts",
      "src/mode/ptc-mode.ts",
      "src/search/contract.ts",
    ];
    const sentences: string[] = [];
    for (const entry of Object.values(TOOLS)) {
      for (const paragraph of ownParagraphs(entry)) {
        if (paragraph.length >= 40) sentences.push(paragraph);
        for (const sentence of sentencesOf(paragraph)) {
          if (sentence.length >= 60) sentences.push(sentence);
        }
      }
      for (const guideline of entry.guidelines) {
        if (guideline.length >= 40) sentences.push(guideline);
      }
    }
    // The ROUTES zone is the registry's prose too: a road's `when`, its per-surface `how` and its
    // `fact` are all sentences the model reads, and the mode briefing used to carry its own copy
    // of the routing half (ADR-0061).
    for (const road of ROUTES) {
      if (road.when.length >= 40) sentences.push(road.when);
      for (const how of Object.values(road.how)) {
        if (how.length >= 40) sentences.push(how);
      }
      for (const sentence of sentencesOf(road.fact)) {
        if (sentence.length >= 60) sentences.push(sentence);
      }
    }
    for (const shared of [
      AGENT_OPTIONAL_CLAUSE,
      PROGRAM_BODY_DESCRIPTION,
      WHY_SUPPRESSED_DESCRIPTION,
      IMAGE_HOISTING_NOTE,
      PTC_CHILD_SEARCH_NOTE,
      TASK_DOOR_RESULT_NOTE,
      TASK_STOP_SEMANTICS,
      CHILD_REPORT_DESCRIPTION,
      PTC_TRUNCATED_NO_NEW_TASK,
      PTC_TRUNCATED_SECTION_LINE,
      ...PTC_TOOL_GUIDELINES,
      ...PTC_TASK_TOOL_GUIDELINES,
      ...Object.values(PTC_TRUNCATION_SECTION_LINES),
    ]) {
      if (shared.length >= 40) sentences.push(shared);
    }
    // The scan is only meaningful if it has something to look for.
    expect(sentences.length, "the registry holds a scan-worthy corpus").toBeGreaterThanOrEqual(30);
    for (const file of files) {
      const source = readFileSync(join(REPO_ROOT, file), "utf8");
      for (const sentence of sentences) {
        expect(
          source.includes(sentence),
          `${file} must not carry a copy of the registry's prose`,
        ).toBe(false);
      }
    }
  });

  test("the three duplicated sentences are ONE constant, carried by both sides", async () => {
    // The three the inventory found. Each was a fix made once and copied, which is the shape
    // that drifts.
    //
    // Counterfactual: reword ONE side in place (the agent clause in the workflow description
    // only, the program-body sentence in one parameter schema only, the whySuppressed text in
    // one output schema only) — the other side's assertion goes red.
    const built = await buildTools();
    const runCode = (built.prose.get("ptc_run_code") as ToolProse).description;
    const workflow = (built.prose.get("ptc_workflow") as ToolProse).description;
    expect(runCode, "ptc_run_code carries the agent clause").toContain(AGENT_OPTIONAL_CLAUSE);
    expect(workflow, "ptc_workflow carries the agent clause").toContain(AGENT_OPTIONAL_CLAUSE);

    const runCodeParams = createPtcRunCodeTool().parameters as unknown as {
      properties?: Record<string, { description?: string }>;
    };
    const workflowParams = createPtcWorkflowTool().parameters as unknown as {
      properties?: Record<string, { description?: string }>;
    };
    expect(runCodeParams.properties?.code?.description, "the program's own description").toBe(
      PROGRAM_BODY_DESCRIPTION,
    );
    expect(workflowParams.properties?.script?.description, "the script's own description").toBe(
      PROGRAM_BODY_DESCRIPTION,
    );

    const codemode = createPtcSubagentTool({
      cwd: REPO_ROOT,
      depth: 0,
      maxDispatchDepth: 3,
    }) as unknown as { outputSchema?: { properties?: Record<string, { description?: string }> } };
    const taskOutput = createPtcTaskOutputTool(
      createTaskRegistry(new InMemoryTaskStorage(), { clock: () => 1_000 }),
      new InMemoryOutputStorage(),
    ) as unknown as { outputSchema?: { properties?: Record<string, { description?: string }> } };
    expect(
      codemode.outputSchema?.properties?.whySuppressed?.description,
      "the codemode door's why_suppressed",
    ).toBe(WHY_SUPPRESSED_DESCRIPTION);
    expect(
      taskOutput.outputSchema?.properties?.why_suppressed?.description,
      "the task output's why_suppressed",
    ).toBe(WHY_SUPPRESSED_DESCRIPTION);
  });

  test("every sentence two surfaces carry reaches BOTH of them", async () => {
    // The shared sentences that were already one constant before this ticket, and the ones
    // that became one because of it. The registry owns the copy; these assertions say the two
    // surfaces still carry it.
    //
    // Counterfactual: drop the image contract from the workflow description — the workflow half
    // goes red; the run_code half stays green, which is exactly the drift this catches.
    const built = await buildTools();
    const runCode = (built.prose.get("ptc_run_code") as ToolProse).description;
    const workflow = (built.prose.get("ptc_workflow") as ToolProse).description;
    expect(runCode, "ptc_run_code carries the image contract").toContain(IMAGE_HOISTING_NOTE);
    expect(workflow, "ptc_workflow carries the image contract").toContain(IMAGE_HOISTING_NOTE);

    // The web sentence reaches the PTC descriptions only in a session whose children can
    // search — so this reads the tools built WITH that capability, not the ones built without.
    const searching = await buildTools(true);
    const searchingRunCode = (searching.prose.get("ptc_run_code") as ToolProse).description;
    expect(searchingRunCode, "ptc_run_code carries the web sentence").toContain(
      PTC_CHILD_SEARCH_NOTE,
    );

    expect(BINDING_CONTRACT, "the binding contract carries the door note").toContain(
      TASK_DOOR_RESULT_NOTE,
    );
    const codemodeDescription = (built.prose.get("pi_task_codemode") as ToolProse).description;
    expect(codemodeDescription, "the codemode door carries the door note").toContain(
      TASK_DOOR_RESULT_NOTE,
    );

    const stopProse = built.prose.get("ptc_task_stop") as ToolProse;
    expect(stopProse.description, "the stop tool's description").toContain(TASK_STOP_SEMANTICS);
    expect(stopProse.promptGuidelines ?? [], "the stop tool's guidelines").toContain(
      `Use ptc_task_stop to stop a task: ${TASK_STOP_SEMANTICS}`,
    );
  });

  test("no description says sandbox", () => {
    // ADR-0007: this package ships no OS sandbox. A description that says "sandbox" would
    // promise a boundary that is not here — pi's `codemode` sandbox is the host's, and the
    // word for it is "`codemode` script".
    //
    // Counterfactual: write "the sandbox" into a description — this goes red.
    for (const entry of Object.values(TOOLS)) {
      for (const paragraph of ownParagraphs(entry)) {
        expect(paragraph, "a description never says sandbox").not.toMatch(/sandbox/i);
      }
      expect(entry.snippet, "a snippet never says sandbox").not.toMatch(/sandbox/i);
      for (const guideline of entry.guidelines) {
        expect(guideline, "a guideline never says sandbox").not.toMatch(/sandbox/i);
      }
    }
  });

  test("the registry's entries name the tools the package registers", () => {
    // A registry entry that names a tool nobody registers is a promise the model cannot keep.
    //
    // Counterfactual: rename an entry's key — the entry stops naming itself, and this goes red.
    for (const [name, entry] of Object.entries(TOOLS) as [ToolName, ToolEntry][]) {
      expect(entry.name, `${name} names itself`).toBe(name);
    }
    // `pi_task_ptc` is a binding, not a declared tool: the model only ever sees it inside a
    // program, so it has no description of its own to register.
    expect(Object.keys(TOOLS)).not.toContain("pi_task_ptc");
  });

  test("the ROUTES zone exists, and every entry in it is a whole road", () => {
    // The zone and its type are this ticket's; the entries are #246's. The shape is pinned now
    // so #246 fills a road rather than inventing one: a road with no facts, no `how` for some
    // surface, or no detail pointer is not a road.
    //
    // The zone is empty in this ticket, so this assertion is also the place that says so
    // out loud — a reader of the test sees that the zone exists and is not yet filled.
    expect(Array.isArray(ROUTES), "the routes zone is an array").toBe(true);
    const surfaces = ["full_ptc", "codemode_ptc"];
    for (const route of ROUTES) {
      expect(route.id, "a road has an id").not.toBe("");
      expect(route.name, "a road has a name").not.toBe("");
      expect(route.when, "a road says when to take it").not.toBe("");
      expect(route.fact, "a road carries facts").not.toBe("");
      expect(route.detail, "a road points at its detail file").not.toBe("");
      for (const surface of surfaces) {
        expect(
          route.how[surface as "full_ptc" | "codemode_ptc"],
          `${surface} is answered`,
        ).not.toBe("");
      }
    }
  });

  test("the registry renders a description from its paragraphs, and drops an unfilled slot", () => {
    // The division of labour the registry exists for: the registry owns the ORDER and the
    // TEXT, and a caller says which paragraphs this session has. A slot with no entry is left
    // out — "this session has no web tool" is the absence of the sentence, not a sentence
    // saying so.
    //
    // Counterfactual: a renderer that keeps an unfilled slot (as an empty string) would leave
    // a blank line in the middle of the description — the block count goes up and this goes red.
    const entry = TOOLS.ptc_run_code;
    const base = renderDescription(entry, { bindingContract: BINDING_CONTRACT });
    const withNote = renderDescription(entry, {
      bindingContract: BINDING_CONTRACT,
      childSearchNote: PTC_CHILD_SEARCH_NOTE,
    });
    expect(blocks(withNote).length, "the filled slot adds one block").toBe(blocks(base).length + 1);
    expect(withNote.endsWith(PTC_CHILD_SEARCH_NOTE), "the note is the last block").toBe(true);
    expect(base.includes(PTC_CHILD_SEARCH_NOTE), "the unfilled slot carries nothing").toBe(false);
  });

  test("the codemode door's roster is the session's own, appended after the registry's prose", async () => {
    // The roster is the one slot whose text is NOT in the registry: it is rendered from the
    // live agent files, so it is a fact about this install rather than about the tool. The
    // registry's static prose still comes first, and the roster still reaches the model.
    //
    // Counterfactual: a registry entry that swallowed the roster (or the tool that dropped it)
    // changes the block count, and this goes red.
    const built = await buildTools();
    const description = (built.prose.get("pi_task_codemode") as ToolProse).description;
    const base = renderDescription(TOOLS.pi_task_codemode);
    expect(description.startsWith(base), "the registry's prose leads").toBe(true);
    const roster = (built.filled.get("pi_task_codemode") ?? {})["agentRoster"];
    expect(roster, "the roster was filled for this session").toBeDefined();
    expect(
      description.endsWith(roster as string),
      "the roster is the session's own last block",
    ).toBe(true);
  });
});
