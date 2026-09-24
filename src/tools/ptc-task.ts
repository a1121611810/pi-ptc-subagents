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
 * `ChildProcessLifecycle` parameter is part of the factory contract so the eventual wiring site
 * hands the same seam the dispatcher uses; this tool only guards it is present.
 *
 * Always-on (ADR-0022 "What we deliberately don't add" 1 + map Notes clause 5): `/ptc off` gates
 * *new spawn*, not in-flight lifecycle, so these tools are not part of PTC mode's gated loadout.
 *
 * TODO(BG-04 integration): the extension entrypoint (`src/index.ts`) has no session-level
 * TaskRegistry / OutputStorage to construct these tools against yet — that wiring lands with the
 * background branch of `pi.dispatch`. Register them there with
 * `pi.registerTool(createPtcTaskListTool(registry))` etc., outside the `/ptc` mode loadout so
 * they stay active when the mode is off. If the program-facing binding table
 * (`src/runtime/bindings.ts`) should also expose them as `tools.ptc_task_*`, add an explicit
 * `includeTaskTools` option there (keeping `includeDispatch` semantics untouched).
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ChildProcessLifecycle } from "../runtime/child-process-lifecycle.ts";
import { applyAdr0015Truncation, type OutputStorage } from "../runtime/output-storage.ts";
import type { TaskRegistry } from "../runtime/task-registry.ts";
import type { TaskRecord, ULID } from "../runtime/task-storage.ts";
import { sanitizeText } from "./text.ts";

/**
 * The type the three factories return.
 *
 * pi's `defineTool` returns an intersection whose params are statically `any` at the seam
 * anyway; naming the erased shape here keeps the factory signatures explicit for
 * `isolatedDeclarations` and lets a future orchestrator hold all three tools in one array.
 */
export type AnyTool = ToolDefinition<any, any, any>;

/** Default number of records `ptc_task_list` returns when the model does not pass `limit`. */
export const DEFAULT_TASK_LIST_LIMIT = 100;

/** `ptc_task_stop`'s reason when the model omits one (wording from ADR-0022 §8's table). */
export const DEFAULT_STOP_REASON = "model stop";

/** Subscriber fallback when a record's `spawnSource.callerId` is empty (see `#ownerSubscriber`). */
const STOP_CALLER_FALLBACK = "ptc_task_stop";

/** A query cap large enough to find one record in a session's list (registry has no get-by-id). */
const ALL_TASKS_LIMIT = Number.MAX_SAFE_INTEGER;

/** Shared guidance for the three tools (they are one surface and should read that way). */
export const PTC_TASK_TOOL_GUIDELINES: readonly string[] = [
  "Use ptc_task_list to see the background tasks this session dispatched and their live status.",
  "Use ptc_task_output to read a task's captured output (it is tail-truncated; the footer names the full-output file).",
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
      return {
        content: [{ type: "text", text }],
        details: { tasks: records, count: records.length },
      };
    },
  });
}

// ---------------------------------------------------------------------------
//  shared: find one record (the registry exposes no get-by-id)
// ---------------------------------------------------------------------------

/**
 * The registry's read surface has no `get(taskId)` (BG-02 owns its shape), so a single-record
 * read is a bounded query + `find`. `limit` is pushed to `Number.MAX_SAFE_INTEGER` so the
 * scan never misses an old record behind the default 100.
 */
async function loadTaskOrThrow(
  registry: TaskRegistry,
  taskId: ULID,
  toolName: string,
): Promise<TaskRecord> {
  const records = await registry.query({ limit: ALL_TASKS_LIMIT });
  const found = records.find((record) => record.id === taskId);
  if (found === undefined) {
    throw new Error(`${toolName}: unknown taskId ${taskId}`);
  }
  return found;
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
  outputTruncated: boolean;
  /** The full-output temp file; present only when `outputTruncated` is true. */
  outputFullPath?: string;
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
      "The text is tail-truncated to pi's ADR-0015 limits (50 KB / 2000 lines); when anything is cut, outputFullPath names a file with the complete output.",
      "Pass sinceBytes to skip a prefix of the stored output when paging.",
    ].join("\n"),
    promptSnippet:
      "Read a background task's output (tail-truncated, with the full-output file path)",
    promptGuidelines: [...PTC_TASK_TOOL_GUIDELINES],
    parameters: OUTPUT_PARAMETERS,
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
      const slice =
        sinceBytes === 0 ? full : Buffer.from(full, "utf8").subarray(sinceBytes).toString("utf8");
      const truncation = applyAdr0015Truncation(slice);
      const details: PtcTaskOutputDetails = {
        taskId,
        output: truncation.text,
        outputBytes,
        outputTruncated: truncation.truncated,
        ...(truncation.fullPath === undefined ? {} : { outputFullPath: truncation.fullPath }),
      };
      const text =
        details.output.length > 0
          ? details.output
          : `(no output yet; task ${taskId} is ${record.status})`;
      return { content: [{ type: "text", text }], details };
    },
  });
}

// ---------------------------------------------------------------------------
//  ptc_task_stop
// ---------------------------------------------------------------------------

/** Structured `details` for `ptc_task_stop`. */
export interface PtcTaskStopDetails {
  task: TaskRecord;
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
    async execute(_toolCallId, params) {
      const taskId = params.taskId as ULID;
      const existing = await loadTaskOrThrow(registry, taskId, "ptc_task_stop");
      // ADR-0022 §8 late-arrival stop: re-stopping a task already asking to stop is a no-op.
      if (existing.status === "stopping") {
        return {
          content: [{ type: "text", text: `${existing.id}  stopping (already stopping)` }],
          details: { task: existing },
        };
      }
      const callerId =
        existing.spawnSource.callerId.length > 0
          ? existing.spawnSource.callerId
          : STOP_CALLER_FALLBACK;
      const { record } = await registry.transition(
        { kind: "stop", taskId, reason: params.reason ?? DEFAULT_STOP_REASON },
        { clock, callerId },
      );
      const reason =
        record.stopReason === undefined ? "" : `  reason=${sanitizeText(record.stopReason)}`;
      return {
        content: [{ type: "text", text: `${record.id}  ${record.status}${reason}` }],
        details: { task: record },
      };
    },
  });
}
