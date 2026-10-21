/**
 * The prose the package actually registers, built through the tool factories.
 *
 * ## Why this is a helper and not a copy of the registry
 *
 * Two suites need the same observation and need it to be the SAME observation:
 * the registry's own tests (`tests/unit/route-registry.test.ts`) and the
 * forcing-point suite (`tests/unit/route-forcing-points.test.ts`). What they
 * both need is what the model reads about a tool — the description, the
 * snippet and the guidelines — as the package BUILDS it, which is a different
 * code path from the registry that produced it.
 *
 * Reading the registry's own entries would compare the registry with itself,
 * and a registry that drifted would drift on both sides at once.
 *
 * Nothing here ends in `.test.ts`, so the suite runner never picks it up as a
 * suite of its own.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import {
  PTC_CHILD_SEARCH_NOTE,
  type DescriptionParagraph,
  type DescriptionSlot,
  type ToolEntry,
  type ToolName,
} from "../../src/routes/registry.ts";

/** The model's copy of a tool's prose, as pi's tool definition carries it. */
export interface ToolProse {
  readonly description: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
}

/** Read the three fields off a tool definition without caring about its parameter types. */
export function proseOf(tool: {
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
export function ownParagraphs(entry: ToolEntry): string[] {
  return entry.description
    .filter((part): part is Extract<DescriptionParagraph, { kind: "text" }> => part.kind === "text")
    .map((part) => part.text);
}

/** Every text block of a tool's description, in the order the model reads them. */
export function blocks(description: string): string[] {
  return description.split("\n\n");
}

/**
 * The sentences inside one paragraph.
 *
 * A copy of a whole paragraph is the drift the one-home rule exists to catch;
 * a copy of ONE SENTENCE is the same drift with less of it, and it is just as
 * invisible when the model reads the two surfaces. So the scan looks for both:
 * the paragraph, and each of its sentences.
 *
 * The split is deliberately crude — a period followed by a space and a capital
 * letter, or a period at the end. A period inside an abbreviation ("e.g.") does
 * not split, because the next character is not a capital; that is a false
 * negative in the splitter, not in the guard, and the paragraph-level check
 * still covers the whole text.
 */
export function sentencesOf(paragraph: string): string[] {
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
export interface BuiltTools {
  readonly prose: ReadonlyMap<ToolName, ToolProse>;
  readonly filled: ReadonlyMap<ToolName, Partial<Record<DescriptionSlot, string>>>;
  /** The tool definitions themselves, so a schema can be read off the same build. */
  readonly raw: ReadonlyMap<ToolName, unknown>;
}

/**
 * Build one tool of each kind, so the registry can be compared against what the
 * package actually registers.
 *
 * The factories are used rather than the extension's registration, because two
 * of these tools are registered only where the session cannot see them
 * (`web_ds_search` lives in the child; `pi_task_codemode` is the codemode
 * door). The prose is the same either way, and the factories are the seam that
 * builds it.
 *
 * The agent directories are EMPTY temp dirs, wired through the `homeDir` seam
 * rather than by mutating `process.env` — a test that could see the
 * developer's real agents would pass or fail depending on whose machine it ran
 * on.
 */
export async function buildTools(childCanSearch = false): Promise<BuiltTools> {
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
    const raw = new Map<ToolName, unknown>([
      ["ptc_run_code", createPtcRunCodeTool({ childCanSearch })],
      ["ptc_workflow", createPtcWorkflowTool({ childCanSearch })],
      ["pi_task_codemode", createPtcSubagentTool(agentOptions)],
      ["ptc_task_list", createPtcTaskListTool(registry)],
      ["ptc_task_output", createPtcTaskOutputTool(registry, outputs)],
      ["ptc_task_stop", createPtcTaskStopTool(registry, lifecycle)],
      ["ptc_child_report", createChildReportTool(true)],
      [
        "web_ds_search",
        createWebDsSearchTool({
          deps: { quota: createSearchQuota({ maxCallsPerSession: 0 }), maxCallsPerSession: 0 },
          unavailable: false,
        }),
      ],
    ]);
    const prose = new Map<ToolName, ToolProse>(
      [...raw].map(([name, tool]) => [name, proseOf(tool as Parameters<typeof proseOf>[0])]),
    );
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
    return { prose, filled, raw };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
