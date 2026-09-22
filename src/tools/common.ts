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
 *
 * The text block is the model's copy, so it is cleaned and laid out for reading (`./text.ts`:
 * ANSI stripped, control characters dropped, strings with real newlines kept multi-line) while
 * `details` stays raw for the TUI. See ADR-0012.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { BUILTIN_BINDING_NAMES } from "../runtime/bindings.ts";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PtcRunOutcome } from "../runtime/dispatcher.ts";
import type { PtcConfig, PtcSurface } from "../runtime/limits.ts";
import type { PtcJsonValue } from "../runtime/protocol.ts";
import { renderModelValue, sanitizeText } from "./text.ts";

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
   * The tool names the binding table is built from, read once per execute.
   *
   * The shipped extension returns the session's active tools — except while PTC mode is on, when
   * it returns the mode's base snapshot instead (the built-ins the mode hid must stay callable
   * from inside a program). See `src/mode/ptc-mode.ts`.
   *
   * Omitting it means "no session context" (direct library use, or a hand-built test stub) and
   * asserts the full built-in surface.
   */
  getBindingSourceNames?: () => readonly string[];
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

/**
 * One-line entry for the system prompt's "Available tools" section.
 *
 * Custom tools are omitted from that section unless they set this, which matters most in PTC mode:
 * there the two PTC surfaces are the *only* callable tools, so a prompt that lists no usable tool
 * would contradict the tool declarations. `promptGuidelines` cannot substitute for it — those
 * bullets land in the flat `Guidelines` section, which does not tell the model what it can call.
 */
export const PTC_RUN_CODE_SNIPPET =
  "Run a TypeScript program that composes pi's tools in one shot (tools.<name>(args)); only its return value and console.log come back";

export const PTC_WORKFLOW_SNIPPET =
  "Run a structured TypeScript workflow with named phases, narration (log/phase) and structured concurrency (parallel/pipeline)";

/**
 * Guidelines are appended flat to the `Guidelines` section with no tool-name prefix, so each bullet
 * must name its tool explicitly (pi's docs call this out; "Use this tool when…" is ambiguous).
 * These are the normal-mode hints — in PTC mode the injected briefing supersedes them.
 */
export const PTC_TOOL_GUIDELINES: readonly string[] = [
  // DSH states this contract in `run_code`'s own description ("Image-bearing subtool results are
  // attached after the run."); the model has to know because the images never appear in the value it
  // returns (ADR-0014).
  "Image-bearing tool results inside a program (a `tools.read` on a PNG, say) are attached to you after the run — never return image data as the completion value.",
  "Use ptc_run_code when a task needs several tool calls whose intermediate output you do not need to see — gather it inside the program and return only the final value.",
  "Use ptc_workflow instead of ptc_run_code when the work has named phases and the user benefits from seeing progress narration.",
];

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
  /**
   * How many images the run hoisted out of tool results (`outcome.images`).
   *
   * The images themselves live in the tool result's `content` (pi forwards them to the model from
   * there), so `details` needs only the count — a second copy here would pin the same base64 twice.
   * See ADR-0014.
   */
  imageCount: number;
  /**
   * Where the untruncated text block was written when pi's truncation contract cut it.
   *
   * Present only for a truncated run. The full text has no other home — a program's logs exist only
   * for the length of the run — so the file is the model's way back to the parts the text block had
   * to drop (it can `tools.read` it from inside the next program).
   */
  fullOutputPath?: string;
}

/**
 * The captured-output lines R1 §3 appends when a run fails.
 *
 * Phases and narrations are prefixed because they are workflow bookkeeping rather than console
 * output; `ptc_run_code` has neither, so its block is exactly the `logs` join R1 describes.
 */
function capturedOutputLines(outcome: PtcRunOutcome): string[] {
  return [
    ...outcome.phases.map((title) => `[phase] ${sanitizeText(title)}`),
    ...outcome.narrations.map((message) => `[log] ${sanitizeText(message)}`),
    ...outcome.logs.map((line) => sanitizeText(line)),
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
  // A program can throw a message containing the raw bytes it just read (a coloured shell
  // error, a log line with escapes); the failure text is model-facing too.
  const failure = new Error(
    sanitizeText(`code run failed (${error.kind}): ${error.message}${block}`),
  );
  failure.name = "CodeRunFailedError";
  return failure;
}

/** Structural view of pi's `truncateTail` outcome, so the footer does not re-derive the numbers. */
type TailTruncation = ReturnType<typeof truncateTail>;

/**
 * Write the untruncated text block to a temp file and return its path.
 *
 * Mirrors what pi's own `bash` does with a long output (its `fullOutputPath`): the run is the only
 * place the text ever existed, so a file under the OS temp dir is the difference between "the rest is
 * gone" and "the rest is one `tools.read` away".
 */
function writeFullOutput(text: string): string {
  const filePath = join(tmpdir(), `pi-ptc-output-${randomUUID()}.txt`);
  writeFileSync(filePath, text, "utf8");
  return filePath;
}

/**
 * The `[Showing … Full output: path]` footer pi's built-ins use, worded for the same numbers.
 *
 * `truncatedBy` decides the wording: a line cut reports the line range, a byte cut also names the
 * ceiling, and a single oversized last line reports its own size — exactly what `bash` prints.
 */
function truncationFooter(truncation: TailTruncation, fullOutputPath: string): string {
  const startLine = truncation.totalLines - truncation.outputLines + 1;
  const endLine = truncation.totalLines;
  if (truncation.lastLinePartial) {
    return `[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine}. Full output: ${fullOutputPath}]`;
  }
  if (truncation.truncatedBy === "lines") {
    return `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${fullOutputPath}]`;
  }
  return `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${fullOutputPath}]`;
}

/**
 * Render one successful outcome as pi's tool result.
 *
 * `content` is ordered the way a reader reconstructs the run: the phase roll-up, then workflow
 * narration, then console output, then the completion value, then warnings. Empty runs get R1's
 * placeholder (`(run_code completed with no output)`) so the model always sees a non-empty text
 * block — a tool result with nothing in it looks like a harness failure.
 *
 * `details` is deliberately the *uncleaned* copy: logs keep their ANSI so the TUI can still
 * colour them, and `result` stays structured for `render.ts`.
 */
export function renderToolResult(input: {
  outcome: PtcRunOutcome;
  surface: PtcSurface;
  durationMs: number;
  warnings?: readonly string[];
}): AgentToolResult<PtcToolDetails> {
  const { outcome, surface } = input;
  const warnings = [...(input.warnings ?? [])];
  const images = outcome.images ?? [];
  const parts: string[] = [];
  if (outcome.phases.length > 0) {
    parts.push(`Phases: ${outcome.phases.map((title) => sanitizeText(title)).join(" → ")}`);
  }
  if (outcome.narrations.length > 0) {
    parts.push(outcome.narrations.map((message) => sanitizeText(message)).join("\n"));
  }
  if (outcome.logs.length > 0) {
    parts.push(outcome.logs.map((line) => sanitizeText(line)).join("\n"));
  }
  if (outcome.value !== undefined) parts.push(renderModelValue(outcome.value));
  for (const warning of warnings) parts.push(`Warning: ${sanitizeText(warning)}`);
  const built =
    parts.length > 0
      ? parts.join("\n")
      : `(${SURFACE_TOOL_NAME[surface]} completed with no output)`;
  // pi's rule for a tool's model-facing text is "Tools MUST truncate their output" — 50 KB / 2000
  // lines, keeping the tail, with the remainder pointed at — and this package's own 64 MiB run
  // budget (ADR-0003) is what makes it bite. `fullOutputPath` is written before the tail is cut, so
  // the pointer never names a partial file.
  const truncation = truncateTail(built, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  let fullOutputPath: string | undefined;
  let text = truncation.content;
  if (truncation.truncated) {
    fullOutputPath = writeFullOutput(built);
    text += `\n\n${truncationFooter(truncation, fullOutputPath)}`;
  }
  // The text block is the model's copy; hoisted images ride the same result as image blocks, which
  // is how pi's own `read` hands a picture to the model (ADR-0014).
  const content: (TextContent | ImageContent)[] = [
    { type: "text", text },
    ...images.map((image): ImageContent => ({
      type: "image",
      data: image.data,
      mimeType: image.mimeType,
    })),
  ];
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
      imageCount: images.length,
      ...(fullOutputPath === undefined ? {} : { fullOutputPath }),
    },
  };
}
