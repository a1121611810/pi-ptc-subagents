/**
 * The route registry: the ONE home for every piece of model-facing prose this
 * package writes about its tools and its routes.
 *
 * ## Why this file exists
 *
 * The prose used to live in the modules that needed it, and a sentence that two
 * surfaces needed was written twice. The inventory that found them is the
 * evidence: three duplicates had survived every earlier cleanup — the
 * `agent`-is-optional clause (in both PTC descriptions), the program-body
 * sentence (in both parameter schemas), and the `whySuppressed` description (in
 * both output schemas). Each of those was a fix that had been made once and
 * copied, which is exactly the shape that drifts.
 *
 * So the rule is not "be careful" — it is "there is one place to be careful in".
 * Every sentence the model reads about a tool lives here, and the tool file
 * RENDERS it back. A second copy is no longer possible without writing the
 * literal again, and a test refuses the literal.
 *
 * ## Two zones
 *
 * - `TOOLS` — one entry per model-visible tool: what it is (the FACT half), the
 *   one-line snippet pi puts in "Available tools", and the bullets pi puts in
 *   the flat "Guidelines" section.
 * - `ROUTES` — one entry per road: when to take it, how to call it on each
 *   surface, the facts, and a pointer to the detail file. **The zone and its
 *   type are here; the entries are ticket #246's**, which also renders the
 *   resident index and publishes the detail files.
 *
 * ## What stays OUT
 *
 * - **Parameter schemas, descriptions included.** A parameter's description
 *   belongs with the parameter (spec decision 10, rule 9): splitting the two
 *   makes the schema harder to read, not easier.
 * - **The binding contract.** It answers "what does a call resolve to", a
 *   different question from "what is this tool", and it has its own record, its
 *   own token budget and its own two-way tests. The registry says WHERE it
 *   goes (a slot); the contract module owns WHAT it says.
 * - **Renderers.** A renderer turns live data into text; the data is not prose
 *   and the renderer is not a sentence.
 * - **The dynamic binding list** the session injects: which tools are bound is a
 *   fact about this session, not about any tool.
 *
 * ## The two shapes a description can take
 *
 * A description is an ORDERED list of paragraphs, because the order is part of
 * the prose. A paragraph is either this registry's own text, or a SLOT: a place
 * where prose this registry does not own goes. Two kinds of slot exist:
 *
 * - the binding contract, which is always there (it is the shape of a call);
 * - a session's own note — this session's children can search, this session's
 *   search has no credential, this install has these agent definitions. A
 *   capability is a fact about the session, so the session fills the slot in
 *   and the tool file names none of it.
 */
import type { SurfaceMode } from "../mode/ptc-mode.ts";

// ---------------------------------------------------------------------------
//  the shared sentences
// ---------------------------------------------------------------------------

/**
 * The `agent` name is optional — the clause two descriptions used to write out
 * separately.
 *
 * ONE constant, because the sentence says the same thing on both surfaces and a
 * copy is a thing that can drift. A test asserts that both descriptions carry
 * this exact text.
 */
export const AGENT_OPTIONAL_CLAUSE: string =
  "**the `agent` name is optional** — omit it and the child is a fresh generalist pi with pi's own " +
  'prompt and toolset; add `agent: "reviewer"` only to narrow it to a registered definition, ' +
  "because a name with no definition behind it is refused.";

/**
 * What the program's body is — the sentence two parameter schemas used to write
 * out separately (`code` on one surface, `script` on the other).
 *
 * The schema itself stays with its parameter; only the TEXT that both schemas
 * share comes from here, so the two cannot say different things about the same
 * program.
 */
export const PROGRAM_BODY_DESCRIPTION: string =
  "The program: the body of an async TypeScript function.";

/**
 * What `whySuppressed` means — the sentence two output schemas used to write out
 * separately (the codemode door's `whySuppressed` and the task output's
 * `why_suppressed`).
 *
 * The two used to end differently, because each carried one fact the other did
 * not: the codemode door has to say that a handle carries no key at all, and
 * the task output has to say that the dropped value is not stored anywhere.
 * Both facts are true on both surfaces, so the sentence says both.
 */
export const WHY_SUPPRESSED_DESCRIPTION: string =
  "`true` when you passed a `why` and this session's `whyEnabled` switch was off, so the child's " +
  "prompt carried no <pi-ptc-why> block (ADR-0043). ABSENT means no `why` was passed — that is " +
  "the distinction the key exists to make. The child was never told your reason; it did not ignore " +
  "one. The dropped value is not stored anywhere, and a handle does not carry this key at all — " +
  "read a task you did not wait for with `ptc_task_output` instead.";

/**
 * How a `codemode` script reaches a child, stated on both PTC surfaces.
 *
 * Measured 2026-10-16 (spike round 2, the dispatch-loop e2e note,
 * `docs/research/dispatch-loop-e2e-spike-20261016.md`): a
 * `codemode` script that decides to fan out looks in its own tool table, finds no `pi.dispatch`,
 * and nothing model-facing says the two-hop path exists — the script's author then reads the
 * silence as "this install does not register the binding" and falls back. The binding's own
 * calling convention is already stated in both descriptions, but those sentences address a reader
 * *inside* a program; this note is the one that addresses a reader inside the script.
 *
 * **Measured again 2026-10-20, on the `codemode_ptc` surface**, and the finding was sharper than
 * the first one: the note was in the parent's context (it rides in `ptc_run_code`'s description, which
 * pi's own `codemode` description enumerates for the script) and the parent STILL wrote
 * `await tools["pi.dispatch"]({ task })` into a `codemode` script, and got
 * `TypeError: tools.pi.dispatch does not exist`. It burned three calls that way before it fell
 * back to the codemode door and created the task successfully. So the note's positive half — "call
 * `ptc_run_code` and use the binding inside the program" — was true, and it was not enough: the
 * note sat BELOW an example that read `await tools["pi.dispatch"]({ task: "..." })` with no scope
 * on it, and a model copying an example does not check the paragraph under it. Hence two changes
 * that this record exists to justify:
 *
 * 1. The example is now scoped to a program ("inside the program"), in both descriptions.
 * 2. This note names the ONE-HOP route first, and points the reader at its own tool table rather
 *    than at a route it has to infer. The codemode door is registered only on the `codemode_ptc`
 *    surface, so the note cannot promise it unconditionally — but a script can SEE its own table,
 *    and `ptc_run_code` / `ptc_workflow` are on every surface.
 *
 * One shared constant rather than a sentence per surface, so the two cannot drift — the same
 * reason `BINDING_CONTRACT` is a module-owned string (ADR-0024). ADR-0052 changed the two door
 * names it names and the word it uses for what a script does: a script CREATES A TASK, and the
 * model-facing word is never "dispatch".
 */
export const PTC_BINDING_REACH_NOTE: string =
  "A `codemode` script cannot call the PTC binding directly: `pi_task_ptc` is never in " +
  "that script's own tool table, on any surface. A script creates a task through the door " +
  "that IS in its own table: `pi_task_codemode` if the session has it, and otherwise `ptc_run_code` " +
  "or `ptc_workflow` with the binding used inside the program.";

/**
 * The sentence that tells the PARENT that a child can search the web.
 *
 * **The parent has no web tool of its own** — the search module lives in the child (ADR-0049)
 * — so the only route to the web is a task whose child searches. But the parent's model reads
 * neither the child's tool list nor the search tool's description, so without this sentence the
 * parent has no reason to believe a child can search; the live end-to-end run measured it
 * writing a task that said "use bash/curl", and the child duly curled instead of using
 * `web_ds_search`.
 *
 * **It is ONE sentence in ONE place, carried by every model-facing surface that mentions the
 * route**: the two PTC tool descriptions, the `<ptc>` section, and the mode briefing. Those are
 * the places the parent's model reads when it decides what to write, and four copies of one fact
 * are four things that can drift — the `<ptc>` section and the briefing already had their own
 * wording, and the section's had been rewritten while the briefing's had not.
 *
 * **The vocabulary is TASK, not "dispatch"** (ADR-0052). The thing the model creates is a task;
 * "dispatch" is what the task side does with a task afterwards, and it is not the model's word.
 *
 * **It is stated as what this package PROVIDES, not as what the model can reach by any means:**
 * a session that still has `bash` can always curl, so a sentence claiming the model has no way
 * to the web would be false there. "This package gives you no web tool of your own" is the claim
 * that survives that.
 */
export const PTC_CHILD_SEARCH_NOTE: string =
  "This package gives you no web tool of your own, but a child does: it can search the web with" +
  " its `web_ds_search` tool (and fetch a page's text). When the task needs the web — a fact you" +
  " cannot know, or a page you have to find — create a task and let the child search.";

/**
 * What a task door resolves to, and what a refusal looks like (ADR-0054).
 *
 * ONE constant, TWO surfaces: the PTC door's note in the binding contract, and the codemode
 * door's description. They say the same thing to a model on two different planes, and a
 * sentence written twice is a sentence that will drift — the failure this whole registry exists
 * to prevent. A test asserts that both sides contain this exact text.
 *
 * Door-agnostic on purpose ("a task door", not a name): the note has to name the binding it is
 * about, and the description belongs to a tool that is not a binding, so a name would be wrong in
 * one of the two places.
 *
 * The refusal half is ADR-0054's: a refusal is a RESULT on both doors — `status: "rejected"` plus
 * an `errorMessage` — and never an exception. The codemode door used to throw, which made a
 * refused call indistinguishable from a broken one.
 *
 * ADR-0055: the shape half is the WAIT MODE. A task door resolves with a handle unless the
 * caller asks it to wait, so a note that said "resolves to `{ text, status, ... }`" was wrong for
 * the default call. The note now names both shapes and the one parameter that chooses between
 * them — and it says which one you get by default, because that is the half a reader gets
 * wrong.
 */
export const TASK_DOOR_RESULT_NOTE: string =
  "A task door never throws and has no `content`: without `wait: true` it resolves with a " +
  'handle (`taskId`, `label`), and a refusal is a result with `status: "rejected"` and an ' +
  "`errorMessage`, so read those two.";

/**
 * ADR-0057: what a stop does, in one sentence.
 *
 * A task that is still WAITING for a concurrency slot is withdrawn from the queue and never
 * starts; a task that is already RUNNING is signaled by the dispatcher and goes through
 * `stopping` to `canceled`. Those are two different edges — libuv's cancel API makes the same
 * split, returning 0 for a work item still in the queue and a busy code for one a worker has
 * already taken.
 *
 * ONE source, because the same sentence reaches the model on two surfaces: the tool's
 * `description` (pi's tool declaration) and the guideline pi puts into the system prompt. Two
 * copies of the same sentence are two things that can drift, and the drift stays invisible
 * until a model reads one of them and acts on the other.
 */
export const TASK_STOP_SEMANTICS: string =
  "A task that is still waiting for a concurrency slot is withdrawn from the queue and never starts; " +
  "a task that is already running is signaled by the dispatcher and goes through stopping to canceled.";

/**
 * What the child is told when it reports (ADR-0032).
 *
 * Each line earns its place: what the call is FOR, the shape, the two fields whose meaning is
 * not guessable (`evidence`, `files_touched`), the fact that its prose survives, and the one
 * thing it must not send.
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
 * The guidelines the two PTC tools share.
 *
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

/**
 * The guidelines the three task tools share.
 *
 * The stop guideline carries ADR-0057's shared sentence, so a stop reads the same way in the
 * description and in the system prompt.
 */
export const PTC_TASK_TOOL_GUIDELINES: readonly string[] = [
  "Use ptc_task_list to see the tasks this session created and their live status.",
  "Use ptc_task_output to read a task's captured output (it is tail-truncated; the footer names the full-output file). A succeeded task's child report is rendered there, ahead of the prose.",
  "Use ptc_task_stop to stop a task: " + TASK_STOP_SEMANTICS,
  "PTC off stops NEW children from being started, pulls the queued ones out of the queue, and takes these tools out of reach while the session has no task record; a task already running keeps going and stays listed here.",
];

// ---------------------------------------------------------------------------
//  the `<ptc>` section's body
// ---------------------------------------------------------------------------

/**
 * How to create a task, per surface.
 *
 * `full_ptc` names the program form because that is the only form the model has: the two PTC
 * tools are offered to it directly. `codemode_ptc` names the codemode door, and says the one
 * thing that is false everywhere else — a `codemode` script's tool table has no `pi_task_ptc`
 * in it.
 *
 * ADR-0052: the model-facing word is TASK, never "dispatch" — the door creates a task, and
 * dispatching is what the task side does with it afterwards. Both names are plain JavaScript
 * identifiers, so both planes call them with a dot.
 *
 * **This is the road the route table will carry.** Ticket #246 fills the `ROUTES` zone with one
 * entry per road and renders the resident index from it; until then the `<ptc>` section renders
 * these two lines directly.
 */
export const TASK_ROUTE_LINES: Readonly<Record<SurfaceMode, string>> = {
  full_ptc:
    "To create a task, write a program and run it with `ptc_run_code`; inside that program the " +
    "binding is `await tools.pi_task_ptc({ task })`.",
  codemode_ptc:
    "To create a task, call `tools.pi_task_codemode` from your `codemode` script. A `codemode` " +
    "script's tool table does not contain `pi_task_ptc` — that name is not a tool there, and " +
    "calling it from a script fails.",
};

/**
 * The one sentence a truncated session says, whichever surface it is (ADR-0058).
 *
 * One constant, because it is ONE sentence in one place — and it is carried by BOTH the model's
 * section and the user's notice, so the two cannot drift into telling the model one thing and the
 * user another.
 *
 * It states the fact and nothing about how it happened: the switch withdraws this package's
 * segment of the chain, and what that means for the model is the same on both surfaces — no task
 * can be created any more.
 */
export const PTC_TRUNCATED_NO_NEW_TASK: string = "No new task can be created from here on.";

/**
 * The line the `<ptc>` section carries when the session is truncated (ADR-0058).
 *
 * One constant because it is ONE sentence in one place — and it is carried by the model's
 * section and by the user's notice alike, so the two cannot drift into telling the model one
 * thing and the user another.
 */
export const PTC_TRUNCATED_SECTION_LINE: string =
  "PTC is off in this session. " + PTC_TRUNCATED_NO_NEW_TASK + " Do not try to create one.";

/**
 * What each surface lost, and what is left (ADR-0058).
 *
 * The two lines differ because the two surfaces truncate at different places, and the difference
 * is not cosmetic: on `full_ptc` there is no orchestrator left at all, while on `codemode_ptc`
 * pi's `codemode` keeps orchestrating and only this package's segment under it is gone.
 *
 * The withdrawn tools are NAMED, because a model that saw them a turn ago needs to know they are
 * gone rather than keep calling into a tool that is no longer there. What is not given is the
 * calling convention — telling a model HOW to create a task in a session where it cannot is an
 * instruction it cannot follow (ADR-0050 decision 6).
 */
export const PTC_TRUNCATION_SECTION_LINES: Readonly<Record<SurfaceMode, string>> = {
  full_ptc:
    "The PTC program tools (`ptc_run_code`, `ptc_workflow`) are withdrawn — there is no " +
    "orchestrator left, so the built-in tools are what the model calls now.",
  codemode_ptc:
    "The PTC execution layer (`ptc_run_code`, `ptc_workflow`) and the task door " +
    "(`pi_task_codemode`) are withdrawn — `codemode` still orchestrates, but it can no longer " +
    "create a task.",
};

// ---------------------------------------------------------------------------
//  the TOOLS zone
// ---------------------------------------------------------------------------

/**
 * The slots a description can leave for prose this registry does not own.
 *
 * - `bindingContract` — what a `tools.<name>(args)` call resolves to. Always filled: it is
 *   the shape of a call, and it stays in the binding contract's own module.
 * - `childSearchNote` — the web route, filled when this session's children can search.
 * - `searchUnavailable` — the search module's notice, filled when the capability is on but
 *   has no credential.
 * - `agentRoster` — the registered agent definitions, rendered per install.
 */
export type DescriptionSlot =
  | "bindingContract"
  | "childSearchNote"
  | "searchUnavailable"
  | "agentRoster";

/**
 * One paragraph of a tool description.
 *
 * Either this registry's own text, or a SLOT — a place where prose this registry does not own
 * goes. The ORDER is part of the prose, so the paragraphs are a list and not a string.
 */
export type DescriptionParagraph =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "slot"; readonly slot: DescriptionSlot };

/** One tool's model-facing prose. */
export interface ToolEntry {
  /** The tool's registered name. */
  readonly name: string;
  /** The description's paragraphs, in the order the model reads them. */
  readonly description: readonly DescriptionParagraph[];
  /** The one-line entry pi puts in the "Available tools" section. */
  readonly snippet: string;
  /** The bullets pi puts in the flat "Guidelines" section. */
  readonly guidelines: readonly string[];
}

/** The model-visible tools, by name. */
export type ToolName =
  | "ptc_run_code"
  | "ptc_workflow"
  | "pi_task_codemode"
  | "ptc_task_list"
  | "ptc_task_output"
  | "ptc_task_stop"
  | "ptc_child_report"
  | "web_ds_search";

/**
 * Every model-visible tool, with the prose the model reads about it.
 *
 * **`pi_task_ptc` is NOT here.** It is not a declared tool: the model only ever sees it as a
 * binding inside a program, so it has no description, no snippet and no guidelines of its own.
 * The binding contract covers what a call to it returns.
 */
export const TOOLS: Readonly<Record<ToolName, ToolEntry>> = {
  ptc_run_code: {
    name: "ptc_run_code",
    description: [
      {
        kind: "text",
        text:
          "Run a TypeScript program that composes pi's tools in one shot. Required arguments: " +
          "`code` — the body of an async function (top-level `return` and `await` work; type " +
          "annotations are advisory, the code runs type-stripped) — and `description`, a 5-10 word " +
          "summary of what the program does.",
      },
      {
        kind: "text",
        text:
          "Inside the program, call this session's enabled built-in tools as `tools.<name>(args)` " +
          '— e.g. `await tools.read({ path: "src/index.ts" })`. The bound names are this ' +
          "session's active built-in tools, less any binding the install has not explicitly opted " +
          "in — this surface is narrower than the session's tool list on purpose; independent " +
          "calls may overlap under `Promise.all`.",
      },
      {
        kind: "text",
        text:
          "The PTC door `pi_task_ptc` is always available — inside the program, call it with a " +
          'dot, e.g. `await tools.pi_task_ptc({ task: "..." })`; ' +
          AGENT_OPTIONAL_CLAUSE +
          " It fans work out to child pi agents, and independent tasks compose under " +
          "`Promise.all` exactly like the built-in calls. The run's actual bound names (this run, " +
          "not a static list) are on the `ptcBindings` global, so the program never has to guess " +
          "what is bound.",
      },
      { kind: "text", text: PTC_BINDING_REACH_NOTE },
      { kind: "slot", slot: "bindingContract" },
      {
        kind: "text",
        text:
          "Only the program's return value and its `console.log` output come back. This surface " +
          "has no helpers: `log` / `phase` / `parallel` / `pipeline` exist only in " +
          "`ptc_workflow`.",
      },
      {
        kind: "text",
        text:
          "Image-bearing tool results inside the program (a `tools.read` on a PNG, say) are " +
          "attached to you after the run, so never return image data as the completion value — " +
          "that only spends your context on base64.",
      },
      { kind: "slot", slot: "childSearchNote" },
    ],
    snippet:
      "Run a TypeScript program that composes pi's tools in one shot (tools.<name>(args)); only its return value and console.log come back",
    guidelines: PTC_TOOL_GUIDELINES,
  },
  ptc_workflow: {
    name: "ptc_workflow",
    description: [
      {
        kind: "text",
        text:
          "Run a structured TypeScript workflow: a named plan that reports phases and narration " +
          "as it goes. `script` is the body of an async function, `meta` names it " +
          "(`{ name, description, phases? }`, where `phases` is the ordered plan), and optional " +
          "`args` is plain-JSON input bound to the program's `args` global.",
      },
      {
        kind: "text",
        text:
          "Helpers inside the script: `log(message)` narrates progress; `phase(title)` frames the " +
          "workflow (titles outside `meta.phases` are reported as warnings); `parallel(thunks)` " +
          "runs thunks concurrently, a failed item becoming `null`; `pipeline(items, ...stages)` " +
          "chains stages per item with the same per-item `null` on failure. There is no `agent()` " +
          "helper.",
      },
      {
        kind: "text",
        text:
          "Tools are reachable as `tools.<name>(args)` exactly as in `ptc_run_code`, and the bound " +
          "names are this session's enabled built-ins less any binding the install has not opted " +
          "in. The PTC door `pi_task_ptc` is always available — inside the program, call it with " +
          "a dot: `await tools.pi_task_ptc({ task })`; " +
          AGENT_OPTIONAL_CLAUSE +
          " The run's actual bound names are on the `ptcBindings` global. What comes back is the " +
          "script's return value, its `log`/`phase` narration and its `console.log` output.",
      },
      { kind: "text", text: PTC_BINDING_REACH_NOTE },
      { kind: "slot", slot: "bindingContract" },
      {
        kind: "text",
        text:
          "Image-bearing tool results inside the script are attached to you after the run — never " +
          "return image data as the script's value.",
      },
      { kind: "slot", slot: "childSearchNote" },
    ],
    snippet:
      "Run a structured TypeScript workflow with named phases, narration (log/phase) and structured concurrency (parallel/pipeline)",
    guidelines: PTC_TOOL_GUIDELINES,
  },
  pi_task_codemode: {
    name: "pi_task_codemode",
    description: [
      {
        kind: "text",
        text:
          "Create a task: start a fresh pi agent as a child process — it gets its own context and " +
          "tools, and it cannot see or change this session except through what it returns. Omit " +
          "`model` and the child inherits this session's current model (when this pi exposes one; " +
          "otherwise it falls back to pi's configured default); pass `model`, or let its agent " +
          "definition pin one, to override that. Use it for work that would otherwise flood this " +
          "context: a survey, a second opinion, or a task that can run while you do something " +
          "else.",
      },
      {
        kind: "text",
        text:
          "The call returns a handle right away — the task id and its label — and the task runs " +
          "on; pass `wait: true` when you need the result before you go on, and read a task you " +
          "did not wait for with ptc_task_output.",
      },
      {
        kind: "text",
        text:
          "`agent` is optional — omit it and the child is a fresh generalist pi, with pi's own " +
          "system prompt and pi's full toolset. Name one to narrow the child instead: an agent is " +
          "a markdown file in ~/.pi/agent/agents/ for your machine, or <project>/.pi/agents/ for " +
          "one project, and naming one can restrict the child's tools, pin its model, or append a " +
          "role. A name with no definition behind it is refused; the refusal lists what IS " +
          "registered and how to write one.",
      },
      { kind: "text", text: TASK_DOOR_RESULT_NOTE },
      { kind: "slot", slot: "agentRoster" },
    ],
    snippet:
      "Create a task: start a fresh pi agent as a child process (it runs on; wait: true to wait for the result)",
    guidelines: [
      "Prefer one subagent over many tool calls when the work is a question with an answer rather than a fact you can look up, or when the raw output would be larger than the answer.",
    ],
  },
  ptc_task_list: {
    name: "ptc_task_list",
    description: [
      {
        kind: "text",
        text:
          "List the tasks this session has created (`pi_task_ptc` creates one, and it keeps " +
          "running unless you wait for it).",
      },
      {
        kind: "text",
        text: "Returns each task's id, status, agent, depth, label and output size, newest first.",
      },
      {
        kind: "text",
        text: 'Filter with status (e.g. ["running"]); limit caps the row count (default 100).',
      },
    ],
    snippet:
      "List this session's tasks and their live status (id, status, agent, label, output size)",
    guidelines: PTC_TASK_TOOL_GUIDELINES,
  },
  ptc_task_output: {
    name: "ptc_task_output",
    description: [
      { kind: "text", text: "Read a task's captured output." },
      {
        kind: "text",
        text:
          "A succeeded task also renders its child report (summary, findings, files touched, " +
          'usage) ahead of the prose, and says which channel delivered it; a channel of "none" ' +
          "means the child ignored the report contract.",
      },
      {
        kind: "text",
        text:
          "A failed or lost task also states the record's error message — the reason it did not " +
          "succeed — ahead of the output, so an empty output.log is not mistaken for an " +
          "infrastructure fault.",
      },
      {
        kind: "text",
        text:
          "The text is tail-truncated to pi's ADR-0015 limits (50 KB / 2000 lines); when anything " +
          "is cut, outputFullPath names a file with the complete output.",
      },
      {
        kind: "text",
        text: "Pass sinceBytes to skip a prefix of the stored output when paging.",
      },
    ],
    snippet: "Read a task's output (tail-truncated, with the full-output file path)",
    guidelines: PTC_TASK_TOOL_GUIDELINES,
  },
  ptc_task_stop: {
    name: "ptc_task_stop",
    description: [
      { kind: "text", text: "Ask a task to stop." },
      { kind: "text", text: TASK_STOP_SEMANTICS },
      {
        kind: "text",
        text:
          "The call is idempotent when the task is already stopping, and errors when the task is " +
          "already terminal.",
      },
    ],
    snippet: "Ask a task to stop (queued: withdrawn, running: signaled)",
    guidelines: PTC_TASK_TOOL_GUIDELINES,
  },
  ptc_child_report: {
    name: "ptc_child_report",
    description: [{ kind: "text", text: CHILD_REPORT_DESCRIPTION }],
    snippet: "Hand the host a child report when you finish",
    guidelines: [
      "Call " +
        "ptc_child_report" +
        ' once before you finish, even when the answer is "I changed nothing": a child that reports an empty result is a different thing from a child that never reported, and only the first one says so.',
    ],
  },
  web_ds_search: {
    name: "web_ds_search",
    description: [
      {
        kind: "text",
        text: [
          "Search the web through DeepSeek's Search API, or open one page.",
          "**Three actions, one at a time.** `query` searches, `open` opens one page, `find` looks for a string inside one page. Give exactly one of them.",
          "**Call it directly, the way you call any other tool.** It is not a PTC binding, so a program you write cannot call it: `tools.web_ds_search` is not a function.",
          "A search returns an OVERVIEW — one entry per result: title, url, authority, rerank_score, date, and DeepSeek's own short snippet. It does NOT return each page's full text.",
          "**Want a page's substance? Call `open` with that result's url.** It costs nothing when the page came from a search you just did, and one request otherwise.",
          "**Want one passage out of a long page? Call `find` with the url and the string you are looking for** — you get the line numbers where it appears, not the whole page.",
          "`url` is the only source identifier in a result, so build citations from it.",
          "Set `need_content` only when you want each result's whole body — it makes the search's payload much larger.",
          "A fetched page's body may carry backslash escapes before punctuation (`\\|`, `\\-`, `\\.`): that is the API's own formatting, not corruption, and the text is still readable.",
          "A failure comes back as a sentence saying whether to retry, change the source or recharge; read it and act on it.",
        ].join("\n"),
      },
      { kind: "slot", slot: "searchUnavailable" },
    ],
    snippet: "Search the web, or fetch a page, through DeepSeek's Search API",
    guidelines: [
      "Prefer `summary` over `content` when you only need to judge a result — `content` is the whole page and it makes the result large.",
      "A search that matched nothing is not an error: it comes back with an empty `results` and a sentence saying so.",
    ],
  },
};

// ---------------------------------------------------------------------------
//  the ROUTES zone
// ---------------------------------------------------------------------------

/**
 * One road: when to take it, how to call it on each surface, the facts, and a
 * pointer to the detail file.
 *
 * The shape is the spec's prototype (spec #234, implementation decision 8). The
 * entries are ticket #246's: this ticket creates the zone and the type, and
 * #246 fills it and renders the resident index from it.
 */
export interface RouteEntry {
  /** The road's stable id; the detail file is `docs/routes/<id>.md`. */
  readonly id: string;
  /** What the road is called, in the model's words. */
  readonly name: string;
  /** When to take this road rather than another one. */
  readonly when: string;
  /** How to call it, per surface. Every surface says something — "not applicable" is an answer. */
  readonly how: Readonly<Record<SurfaceMode, string>>;
  /** The facts the road carries. Never empty: a road with no facts is prose, not a route. */
  readonly fact: string;
  /** The detail file this road points at. */
  readonly detail: string;
}

/**
 * Every road this package offers, one per row.
 *
 * **Empty in this ticket by design.** The zone and its type are here; the entries
 * are ticket #246's, which also renders the resident `<ptc>` index from them and
 * publishes the detail files the index points at.
 */
export const ROUTES: readonly RouteEntry[] = [];

// ---------------------------------------------------------------------------
//  rendering
// ---------------------------------------------------------------------------

/**
 * Render one tool's description.
 *
 * `filled` is what the slots hold in this session. A slot with no entry is left
 * out entirely and the paragraphs around it close up — so "this session has no
 * web tool" is expressed by the ABSENCE of the sentence, which is the only
 * honest way to say it.
 *
 * The registry owns the order and the text; a caller says which paragraphs this
 * session has. That is the whole division of labour.
 */
export function renderDescription(
  entry: ToolEntry,
  filled: Readonly<Partial<Record<DescriptionSlot, string>>> = {},
): string {
  const blocks: string[] = [];
  for (const part of entry.description) {
    if (part.kind === "text") {
      blocks.push(part.text);
      continue;
    }
    const value = filled[part.slot];
    if (value !== undefined) blocks.push(value);
  }
  return blocks.join("\n\n");
}
