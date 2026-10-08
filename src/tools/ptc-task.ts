/**
 * The three model-facing background-dispatch tools (ADR-0022 §3/§6/§8, BG-06 + BG-07 + BG-08):
 *
 *   - `ptc_task_list`   - "what background tasks exist / how are they doing" (read-only)
 *   - `ptc_task_output` - "give me task X's output" (read-only, ADR-0015-truncated)
 *   - `ptc_task_stop`   - "ask task X to stop" (lifecycle; the *dispatcher* owns the signal)
 *
 * These tools are the *only* model-visible lifecycle face of a background child: the
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
 * Always-on (ADR-0022 "What we deliberately don't add" 1 + map Notes clause 5): `/ptc off` gates
 * *new spawn*, not in-flight lifecycle, so these tools are not part of PTC mode's gated loadout.
 * `src/index.ts` constructs all three factories against the session-scoped stable holder
 * (registry / outputStorage / lifecycle) and registers them with `pi.registerTool(...)` outside
 * the `/ptc` mode loadout, so they stay callable while PTC mode is off. This module is the
 * factory layer only.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import type { ChildProcessLifecycle } from "../runtime/child-process-lifecycle.ts";
import {
  CHILD_REPORT_MAX_FINDINGS,
  type ChildReport,
  type ChildReportChannel,
} from "../runtime/child-report.ts";
import { applyAdr0015Truncation, type OutputStorage } from "../runtime/output-storage.ts";
import { OUTPUT_PREVIEW_MAX_BYTES, type TaskRegistry } from "../runtime/task-registry.ts";
import type { TaskRecord, TaskStatus, ULID } from "../runtime/task-storage.ts";
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

/** `ptc_task_stop`'s reason when the model omits one (wording from ADR-0022 §8's table). */
export const DEFAULT_STOP_REASON = "model stop";

/** Subscriber fallback when a record's `spawnSource.callerId` is empty (see `#ownerSubscriber`). */
const STOP_CALLER_FALLBACK = "ptc_task_stop";

/** Shared guidance for the three tools (they are one surface and should read that way). */
export const PTC_TASK_TOOL_GUIDELINES: readonly string[] = [
  "Use ptc_task_list to see the background tasks this session dispatched and their live status.",
  "Use ptc_task_output to read a task's captured output (it is tail-truncated; the footer names the full-output file). A succeeded task's child report is rendered there, ahead of the prose.",
  "Use ptc_task_stop to ask a running task to stop; the dispatcher delivers the actual signal, so the task transitions through stopping to canceled.",
  "These background-task tools stay callable when PTC mode is off — /ptc off only blocks new dispatches.",
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
  return defineTool({
    name: "ptc_task_list",
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

/**
 * Render one record's persisted child report (ADR-0032), or `undefined` when the record carries
 * none — the `running` and `failed` cases, where "has not reported yet" is the honest answer and
 * an empty report block would claim otherwise.
 *
 * A `succeeded` record with `reportChannel: "none"` DOES render, as the explicit non-compliance
 * marker ADR-0032 requires: the child's prose follows it, and the model is told the prose is not
 * backed by a report rather than being left to infer it from the absence of one.
 *
 * Shape follows the `<bg-task-notification>` XML the same subsystem emits, so a model reading
 * both surfaces sees one convention: the channel is always an attribute, the payload is the body.
 */
export function renderChildReport(record: TaskRecord): string | undefined {
  const channel = record.reportChannel;
  if (channel === undefined) return undefined;
  if (channel === "none") {
    return (
      '<child-report channel="none">the child produced no report; it did not comply with the ' +
      "report contract. What follows is its prose, unbacked by a report.</child-report>"
    );
  }
  const report = record.report;
  if (report === undefined) {
    // Unreachable through the registry (a channel is only ever written with its report or as the
    // `none` marker), and stated rather than silently skipped if some other writer produces it.
    return `<child-report channel="${channel}">the record names channel ${channel} but carries no report.</child-report>`;
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
  // The host's counter, not the child's claim — see ChildReportPayload.
  lines.push(
    `usage: input=${String(report.usage.input)} output=${String(report.usage.output)} ` +
      `cost=${String(report.usage.cost)} turns=${String(report.usage.turns)}`,
  );
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
});

/**
 * Build `ptc_task_output` (ADR-0022 §3): read the record (existence + current status), read the
 * raw bytes through {@link OutputStorage}, apply ADR-0015's tail rule, and report the truncation
 * facts. An unknown `taskId` is an explicit error, never a silent empty result.
 */
export function createPtcTaskOutputTool(registry: TaskRegistry, storage: OutputStorage): AnyTool {
  return defineTool({
    name: "ptc_task_output",
    label: "PTC Task Output",
    description: [
      "Read a background task's captured output.",
      'A succeeded task also renders its child report (summary, findings, files touched, usage) ahead of the prose, and says which channel delivered it; a channel of "none" means the child ignored the report contract.',
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
      const details: PtcTaskOutputDetails = {
        taskId,
        output: truncation.text,
        outputBytes,
        ...(outputPreview === undefined ? {} : { outputPreview }),
        outputTruncated: truncation.truncated,
        ...(truncation.fullPath === undefined ? {} : { outputFullPath: truncation.fullPath }),
        ...(record.report === undefined ? {} : { report: record.report }),
        ...(record.reportChannel === undefined ? {} : { reportChannel: record.reportChannel }),
      };
      // ADR-0032 rendering: the report reads first, the child's prose after — conclusion first,
      // reasoning second. A task with a report always has output too (a `succeeded` child produced
      // text), so the "(no output yet)" fallback can never swallow the report block.
      const body =
        details.output.length > 0
          ? details.output
          : `(no output yet; task ${taskId} is ${record.status})`;
      const text = reportBlock === undefined ? body : `${reportBlock}\n${body}`;
      // Same computed values, projected onto the declared schema. `status` is free here:
      // `record` is already loaded for the existence check above.
      const structuredContent: Static<typeof OUTPUT_OUTPUT_SCHEMA> = {
        task_id: taskId,
        status: record.status,
        output: truncation.text,
        output_bytes: outputBytes,
        ...(outputPreview === undefined ? {} : { output_preview: outputPreview }),
        output_truncated: truncation.truncated,
        ...(truncation.fullPath === undefined ? {} : { output_full_path: truncation.fullPath }),
        ...(record.reportChannel === undefined ? {} : { report_channel: record.reportChannel }),
        ...(record.report === undefined ? {} : { report: record.report }),
      };
      return { content: [{ type: "text", text }], details, structuredContent };
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
  return defineTool({
    name: "ptc_task_stop",
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
