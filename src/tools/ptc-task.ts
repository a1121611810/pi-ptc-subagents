/**
 * The three model-facing background-dispatch tools (ADR-0022 §3/§6/§8, BG-06 + BG-07 + BG-08):
 *
 *   - `ptc_task_list`   - "what background tasks exist / how are they doing" (read-only)
 *   - `ptc_task_output` - "give me task X's output" (read-only, ADR-0015-truncated)
 *   - `ptc_task_stop`   - "ask task X to stop" (lifecycle; the *dispatcher* owns the signal)
 *
 * These tools are the *only* model-facing lifecycle face of a background child: the
 * `pi.dispatch({ background: true })` binding returns a thin `DispatchHandle` at spawn
 * (ADR-0022 §4) and never updates it, so live state is read through `ptc_task_list`.
 *
 * Layering: the tools own the model-facing presentation (flat params, truncated text, structured
 * `details`) and nothing else. State lives in {@link TaskRegistry} (BG-02); bytes live behind
 * {@link OutputStorage}; the actual SIGTERM/SIGKILL dance belongs to the dispatcher pump, which is
 * why `ptc_task_stop` deliberately never calls `lifecycle.kill` (ADR-0022 §8). The
 * `ChildProcessLifecycle` parameter is part of the factory contract so the wiring site hands the
 * same seam the dispatcher uses; this module only guards it is present.
 *
 * Each tool additionally declares pi 1.0.0's `outputSchema` and sets `structuredContent` — a lean
 * codemode-facing projection, not a copy of `details` (see "codemode projection" below). The model
 * never sees it: pi documents `structuredContent` as "Not sent to the model", and the three text
 * blocks and `details` shapes are unchanged by it.
 *
 * Conditional, not always-on (ADR-0050): PTC off stops NEW children from being started, and
 * while nothing is running these three leave the model's face — there is nothing for them to do.
 * They come back the moment a task is in flight, because that task has to stay readable and
 * stoppable: off is about what starts from here on, and hiding the lifecycle face of a running
 * task would strand it (ADR-0022 "What we deliberately don't add" 1).
 * `src/index.ts` constructs all three factories against the session-scoped stable holder
 * (registry / outputStorage / lifecycle) and registers them with `pi.registerTool(...)` outside
 * the `/ptc` mode loadout, so they stay callable while PTC mode is off. This module is the
 * factory layer only.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineCompatTool } from "./pi-compat-types.ts";

import { Type } from "typebox";
import type { Static } from "typebox";
import type { ChildProcessLifecycle } from "../runtime/child-process-lifecycle.ts";
import {
  CHILD_REPORT_MAX_FINDINGS,
  type ChildReport,
  type ChildReportChannel,
} from "../runtime/child-report.ts";
import type { DispatchUsage, ReadOnlyTier } from "../runtime/dispatch.ts";
import { applyAdr0015Truncation, type OutputStorage } from "../runtime/output-storage.ts";
import { OUTPUT_PREVIEW_MAX_BYTES, type TaskRegistry } from "../runtime/task-registry.ts";
import type { TaskRecord, TaskStatus, ULID } from "../runtime/task-storage.ts";
import { formatObservedModel } from "../runtime/session-model.ts";
import { renderReadOnlyTierText } from "./read-only-tier-text.ts";
import { renderWhySuppressedText } from "./why-suppressed-text.ts";
import { createTaskPanelRenderers } from "./task-panel-render.ts";
import { sanitizeText } from "./text.ts";

/**
 * The type the three factories return.
 *
 * pi's `defineTool` returns an intersection whose params are statically `any` at the seam
 * anyway; naming the erased shape here keeps the factory signatures explicit for
 * `isolatedDeclarations` and lets the entrypoint orchestrator hold all three tools together.
 */
export type AnyTool = ToolDefinition<any, any, any>;

/** Default number of records `ptc_task_list` returns when the model does not pass `limit`. */
export const DEFAULT_TASK_LIST_LIMIT = 100;

/**
 * The three task tools' names.
 *
 * ADR-0050 withholds them from the model when PTC is off and nothing is running, so the set has
 * to be readable from outside this module. One list, built from the three constants the
 * registrations use, so the set and the registrations cannot drift apart.
 */
export const PTC_TASK_LIST_TOOL_NAME: string = "ptc_task_list";
export const PTC_TASK_OUTPUT_TOOL_NAME: string = "ptc_task_output";
export const PTC_TASK_STOP_TOOL_NAME: string = "ptc_task_stop";
export const PTC_TASK_TOOL_NAMES: readonly string[] = [
  PTC_TASK_LIST_TOOL_NAME,
  PTC_TASK_OUTPUT_TOOL_NAME,
  PTC_TASK_STOP_TOOL_NAME,
];

/** `ptc_task_stop`'s reason when the model omits one (wording from ADR-0022 §8's table). */
export const DEFAULT_STOP_REASON = "model stop";

/** Subscriber fallback when a record's `spawnSource.callerId` is empty (see `#ownerSubscriber`). */
const STOP_CALLER_FALLBACK = "ptc_task_stop";

/** Shared guidance for the three tools (they are one surface and should read that way). */
export const PTC_TASK_TOOL_GUIDELINES: readonly string[] = [
  "Use ptc_task_list to see the background tasks this session dispatched and their live status.",
  "Use ptc_task_output to read a task's captured output (it is tail-truncated; the footer names the full-output file). A succeeded task's child report is rendered there, ahead of the prose.",
  "Use ptc_task_stop to ask a running task to stop; the dispatcher delivers the actual signal, so the task transitions through stopping to canceled.",
  "PTC off stops NEW children from being started, and takes these tools out of reach while nothing is running; a task already running keeps going and stays listed here.",
];

/** The 6-state status set (ADR-0022 §2), exposed to the model as a schema union. */
const TASK_STATUS_SCHEMA = Type.Union([
  Type.Literal("running"),
  Type.Literal("stopping"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("canceled"),
  Type.Literal("lost"),
]);

// ---------------------------------------------------------------------------
//  codemode projection (`structuredContent` + `outputSchema`)
// ---------------------------------------------------------------------------

/**
 * The three tools also declare pi 1.0.0's `ToolDefinition.outputSchema` and set
 * `structuredContent` on every successful result, which is the value a *codemode script* receives
 * instead of the text block (`toScriptValue` in pi's `dist/extensions/codemode/execute.js`:
 * `if (tool.outputSchema && result.structuredContent !== undefined) return result.structuredContent;`).
 * Two rules decide what goes in.
 *
 * **1. A lean projection, never a mirror of `details`.** `details` is the TUI's structure and is
 * allowed to be rich — a `TaskRecord` carries `outputPreview` (≤ 2 KB), `outputRef` and the
 * ADR-0023 owner fields, so mirroring {@link PtcTaskListDetails.tasks} would push ~200 KB of
 * preview text into a QuickJS sandbox whose whole job is to filter and aggregate. Each schema
 * below therefore keeps only the fields a script filters or aggregates on, and `details` keeps
 * everything.
 *
 * **2. Absent, never `undefined`.** `structuredContent` is a `JsonValue` and `JsonObject` is
 * `{ [key: string]: JsonValue }`, so `undefined` is not assignable — an optional key is omitted
 * with the same conditional spread `details` already uses (see {@link PtcTaskOutputDetails}).
 *
 * **Nothing validates the value against the schema** — pi checks neither shape nor presence — so
 * each value below is annotated `Static<typeof …_OUTPUT_SCHEMA>`: a missing key, an extra key or a
 * wrong type is a compile error rather than a silent lie a codemode script would read as data.
 *
 * Adding this changes nothing for a model making a direct tool call: pi documents
 * `AgentToolResult.structuredContent` as "Not sent to the model; `content` remains the
 * model-facing result". `content` and `details` are untouched by design, and the three throw paths
 * (unknown `taskId`, bad `sinceBytes`) have no result at all, so they have no projection.
 *
 * Key spelling follows the text {@link formatTaskLine} prints — `id`, `status`, agent, `depth=`,
 * label, `<bytes>B`, `error=<message>` — so a script comparing a structured result against what the
 * model was shown does not have to remember a third spelling. `agent` (not `agentName`) and the
 * snake_case `output_bytes` / `error_message` are deliberate; this projection is read next to the
 * model's text block, not next to `TaskRecord`.
 */

// ---------------------------------------------------------------------------
//  ptc_task_list
// ---------------------------------------------------------------------------

/** Structured `details` for `ptc_task_list` (the text block is the model's copy). */
export interface PtcTaskListDetails {
  tasks: TaskRecord[];
  count: number;
}

const LIST_PARAMETERS = Type.Object({
  status: Type.Optional(
    Type.Array(TASK_STATUS_SCHEMA, {
      description:
        "Only return tasks in these states. Omit for all six states (running, stopping, succeeded, failed, canceled, lost).",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: `Maximum number of tasks to return, newest first. Defaults to ${DEFAULT_TASK_LIST_LIMIT}.`,
    }),
  ),
});

/** `structuredContent` for `ptc_task_list`; see the codemode projection note above. */
const LIST_OUTPUT_SCHEMA = Type.Object({
  tasks: Type.Array(
    Type.Object({
      id: Type.String({
        description: "The task's ULID — the id ptc_task_output and ptc_task_stop take.",
      }),
      status: Type.String({
        description: "One of running, stopping, succeeded, failed, canceled, lost (ADR-0022 §2).",
      }),
      agent: Type.String({
        description: "The agent the task was dispatched with (the record's agentName).",
      }),
      depth: Type.Number({
        description:
          "0 for a direct child of the session, 1 for a grandchild, and so on (ADR-0016).",
      }),
      label: Type.String({ description: "The label the task was dispatched with." }),
      output_bytes: Type.Optional(
        Type.Number({
          description: "Captured output size; absent while the task has flushed no output.",
        }),
      ),
      error_message: Type.Optional(
        Type.String({ description: "Failure text; absent unless the record carries an error." }),
      ),
    }),
    { description: "One row per task, newest first — the same order as details.tasks." },
  ),
  count: Type.Number({ description: "Number of rows in `tasks`." }),
});

/** One projected row — the compile-time twin of `LIST_OUTPUT_SCHEMA`'s array element. */
type PtcTaskListRow = Static<typeof LIST_OUTPUT_SCHEMA>["tasks"][number];

/**
 * Project one record onto the fields a script filters or aggregates on. `outputBytes` and
 * `errorMessage` are omitted (never set to `undefined`) when the record has none, matching the two
 * conditionals in {@link formatTaskLine} so a row says exactly what the model's line said.
 */
function projectTaskRow(record: TaskRecord): PtcTaskListRow {
  return {
    id: record.id,
    status: record.status,
    agent: record.agentName,
    depth: record.depth,
    label: record.label,
    ...(record.outputBytes === undefined ? {} : { output_bytes: record.outputBytes }),
    ...(record.errorMessage === undefined ? {} : { error_message: record.errorMessage }),
  };
}

/** One line per record for the model-facing text block. */
function formatTaskLine(record: TaskRecord): string {
  const parts = [
    record.id,
    record.status,
    `${record.agentName} depth=${record.depth}`,
    sanitizeText(record.label),
  ];
  if (record.outputBytes !== undefined) parts.push(`${record.outputBytes}B`);
  if (record.errorMessage !== undefined) parts.push(`error=${sanitizeText(record.errorMessage)}`);
  return parts.join("  ");
}

/**
 * Build `ptc_task_list` (ADR-0022 §3): a read-only, `createdAt`-desc view of the session's
 * task registry, defaulting to {@link DEFAULT_TASK_LIST_LIMIT} rows. An invalid limit is the
 * registry's own error (it throws rather than returning a silent empty list).
 */
export function createPtcTaskListTool(registry: TaskRegistry): AnyTool {
  return defineCompatTool({
    name: PTC_TASK_LIST_TOOL_NAME,
    label: "PTC Task List",
    description: [
      "List the background tasks this session has dispatched (from pi.dispatch({ background: true })).",
      "Returns each task's id, status, agent, depth, label and output size, newest first.",
      'Filter with status (e.g. ["running"]); limit caps the row count (default 100).',
    ].join("\n"),
    promptSnippet:
      "List background tasks and their live status (id, status, agent, label, output size)",
    promptGuidelines: [...PTC_TASK_TOOL_GUIDELINES],
    parameters: LIST_PARAMETERS,
    outputSchema: LIST_OUTPUT_SCHEMA,
    async execute(_toolCallId, params) {
      const records = await registry.query({
        ...(params.status === undefined ? {} : { status: params.status }),
        limit: params.limit ?? DEFAULT_TASK_LIST_LIMIT,
        orderBy: "createdAt-desc",
      });
      const text =
        records.length === 0
          ? "(no background tasks)"
          : records.map((record) => formatTaskLine(record)).join("\n");
      const structuredContent: Static<typeof LIST_OUTPUT_SCHEMA> = {
        tasks: records.map((record) => projectTaskRow(record)),
        count: records.length,
      };
      return {
        content: [{ type: "text", text }],
        details: { tasks: records, count: records.length },
        structuredContent,
      };
    },

    ...createTaskPanelRenderers("task-list"),
  });
}

// ---------------------------------------------------------------------------
//  shared: load one record by id
// ---------------------------------------------------------------------------

/**
 * Read one record through the registry's O(1) `get(taskId)` and fail loudly for an unknown id,
 * so each tool keeps its own explicit "unknown taskId" error instead of a silent empty result.
 */
async function loadTaskOrThrow(
  registry: TaskRegistry,
  taskId: ULID,
  toolName: string,
): Promise<TaskRecord> {
  const record = await registry.get(taskId);
  if (record === null) {
    throw new Error(`${toolName}: unknown taskId ${taskId}`);
  }
  return record;
}

// ---------------------------------------------------------------------------
//  ptc_task_output
// ---------------------------------------------------------------------------

/** Structured `details` for `ptc_task_output` (ADR-0015's truncation facts). */
export interface PtcTaskOutputDetails {
  taskId: ULID;
  /** The (possibly truncated) text the model reads. */
  output: string;
  /** Total bytes stored for the task, regardless of `sinceBytes` or truncation. */
  outputBytes: number;
  /**
   * ADR-0022 §2 / issue #70: the record's own reason for a `failed` or `lost` task — the
   * `errorMessage` the registry wrote on the terminal close (or the recovery sweep). Present if
   * and only if the record carries one; the text block states it as `error=…` and
   * `structuredContent` as `error_message`. A record with no reason omits the key rather than
   * claiming an empty one, so "no reason recorded" and "reason recorded as empty" stay distinct.
   */
  errorMessage?: string;
  /**
   * ADR-0022 §7: inline preview of the stored output, present only when `outputBytes` is at
   * or below the 2048-byte Map+preview ceiling (OUTPUT_PREVIEW_MAX_BYTES).
   */
  outputPreview?: string;
  outputTruncated: boolean;
  /** The full-output temp file; present only when `outputTruncated` is true. */
  outputFullPath?: string;
  /**
   * ADR-0032: the background child's report, read off the record the pump persisted it on.
   * Absent for every task that has not reached `succeeded` — a running child has not reported
   * yet and a failed one did not report at all, and neither is the same claim as "reported
   * nothing", which arrives as `reportChannel: "none"` with no `report`.
   */
  report?: ChildReport;
  /**
   * ADR-0032 "The channel is always stated": which channel delivered `report`, or the explicit
   * `none` marker for a child that ignored the contract. Absent exactly when `report` is absent.
   */
  reportChannel?: ChildReportChannel;
  /**
   * ADR-0041: the read-only tier this task was dispatched with, read off the record the spawn
   * wrote it on. Absent for every task dispatched without a tier — which is the same claim the
   * foreground `DispatchResult` makes when it carries no `readOnlyTier`.
   */
  readOnlyTier?: ReadOnlyTier;
  /**
   * ADR-0043: `true` when the caller passed a `why` and this session's switch dropped it. Mirrors
   * the foreground `DispatchResult` field, and makes the same claim when absent: no `why` was
   * passed, so nothing was withheld.
   */
  whySuppressed?: true;
}

// ---------------------------------------------------------------------------
//  ADR-0032: the persisted child report, rendered into the model's text block
// ---------------------------------------------------------------------------

/**
 * Findings cap for the model-facing render (ADR-0032: "bounded at 20 findings with the withheld
 * count stated in-band"). The literal is ADR-0032's; the withheld count is stated because a
 * silently shortened list reads as "these were all of them".
 */
export const MAX_RENDERED_REPORT_FINDINGS: number = CHILD_REPORT_MAX_FINDINGS;

/** The four display fields the report's `usage` view, this tool's text line and its projection share. */
type DisplayUsage = ChildReport["usage"];

/**
 * The four-field view of the record's six-field accumulator (issue #199): `input` / `output` /
 * `cost` / `turns`, the same four {@link ChildReport} carries. It is a projection, not a second
 * measurement — one function, so the line the text prints and the object `structuredContent`
 * carries cannot disagree about the numbers.
 */
function projectUsage(usage: DispatchUsage): DisplayUsage {
  return { input: usage.input, output: usage.output, cost: usage.cost, turns: usage.turns };
}

/**
 * The host's counter as one line — the format the report block has always printed, reused verbatim
 * for the children that have no report block to print it in, so a reader parses one spelling.
 */
function formatUsageLine(usage: DisplayUsage): string {
  return (
    `usage: input=${String(usage.input)} output=${String(usage.output)} ` +
    `cost=${String(usage.cost)} turns=${String(usage.turns)}`
  );
}

/**
 * One `<child-report>` element with no report inside it: the channel, the sentence that says what
 * the absence means, and — since issue #199 — the host's usage line when the record carries one.
 *
 * Three sentences, three different claims (see the callers); what they share is the shape. The
 * usage line goes where the full report block puts it: last, inside the element. A record with no
 * `usage` (one written before the field existed, or a child the host never measured) produces
 * exactly the string this helper produced before it had a usage parameter.
 */
function noReportElement(
  channel: ChildReportChannel,
  sentence: string,
  usage: DisplayUsage | undefined,
): string {
  const head = `<child-report channel="${channel}">${sentence}`;
  if (usage === undefined) return `${head}</child-report>`;
  return `${head}\n${formatUsageLine(usage)}\n</child-report>`;
}

/**
 * Render one record's persisted child report (ADR-0032), or `undefined` when the record carries
 * none — the `running` and `failed` cases, where "has not reported yet" is the honest answer and
 * an empty report block would claim otherwise.
 *
 * A `succeeded` record with `reportChannel: "none"` DOES render, as the explicit non-compliance
 * marker ADR-0032 requires: the child's prose follows it, and the model is told the prose is not
 * backed by a report rather than being left to infer it from the absence of one.
 *
 * Issue #199: every branch here also states the host's own counter when the record has one
 * (`record.usage`), including the branches that render no report. A `none` / `opted-out` /
 * anomalous child still ran and still cost what it cost, and ADR-0032's channel is what
 * distinguishes those outcomes — not a missing measurement.
 *
 * Shape follows the `<bg-task-notification>` XML the same subsystem emits, so a model reading
 * both surfaces sees one convention: the channel is always an attribute, the payload is the body.
 */
export function renderChildReport(record: TaskRecord): string | undefined {
  const channel = record.reportChannel;
  if (channel === undefined) return undefined;
  const usage = record.usage === undefined ? undefined : projectUsage(record.usage);
  if (channel === "none") {
    return noReportElement(
      channel,
      "the child produced no report; it did not comply with the report contract. What follows " +
        "is its prose, unbacked by a report.",
      usage,
    );
  }
  if (channel === "opted-out") {
    // NOT the anomaly branch below, and the difference is the whole point: an opted-out agent
    // resolves `succeeded` carrying this channel and no report, which is an ORDINARY outcome, not
    // a writer that broke a promise. Rendering it in anomaly voice told the model a channel was
    // announced when nobody was ever asked. `tools/render.ts` got the same fix in 29b3a9a.
    return noReportElement(
      channel,
      "this agent opts out of the report contract, so none was asked for; the prose below is " +
        "the whole of what it produced, and nothing is missing.",
      usage,
    );
  }
  const report = record.report;
  if (report === undefined) {
    // Anomaly branch: a channel was announced and nothing arrived. Reachable if some writer other
    // than the registry ever sets one, and stated rather than silently skipped when it does.
    return noReportElement(
      channel,
      `the record names channel ${channel} but carries no report.`,
      usage,
    );
  }
  const lines = [`<child-report channel="${channel}">`, `summary: ${report.summary}`];
  const shown = report.findings.slice(0, MAX_RENDERED_REPORT_FINDINGS);
  const withheld = report.findings.length - shown.length;
  lines.push(`findings (${String(report.findings.length)}):`);
  for (const [index, finding] of shown.entries()) {
    lines.push(`  ${String(index + 1)}. ${finding.what} — evidence: ${finding.evidence}`);
  }
  if (withheld > 0) lines.push(`  …+${String(withheld)} more findings not shown`);
  lines.push(
    report.files_touched.length === 0
      ? "files_touched: (none)"
      : `files_touched: ${report.files_touched.join(", ")}`,
  );
  // The host's counter, not the child's claim — see ChildReportPayload. This branch prints the
  // REPORT's four-field view, which the canonical accumulator feeds (§199's rule: the two agree
  // on these fields), so a report-bearing child is not re-sourced and the line appears once.
  lines.push(formatUsageLine(report.usage));
  lines.push("</child-report>");
  return lines.join("\n");
}

const OUTPUT_PARAMETERS = Type.Object({
  taskId: Type.String({
    description: "The background task's id (as returned by ptc_task_list or the dispatch handle).",
  }),
  sinceBytes: Type.Optional(
    Type.Number({
      description:
        "Skip this many bytes of the stored output before returning it. Use for paging larger logs; defaults to 0.",
    }),
  ),
});

/** `structuredContent` for `ptc_task_output`; see the codemode projection note above. */
const OUTPUT_OUTPUT_SCHEMA = Type.Object({
  task_id: Type.String({ description: "The background task id that was asked for." }),
  status: Type.String({
    description:
      "The task's status at read time (ADR-0022 §2's six states), so a polling script does not need a second ptc_task_list call.",
  }),
  error_message: Type.Optional(
    Type.String({
      description:
        "The record's raw reason for a `failed` or `lost` task (ADR-0022 §2 / issue #70) — the string the text block prints as `error=…` after sanitizing it for display, and the same field `ptc_task_list` projects as `error_message`. Absent unless the record carries an error: a running task has no failure yet, and a `succeeded` or `canceled` close records no reason of its own.",
    }),
  ),
  output: Type.String({
    description: "The page the model reads: the stored output's tail, ADR-0015-truncated.",
  }),
  output_bytes: Type.Number({
    description:
      "Total bytes stored for the task, regardless of sinceBytes or ADR-0015 truncation.",
  }),
  output_preview: Type.Optional(
    Type.String({
      description:
        "The complete stored output; present only at or below the 2048-byte preview ceiling (ADR-0022 §7).",
    }),
  ),
  output_truncated: Type.Boolean({
    description: "Whether ADR-0015 cut anything out of `output`.",
  }),
  output_full_path: Type.Optional(
    Type.String({
      description:
        "A file holding the complete output; present only when `output_truncated` is true (ADR-0015 §2).",
    }),
  ),
  report_channel: Type.Optional(
    Type.String({
      description:
        "Which channel delivered the child's report: `tool`, `prompt-json`, or `none` when the child ignored the contract (ADR-0032). Absent until the task succeeds — a running or failed task carries no report claim at all.",
    }),
  ),
  read_only_tier: Type.Optional(
    Type.String({
      description:
        "The read-only tier the dispatch resolved to: `strict` or `lenient` (ADR-0041). Absent when the dispatch asked for no tier. Present from spawn onwards, including for a task that later failed — a failed read-only child was still dispatched read-only.",
    }),
  ),
  why_suppressed: Type.Optional(
    Type.Boolean({
      description:
        "`true` when you passed a `why` and this session's `whyEnabled` switch was off, so the child's prompt carried no <pi-ptc-why> block (ADR-0043). ABSENT means no `why` was passed — that is the distinction the key exists to make. The child was never told your reason; it did not ignore one. The dropped value is not stored.",
    }),
  ),
  report: Type.Optional(
    Type.Object({
      summary: Type.String({ description: "The child's own one-line summary." }),
      findings: Type.Array(
        Type.Object({
          what: Type.String({ description: "The claim the child makes." }),
          evidence: Type.String({ description: "The evidence that claim rests on." }),
        }),
        { description: "One entry per claim the child made." },
      ),
      files_touched: Type.Array(Type.String(), {
        description: "Paths the child says it touched.",
      }),
      usage: Type.Object({
        input: Type.Number({
          description: "Host-observed input tokens (never the child's claim).",
        }),
        output: Type.Number({ description: "Host-observed output tokens." }),
        cost: Type.Number({ description: "Host-observed cost." }),
        turns: Type.Number({ description: "Host-observed assistant turns." }),
      }),
    }),
  ),
  usage: Type.Optional(
    Type.Object(
      {
        input: Type.Number({
          description: "Host-observed input tokens (never the child's claim).",
        }),
        output: Type.Number({ description: "Host-observed output tokens." }),
        cost: Type.Number({ description: "Host-observed cost." }),
        turns: Type.Number({ description: "Host-observed assistant turns." }),
      },
      {
        description:
          "The host's own count for this child, in the same four fields `report.usage` carries (ADR-0032, issue #199). ABSENT when no top-level count was recorded: a `running` / `stopping` task has not closed yet, a `lost` record was never observed closing, and a record written before the field existed carries none — a pre-change record that has a report still renders the report's own host-stamped numbers. Present on every close outcome including `failed` and `canceled`, and independent of `report_channel` — so a child that reported nothing still accounts for what it cost. The text block states the same four numbers on the `usage: …` line.",
      },
    ),
  ),
});

/**
 * Build `ptc_task_output` (ADR-0022 §3): read the record (existence + current status), read the
 * raw bytes through {@link OutputStorage}, apply ADR-0015's tail rule, and report the truncation
 * facts. An unknown `taskId` is an explicit error, never a silent empty result.
 */
export function createPtcTaskOutputTool(registry: TaskRegistry, storage: OutputStorage): AnyTool {
  return defineCompatTool({
    name: PTC_TASK_OUTPUT_TOOL_NAME,
    label: "PTC Task Output",
    description: [
      "Read a background task's captured output.",
      'A succeeded task also renders its child report (summary, findings, files touched, usage) ahead of the prose, and says which channel delivered it; a channel of "none" means the child ignored the report contract.',
      "A failed or lost task also states the record's error message — the reason it did not succeed — ahead of the output, so an empty output.log is not mistaken for an infrastructure fault.",
      "The text is tail-truncated to pi's ADR-0015 limits (50 KB / 2000 lines); when anything is cut, outputFullPath names a file with the complete output.",
      "Pass sinceBytes to skip a prefix of the stored output when paging.",
    ].join("\n"),
    promptSnippet:
      "Read a background task's output (tail-truncated, with the full-output file path)",
    promptGuidelines: [...PTC_TASK_TOOL_GUIDELINES],
    parameters: OUTPUT_PARAMETERS,
    outputSchema: OUTPUT_OUTPUT_SCHEMA,
    async execute(_toolCallId, params) {
      const taskId = params.taskId as ULID;
      const record = await loadTaskOrThrow(registry, taskId, "ptc_task_output");
      const stored = await storage.readOutput(taskId);
      const full = stored ?? "";
      const outputBytes = Buffer.byteLength(full, "utf8");

      const sinceBytes = params.sinceBytes ?? 0;
      if (!Number.isInteger(sinceBytes) || sinceBytes < 0) {
        throw new Error(
          `ptc_task_output: sinceBytes must be a non-negative integer, got ${String(params.sinceBytes)}`,
        );
      }
      if (sinceBytes > outputBytes) {
        throw new Error(
          `ptc_task_output: sinceBytes ${sinceBytes} exceeds the ${outputBytes}-byte output of task ${taskId}`,
        );
      }
      // R-m16: a byte offset inside a UTF-8 codepoint would decode to U+FFFD. Reject it
      // explicitly (rather than silently advancing) so the caller pages on a character boundary;
      // `outputBytes` still reports the full stored byte length.
      const rawBytes = Buffer.from(full, "utf8");
      if (sinceBytes < outputBytes && ((rawBytes[sinceBytes] ?? 0) & 0xc0) === 0x80) {
        throw new Error(
          `ptc_task_output: sinceBytes ${sinceBytes} splits a UTF-8 character in task ${taskId}; use a byte offset on a character boundary`,
        );
      }
      const slice = sinceBytes === 0 ? full : rawBytes.subarray(sinceBytes).toString("utf8");
      // ADR-0015 §2: the model reads the (possibly truncated) page, but the full-output pointer
      // must name the COMPLETE stored text — `full`, never the page `slice`.
      const truncation = applyAdr0015Truncation(slice, full);
      // ADR-0022 §7: inline the preview only at or below the 2048-byte ceiling.
      const outputPreview = outputBytes <= OUTPUT_PREVIEW_MAX_BYTES ? full : undefined;
      // ADR-0032: the report is read off the record, exactly where the child's prose comes from
      // (the pump persisted both through the same terminal write), so the two cannot describe
      // different messages. Both are absent together.
      const reportBlock = renderChildReport(record);
      // Issue #199: the host's counter, projected once so the text line and `structuredContent`
      // cannot disagree. It is read off the RECORD, not off the report — that is what makes it
      // available to a child that reported nothing.
      const usage = record.usage === undefined ? undefined : projectUsage(record.usage);
      // Issue #199 decision 4 scoped the model-facing half: the text line above and the
      // `structuredContent` projection below carry the counter. `details` deliberately stays
      // without a `usage` field — the TUI task panel draws no usage cell for any record, so a
      // `details.usage` would be inert there. (ADR-0041's `readOnlyTier` does sit on `details`;
      // the two placements are separate calls, recorded here so neither reads as an oversight.)
      const details: PtcTaskOutputDetails = {
        taskId,
        output: truncation.text,
        outputBytes,
        ...(record.errorMessage === undefined ? {} : { errorMessage: record.errorMessage }),
        ...(outputPreview === undefined ? {} : { outputPreview }),
        outputTruncated: truncation.truncated,
        ...(truncation.fullPath === undefined ? {} : { outputFullPath: truncation.fullPath }),
        ...(record.report === undefined ? {} : { report: record.report }),
        ...(record.reportChannel === undefined ? {} : { reportChannel: record.reportChannel }),
        ...(record.readOnlyTier === undefined ? {} : { readOnlyTier: record.readOnlyTier }),
        ...(record.whySuppressed === undefined ? {} : { whySuppressed: record.whySuppressed }),
      };
      // ADR-0032 rendering: the report reads first, the child's prose after — conclusion first,
      // reasoning second. A task with a report always has output too (a `succeeded` child produced
      // text), so the empty-output fallback can never swallow the report block. The fallback
      // distinguishes a task still in flight ("yet") from a settled one: issue #70's 0-byte failed
      // page used to read "(no output yet …)", which a parent could only take for a live task or
      // an infrastructure fault.
      const body =
        details.output.length > 0
          ? details.output
          : record.status === "running" || record.status === "stopping"
            ? `(no output yet; task ${taskId} is ${record.status})`
            : `(no output; task ${taskId} is ${record.status})`;
      // Issue #70 / ADR-0022 §2: the record's own reason for the failure, in the `error=` spelling
      // `formatTaskLine` already uses for ptc_task_list, so the two surfaces cannot disagree and a
      // model that read the reason in the list reads the same string here. Absent exactly when the
      // record carries none.
      const errorLine =
        record.errorMessage === undefined
          ? undefined
          : `error=${sanitizeText(record.errorMessage)}`;
      // Issue #199: a started child the host measured that has NO block to print the line in. A
      // `failed` or `canceled` record carries neither a report nor a channel (ADR-0032: "has not
      // reported yet" is not "reported nothing"), so there is no `<child-report>` element to put it
      // inside — it goes exactly where a block would go, above the prose, in the same format. A
      // task with a block never takes this path, so the line is rendered once either way.
      const usageLine =
        reportBlock === undefined && usage !== undefined ? formatUsageLine(usage) : undefined;
      // ADR-0044 Decision 2: the model the child actually ran, observed by the host off its assistant
      // turns. It sits in the HEAD, after the report block and the host counter and ahead of the
      // prose — the same position the foreground `ptc_subagent` result gives it — rather than
      // inside `<child-report>`, because it is a HOST measurement: putting it in the report could
      // only happen by the child reporting on itself. Absent when no turn was observed, so an
      // old record and an unstarted child render exactly the text they rendered before.
      const observedModel = formatObservedModel(record.observedProvider, record.observedModel);
      const modelLine = observedModel === undefined ? undefined : "model: " + observedModel;
      // One head, in reading order: the report block (which already carries the counter), then the
      // failure reason, then the standalone counter for the children that have no block, then the
      // observed model (the last fact about the child, stated just before its prose).
      const headParts = [reportBlock, errorLine, usageLine, modelLine].filter(
        (part): part is string => part !== undefined,
      );
      const head = headParts.length === 0 ? undefined : headParts.join("\n");
      const text = head === undefined ? body : `${head}\n${body}`;
      // ADR-0041 §Reporting: the tier, on the THIRD model-facing surface. `structuredContent`
      // and `details` both carry it below, but neither reaches the model — this tool is `direct`,
      // and a parent PTC program that polls a SETTLED background child reads this text and
      // nothing else. Without the line, the background front is the one front that stays silent
      // about the tier, which is the exact thing the field was added to prevent.
      const tierText = renderReadOnlyTierText(record.readOnlyTier);
      const textWithTier = tierText.length === 0 ? text : `${tierText}\n${text}`;
      // ADR-0043 on the same surface, for the same reason the tier line above needed one: this
      // tool is `direct`, so a parent PTC program polling a settled background child reads this
      // text and nothing else. Without the line, a suppressed `why` would be visible on the
      // record and on the structured projection but silent where a program actually looks.
      const suppressedText = renderWhySuppressedText(record.whySuppressed);
      const textWithSuppression =
        suppressedText.length === 0 ? textWithTier : `${suppressedText}\n${textWithTier}`;
      // Same computed values, projected onto the declared schema. `status` is free here:
      // `record` is already loaded for the existence check above.
      const structuredContent: Static<typeof OUTPUT_OUTPUT_SCHEMA> = {
        task_id: taskId,
        status: record.status,
        ...(record.errorMessage === undefined ? {} : { error_message: record.errorMessage }),
        output: truncation.text,
        output_bytes: outputBytes,
        ...(outputPreview === undefined ? {} : { output_preview: outputPreview }),
        output_truncated: truncation.truncated,
        ...(truncation.fullPath === undefined ? {} : { output_full_path: truncation.fullPath }),
        ...(record.reportChannel === undefined ? {} : { report_channel: record.reportChannel }),
        ...(record.readOnlyTier === undefined ? {} : { read_only_tier: record.readOnlyTier }),
        ...(record.whySuppressed === undefined ? {} : { why_suppressed: record.whySuppressed }),
        ...(record.report === undefined ? {} : { report: record.report }),
        // Issue #199: the host's counter, on the projection as well as in the text (ADR-0028:
        // shaped to match what the model was shown). Same four fields, same numbers, and present
        // exactly when the record has them — a `running` task, a `lost` record and a pre-#199
        // record carry no key at all rather than a zeroed one.
        ...(usage === undefined ? {} : { usage }),
      };
      return { content: [{ type: "text", text: textWithSuppression }], details, structuredContent };
    },

    ...createTaskPanelRenderers("task-output"),
  });
}

// ---------------------------------------------------------------------------
//  ptc_task_stop
// ---------------------------------------------------------------------------

/** Structured `details` for `ptc_task_stop`. */
export interface PtcTaskStopDetails {
  task: TaskRecord;
  /**
   * ADR-0022 §8: the status observed before the stop command. `running` for a fresh stop,
   * `stopping` for the idempotent late-arrival path.
   */
  fromStatus: TaskStatus;
}

/** Injection seams a deterministic caller (or a test) needs; both have production defaults. */
export interface PtcTaskStopToolOptions {
  /**
   * Time source for the registry transition. Defaults to `Date.now`. The wiring site passes the
   * session clock so `transitionAt` matches the rest of the task lifecycle.
   */
  clock?: () => number;
}

const STOP_PARAMETERS = Type.Object({
  taskId: Type.String({
    description: "The running task's id (as returned by ptc_task_list or the dispatch handle).",
  }),
  reason: Type.Optional(
    Type.String({
      description: `Why the task is being stopped; recorded as the task's stopReason. Defaults to "${DEFAULT_STOP_REASON}".`,
    }),
  ),
});

/** `structuredContent` for `ptc_task_stop`; see the codemode projection note above. */
const STOP_OUTPUT_SCHEMA = Type.Object({
  task_id: Type.String({ description: "The background task id that was asked to stop." }),
  status: Type.String({
    description:
      "The task's status AFTER the stop command — `stopping`, not the terminal `canceled`; the dispatcher pump owns the latter (ADR-0022 §8).",
  }),
  from_status: Type.String({
    description:
      "The status observed before the stop: `running` for a fresh stop, `stopping` for the idempotent late-arrival path (ADR-0022 §8).",
  }),
  stop_reason: Type.Optional(
    Type.String({
      description:
        "The reason recorded as the task's stopReason; absent when the record carries none.",
    }),
  ),
});

/**
 * Build `ptc_task_stop` (ADR-0022 §8): drive `running -> stopping` through the registry and
 * return the updated record. The model stop is explicit and synchronous; the *dispatcher pump*
 * sends the signal and writes the terminal `canceled` state when the child closes — this tool
 * never calls `lifecycle.kill`.
 *
 * A stop issued while the task is already `stopping` is idempotent (ADR-0022 §8 "Late-arrival
 * stop"): the existing record is returned without emitting a second event. Stopping a terminal
 * task is the registry's illegal-edge error.
 */
export function createPtcTaskStopTool(
  registry: TaskRegistry,
  lifecycle: ChildProcessLifecycle,
  options: PtcTaskStopToolOptions = {},
): AnyTool {
  if (lifecycle === undefined || lifecycle === null) {
    throw new TypeError("createPtcTaskStopTool: lifecycle is required");
  }
  const clock = options.clock ?? (() => Date.now());
  return defineCompatTool({
    name: PTC_TASK_STOP_TOOL_NAME,
    label: "PTC Task Stop",
    description: [
      "Ask a running background task to stop.",
      'The task moves to "stopping"; the dispatcher sends the signal and records the terminal "canceled" state when the child exits.',
      "The call is idempotent when the task is already stopping, and errors when the task is already terminal.",
    ].join("\n"),
    promptSnippet: "Ask a background task to stop (dispatcher delivers the signal)",
    promptGuidelines: [...PTC_TASK_TOOL_GUIDELINES],
    parameters: STOP_PARAMETERS,
    outputSchema: STOP_OUTPUT_SCHEMA,
    async execute(_toolCallId, params) {
      const taskId = params.taskId as ULID;
      const existing = await loadTaskOrThrow(registry, taskId, "ptc_task_stop");
      const callerId =
        existing.spawnSource.callerId.length > 0
          ? existing.spawnSource.callerId
          : STOP_CALLER_FALLBACK;
      // ADR-0022 §8 late-arrival stop: the registry owns the idempotence check under its write
      // lock, so two concurrent stops cannot both emit a stopping event. `fromStatus` comes from
      // the registry's atomic result, not a second (racing) read of the record.
      const { record, fromStatus } = await registry.transition(
        { kind: "stop", taskId, reason: params.reason ?? DEFAULT_STOP_REASON },
        { clock, callerId },
      );
      const reason =
        record.stopReason === undefined ? "" : `  reason=${sanitizeText(record.stopReason)}`;
      // `details.fromStatus` and `structuredContent.from_status` are the same observation, so the
      // registry's fallback is resolved once here rather than written twice into two surfaces.
      const observedFromStatus = fromStatus ?? existing.status;
      const structuredContent: Static<typeof STOP_OUTPUT_SCHEMA> = {
        task_id: taskId,
        status: record.status,
        from_status: observedFromStatus,
        ...(record.stopReason === undefined ? {} : { stop_reason: record.stopReason }),
      };
      return {
        content: [{ type: "text", text: `${record.id}  ${record.status}${reason}` }],
        details: { task: record, fromStatus: observedFromStatus },
        structuredContent,
      };
    },

    ...createTaskPanelRenderers("task-stop"),
  });
}
