/**
 * Shared plumbing for the two model-facing PTC tools (`ptc_run_code`, `ptc_workflow`).
 *
 * Both tools are thin. They resolve the run's working directory, hand the program to
 * `runPtcProgram()` (T3), and turn the dispatcher's outcome into one of pi's two tool-result
 * shapes:
 *
 * - **success** — `content` carries one text block (logs, workflow narration, phases, then the
 *   completion value) and `details` carries the same facts structurally for rendering and logs;
 * - **failure** — the tool *throws* (pi's convention: `AgentTool.execute` — "Throw on failure
 *   instead of encoding errors in `content`"), with R1 §3's message shape
 *   `code run failed (<kind>): <message>` plus a `Captured output:` block.
 *
 * The dispatcher never rejects for program failures — it reports them as `outcome.error` — so
 * "did the run fail" is one check in one place, shared by both tools.
 */
import type { TextContent } from "@earendil-works/pi-ai";
import { BUILTIN_BINDING_NAMES } from "../runtime/bindings.ts";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PtcRunOutcome } from "../runtime/dispatcher.ts";
import type { PtcConfig, PtcSurface } from "../runtime/limits.ts";
import type { PtcJsonValue } from "../runtime/protocol.ts";

/** Options every PTC tool factory accepts. */
export interface PtcToolOptions {
  /**
   * Per-run limit overrides, merged over `DEFAULT_CONFIG` by the dispatcher (`resolveConfig`).
   *
   * The shipped extension registers the tools without overrides; the seam exists so tests can
   * exercise budget/grace behaviour without materializing 64 MiB of logs, and so a future
   * settings surface has somewhere to plug in.
   */
  config?: Partial<PtcConfig>;
  /**
   * The session's active tool names (`pi.getActiveTools()`), read once per execute.
   *
   * The shipped extension always provides this; omitting it means "no session context"
   * (direct library use, or a hand-built test stub) and asserts the full built-in surface.
   */
  getActiveToolNames?: () => readonly string[];
}

/**
 * Binding names for one run: the built-ins this session actually has enabled (T7, #21).
 *
 * A PTC program must never reach further than the session it runs in — a session started
 * with `--tools read` or `--no-builtin-tools` must not be escapable through `tools.<name>`
 * calls. Names outside the built-in factory set are ignored: only tools this package can
 * build adapters for can be bound.
 */
export function resolveBindingNames(
  activeToolNames: readonly string[] | undefined,
): readonly string[] {
  if (activeToolNames === undefined) return BUILTIN_BINDING_NAMES;
  const active = new Set(activeToolNames);
  return BUILTIN_BINDING_NAMES.filter((name) => active.has(name));
}

/** Tool name per worker surface — the names the model calls and reads in failure messages. */
export const SURFACE_TOOL_NAME: Record<PtcSurface, string> = {
  run_code: "ptc_run_code",
  workflow: "ptc_workflow",
};

/**
 * Resolve the run's working directory from pi's tool execution context.
 *
 * Investigated against `@earendil-works/pi-coding-agent@0.86.1`: `execute`'s fifth parameter is
 * `ExtensionContext`, and the type *does* expose `cwd: string` — documented there as "Current
 * working directory" (`dist/core/extensions/types.d.ts`), the same value pi's own built-in tools
 * resolve relative paths against (`ToolRenderContext.cwd`, and the extension guide's
 * `resolve(ctx.cwd, params.path)` pattern). So the session cwd comes from pi, and this package
 * never has to guess from `process.cwd()`.
 *
 * The `process.cwd()` fallback stays for hand-built contexts (tests, or a future caller passing a
 * partial object); pi always supplies the field.
 */
export function resolveToolCwd(ctx: ExtensionContext): string {
  const cwd: unknown = (ctx as { cwd?: unknown } | undefined)?.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd();
}

/** Structured, model-independent facts about a run: pi's `details` payload for both tools. */
export interface PtcToolDetails {
  /** Which worker surface produced this result. */
  surface: PtcSurface;
  /** `console.*` output in arrival order. */
  logs: string[];
  /** Workflow `log(message)` narration (always empty on `ptc_run_code`). */
  narrations: string[];
  /** Workflow `phase(title)` titles in arrival order (always empty on `ptc_run_code`). */
  phases: string[];
  /** Non-fatal diagnostics the run itself could not report (currently: unlisted phase titles). */
  warnings: string[];
  /** Completion value; absent when the program returned nothing. */
  result?: PtcJsonValue;
  /** Wall-clock duration of the whole run, including worker spawn and teardown. */
  durationMs: number;
}

/**
 * Render a completion value for the model.
 *
 * Strings go through verbatim (a program returning text reads as text); everything else is
 * pretty-printed JSON, which is what the transport already guarantees the value to be.
 */
function renderValue(value: PtcJsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/**
 * The captured-output lines R1 §3 appends when a run fails.
 *
 * Phases and narrations are prefixed because they are workflow bookkeeping rather than console
 * output; `ptc_run_code` has neither, so its block is exactly the `logs` join R1 describes.
 */
function capturedOutputLines(outcome: PtcRunOutcome): string[] {
  return [
    ...outcome.phases.map((title) => `[phase] ${title}`),
    ...outcome.narrations.map((message) => `[log] ${message}`),
    ...outcome.logs,
  ];
}

/**
 * Build the error a failed run is surfaced with (R1 §3's `CodeRunFailedError` message).
 *
 * The model must be able to fix its program from this message alone: the error kind and message
 * explain what broke, and the captured output shows how far the program got before it did. There
 * is no `sandbox` text and no escalation guidance — ADR-0007 ships no OS sandbox, so the only
 * failure classes are the protocol ones.
 */
export function codeRunFailedError(outcome: PtcRunOutcome): Error {
  const error = outcome.error;
  if (error === undefined) {
    // Callers check `outcome.error` first; reaching here means the tool layer asked to render a
    // success as a failure, which is a bug in this package rather than in the model's program.
    return new Error("internal error: a successful PTC run was rendered as a failure");
  }
  const captured = capturedOutputLines(outcome);
  const block = captured.length === 0 ? "" : `\nCaptured output:\n${captured.join("\n")}`;
  const failure = new Error(`code run failed (${error.kind}): ${error.message}${block}`);
  failure.name = "CodeRunFailedError";
  return failure;
}

/**
 * Render one successful outcome as pi's tool result.
 *
 * `content` is ordered the way a reader reconstructs the run: the phase roll-up, then workflow
 * narration, then console output, then the completion value, then warnings. Empty runs get R1's
 * placeholder (`(run_code completed with no output)`) so the model always sees a non-empty text
 * block — a tool result with nothing in it looks like a harness failure.
 */
export function renderToolResult(input: {
  outcome: PtcRunOutcome;
  surface: PtcSurface;
  durationMs: number;
  warnings?: readonly string[];
}): AgentToolResult<PtcToolDetails> {
  const { outcome, surface } = input;
  const warnings = [...(input.warnings ?? [])];
  const parts: string[] = [];
  if (outcome.phases.length > 0) parts.push(`Phases: ${outcome.phases.join(" → ")}`);
  if (outcome.narrations.length > 0) parts.push(outcome.narrations.join("\n"));
  if (outcome.logs.length > 0) parts.push(outcome.logs.join("\n"));
  if (outcome.value !== undefined) parts.push(renderValue(outcome.value));
  for (const warning of warnings) parts.push(`Warning: ${warning}`);
  const text =
    parts.length > 0
      ? parts.join("\n")
      : `(${SURFACE_TOOL_NAME[surface]} completed with no output)`;
  const content: TextContent[] = [{ type: "text", text }];
  return {
    content,
    details: {
      surface,
      logs: [...outcome.logs],
      narrations: [...outcome.narrations],
      phases: [...outcome.phases],
      warnings,
      ...(outcome.value === undefined ? {} : { result: outcome.value }),
      durationMs: input.durationMs,
    },
  };
}
