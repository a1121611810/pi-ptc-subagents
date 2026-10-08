/**
 * `ptc_child_report` — the report tool (ADR-0032 channel 1, ticket #101).
 *
 * A dispatched child hands its report back through a DECLARED TOOL rather than through prose:
 * this declaration is what makes the child's return value a value, and its `structuredContent` is
 * what the host reads off the child's `tool_execution_end` event.
 *
 * **The contract's shape is NOT here.** It lives in `CHILD_REPORT_SHAPE`, which the child's
 * appended system prompt renders -- see the note on `CHILD_REPORT_PROMPT_CLAUSE` for why the
 * prompt is that home and not this description. Restating it here would be a second copy.
 * `CHILD_REPORT_SHAPE` lives in
 * `runtime/child-report.ts` so this module and `dispatch.ts` can share it without either
 * importing the other, and it is stated HERE and nowhere else: the child's appended system prompt
 * carries one sentence requiring the child to call this tool, and no shape at all. Ticket #100's
 * clause was the migration marker and it has now been deleted, deliberately — a second copy of
 * the shape in the prompt is the two-copies problem ADR-0032 rejects.
 *
 * ## Why the tool is a carrier and not a validator
 *
 * `execute` does not validate its arguments and does not build a report. pi has already checked
 * them against {@link CHILD_REPORT_PAYLOAD_SCHEMA} by the time it runs, and the HOST validates
 * what comes back through `validateChildReport` — one validator, one shape, and the side that
 * stamps the report is the side that reads it. Importing that validator here would also put
 * `dispatch.ts` in this module's graph, which has broken this repo's tests once (see the
 * `CHILD_REPORT_MAX_FINDINGS` note in `runtime/child-report.ts`); this module imports nothing
 * from `runtime/` except the import-free vocabulary module.
 *
 * ## When it is active
 *
 * `defaultActive` is decided by whether THIS pi process is itself a dispatched child
 * (`PI_PTC_DEPTH`, ADR-0016 Recursive section). A parent session never has it active — the tool
 * is registered there and never offered to the model — because a parent has no child to report.
 * `buildArgv` additionally merges the name into the child's `--tools` list, which is what makes
 * it active for an agent whose markdown declares tools of its own; without that merge pi's
 * `--tools` allowlist would filter the tool straight back out.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TArray, TObject, TString } from "typebox";

import { CHILD_REPORT_TOOL_NAME } from "../runtime/child-report.ts";

/** Mirrors `AnyTool` in `tools/subagent.ts`; written out here rather than imported from there. */
export type AnyTool = ToolDefinition<any, any, any>;

/** One finding: the claim, and the independent thing that supports it. */
type FindingSchema = TObject<{ what: TString; evidence: TString }>;

/**
 * The report, as a TypeBox schema. Written out explicitly for `isolatedDeclarations`, the same
 * reason `subagent.ts` writes its output schema out rather than deriving it from a type.
 */
type ChildReportPayloadSchema = TObject<{
  summary: TString;
  findings: TArray<FindingSchema>;
  files_touched: TArray<TString>;
}>;

/**
 * The shape the child calls this tool WITH, and the shape its `structuredContent` carries back.
 *
 * One schema used for both `parameters` and `outputSchema` is not a shortcut: the host reads the
 * report off `result.structuredContent`, so anything the tool returned would have to be declared
 * twice and validated twice, and the two copies could disagree. `execute` echoes its arguments
 * verbatim, so what the host reads is exactly what the child declared.
 *
 * `files_touched` is snake_case because this is wire text a model produces; `ChildReportPayload`
 * keeps the same spelling for the same reason.
 */
export const CHILD_REPORT_PAYLOAD_SCHEMA: ChildReportPayloadSchema = Type.Object({
  summary: Type.String({
    description: "One line, in your own words, of what you concluded.",
  }),
  findings: Type.Array(
    Type.Object({
      what: Type.String({ description: "The claim this finding makes." }),
      evidence: Type.String({
        description:
          "The independent thing that supports the claim — what you read, ran or checked. Not the claim restated.",
      }),
    }),
  ),
  files_touched: Type.Array(
    Type.String({ description: "A path you created or modified. Empty if you touched nothing." }),
  ),
});

/**
 * What the child is told, and the only place it is told (ADR-0032 "the contract has exactly one
 * home"). Each line earns its place: what the call is FOR, the shape, the two fields whose
 * meaning is not guessable (`evidence`, `files_touched`), the fact that its prose survives, and
 * the one thing it must not send.
 */
export const CHILD_REPORT_DESCRIPTION: string = [
  "Hand the host a child report: what you did in this run, in the shape it can read without parsing English.",
  "Call it once, at the end. The exact shape is stated in your instructions, which also tell you what to do if this tool is unavailable to you.",
  "Evidence is the point of a finding. Put in the independent thing you read, ran or checked — the claim restated is not evidence, and a finding with none is worse than no finding.",
  "files_touched lists only paths you actually created or modified; leave it empty rather than guessing.",
  "Your prose answer is kept alongside this report and is never replaced by it, so still answer in words.",
  "Do not report usage or token counts — those are measured by the host, and anything you send under them is discarded.",
].join("\n");

/**
 * What `structuredContent` carries: the report, as a plain JSON value.
 *
 * A `type` alias and not {@link ChildReportPayload}: `structuredContent` has to satisfy
 * `JsonValue`'s `[key: string]: JsonValue` index signature, and only an object TYPE gets the
 * implicit one an interface never has — the same reason `tools/subagent.ts` names its projection
 * separately. Structurally the three fields, so nothing is lost and nothing is added.
 */
type ChildReportEcho = {
  summary: string;
  findings: { what: string; evidence: string }[];
  files_touched: string[];
};

/**
 * Build the report tool.
 *
 * `activeByDefault` is the caller's read of "is this pi process a dispatched child". It is a
 * parameter rather than a read of `process.env` here so the decision stays with the entrypoint,
 * which is where `resolveDepthFromEnv` already runs, and so a test can drive both states without
 * mutating the environment.
 */
export function createChildReportTool(activeByDefault: boolean): AnyTool {
  return defineTool({
    name: CHILD_REPORT_TOOL_NAME,
    label: "Child Report",
    description: CHILD_REPORT_DESCRIPTION,
    promptSnippet: "Hand the host a child report when you finish",
    promptGuidelines: [
      "Call " +
        CHILD_REPORT_TOOL_NAME +
        ' once before you finish, even when the answer is "I changed nothing": a child that reports an empty result is a different thing from a child that never reported, and only the first one says so.',
    ],
    parameters: CHILD_REPORT_PAYLOAD_SCHEMA,
    outputSchema: CHILD_REPORT_PAYLOAD_SCHEMA,
    // `false` in a parent is what makes this tool invisible to the parent's own model. pi
    // activates a `direct` tool on registration unless this says otherwise
    // (`ToolDefinition.defaultActive`), and registering is all a parent ever does.
    defaultActive: activeByDefault,
    async execute(_toolCallId, params) {
      // Projection, not rebuild: pi has already checked these against
      // `CHILD_REPORT_PAYLOAD_SCHEMA`, and the HOST validates what comes back through
      // `validateChildReport` — so this module holds no second opinion about what a report is.
      // It also drops anything else on the payload, which is what keeps a child-supplied `usage`
      // out of the channel that would otherwise look like a measurement (see `ChildReport`).
      const echoed: ChildReportEcho = {
        summary: params.summary,
        findings: params.findings.map((finding) => ({
          what: finding.what,
          evidence: finding.evidence,
        })),
        files_touched: [...params.files_touched],
      };
      return {
        content: [
          {
            type: "text" as const,
            text: "child report recorded (" + String(echoed.findings.length) + " findings)",
          },
        ],
        details: undefined,
        structuredContent: echoed,
      };
    },
  });
}
