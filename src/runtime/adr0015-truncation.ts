/**
 * Shared ADR-0015 truncation primitive (R-m13 / R2-3).
 *
 * ADR-0015 §1 makes pi's `truncateTail` (50 KB / 2000 lines, tail-biased) this package's
 * model-facing text ceiling, and §2 requires the untruncated text to be written under
 * `os.tmpdir()` before the tail is cut so the pointer the model receives never names a
 * partial file. Two call sites implement that contract:
 *
 *   - the run-scale text block, `src/tools/common.ts`'s `renderToolResult`
 *     (temp-file prefix `pi-ptc-output-`), and
 *   - the task-scale output dereference, `src/runtime/output-storage.ts`'s
 *     `applyAdr0015Truncation` (temp-file prefix `pi-ptc-task-output-`).
 *
 * Before R-m13 each call site carried a private copy of the temp-file writer and an
 * identical three-branch `[Showing …]` footer; only the prefix differed. This module is the
 * single implementation of both. The prefix stays a parameter (defaulting to the run-scale
 * prefix) so each call site keeps its byte-identical naming, and the footer wording is built
 * once so the two sites cannot drift.
 */

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
} from "@earendil-works/pi-coding-agent";

/** Temp-file prefix for the run-scale text block (`src/tools/common.ts`, ADR-0015 §2). */
export const RUN_SCALE_TEMP_PREFIX = "pi-ptc-output-";

/**
 * Temp-file prefix for the task-scale output dereference (`src/runtime/output-storage.ts`,
 * ADR-0015 §2 + ADR-0022 §3); documented in `docs/usage/bgdispatch.md`.
 */
export const TASK_SCALE_TEMP_PREFIX = "pi-ptc-task-output-";

/** The result of applying ADR-0015's tail rule to one text block. */
export interface Adr0015Truncation {
  /** The text the model reads (the tail plus the `[Showing …]` footer when truncated). */
  text: string;
  truncated: boolean;
  /** Where the untruncated text was written; present only when `truncated` is true. */
  fullPath?: string;
}

/** Structural view of pi's `truncateTail` outcome, so the footer does not re-derive numbers. */
type TailTruncation = ReturnType<typeof truncateTail>;

/**
 * Write the untruncated text block to a temp file and return its path (ADR-0015 §2).
 *
 * `prefix` defaults to the run-scale prefix; the task-scale call site passes
 * {@link TASK_SCALE_TEMP_PREFIX} so the pointer keeps its documented name.
 */
export function writeFullOutput(text: string, prefix: string = RUN_SCALE_TEMP_PREFIX): string {
  const filePath = join(tmpdir(), `${prefix}${randomUUID()}.txt`);
  writeFileSync(filePath, text, "utf8");
  return filePath;
}

/**
 * The `[Showing … Full output: path]` footer pi's built-ins use, worded for the same numbers.
 *
 * `truncatedBy` decides the wording: a line cut reports the line range, a byte cut also names
 * the ceiling, and a single oversized last line reports its own size — exactly what `bash`
 * prints.
 */
export function truncationFooter(truncation: TailTruncation, fullOutputPath: string): string {
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

/** Options for {@link applyAdr0015Truncation}. */
export interface Adr0015TruncationOptions {
  /**
   * The text written to the temp file when `text` is truncated. Defaults to `text`.
   *
   * Set this when the displayed text is a page of a larger body (e.g. `ptc_task_output` with
   * `sinceBytes`): the pointer must name the COMPLETE body, never the page. Truncation and the
   * footer's line numbers still derive from `text`, so the display stays a faithful tail.
   */
  fullText?: string;
}

/**
 * Apply ADR-0015's truncateTail contract to `text`: keep the last
 * {@link DEFAULT_MAX_LINES} lines / {@link DEFAULT_MAX_BYTES} bytes, and when anything was cut,
 * write the complete text to a temp file and append the `[Showing …]` footer.
 *
 * Small text passes through byte-for-byte with `truncated: false` and no file.
 *
 * By default the file receives `text` itself. A caller whose `text` is a page of a larger body
 * passes {@link Adr0015TruncationOptions.fullText} so the pointer names the complete body while
 * the model still reads the truncated page.
 */
export function applyAdr0015Truncation(
  text: string,
  prefix: string = RUN_SCALE_TEMP_PREFIX,
  options: Adr0015TruncationOptions = {},
): Adr0015Truncation {
  const truncation = truncateTail(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  if (!truncation.truncated) {
    return { text, truncated: false };
  }
  const fullPath = writeFullOutput(options.fullText ?? text, prefix);
  return {
    text: `${truncation.content}\n\n${truncationFooter(truncation, fullPath)}`,
    truncated: true,
    fullPath,
  };
}
