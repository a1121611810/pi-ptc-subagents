/**
 * OutputStorage: the persistence seam for a background task's captured output
 * (ADR-0022 §3 + §6, BG-06/07/08).
 *
 * The TaskRecord (BG-01) deliberately does **not** carry the child's result body: ADR-0022 §3
 * keeps only a small `outputRef` / `outputBytes` / `outputPreview` projection on the record and
 * states that "the model gets [the raw text] via `ptc_task_output` which dereferences
 * `outputRef` and applies ADR-0015 truncateTail (50 KB / 2000 lines)". This module owns that
 * dereference seam:
 *
 *   - {@link OutputStorage} - the three-method interface the `ptc_task_output` tool reads/writes
 *     through. `readOutput` returns `null` for "no output yet" (an explicit absence, never a
 *     silent empty string); `outputRef` is the path/ref the dispatcher records on
 *     `TaskRecord.outputRef`.
 *   - {@link InMemoryOutputStorage} - v1 backend for tests and ephemeral sessions.
 *   - {@link FileOutputStorage} - durable backend writing `<base>/tasks/<taskId>/output.log`
 *     (the R1 session-dir layout: `<sessionDir>/tasks/<id>/output.log`).
 *
 * The adapters store/return the **raw** text. Truncation is applied by the *tool*, not the
 * adapter (the brief is explicit), through {@link applyAdr0015Truncation}, which delegates to pi's
 * `truncateTail` with pi's own `DEFAULT_MAX_BYTES` (50 KB) / `DEFAULT_MAX_LINES` (2000) — the
 * contract ADR-0015 §1 makes this package's ceiling. The untruncated text is written to
 * `os.tmpdir()/pi-ptc-task-output-<uuid>.txt` before the tail is cut (ADR-0015 §2), so the
 * pointer the model receives never names a partial file.
 */

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import type { ULID } from "./task-storage.ts";

/**
 * The persistence seam for one task's captured output.
 *
 * `readOutput` returning `null` and `writeOutput` accepting any string are the whole contract;
 * ordering, framing and truncation are the caller's job.
 */
export interface OutputStorage {
  /** Load the task's raw output; `null` when nothing has been written for that id. */
  readOutput(taskId: ULID): Promise<string | null>;
  /** Persist (insert-or-replace) the task's raw output. */
  writeOutput(taskId: ULID, content: string): Promise<void>;
  /**
   * The stable path/ref the dispatcher records on `TaskRecord.outputRef`. It exists even before
   * the first `writeOutput` (the ref is the record's address, not the file's existence).
   */
  outputRef(taskId: ULID): string;
}

/** In-memory `OutputStorage`: a `Map`, the v1 backend. */
export class InMemoryOutputStorage implements OutputStorage {
  readonly #outputs: Map<ULID, string>;

  constructor(seed?: ReadonlyMap<ULID, string>) {
    this.#outputs = new Map(seed ?? []);
  }

  async readOutput(taskId: ULID): Promise<string | null> {
    const found = this.#outputs.get(taskId);
    return found === undefined ? null : found;
  }

  async writeOutput(taskId: ULID, content: string): Promise<void> {
    this.#outputs.set(taskId, content);
  }

  /** No filesystem path exists for an in-memory backend; the ref is unambiguous, not a real path. */
  outputRef(taskId: ULID): string {
    return `memory:tasks/${taskId}/output.log`;
  }
}

/** True for the one `readFile` failure that means "not written yet" rather than "IO broke". */
function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  );
}

/** File-backed `OutputStorage`: `<base>/tasks/<taskId>/output.log` (ADR-0022 §3, R1 layout). */
export class FileOutputStorage implements OutputStorage {
  readonly #baseDir: string;

  constructor(baseDir: string) {
    if (baseDir.length === 0) {
      throw new TypeError("FileOutputStorage: baseDir is required");
    }
    this.#baseDir = baseDir;
  }

  async readOutput(taskId: ULID): Promise<string | null> {
    try {
      return await readFile(this.#path(taskId), "utf8");
    } catch (error) {
      // A missing file is the explicit "no output yet" state (not a silent empty string).
      if (isEnoent(error)) return null;
      throw error;
    }
  }

  async writeOutput(taskId: ULID, content: string): Promise<void> {
    const dir = join(this.#baseDir, "tasks", taskId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "output.log"), content, "utf8");
  }

  outputRef(taskId: ULID): string {
    return this.#path(taskId);
  }

  #path(taskId: ULID): string {
    return join(this.#baseDir, "tasks", taskId, "output.log");
  }
}

/** The result of applying ADR-0015's tail rule to one text block. */
export interface Adr0015Truncation {
  /** The text the model reads (the tail plus the `[Showing …]` footer when truncated). */
  text: string;
  truncated: boolean;
  /** Where the untruncated text was written; present only when `truncated` is true. */
  fullPath?: string;
}

/** Write the untruncated text to a temp file and return its path (ADR-0015 §2). */
function writeFullOutput(text: string): string {
  const filePath = join(tmpdir(), `pi-ptc-task-output-${randomUUID()}.txt`);
  writeFileSync(filePath, text, "utf8");
  return filePath;
}

/**
 * Apply ADR-0015's truncateTail contract to `text`: keep the last
 * {@link DEFAULT_MAX_LINES} lines / {@link DEFAULT_MAX_BYTES} bytes, and when anything was cut,
 * write the complete text to a temp file and append pi's `[Showing …]` footer.
 *
 * The exact tail bias, ceilings and footer wording mirror `src/tools/common.ts`'s
 * `renderToolResult`, which is the same contract for the run-scale text block; both trace to
 * ADR-0015 §1/§2. Small text passes through byte-for-byte with `truncated: false` and no file.
 */
export function applyAdr0015Truncation(text: string): Adr0015Truncation {
  const truncation = truncateTail(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  if (!truncation.truncated) {
    return { text, truncated: false };
  }
  const fullPath = writeFullOutput(text);
  const startLine = truncation.totalLines - truncation.outputLines + 1;
  const endLine = truncation.totalLines;
  const footer = truncation.lastLinePartial
    ? `[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine}. Full output: ${fullPath}]`
    : truncation.truncatedBy === "lines"
      ? `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${fullPath}]`
      : `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${fullPath}]`;
  return { text: `${truncation.content}\n\n${footer}`, truncated: true, fullPath };
}
