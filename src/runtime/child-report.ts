/**
 * The child report's types (ADR-0032, `CONTEXT.md` §child report).
 *
 * These four declarations used to live in `dispatch.ts` next to the extraction that produces
 * them. They moved here so the *persisted* `TaskRecord` field (`task-storage.ts`, Layer 1) can
 * name the shape without a type-only import back up into the dispatch layer — a record that
 * stores a report has to be able to say what a report is, and the storage layer is below the
 * dispatcher, not above it. `dispatch.ts` re-exports all four, so every existing import site
 * (and the report tool's) keeps working unchanged.
 *
 * The EXTRACTION stays in `dispatch.ts`. This module owns vocabulary, not parsing.
 *
 * #101 added the last two constants here, and the reason is the same one: ADR-0032's "the
 * contract has exactly one home". The report tool's NAME and the SHAPE it demands are both
 * needed by two modules that must not know about each other — `dispatch.ts`, which has to put
 * the tool in the child's argv and read its `structuredContent` back, and the tool declaration
 * in `src/tools/`, which must not import `dispatch.ts` (that edge has broken this repo's tests
 * once; see `CHILD_REPORT_MAX_FINDINGS` below for why). Neither can reach the other's module, so
 * both read the text from here, which imports nothing at all.
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
 * is the fenced block in the child's final assistant message, which is the channel that still
 * works when this package does not load in the child at all; `none` means the contract was on and
 * the child did not comply.
 *
 * `opted-out` is the fourth value, added by ticket #102, and it is the one that keeps `none`
 * honest. Without it, an agent that opted out and a child that ignored the contract would produce
 * the same string, and ADR-0032 has already said which of those two is a defect — so a reader
 * could not tell "nobody asked" from "it did not comply". A field whose value cannot distinguish
 * those is the silent failure `docs/testing-constraints.md` #3 forbids.
 */
export type ChildReportChannel = "tool" | "prompt-json" | "none" | "opted-out";

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
  /**
   * Total. `opted-out` is not something an extraction can produce — it is what `dispatch()`
   * substitutes for a whole scan when the agent is not under the contract at all, because at that
   * point there is no channel to have extracted anything over.
   */
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

/**
 * The name of the report tool a dispatched child calls (ADR-0032 §"Two channels, both
 * implemented", channel 1).
 *
 * A name and not a constant object because THREE modules have to agree on it and two of them
 * cannot import each other: the tool declaration in `src/tools/child-report-tool.ts` registers
 * under it, `src/index.ts` decides whether it is active, and `buildArgv` puts it in the child's
 * tool list. A second literal would be a second home for the same string.
 */
export const CHILD_REPORT_TOOL_NAME = "ptc_child_report";

/**
 * The ONE place the child's report shape is written down (ADR-0032 "The contract has exactly one
 * home", #101).
 *
 * It used to live inside `CHILD_REPORT_PROMPT_CLAUSE` in `dispatch.ts` as well, which is the two
 * copies this repo has already paid for twice. Ticket #101 is the migration: the text moved here
 * and the prompt clause shrank to a single sentence requiring the child to CALL the tool, so the
 * tool's own description is now the only thing a child is told the shape by.
 *
 * Three fields, and only the child-DECLARED ones: `usage` is deliberately absent because the
 * host measures that and a child asked for it would only invent it (see {@link ChildReport}).
 */
export const CHILD_REPORT_SHAPE: string =
  'a JSON object with exactly these keys: "summary" (one line, your own words), "findings" ' +
  '(an array of objects each with "what" and "evidence", where evidence is the independent thing ' +
  'that supports the claim), and "files_touched" (an array of paths you created or modified)';
