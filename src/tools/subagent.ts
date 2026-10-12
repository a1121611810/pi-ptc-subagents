/**
 * `ptc_subagent` (ADR-0025): the top-level face for spawning a fresh pi subprocess.
 *
 * Why it exists: the parallel binding `pi.dispatch` can only be reached from *inside* a PTC
 * program. A session that hands orchestration to pi's `codemode` can dispatch -- the pair sits at
 * `codemode` reach underneath that script -- but it has to write the script first. This is that
 * way in with no script at all, which is the whole of the difference.
 *
 * Layering, per spec decision 9: this tool is a front and owns no lifecycle. It builds the
 * same DispatchContext the binding builds and calls the same `dispatch()`. Depth, concurrency,
 * the six-state task record and `ptc_task_*` visibility all come from the dispatcher, so a
 * fix in one place fixes both call sites. The one thing it adds is a difference the binding
 * could not have: a refused call surfaces as a tool error rather than as a DispatchResult the
 * model has to learn to read.
 *
 * The argument schema is the binding's own, imported -- not a second copy that could drift.
 * A test pins the two key sets equal.
 *
 * The RESULT is declared twice, on purpose: `content` is what a model reads, `structuredContent`
 * is what a codemode script reads. A script dispatching through `ptc_run_code` reads its own result
 * over there instead, so this second channel is for the direct call -- and without it that caller
 * has to regex the ULID out of `"Started background task 01JABC..."`. See
 * {@link SUBAGENT_OUTPUT_SCHEMA} for why that projection is not a mirror of `details`.
 *
 * A dispatched child also produces a **child report** (ADR-0032). It is rendered into the text the
 * model reads -- see `renderChildReportText` -- with the report key in {@link SUBAGENT_OUTPUT_SCHEMA}
 * for callers that have a structured channel. (ADR-0032 once argued this surface had no
 * `codemode` and therefore no reader for `structuredContent`; as of 2026-10-09 `subagents` ships
 * `codemode` and this tool is `direct`, so a script reaches the structured side through
 * `ctx.executeTool()`. The rendering below is unchanged and is what the model reads either way.)
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TArray, TNumber, TObject, TOptional, TString } from "typebox";
import { DISPATCH_PARAMETERS } from "../runtime/bindings.ts";
import type { DispatchDeps, DispatchInput, DispatchResult } from "../runtime/dispatch.ts";
import { dispatch, describeRegisteredAgentRoster } from "../runtime/dispatch.ts";
import type { DispatchHandle } from "../runtime/task-registry.ts";
import type { ULID } from "../runtime/task-storage.ts";
import { renderChildReportText } from "./render.ts";

/** Anything this module returns is one of the two dispatch shapes. */
export type SubagentOutcome = DispatchResult | DispatchHandle;

export interface CreatePtcSubagentToolOptions {
  /** Run cwd; the `cwd` default for a spawn that does not name one. */
  cwd: string;
  /** Depth of the calling run: 0 at the parent turn, 1+ inside a `pi.dispatch` child. */
  depth: number;
  /** Recursion ceiling; the same one the binding's call is checked against (ADR-0016). */
  maxDispatchDepth: number;
  /** This pi process's own task id, when it was itself spawned (ADR-0022 section 3). */
  parentTaskId?: ULID;
  /** Session-scoped deps, so a background spawn lands in the session registry. */
  getDispatchDeps?: () => DispatchDeps;
  /**
   * Scope the roster in the tool description is built from. Defaults to `"both"` because the
   * roster's job is to show what the model COULD dispatch, and a dispatch may still narrow the
   * scope per call — the description labels each agent, so a narrower call is informed.
   */
  agentRosterScope?: "user" | "project" | "both";
  /** Overrides `os.homedir()` when building the roster. Tests only. */
  homeDir?: string;
}

/**
 * The tool's registered name, in one place.
 *
 * It had a second consumer until #187: `session_start` asked "does this surface register
 * `ptc_subagent`?" before reporting on agent availability, and that check was the reason the
 * string could not be spelled twice — a rename that updated the registration but not the check
 * would have left a notice describing a tool the session does not have. The check went with the
 * notice it fed.
 *
 * It stays a constant rather than being inlined even though the registration is now its only
 * production reader: a test pins it as the tool's public name, and the next cross-module reference
 * to that name should not have to re-introduce one.
 */
export const SUBAGENT_TOOL_NAME = "ptc_subagent";

const HANDLE_TEXT = "Started background task ";

/** One shape for both dispatch outcomes, so the tool's result type has a single form. */
export interface SubagentDetails {
  /** The background task's id; set only for a background spawn. */
  taskId: string | undefined;
  /** `background` when the call returned a handle, else the dispatcher's own status. */
  status: string;
  /** The child's exit code; undefined for a background spawn that has not finished. */
  exitCode: number | undefined;
}
export type AnyTool = ToolDefinition<any, any, any>;

/** Written out explicitly for `isolatedDeclarations`, as `DISPATCH_PARAMETERS` is. */
type SubagentOutputSchema = TObject<{
  task_id: TOptional<TString>;
  status: TString;
  exit_code: TOptional<TNumber>;
  report_channel: TString;
  report: TOptional<SubagentReportSchema>;
}>;

/**
 * The child report as the projection carries it (ADR-0032 §`child report`).
 *
 * Structurally identical to `ChildReport` — `summary` / `findings[{what,evidence}]` /
 * `files_touched` / `usage` — and named apart from it so the two can be held together in one
 * direction only. Nothing rebuilds a report here: the value is `DispatchResult.report` verbatim,
 * host-stamped `usage` and all, because a child cannot measure its own tokens (see
 * `ChildReportPayload`).
 *
 * A `type` alias rather than an `interface`: `structuredContent` has to satisfy
 * `JsonObject`'s `[key: string]: JsonValue` index signature, and only an object TYPE gets the
 * implicit one an interface never has.
 */
type SubagentReportProjection = {
  summary: string;
  findings: { what: string; evidence: string }[];
  files_touched: string[];
  usage: { input: number; output: number; cost: number; turns: number };
};

/** The report half of the declared schema; see `SUBAGENT_OUTPUT_SCHEMA`. */
type SubagentReportSchema = TObject<{
  summary: TString;
  findings: TArray<TObject<{ what: TString; evidence: TString }>>;
  files_touched: TArray<TString>;
  usage: TObject<{
    input: TNumber;
    output: TNumber;
    cost: TNumber;
    turns: TNumber;
  }>;
}>;

/**
 * What `structuredContent` may be: one branch per dispatch outcome, and NO key is optional.
 *
 * The branches are written out rather than declared as `{ task_id?: string; ... }` for a concrete
 * reason, not a stylistic one. An optional property has type `string | undefined`, which is not a
 * `JsonValue`, so `AgentToolResult.structuredContent?: JsonValue` rejects it -- and so does an
 * optional-shaped union, because TypeScript normalises the union of two object literals by adding
 * `?: undefined` to whichever key the other branch lacks. Naming the branches keeps every property
 * present, which is also what makes "this key is absent" a property of the VALUE rather than of a
 * type.
 *
 * The status-only branch is defensive: `DispatchResult.exitCode` is a required `number`, so a
 * foreground outcome always carries one. `SubagentDetails.exitCode` is not required, and this
 * projection reads the details rather than the outcome, so the no-exit-code case is spelled out
 * rather than assumed away.
 *
 * `report` is a fourth branch rather than a key on the other three for the same reason: the key is
 * ABSENT whenever the child produced no report, and a background handle has not finished yet, so
 * neither of those outcomes has a report to carry.
 */
type SubagentStructuredContent =
  | { task_id: string; status: string; report_channel: string }
  | { status: string; exit_code: number; report_channel: string }
  | { status: string; report_channel: string }
  | {
      status: string;
      exit_code: number;
      report_channel: string;
      report: SubagentReportProjection;
    };

/**
 * The machine-readable result, declared as the tool's `outputSchema` so pi hands a codemode script
 * this object *instead of* the text block (`ToolDefinition.outputSchema`: "codemode scripts then
 * receive it instead of the text content"). It never reaches the model: `structuredContent` is
 * documented as not sent to the model, so declaring it changes nothing for a direct tool call.
 *
 * NOT a mirror of {@link SubagentDetails}. `details` is the TUI's structure and can hold `undefined`;
 * `structuredContent` is JSON, and `JsonValue` has no `undefined` -- so the half of each outcome
 * that does not apply is OMITTED rather than set. That omission IS the contract: `task_id` present
 * means "here is a handle, poll it", `exit_code` present means "this one already ran to completion",
 * and a script can tell the two apart without parsing a word of the text.
 *
 * snake_case, like pi's own builtin tools, so a script reading our declared schema does not have to
 * learn a second spelling for the same concept. `details` keeps its camelCase: it is a different
 * channel with its own consumers.
 *
 * `report` is the child report (ADR-0032) at FULL length, not the rendered view: a program is not a
 * display surface, and the 20-finding bound is a rendering bound, applied in the text block by
 * `renderChildReportText`. Absent when no report arrived -- including on a background handle, which
 * has not finished and therefore has nothing to report yet.
 *
 * `report_channel` is projected, and it is present on EVERY branch rather than alongside `report`.
 * Without it a caller reading this channel cannot tell a child that ignored the contract from a
 * handle that has not finished yet -- both arrive as "no `report` key" -- and that is exactly the
 * invisible degradation ADR-0032 forbids. The channel is the total field; `report` is the optional
 * one, and the pair is what makes the pair readable. ("A second spelling of `reportChannel`" is not
 * an objection: `exit_code` and `task_id` are already snake_case projections, per ADR-0028.)
 */
export const SUBAGENT_OUTPUT_SCHEMA: SubagentOutputSchema = Type.Object({
  task_id: Type.Optional(
    Type.String({
      description:
        "Id of the background task to poll with ptc_task_output. Present ONLY for a background call; absent once the call has already finished.",
    }),
  ),
  status: Type.String({
    description:
      '"background" when this call returned a handle to poll, otherwise the dispatcher\'s own outcome status ("fulfilled").',
  }),
  report_channel: Type.String({
    description:
      'Which channel delivered the child report: "prompt-json" (a fenced JSON block on the child\'s final message), "tool" (the child called the report tool), "none" (no report arrived — either the child did not comply with the contract, or this is a background handle that has not finished), or "opted-out" (the agent\'s frontmatter set `childReport: false`, so it was never asked). ALWAYS present, so an absent `report` key is never ambiguous — "none" and "opted-out" are different claims about the child.',
  }),
  exit_code: Type.Optional(
    Type.Number({
      description: "The child's exit code. Present ONLY for a call that already finished.",
    }),
  ),
  report: Type.Optional(
    Type.Object({
      summary: Type.String({
        description: "One line, in the child's own words, of what it concluded.",
      }),
      findings: Type.Array(
        Type.Object({
          what: Type.String({ description: "The claim this finding makes." }),
          evidence: Type.String({
            description: "The independent thing that supports the claim.",
          }),
        }),
      ),
      files_touched: Type.Array(
        Type.String({ description: "A path the child created or modified." }),
      ),
      usage: Type.Object({
        input: Type.Number({ description: "Input tokens, counted by the host." }),
        output: Type.Number({ description: "Output tokens, counted by the host." }),
        cost: Type.Number({ description: "Total cost, counted by the host." }),
        turns: Type.Number({ description: "Assistant turns, counted by the host." }),
      }),
    }),
  ),
});

// `DispatchResult` and `DispatchHandle` both carry `status` with different literal types, so a
// type predicate on their union produces a never intersection in the negative branch. The
// dispatcher only returns a handle for `background: true`, and a handle always has a `taskId`,
// so the field itself is the discriminator -- read defensively rather than asserted.
function handleTaskId(outcome: SubagentOutcome): string | undefined {
  const taskId = (outcome as { taskId?: unknown }).taskId;
  return typeof taskId === "string" ? taskId : undefined;
}
export function createPtcSubagentTool(options: CreatePtcSubagentToolOptions): AnyTool {
  // Built at registration, so it is a snapshot: an agent file added or edited after this point
  // is not in the description until the next session. That staleness is the accepted cost of
  // giving the model a pre-decision view — the alternative is no view at all until a refusal.
  const roster = describeRegisteredAgentRoster({
    cwd: options.cwd,
    agentScope: options.agentRosterScope ?? "both",
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
  });
  return defineTool({
    name: SUBAGENT_TOOL_NAME,
    label: "PTC Subagent",
    description: [
      "Start a fresh pi agent as a child process: it gets its own context, its own model and its own tools, and it cannot see or change this session except through what it returns. Use it for work that would otherwise flood this context: a survey, a second opinion, or a task that can run while you do something else.",
      // T4 (#181): the model cannot learn where agent definitions come from by reading a tool
      // list, so it goes looking -- and in the session that motivated this it spent twenty-plus
      // tool calls inspecting the install and guessing at argument values. The two directories
      // and what the argument does are the whole of what it needed.
      //
      // #185 rewrote the first clause. It used to open with the absence of a default, which was
      // true and discouraging: the answer to "can I use this?" was "write a file first". The
      // child is a generalist pi unless a definition narrows it, so the omission is the normal
      // case and the names are the exception.
      //
      // Both sentences point at the refusal rather than restating it: the actionable detail
      // (which names are registered, and what a definition file looks like) is rendered by
      // `describeRegisteredAgents` from the same resolver a dispatch uses. A copy here would be
      // the copy that goes stale. Same one-home rule the child-report work established.
      "`agent` is optional — omit it and the child is a fresh generalist pi, with pi's own system prompt and pi's full toolset. Name one to narrow the child instead: an agent is a markdown file at ~/.pi/agent/agents/<name>.md for your machine, or <project>/.pi/agents/<name>.md for one project, and naming one can restrict the child's tools, pin its model, or append a role. A name with no file behind it is refused; the refusal lists what IS registered and how to write one.",
      // The pre-decision view (see describeRegisteredAgentRoster): names alone only help
      // someone who already suspects a name, and this reaches the model BEFORE any refusal.
      // Both this and the refusal render from listRegisteredAgentEntries — one traversal, one
      // home for the data — they are two moments (registration vs. failure), not two sources.
      roster,
    ].join("\n"),
    promptSnippet: "Start a fresh pi agent as a child process (foreground or background)",
    promptGuidelines: [
      "Prefer one subagent over many tool calls when the work is a question with an answer rather than a fact you can look up, or when the raw output would be larger than the answer.",
    ],
    parameters: DISPATCH_PARAMETERS,
    outputSchema: SUBAGENT_OUTPUT_SCHEMA,
    async execute(_toolCallId, params) {
      const outcome = await dispatch(
        params as DispatchInput,
        {
          callId: 0,
          cwd: params.cwd ?? options.cwd,
          depth: options.depth,
          maxDispatchDepth: options.maxDispatchDepth,
          ...(options.parentTaskId === undefined ? {} : { parentTaskId: options.parentTaskId }),
        },
        options.getDispatchDeps?.() ?? {},
      );
      // One details shape for both outcomes. Two literals with different keys infer a union,
      // and `defineTool` then binds to whichever branch it saw first -- so the second return
      // stops typechecking against the tool's own result type.
      const taskId = handleTaskId(outcome);
      const details: SubagentDetails =
        taskId === undefined
          ? { taskId: undefined, status: outcome.status, exitCode: outcome.exitCode }
          : { taskId, status: "background", exitCode: undefined };
      // `structuredContent` is projected from the SAME three values `details` was built from, not
      // re-derived from `outcome`: one outcome, one reading. Each literal carries only the keys
      // that apply to it, because JsonValue has no `undefined` -- see SUBAGENT_OUTPUT_SCHEMA.
      if (taskId !== undefined) {
        const structured: SubagentStructuredContent = {
          task_id: taskId,
          status: details.status,
          // A handle has not finished, so it has nothing to report YET -- and a handle is a
          // `DispatchHandle`, not a `DispatchResult`, so it carries no `reportChannel` to read.
          // The literal "none" is the claim: nothing was reported, because nothing could be yet.
          // It must be a STRING and not `undefined`: `structuredContent` crosses a JSON boundary,
          // and an undefined-valued key vanishes there, leaving a script a projection its own
          // schema does not describe.
          report_channel: "none",
        };
        return {
          content: [{ type: "text" as const, text: HANDLE_TEXT + taskId }],
          details,
          structuredContent: structured,
        };
      }
      if (outcome.status === "rejected") {
        throw new Error("ptc_subagent refused the call: " + outcome.errorMessage);
      }
      // The report is projected verbatim, never rebuilt: `usage` in it was stamped by the host
      // at settle, and a value this tool could recompute would be a second, unauthoritative
      // reading of the same number.
      const report: SubagentReportProjection | undefined = outcome.report;
      const structured: SubagentStructuredContent =
        details.exitCode === undefined
          ? { status: details.status, report_channel: outcome.reportChannel }
          : report === undefined
            ? {
                status: details.status,
                exit_code: details.exitCode,
                report_channel: outcome.reportChannel,
              }
            : {
                status: details.status,
                exit_code: details.exitCode,
                report_channel: outcome.reportChannel,
                report,
              };
      // ADR-0032 §Rendering: the report has to be IN the text, not only in `structuredContent`. That
      // reason was once stated as "on this surface there is no `codemode`", which stopped being true
      // on 2026-10-09 — but the conclusion is unchanged and does not depend on it: this tool is
      // `direct`, so a model reading the text is the primary channel whatever a script does with
      // the structured half. The rendered block goes first
      // and the child's prose after it, so the model reads the conclusion before the reasoning --
      // and the block is emitted whether or not a report arrived, because an unmarked gap reads as
      // an empty result.
      const reportBlock = renderChildReportText(report, outcome.reportChannel);
      const text = [reportBlock, outcome.text].filter((part) => part.length > 0).join("\n\n");
      return {
        content: [{ type: "text" as const, text }],
        details,
        structuredContent: structured,
      };
    },
  });
}
