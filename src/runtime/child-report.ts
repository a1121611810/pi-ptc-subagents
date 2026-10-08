/**
 * The child report's types (ADR-0032, `CONTEXT.md` §child report).
 *
 * These four declarations used to live in `dispatch.ts` next to the extraction that produces
 * them. They moved here so the *persisted* `TaskRecord` field (`task-storage.ts`, Layer 1) can
 * name the shape without a type-only import back up into the dispatch layer — a record that
 * stores a report has to be able to say what a report is, and the storage layer is below the
 * dispatcher, not above it. `dispatch.ts` re-exports all four, so every existing import site
 * (and the report tool's, when it lands) keeps working unchanged.
 *
 * The EXTRACTION stays in `dispatch.ts`. This module owns vocabulary, not parsing: a second copy
 * of the shape text is exactly what ADR-0032's "the contract has exactly one home" forbids.
 */

/** One claim the child makes, with the evidence it rests on. */
export interface ChildReportFinding {
  what: string;
  evidence: string;
}

/**
 * Which channel a {@link ChildReport} arrived over (ADR-0032 "The channel is always stated").
 *
 * `tool` is the report tool's `structuredContent`, read off `tool_execution_end`; `prompt-json`
 * is the fenced block in the child's final assistant message, which is the only channel the
 * dispatch module currently produces; `none` means the contract was on and the child did not
 * comply.
 */
export type ChildReportChannel = "tool" | "prompt-json" | "none";

/**
 * What the child DECLARES. `files_touched` is snake_case on purpose: this object is produced by a
 * model emitting JSON, and renaming it on the way in would mean the wire text and the type
 * disagree. The child's prose is returned alongside it, never replaced by it.
 */
export interface ChildReportPayload {
  summary: string;
  findings: ChildReportFinding[];
  files_touched: string[];
}

/**
 * The child report as the host stamps it: the payload the child declared, plus `usage`, which is
 * what the host OBSERVED and read off the child's own `message_end` usage blocks.
 *
 * `usage` is deliberately not on {@link ChildReportPayload}. A model cannot know its token
 * count, so a child-declared `usage` would be a fabricated number that happened to look like a
 * measurement — `docs/testing-constraints.md` #4 requires the expected value to point at an
 * independent source, and the host's counter is that source. Anything the child puts under
 * `usage` is read and discarded.
 */
export interface ChildReport extends ChildReportPayload {
  usage: { input: number; output: number; cost: number; turns: number };
}

/**
 * What one extraction attempt yielded. `reportChannel: "none"` with no `report` is an ordinary
 * outcome, not an error: the child ran, answered, and did not comply with the contract.
 */
export interface ChildReportExtraction {
  report?: ChildReportPayload;
  reportChannel: ChildReportChannel;
}

/**
 * The one bound both report renderers share (ADR-0032).
 *
 * There are TWO renderers, deliberately: `ptc_subagent` renders inline in the tool-result text
 * and follows the value-tree conventions of `tools/render.ts`, while `ptc_task_output` renders a
 * stored background record and follows the `<bg-task-notification>` XML convention the rest of
 * that subsystem already uses. Two surfaces, two house styles — that part is fine and each is
 * locally consistent.
 *
 * What is NOT fine is two NUMBERS. A reader who sees "at most 20" in one place and 20 in the other
 * has learned nothing, and the day one moves the other silently does not. So the constant lives
 * here, in a module with no imports at all, and both renderers read it.
 *
 * It is here rather than in `tools/render.ts` because `tools/ptc-task.ts` cannot import that:
 * `render.ts` reaches `common.ts` -> `runtime/bindings.ts` -> `runtime/dispatch.ts`, and
 * `bindings.ts` imports `dispatch.ts` back as a VALUE, so the two form a cycle. Adding the edge
 * pulls `dispatch.ts` into `ptc-task.ts`'s module graph ahead of its tests' `node:fs` mock, and
 * agent discovery then reads the real filesystem. That cycle predates this ADR; the fix is not
 * this ticket's, and re-exporting a number through it to save one constant would be the wrong
 * trade.
 */
export const CHILD_REPORT_MAX_FINDINGS = 20;
