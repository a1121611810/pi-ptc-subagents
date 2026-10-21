/**
 * `pi_task_codemode` (ADR-0025, renamed by ADR-0052, reshaped by ADR-0054): the codemode door for
 * creating a task.
 *
 * Why it exists: the PTC door `pi_task_ptc` can only be reached from *inside* a PTC program. A
 * session that hands orchestration to pi's `codemode` still needs a way in -- the pair sits at
 * `codemode` reach underneath that script -- but it has to write the script first. This is the
 * other door, and it is reached from the same script.
 *
 * **It is NOT declared to the model** (ADR-0052): its exposure is `codemode`, so only a
 * `codemode` script can call it. On the `codemode_ptc` surface the orchestrator responsible to
 * the model is pi's own `codemode`, and this door sits underneath it -- the model composes, the
 * script calls.
 *
 * Layering, per spec decision 9: this tool is a front and owns no lifecycle. It builds the
 * same DispatchContext the binding builds and calls the same `dispatch()`. Depth, concurrency,
 * the six-state task record and `ptc_task_*` visibility all come from the dispatcher, so a
 * fix in one place fixes both call sites.
 *
 * **The two doors give the same object** (ADR-0054, spec decision 3). The PTC door resolves with
 * the raw `DispatchResult` -- or the raw `DispatchHandle` when the caller did not wait -- and this
 * door hands a `codemode` script that same raw value as its `structuredContent`. No projection, no
 * envelope, no renamed keys: a script and a PTC program read the same field names, so what a
 * model learned on one plane it writes on the other.
 *
 * **Neither door throws** (ADR-0054). A refusal is a result, not an exception: `status:
 * "rejected"` plus an `errorMessage`, in the shape the dispatcher already produces. This door used
 * to throw, which made a refused call indistinguishable from a broken one and cost a sibling
 * result with it.
 *
 * The argument schema is the binding's own, imported -- not a second copy that could drift.
 * A test pins the two key sets equal.
 *
 * The RESULT travels on three channels, on purpose: `content` is the text a reader sees, `details`
 * is this package's own structure, and `structuredContent` is what a `codemode` script reads.
 * The last two carry the SAME raw object (ADR-0054) -- one result, two channels to it, not two
 * results.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineCompatTool } from "./pi-compat-types.ts";
import { Type } from "typebox";
import type { TArray, TBoolean, TNumber, TObject, TOptional, TString } from "typebox";
import { DISPATCH_PARAMETERS } from "../runtime/bindings.ts";
import type { DispatchDeps, DispatchInput, DispatchResult } from "../runtime/dispatch.ts";
import {
  dispatch,
  describeRegisteredAgentRoster,
  isDispatchHandle,
  resolveReadOnlyTier,
} from "../runtime/dispatch.ts";
import type { PtcJsonObject } from "../runtime/protocol.ts";
import {
  formatObservedModel,
  readContextModel,
  type SessionModel,
} from "../runtime/session-model.ts";
import type { DispatchHandle } from "../runtime/task-registry.ts";
import type { ULID } from "../runtime/task-storage.ts";
import { renderChildReportText, renderSubagentToolCall, type SubagentCallArgs } from "./render.ts";
import { renderDescription, TOOLS, WHY_SUPPRESSED_DESCRIPTION } from "../routes/registry.ts";
import { renderReadOnlyTierText } from "./read-only-tier-text.ts";
import { renderWhySuppressedText } from "./why-suppressed-text.ts";

/** Anything this module returns is one of the two dispatch shapes. */
export type SubagentOutcome = DispatchResult | DispatchHandle;

export interface CreatePtcSubagentToolOptions {
  /** Run cwd; the `cwd` default for a spawn that does not name one. */
  cwd: string;
  /** Depth of the calling run: 0 at the parent turn, 1+ inside a `pi_task_ptc` child. */
  depth: number;
  /** Recursion ceiling; the same one the binding's call is checked against (ADR-0016). */
  maxDispatchDepth: number;
  /** This pi process's own task id, when it was itself spawned (ADR-0022 section 3). */
  parentTaskId?: ULID;
  /** Session-scoped deps, so a background spawn lands in the session registry. */
  getDispatchDeps?: () => DispatchDeps;
  /**
   * ADR-0044: the model the caller's session is currently running, read structurally off pi's
   * tool-execution context by the host. The call row uses it to state the inherited model when
   * the call names none; absent means the host could not read a session model (an old pi, a
   * direct library caller), and the row simply omits the inherited part. This is a REQUEST view
   * fact, not the observed model — that stays on the result.
   */
  getSessionModel?: () => SessionModel | undefined;
  /**
   * Scope the roster in the tool description is built from. Defaults to `"both"` because the
   * roster's job is to show what the model COULD dispatch, and a dispatch may still narrow the
   * scope per call — the description labels each agent, so a narrower call is informed.
   */
  agentRosterScope?: "user" | "project" | "both";
  /** Overrides `os.homedir()` when building the roster. Tests only. */
  homeDir?: string;
}

/**
 * The tool's registered name, in one place.
 *
 * It had a second consumer until #187: `session_start` asked "does this surface register
 * the top-level face?" before reporting on agent availability, and that check was the reason the
 * string could not be spelled twice — a rename that updated the registration but not the check
 * would have left a notice describing a tool the session does not have. The check went with the
 * notice it fed.
 *
 * It stays a constant rather than being inlined even though the registration is now its only
 * production reader: a test pins it as the tool's public name, and the next cross-module reference
 * to that name should not have to re-introduce one.
 *
 * ADR-0052 renamed it to `pi_task_codemode`: the codemode door, sharing the `pi_task_` prefix
 * with the PTC door so both are plain JavaScript identifiers and both planes use dot access.
 */
export const SUBAGENT_TOOL_NAME = "pi_task_codemode";

/**
 * ADR-0055: the handle text, and the tail that says what a handle IS.
 *
 * The call did NOT wait — that is the only way a handle is produced — and the model is told so
 * in the same breath as the id. The ticket names the failure this guards: Kotlin calls it
 * "await 遗忘综合征", a caller that expected a result and got a handle instead. The description
 * text, this line, and the task-output channel are the three things that catch it.
 */
const HANDLE_TEXT = "Started task ";
/** What to do with a handle, since it carries no result. */
const HANDLE_TAIL = " — it runs on; read its result with ptc_task_output";

export type AnyTool = ToolDefinition<any, any, any>;

/**
 * The raw outcome, as the JSON value `structuredContent` has to be (ADR-0054).
 *
 * `structuredContent` is typed as pi's `JsonValue`, whose object branch is an index signature
 * `{ [key: string]: JsonValue }`. An INTERFACE never gets that implicitly, and `DispatchResult`
 * is an interface whose optional fields are `X | undefined` -- a value `JsonValue` does not
 * admit. So the outcome is carried as this shape instead.
 *
 * The cast is sound because the dispatcher builds the object with ABSENT optional keys, never
 * `undefined`-valued ones: a key that does not apply is missing, and a missing key is what the
 * JSON boundary would have dropped anyway. `PtcJsonObject` is this package's own JSON type
 * (`src/runtime/protocol.ts`), used here so the cast does not depend on which pi version
 * exports which name.
 */
type OutcomeJson = PtcJsonObject;

/**
 * The declared shape of what a `codemode` script receives (ADR-0054).
 *
 * It is the RAW result shape, field for field, under the SAME names the PTC door's value carries
 * — so the two doors are one object seen from two planes. The projection this replaces renamed
 * the fields (`report_channel`, `exit_code`, `task_id`) and kept only the ones that applied to
 * the branch it was projecting, which is how the child's own text (`text`) went missing while
 * the declared schema said nothing about it.
 *
 * ONE flat object rather than a union of the two shapes: pi renders the declared schema into the
 * `codemode` catalogue by its `properties`, and a union has none, so it would render as an opaque
 * type. `status` is the only field BOTH shapes carry, so it is the only required one — and it is
 * also the discriminant: `"running"` is a handle, `"fulfilled"` or `"rejected"` is a result. Every
 * other field's description says which shape carries it.
 *
 * Written out explicitly for `isolatedDeclarations`, as `DISPATCH_PARAMETERS` is.
 */
type SubagentOutputSchema = TObject<{
  text: TOptional<TString>;
  status: TString;
  started: TOptional<TBoolean>;
  agentName: TOptional<TString>;
  durationMs: TOptional<TNumber>;
  exitCode: TOptional<TNumber>;
  reportChannel: TOptional<TString>;
  errorMessage: TOptional<TString>;
  taskId: TOptional<TString>;
  label: TOptional<TString>;
  observedProvider: TOptional<TString>;
  observedModel: TOptional<TString>;
  stderr: TOptional<TString>;
  readOnlyTier: TOptional<TString>;
  whySuppressed: TOptional<TBoolean>;
  usage: TOptional<SubagentUsageSchema>;
  report: TOptional<SubagentReportSchema>;
}>;

/**
 * The host's own counter, as `DispatchResult.usage` carries it (ADR-0044 / issue #199).
 *
 * Six fields, not the four the report's own `usage` block carries: this is the accumulator the
 * host measured, and it counts the cache reads and writes the report block does not mention.
 */
type SubagentUsageSchema = TObject<{
  input: TNumber;
  output: TNumber;
  cacheRead: TNumber;
  cacheWrite: TNumber;
  cost: TNumber;
  turns: TNumber;
}>;

/**
 * The child report as the raw result carries it (ADR-0032 §`child report`).
 *
 * Structurally identical to `ChildReport` — `summary` / `findings[{what,evidence}]` /
 * `files_touched` / `usage` — and named apart from it so the two can be held together in one
 * direction only. Nothing rebuilds a report here: the value is `DispatchResult.report` verbatim,
 * host-stamped `usage` and all, because a child cannot measure its own tokens (see
 * `ChildReportPayload`).
 *
 * `files_touched` stays snake_case because that is the child's OWN wire spelling (ADR-0032): the
 * raw object is carried verbatim, and renaming one key of it would be a projection again.
 */
type SubagentReportProjection = {
  summary: string;
  findings: { what: string; evidence: string }[];
  files_touched: string[];
  usage: { input: number; output: number; cost: number; turns: number };
};

/** The report half of the declared schema; see `SUBAGENT_OUTPUT_SCHEMA`. */
type SubagentReportSchema = TObject<{
  summary: TString;
  findings: TArray<TObject<{ what: TString; evidence: TString }>>;
  files_touched: TArray<TString>;
  usage: TObject<{
    input: TNumber;
    output: TNumber;
    cost: TNumber;
    turns: TNumber;
  }>;
}>;

/**
 * The machine-readable result, declared as the tool's `outputSchema` so pi hands a codemode script
 * this object *instead of* the text block (`ToolDefinition.outputSchema`: "codemode scripts then
 * receive it instead of the text content"). It never reaches the model: `structuredContent` is
 * documented as not sent to the model, so declaring it changes nothing for a direct tool call.
 *
 * **It is the raw result, declared field for field** (ADR-0054). The projection it replaces
 * renamed the keys (`report_channel`, `exit_code`, `task_id`) and kept only the ones that applied
 * to the branch it was projecting — which is how the child's own text (`text`) went missing: the
 * script got a structured value in place of the text block, and that value had no prose in it.
 * The two doors are one object seen from two planes, so the names here are the names the PTC
 * door's value carries.
 *
 * `status` is the only required key, because it is the only one BOTH shapes carry — and it is
 * also the discriminant between them: `"running"` is a handle (poll it with `ptc_task_output`),
 * `"fulfilled"` is a child that answered, `"rejected"` is a gate that said no (read
 * `errorMessage`). Every other key's description says which shape carries it, so a script can
 * tell the two apart from the schema alone.
 *
 * `report` is the child report (ADR-0032) at FULL length, not the rendered view: a script is not a
 * display surface, and the 20-finding bound is a rendering bound, applied in the text block by
 * `renderChildReportText`. Absent when no report arrived — including on a handle, which has not
 * finished and therefore has nothing to report yet.
 *
 * `reportChannel` is present on EVERY settled result rather than alongside `report`. Without it a
 * caller reading this channel cannot tell a child that ignored the contract from a handle that
 * has not finished yet — both arrive as "no `report` key" — and that is exactly the invisible
 * degradation ADR-0032 forbids. The channel is the total field; `report` is the optional one, and
 * the pair is what makes the pair readable.
 *
 * `readOnlyTier` is ADR-0041's "the tier that took effect is reported", for the same reason
 * `reportChannel` is: call-site precedence is total, so the value cannot differ from the
 * request, and that is precisely why stating it is worth a key — it is what makes an override of
 * a definition's declared `tools:` visible to a script instead of something the script has to
 * infer from an agent file it may never have read. ABSENT when no tier was asked for.
 *
 * `usage` (issue #199) is the host's own counter, and it is the `DispatchResult.usage`
 * accumulator rather than `report.usage` — which is the whole point: before this key, a child
 * that delivered no report (`none`, `opted-out`, or a settled call with no report at all) had no
 * token accounting anywhere a script could read. ABSENT for a handle, whose child has not been
 * measured yet, and for a child that emitted no usage block; never zeroed to say "not measured".
 */
export const SUBAGENT_OUTPUT_SCHEMA: SubagentOutputSchema = Type.Object({
  text: Type.Optional(
    Type.String({
      description:
        "The child's own final words — its working output. Present on every settled call, and EMPTY on a refusal (nothing ran). ABSENT on a handle, whose child has not finished.",
    }),
  ),
  status: Type.String({
    description:
      'What the call produced: "fulfilled" (the child ran and answered), "rejected" (a gate said no, or the child failed — read `errorMessage`), or "running" (a handle: the child is still going, poll it with `ptc_task_output`). This is the ONE key every shape carries, and it is also how the two shapes are told apart.',
  }),
  started: Type.Optional(
    Type.Boolean({
      description:
        "Whether the child was actually brought up. FALSE on every refusal: the harness declined to start it.",
    }),
  ),
  agentName: Type.Optional(
    Type.String({
      description:
        'The agent definition the child ran under, or "" for the generalist child (no definition named).',
    }),
  ),
  durationMs: Type.Optional(
    Type.Number({
      description: "How long the child ran, in milliseconds. 0 on a refusal: nothing ran.",
    }),
  ),
  exitCode: Type.Optional(
    Type.Number({
      description:
        "The child's exit code. -1 on a refusal (nothing ran); 0 on a child that exited cleanly. ABSENT on a handle, which has not finished.",
    }),
  ),
  reportChannel: Type.Optional(
    Type.String({
      description:
        'Which channel delivered the child report: "prompt-json" (a fenced JSON block on the child\'s final message), "tool" (the child called the report tool), "none" (no report arrived — either the child did not comply with the contract, or this is a background handle that has not finished), or "opted-out" (the agent\'s frontmatter set `childReport: false`, so it was never asked). ALWAYS present on a settled call, so an absent `report` key is never ambiguous — "none" and "opted-out" are different claims about the child.',
    }),
  ),
  errorMessage: Type.Optional(
    Type.String({
      description:
        'Why the call was refused or failed. Present whenever `status` is "rejected": which gate said no, and what the dispatcher knew.',
    }),
  ),
  taskId: Type.Optional(
    Type.String({
      description:
        'The id of the task. On a handle (`status: "running"` or `"queued"`) it is the running task\'s id; on a settled call it is the id of the record the call created — the same id, named the same way (ADR-0055).',
    }),
  ),
  label: Type.Optional(
    Type.String({
      description:
        "The label the task was created with — the caller's `label`, or the task text truncated. On both shapes, because both name the same task (ADR-0055).",
    }),
  ),
  observedProvider: Type.Optional(
    Type.String({
      description:
        "The provider that actually served the child, observed off its assistant messages. ABSENT means no turn named one — not that the model is unknown.",
    }),
  ),
  observedModel: Type.Optional(
    Type.String({
      description: "The model id the child actually ran. Observed like `observedProvider`.",
    }),
  ),
  stderr: Type.Optional(
    Type.String({
      description: "The child's stderr, when it produced any.",
    }),
  ),
  readOnlyTier: Type.Optional(
    Type.String({
      description:
        'The read-only tier the dispatch resolved to: "strict" or "lenient" (ADR-0041). Absent when no tier was asked for, so an absent key means "no tier" rather than "tier unknown".',
    }),
  ),
  whySuppressed: Type.Optional(
    Type.Boolean({
      description: WHY_SUPPRESSED_DESCRIPTION,
    }),
  ),
  usage: Type.Optional(
    Type.Object(
      {
        input: Type.Number({ description: "Input tokens, counted by the host." }),
        output: Type.Number({ description: "Output tokens, counted by the host." }),
        cacheRead: Type.Number({ description: "Cached input tokens read, counted by the host." }),
        cacheWrite: Type.Number({
          description: "Cached input tokens written, counted by the host.",
        }),
        cost: Type.Number({ description: "Total cost, counted by the host." }),
        turns: Type.Number({ description: "Assistant turns, counted by the host." }),
      },
      {
        description:
          "The host's own count for this child, read from the `DispatchResult.usage` accumulator (ADR-0032, issue #199). ABSENT for a handle, which has measured nothing yet, and for a child that emitted no usage block. Present on every settled call REGARDLESS of `reportChannel`, so a child that reported nothing still accounts for what it cost — the text render states the same numbers on its `usage` row.",
      },
    ),
  ),
  report: Type.Optional(
    Type.Object({
      summary: Type.String({
        description: "One line, in the child's own words, of what it concluded.",
      }),
      findings: Type.Array(
        Type.Object({
          what: Type.String({ description: "The claim this finding makes." }),
          evidence: Type.String({
            description: "The independent thing that supports the claim.",
          }),
        }),
      ),
      files_touched: Type.Array(
        Type.String({ description: "A path the child created or modified." }),
      ),
      usage: Type.Object({
        input: Type.Number({ description: "Input tokens, counted by the host." }),
        output: Type.Number({ description: "Output tokens, counted by the host." }),
        cost: Type.Number({ description: "Total cost, counted by the host." }),
        turns: Type.Number({ description: "Assistant turns, counted by the host." }),
      }),
    }),
  ),
});

// The two shapes are told apart by `status`, never by "does the outcome carry an id" (ADR-0054).
// ADR-0053 gave a settled result an id of its own, so a handle's `taskId` no longer identifies
// the shape — and ADR-0055 made the two name the id the SAME way, which is why the presence of
// an id cannot be the test either. `isDispatchHandle` discriminates on `status`: a handle is
// always `"running"` or `"queued"`, a result is always `"fulfilled"` or `"rejected"`.

/**
 * Upper bound on the diagnostic a refused call carries, in characters.
 *
 * The facts exist to make a failed dispatch actionable — a real one is a provider's
 * `429 … (2056)` plus "the child retried four turns and never produced text" — so the budget is
 * sized to keep the CAUSE readable at the break: an unbounded provider message would otherwise
 * push the reason it failed out of the first screenful. The bound keeps the TAIL because that is
 * where a provider's own diagnosis usually is (status code and request id arrive after the
 * prose), and the leading ellipsis marks the cut so a truncated diagnosis is never mistaken for
 * a complete one.
 */
export const SETTLED_FAILURE_MAX_CHARS = 800;

/**
 * One line describing why a settled dispatch call was refused: the cause, then the facts the
 * caller would otherwise have to infer.
 *
 * The failure this replaces was `"pi_task_codemode refused the call: undefined"`: a rejected
 * dispatch whose `errorMessage` is absent (a spawn that never happened, or a child that
 * reported no reason) rendered the string `undefined` and said nothing about what the
 * dispatcher knew. The facts are the dispatcher's own fields, so a caller reads the same values
 * the result carries — `started` separates "the harness declined to start a child" from "a
 * child ran and failed", `exit=` separates a crash from a silent exit, `turns=` (0 when no
 * usage was measured) says whether the child ever answered at all, `reportChannel=` says
 * whether the prose had a report behind it, and the model names what actually served the call
 * when the host observed one.
 *
 * Exported rather than inlined into the throw so a test can pin the format without matching the
 * prefix, and so any other refusal front has one wording to reuse.
 */
export function describeSettledFailure(outcome: DispatchResult): string {
  const cause = outcome.errorMessage ?? "the child failed without an error message";
  const facts = [
    outcome.started ? "child ran" : "harness declined to start",
    "exit=" + String(outcome.exitCode),
    "turns=" + String(outcome.usage?.turns ?? 0),
    "reportChannel=" + outcome.reportChannel,
  ];
  const model = formatObservedModel(outcome.observedProvider, outcome.observedModel);
  if (model !== undefined) facts.push("model=" + model);
  const text = cause + " (" + facts.join(", ") + ")";
  // Keep the tail: a provider's diagnosis usually ends with the actionable part, and the cause
  // is already what the caller read before the refusal. Length is exactly the bound either way.
  return text.length <= SETTLED_FAILURE_MAX_CHARS
    ? text
    : "…" + text.slice(-(SETTLED_FAILURE_MAX_CHARS - 1));
}

export function createPtcSubagentTool(options: CreatePtcSubagentToolOptions): AnyTool {
  // Built at registration, so it is a snapshot: an agent file added or edited after this point
  // is not in the description until the next session. That staleness is the accepted cost of
  // giving the model a pre-decision view — the alternative is no view at all until a refusal.
  const roster = describeRegisteredAgentRoster({
    cwd: options.cwd,
    agentScope: options.agentRosterScope ?? "both",
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
  });
  return defineCompatTool({
    name: SUBAGENT_TOOL_NAME,
    // ADR-0054: the door creates a TASK, and "subagent" is retired from the vocabulary the model
    // reads (ADR-0052). This label is a USER-FACING row, not model-facing text -- the model never
    // sees this tool declared -- but the words a user reads should be the same words the rest of
    // the surface uses, and the task family is already "PTC Task List" / "PTC Task Output" /
    // "PTC Task Stop". Shorter than the name it replaces, too, which is what the wider tool name
    // (16 characters against the 13 of the one it replaced) asked to be looked at.
    label: "PTC Task",
    // ADR-0052: the codemode door is at `codemode` reach, so it is NOT declared to the model.
    // On the `codemode_ptc` surface the orchestrator responsible to the model is pi's own
    // `codemode`; this door sits underneath it, and only a `codemode` script can call it.
    exposure: "codemode",
    description: renderDescription(TOOLS.pi_task_codemode, { agentRoster: roster }),
    promptSnippet: TOOLS.pi_task_codemode.snippet,
    promptGuidelines: [...TOOLS.pi_task_codemode.guidelines],
    parameters: DISPATCH_PARAMETERS,
    // Inert on the declared floor (#193). `outputSchema` did not exist on pi's
    // ToolDefinition below 0.99.0 -- measured: 0.86.0's interface runs
    // `dist/core/extensions/types.d.ts:345`-`:378` and goes from `prepareArguments` straight
    // to `executionMode`, so a floor pi simply does not read this field.
    //
    // It is inert twice over, and the second half is what makes it safe rather than merely
    // unread. The field only has a reader when a `codemode` script can consume
    // `structuredContent`, and 0.86.0 ships no `codemode` at all (#197 measured the concept
    // absent from its `dist/`, zero matches). This tool is also `direct`, not `codemode`-reach,
    // so nothing on ANY version reads this half for this tool. Declaring it therefore costs a
    // floor pi nothing and leaves the tool byte-identical across the peer range -- and the
    // rendered child report above reaches the model either way, which is why the text block
    // rather than this field is what ADR-0032 leans on. See ./pi-compat-types.ts.
    outputSchema: SUBAGENT_OUTPUT_SCHEMA,
    // Only `ctx` (the fifth parameter) is read. The middle three are declared optional so a
    // direct library caller or a test can stop after `params`, while pi's agent loop still
    // passes all five. `readContextModel` takes `unknown` so the declared 0.86.0 floor's
    // context type -- which may not declare a `model` field -- needs no narrowing here.
    async execute(_toolCallId, params, _signal?, _onUpdate?, ctx?) {
      // ADR-0044: inherit the caller session's current model when neither the call site nor the
      // agent definition names one. The snapshot is read here and carried in the dispatch
      // context; dispatch resolves it at spawn, so a model switch after this call cannot
      // retro-change a child that is already running.
      const sessionModel = readContextModel(ctx);
      // The union is asserted, not inferred: `dispatch()`'s overloads narrow by a LITERAL
      // `{ wait: true }`, and this tool's parameters are dynamic, so the call resolves
      // against the general overload whose declared type is `DispatchResult` alone. At runtime the
      // dispatcher returns a handle exactly when `input.wait` is not true, so the union is the
      // truth of the call. Narrowing it afterwards is `isDispatchHandle`'s job, not a cast's.
      const outcome = (await dispatch(
        params as DispatchInput,
        {
          callId: 0,
          cwd: params.cwd ?? options.cwd,
          depth: options.depth,
          maxDispatchDepth: options.maxDispatchDepth,
          ...(options.parentTaskId === undefined ? {} : { parentTaskId: options.parentTaskId }),
          ...(sessionModel === undefined ? {} : { sessionModel }),
        },
        options.getDispatchDeps?.() ?? {},
      )) as DispatchResult | DispatchHandle;
      // ADR-0054: the two doors give the SAME object, and this door gives it to a script
      // unchanged. `details` and `structuredContent` both carry the raw outcome -- no projection,
      // no envelope, no renamed keys -- so a script reads the same field names a PTC program
      // reads, and the two doors cannot drift apart in shape.
      //
      // The shape of the two outcomes differs, and `status` is what tells them apart: a handle is
      // `"running"`, a result is `"fulfilled"` or `"rejected"`. `isDispatchHandle` is that
      // discriminant; it is NOT "does the outcome carry an id", because a settled result carries
      // an id of its own (ADR-0053) and reading THAT as a handle would make every settled call
      // announce itself as a background task.
      const details: SubagentOutcome = outcome;
      if (isDispatchHandle(outcome)) {
        // ADR-0041: a background dispatch returns a DispatchHandle, which carries no
        // `readOnlyTier` to read -- the field this front states is on the DispatchResult and on
        // the TaskRecord (`ptc_task_output`). The tier that took effect is nevertheless known
        // here and IS known for this call: reaching this branch means `dispatch()` returned a
        // handle, and `dispatch()` returns a handle only after its read-point guard passed, so
        // this is the tier the child was actually spawned with. Stated rather than omitted, for
        // the same reason `reportChannel: "none"` is stated on a settled call.
        const handleTier = resolveReadOnlyTier((params as DispatchInput).readOnly);
        return {
          content: [
            {
              type: "text" as const,
              text: [HANDLE_TEXT + outcome.taskId + HANDLE_TAIL, renderReadOnlyTierText(handleTier)]
                .filter((part) => part.length > 0)
                .join("\n\n"),
            },
          ],
          details,
          structuredContent: outcome as unknown as OutcomeJson,
        };
      }
      // The report is carried verbatim, never rebuilt: `usage` in it was stamped by the host
      // at settle, and a value this tool could recompute would be a second, unauthoritative
      // reading of the same number.
      const report: SubagentReportProjection | undefined = outcome.report;
      // ADR-0032 §Rendering: the report has to be IN the text, not only in `structuredContent`. That
      // reason was once stated as "on this surface there is no `codemode`", which stopped being true
      // on 2026-10-09 — but the conclusion is unchanged and does not depend on it: a reader of the
      // text is the primary channel whatever a script does with the structured half. The rendered
      // block goes first and the child's prose after it, so the conclusion is read before the
      // reasoning -- and the block is emitted whether or not a report arrived, because an unmarked
      // gap reads as an empty result.
      //
      // EXCEPT on a refusal, and the exception is a wording one: the block's "the child did not
      // comply with the contract, so its prose below is unbacked by a report" is a claim about a
      // child that RAN. A refusal that never started a child has no report story to tell, and the
      // diagnostic beside it already states the channel (`reportChannel=none` is in it), so nothing
      // is left unmarked. A child that ran and failed is the same case: the refusal line says
      // what happened, and the block's "its prose below" would point at a prose that is not there.
      const reportBlock =
        outcome.started && (outcome.status === "fulfilled" || report !== undefined)
          ? renderChildReportText(report, outcome.reportChannel, outcome.usage)
          : "";
      // ADR-0041: the tier goes FIRST, above the report block and the child's prose. It is a fact
      // about what the child was allowed to do, so the reader should see it before anything it
      // might attribute to the child.
      const tierText = renderReadOnlyTierText(outcome.readOnlyTier);
      // ADR-0043 on the same surface and for the same reason: the suppressed `why` is a fact about
      // what the child was TOLD — the report describes what it did. It sits beside the tier rather
      // than after the report.
      const suppressedText = renderWhySuppressedText(outcome.whySuppressed);
      // ADR-0044: the model the child ACTUALLY ran is a host observation, stated after the
      // report block and before the child's prose. After the report because the report is the
      // conclusion the caller asked for; before the prose because that prose is evidence
      // produced by the process whose model this line names. Absent when no assistant turn was
      // observed -- a missing line is the honest claim "we saw no model", never `model: undefined`.
      const observedModel = formatObservedModel(outcome.observedProvider, outcome.observedModel);
      // The model line is the SETTLED path's. On a refusal the diagnostic already names the model
      // it observed (`model=` is one of its facts), so a second statement of the same fact would be
      // noise rather than information.
      const modelText =
        observedModel === undefined || outcome.status === "rejected"
          ? ""
          : "model: " + observedModel;
      // ADR-0054: a REFUSAL is a result, not an exception. The bounded diagnostic, not the bare
      // `errorMessage`: see `describeSettledFailure` for the `refused the call: undefined` failure
      // the bare message produced. The wording is unchanged from the throw it replaces, so a
      // reader that matched it keeps matching it -- only the DELIVERY changed: a gate that said no
      // is now a result the caller can read, not an exception that took its siblings down with it.
      const refusalText =
        outcome.status === "rejected"
          ? SUBAGENT_TOOL_NAME + " refused the call: " + describeSettledFailure(outcome)
          : "";
      const text = [tierText, suppressedText, refusalText, reportBlock, modelText, outcome.text]
        .filter((part) => part.length > 0)
        .join("\n\n");
      return {
        content: [{ type: "text" as const, text }],
        details,
        structuredContent: outcome as unknown as OutcomeJson,
      };
    },
    renderCall(args, theme, context) {
      // ADR-0044: the inherited-model statement is a snapshot of the session model at this
      // CALL's first render. pi reuses `context.state` for one tool execution, so capturing it
      // there keeps a settled row from changing its statement after a later model switch; a new
      // call gets fresh state and captures the then-current model. Without a render state
      // (older pi), fall back to a live read rather than dropping the statement.
      const state = context?.state as { inheritedSessionModel?: SessionModel | null } | undefined;
      let sessionModel: SessionModel | undefined;
      if (state === undefined) {
        sessionModel = options.getSessionModel?.();
      } else {
        if (state.inheritedSessionModel === undefined) {
          state.inheritedSessionModel = options.getSessionModel?.() ?? null;
        }
        sessionModel = state.inheritedSessionModel ?? undefined;
      }
      return renderSubagentToolCall(args as SubagentCallArgs, theme, {
        ...(context?.invalidate === undefined ? {} : { requestInvalidate: context.invalidate }),
        ...(context?.isPartial === undefined ? {} : { isPartial: context.isPartial }),
        ...(context?.state === undefined ? {} : { state: context.state }),
        ...(context?.expanded === true ? { expanded: true } : {}),
        ...(sessionModel === undefined ? {} : { sessionModel }),
      });
    },
  });
}
