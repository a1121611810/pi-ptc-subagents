/**
 * `ptc_subagent` (ADR-0025): the top-level face for spawning a fresh pi subprocess.
 *
 * Why it exists: the parallel binding `pi.dispatch` can only be reached from *inside* a PTC
 * program, so a session that hands orchestration to pi's `codemode` -- and therefore has no
 * `ptc_run_code` -- would have no way to start a subagent at all. This is that way in.
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
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { DISPATCH_PARAMETERS } from "../runtime/bindings.ts";
import type { DispatchDeps, DispatchInput, DispatchResult } from "../runtime/dispatch.ts";
import { dispatch } from "../runtime/dispatch.ts";
import type { DispatchHandle } from "../runtime/task-registry.ts";
import type { ULID } from "../runtime/task-storage.ts";

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
}

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

// `DispatchResult` and `DispatchHandle` both carry `status` with different literal types, so a
// type predicate on their union produces a never intersection in the negative branch. The
// dispatcher only returns a handle for `background: true`, and a handle always has a `taskId`,
// so the field itself is the discriminator -- read defensively rather than asserted.
function handleTaskId(outcome: SubagentOutcome): string | undefined {
  const taskId = (outcome as { taskId?: unknown }).taskId;
  return typeof taskId === "string" ? taskId : undefined;
}
export function createPtcSubagentTool(options: CreatePtcSubagentToolOptions): AnyTool {
  return defineTool({
    name: "ptc_subagent",
    label: "PTC Subagent",
    description: [
      "Start a fresh pi agent as a child process: it gets its own context, its own model and its own tools, and it cannot see or change this session except through what it returns. Use it for work that would otherwise flood this context: a survey, a second opinion, or a task that can run while you do something else.",
    ].join("\n"),
    promptSnippet: "Start a fresh pi agent as a child process (foreground or background)",
    promptGuidelines: [
      "Prefer one subagent over many tool calls when the work is a question with an answer rather than a fact you can look up, or when the raw output would be larger than the answer.",
    ],
    parameters: DISPATCH_PARAMETERS,
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
      if (taskId !== undefined) {
        return { content: [{ type: "text" as const, text: HANDLE_TEXT + taskId }], details };
      }
      if (outcome.status === "rejected") {
        throw new Error("ptc_subagent refused the call: " + outcome.errorMessage);
      }
      return { content: [{ type: "text" as const, text: outcome.text }], details };
    },
  });
}
