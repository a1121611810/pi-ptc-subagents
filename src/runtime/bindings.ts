/**
 * Bindings: the pi tools a PTC program may call as `tools.<name>(args)`.
 *
 * R5 found that pi's extension API exposes no tool-dispatch surface — `pi.on('tool_call')`
 * only fires from the agent loop, `extensionsResult.runtime` is state plumbing, and
 * `pi.exec` has no `execArgv`/`resourceLimits`/`stdio`. So a binding builds the tool with
 * pi's own SDK factory and calls `execute()` on it directly. That keeps the tool
 * implementation identical to the native one, but it also means worker-driven calls are
 * **not** seen by pi's tool-call pipeline: `tool_call` guards, `protected-paths`-style
 * extensions, permission gates and sandbox overrides never run for them. This is the
 * inherited risk ADR-0005 accepts and records — it must not be described as resolved, and
 * nothing here may pretend to route through `pi.on('tool_call')`.
 *
 * Arguments are validated with pi's own `validateToolArguments`, the same helper the agent
 * loop uses, so a bad call fails with the same message (and the same coercion) it would
 * get from the native pipeline.
 */
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { ULID } from "./task-storage.ts";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TBoolean, TLiteral, TObject, TOptional, TSchema, TString, TUnion } from "typebox";

import {
  dispatch as dispatchBinding,
  isMalformedAgentName,
  missingAgentResult,
  resolveReadOnlyTier,
  resolveWhy,
  withReadOnlyTier,
  withWhySuppressed,
  type DispatchDeps,
  type DispatchInput,
} from "./dispatch.ts";

/** pi's built-in tools that can be exposed as bindings, in native order. */
export const BUILTIN_BINDING_NAMES = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;
export type BuiltinBindingName = (typeof BUILTIN_BINDING_NAMES)[number];

/** Parallel binding name (ADR-0016). */
export const DISPATCH_BINDING_NAME = "pi.dispatch" as const;

/**
 * Bindings that are known but NOT exposed unless someone asks for them (#73).
 *
 * `bash` is here rather than deleted from {@link BUILTIN_BINDING_NAMES} because DSH's PTC preset
 * still mounts `tool-bash`/`tool-pwsh` (R1 §2 — PTC mode hides the tools from the wire list and
 * re-exposes the same registry as bindings), so a PTC program written against DSH may run shell
 * commands. Removing it outright would break those programs; leaving it on by default hands every
 * model-written program a shell with the user's own identity, which is the larger risk. An explicit
 * opt-in is what makes the second case a decision instead of a default.
 */
export const OPT_IN_BINDING_NAMES = ["bash"] as const;
export type OptInBindingName = (typeof OPT_IN_BINDING_NAMES)[number];

/** Whether `name` is one of the {@link OPT_IN_BINDING_NAMES}. */
export function isOptInBindingName(name: string): name is OptInBindingName {
  return (OPT_IN_BINDING_NAMES as readonly string[]).includes(name);
}

/**
 * Validate a caller's opt-in list and return it in {@link BUILTIN_BINDING_NAMES} order.
 *
 * Order is normalised rather than kept as given so that a table built with and without an opt-in
 * lists the same bindings in the same sequence — the model-facing prompt renders this list, and two
 * spellings of the same surface would be two things to drift.
 *
 * A name that is not an opt-in is refused, including a name that IS a known builtin: `["read"]` is
 * a configuration mistake, not a request, and accepting it would mean `optIns` silently no-ops for
 * every name a caller already had by default.
 */
export function resolveOptInBindingNames(
  optIns: readonly string[] | undefined,
): readonly BuiltinBindingName[] {
  if (optIns === undefined) return [];
  const requested = new Set(optIns);
  for (const name of requested) {
    if (!isOptInBindingName(name)) {
      throw new TypeError(
        `unknown PTC opt-in binding "${name}"; opt-in bindings: ${OPT_IN_BINDING_NAMES.join(", ")}`,
      );
    }
  }
  return BUILTIN_BINDING_NAMES.filter((name) => requested.has(name));
}

/**
 * Bindings exposed when the caller does not pass an explicit name list and does not opt in.
 *
 * The known set minus {@link OPT_IN_BINDING_NAMES}, in native order. Both resolution paths emit
 * {@link BUILTIN_BINDING_NAMES} order, so adding an opt-in re-inserts the binding where the model
 * expects it rather than at the end.
 */
export const DEFAULT_BINDING_NAMES: readonly BuiltinBindingName[] = BUILTIN_BINDING_NAMES.filter(
  (name) => !isOptInBindingName(name),
);

export interface BindingContext {
  /** Aborted when the run is cancelled, times out, or settles. */
  signal?: AbortSignal;
  /** Wire call id; also used to build the tool call id the tools see. */
  callId: number;
  /** Depth of the current PTC run (0 for parent turn, 1+ for a child of `pi.dispatch`). */
  depth: number;
  /** Maximum allowed depth; passed through to `pi.dispatch` for the depth check. */
  maxDispatchDepth: number;
  /**
   * ADR-0022 §5: the TaskRecord owner / subscription subscriber. The dispatcher threads the
   * run id here so a background task's events are addressed to the spawning run.
   */
  callerId?: string;
  /**
   * ADR-0022 R1: the session dir a background child persists into. Threaded from the
   * dispatcher (see `RunPtcProgramOptions.sessionDir`); when no dir is available the spawn
   * keeps the foreground no-session shape.
   */
  sessionDir?: string;
  /**
   * ADR-0022 §3/reopen R-m12: this process's own background task id, when this run is inside a
   * background child. Threaded from the dispatcher (see `RunPtcProgramOptions.parentTaskId`)
   * and forwarded to `pi.dispatch` so a nested spawn records `TaskRecord.parentTaskId`.
   */
  parentTaskId?: ULID;
  /**
   * ADR-0022 §9: per-run dispatch dependencies. The dispatcher supplies the run's shared
   * `DispatchSlotCounter` here; a host may also pass session-level deps (registry / lifecycle /
   * output storage) so the binding's `dispatch()` call shares them.
   */
  dispatchDeps?: DispatchDeps;
}

export interface Binding {
  readonly name: string;
  execute(args: unknown, context: BindingContext): Promise<unknown>;
}

export type BindingTable = ReadonlyMap<string, Binding>;

/**
 * Structural view of an SDK tool, wide enough for every `createXxxTool(cwd)` factory.
 *
 * `params: never` is what makes the seven typed factories assignable to one shape: a
 * function that takes `Static<typeof readSchema>` accepts a `never`, and `never` is what
 * the wire hands us before validation.
 */
interface AnyBuiltinTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: TSchema;
  execute(
    toolCallId: string,
    params: never,
    signal?: AbortSignal,
    onUpdate?: unknown,
  ): Promise<{
    content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
    details?: unknown;
    /**
     * pi 1.0.0's non-throwing failure channel. Absent means success, so this is compared
     * against `true` rather than tested for truthiness — see `bindingFailureMessage`.
     */
    isError?: boolean;
  }>;
}

const BUILTIN_TOOL_FACTORIES: Record<BuiltinBindingName, (cwd: string) => AnyBuiltinTool> = {
  read: createReadTool,
  bash: createBashTool,
  edit: createEditTool,
  write: createWriteTool,
  grep: createGrepTool,
  find: createFindTool,
  ls: createLsTool,
};

/** Argument type of pi's `validateToolArguments`, i.e. pi-ai's `ToolCall`. */
type ToolCallLike = Parameters<typeof validateToolArguments>[1];

/**
 * The `pi.dispatch` argument schema, validated with pi's own `validateToolArguments`
 * exactly like the seven built-in bindings (field report pitfall #2: the binding used to
 * cast the wire args straight to `DispatchInput`, so a malformed call reached the
 * subprocess layer). `agent` / `task` must be non-empty strings; everything else is
 * optional and typed when present. Written out explicitly for `isolatedDeclarations`.
 */
type DispatchParameters = TObject<{
  agent: TString;
  task: TString;
  why: TOptional<TString>;
  cwd: TOptional<TString>;
  agentScope: TOptional<TUnion<[TLiteral<"user">, TLiteral<"project">, TLiteral<"both">]>>;
  model: TOptional<TString>;
  thinkingLevel: TOptional<TString>;
  background: TOptional<TBoolean>;
  label: TOptional<TString>;
  readOnly: TOptional<TUnion<[TLiteral<"strict">, TLiteral<"lenient">]>>;
}>;

/**
 * The parallel binding's argument schema. Exported so ADR-0025's top-level `ptc_subagent`
 * can declare the SAME arguments rather than a second hand-written copy that could drift: the
 * two are different call sites for one dispatcher, and a test pins their key sets equal.
 */
export const DISPATCH_PARAMETERS: DispatchParameters = Type.Object({
  // Optional (issue #185). The child is already a full-capability pi -- the dispatch prompt is
  // APPENDED to pi's system prompt, and no `--tools` flag is passed unless a definition declares
  // one -- so a definition can only narrow. Requiring a name therefore asked every caller to name
  // a narrowing that does not exist, and a fresh install could not dispatch at all until its user
  // had written a file first.
  agent: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Optional. Name a registered agent definition to narrow the child, or omit it entirely " +
        "for a fresh generalist pi with pi's own prompt and its full toolset. A name with no " +
        "definition behind it is refused; an empty string is refused.",
    }),
  ),
  task: Type.String({ minLength: 1 }),
  // ADR-0042, renamed from `goal` by ADR-0043. The description has to say WHEN to pass it, not
  // only what it is: an optional parameter whose purpose is left implicit is one the model never
  // uses, and an unused `why` makes E3 measure nothing. The description is unchanged by the rename
  // — it already opened with "Why this dispatch slice exists", so the key and its own prose now
  // agree on the word.
  why: Type.Optional(
    Type.String({
      description:
        "Why this dispatch slice exists, in your own words: the intent behind cutting this task " +
        "out, not the whole conversation and not the user's original request. Pass it when the " +
        "task involves judgment or trade-offs, so the child can resolve ambiguities the task " +
        "text leaves open instead of inventing context. Omit it for a fully specified task.",
    }),
  ),
  cwd: Type.Optional(Type.String()),
  // The default is "user", which does NOT see `<cwd>/.pi/agents/`. Without a description here
  // the model cannot know that, so it dispatches a project agent by name and gets a refusal —
  // the roster in the tool description labels each agent's scope for exactly this reason.
  agentScope: Type.Optional(
    Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("both")], {
      description:
        'Which agent directories to search: "user" (~/.pi/agent/agents, the default), "project" (<cwd>/.pi/agents), or "both". Defaults to "user", which cannot see project agents.',
    }),
  ),
  model: Type.Optional(Type.String()),
  thinkingLevel: Type.Optional(Type.String()),
  background: Type.Optional(Type.Boolean()),
  label: Type.Optional(Type.String()),
  // ADR-0041. A union of STRING LITERALS, and that is the whole reason this closes. Measured
  // against pi's `validateToolArguments`: including `Type.Boolean()` makes pi COERCE — `1` and
  // `"true"` are handed onward as `true`, `0` and `"false"` as `false` — so a boolean short
  // spelling silently turned a wrong-typed value into a tier, on the one parameter whose entire
  // job is to be unambiguous. A string-only union refuses all of them, and it is also the shape
  // tool schemas carry most widely. `true` as a short spelling for "strict" was dropped for this.
  readOnly: Type.Optional(
    Type.Union([Type.Literal("strict"), Type.Literal("lenient")], {
      description:
        'Ask for a read-only child. "strict": its tools are narrowed to the read set, so it ' +
        'cannot write anything. "lenient": its tools are left exactly as they would have been ' +
        "and it is only told to work without modifying anything. Omit for today\u2019s behaviour.",
    }),
  ),
});

/** Minimal `Tool` shape for pi's validator. */
const DISPATCH_TOOL_LIKE = {
  name: DISPATCH_BINDING_NAME,
  description:
    "Dispatch a task to a registered pi agent as a child subprocess (foreground await or background task).",
  parameters: DISPATCH_PARAMETERS,
};

/**
 * The read-only tier the caller asked for, read off the RAW (pre-validation) arguments.
 *
 * Raw rather than `validated`, and that is the whole point: these two refusals live INSIDE the
 * validation `catch`, where the arguments have failed `validateToolArguments` and the validated
 * value is not in hand. It also means a `readOnly` that failed validation contributes nothing —
 * which is correct, because it is not a tier anyone applied.
 *
 * ADR-0041 §Reporting: the field is present whenever a tier was requested. Without this, these
 * were the only `DispatchResult`s in the package that dropped it, because they never pass
 * through `dispatch()`'s refusal factories where `withReadOnlyTier` lives.
 */
function readOnlyTierOf(
  raw: Record<string, unknown> | undefined,
): ReturnType<typeof resolveReadOnlyTier> {
  return resolveReadOnlyTier(raw?.readOnly as Parameters<typeof resolveReadOnlyTier>[0]);
}

/**
 * ADR-0043: whether the caller's `why` was dropped, read off the RAW arguments for the same reason
 * {@link readOnlyTierOf} reads the tier off them — these two refusals live INSIDE the validation
 * `catch`, where the validated value is not in hand.
 *
 * The rule is NOT restated here. {@link resolveWhy} owns it, and it is the same rule `dispatch()`
 * applies a few lines later on the validated arguments: a blank `why` is never a suppression, and
 * only a switch that is explicitly `false` suppresses. Two spellings of that would let the binding
 * front and `dispatch()` disagree about what the field on a refusal means, which is the one thing
 * a caller reading it cannot check for itself.
 */
function whySuppressedOf(raw: Record<string, unknown> | undefined, enabled: boolean): boolean {
  return resolveWhy(raw?.why as DispatchInput["why"], enabled).suppressed;
}

export interface CreateBuiltinBindingsOptions {
  /** Per-run working directory: the F4 `RunConfig.cwd`, used to build every tool. */
  cwd: string;
  /**
   * Subset of {@link BUILTIN_BINDING_NAMES}; defaults to {@link DEFAULT_BINDING_NAMES} plus any
   * {@link CreateBuiltinBindingsOptions.optIns}. A list passed here is honoured VERBATIM: a caller
   * that curates names has already decided its surface, so an opt-in name in an explicit list is
   * taken at face value and the default gate does not apply to it.
   */
  names?: readonly string[];
  /**
   * Opt-in bindings to add to the default surface (#73). Each must be an
   * {@link OPT_IN_BINDING_NAMES} member or {@link resolveOptInBindingNames} throws. Omitted means
   * "none granted", which is the safe direction: an unreadable or absent opt-in list narrows the
   * surface rather than widening it.
   */
  optIns?: readonly string[];
  /**
   * Whether the parallel binding `pi.dispatch` (ADR-0016) joins the table. Defaults to
   * "did the caller curate the surface": `true` when `names` is omitted, `false` when an
   * explicit list is passed (R3's read-only PTC surface pattern). Deciding on whether
   * `names` was provided — not on array identity with {@link DEFAULT_BINDING_NAMES} —
   * matters because production callers resolve names through a `.filter()` that always
   * returns a fresh array. The two shipped tools pass `true` explicitly: the dispatch
   * binding is part of every production surface.
   */
  includeDispatch?: boolean;
}

/**
 * How much of a failed tool's own message is carried into the rejection the program sees.
 *
 * The rejection is a diagnostic, not a transport: the worker's `ToolCallError` wraps it, and a
 * 50 KB stdout dump inside an Error message would crowd out the failure that matters. pi already
 * appended "Command exited with code N" to the text, so the tail is kept -- that is the sentence
 * worth reading.
 */
/**
 * The cap on a binding failure's model-facing text: 2000 characters, tail-kept.
 *
 * This is OUR policy, not a host-provided value — pi exports no message-limit knob on any
 * version (checked the 1.0.0 and 1.2.0 export surfaces and the published settings schema). The
 * numeric match with pi's `DEFAULT_MAX_LINES = 2000` is coincidence: that constant caps a bash
 * output's LINE count through `core/tools/truncate.js`, a different mechanism in a different
 * domain (tool output files, not model-facing failure diagnostics).
 */
const FAILURE_MESSAGE_MAX_CHARS = 2000;

/**
 * The message a rejected binding call carries, taken from the tool's own model-facing text.
 *
 * pi 1.0.0 added a non-throwing failure channel: `AgentToolResult.isError` — "Report a failure
 * without throwing. The model sees `content` as an error result, like a thrown error, but
 * `details` and `structuredContent` are kept" (`pi-agent-core/dist/types.d.ts`). `bash` moved
 * its non-zero exit onto it, so on 1.0.0 `tools.bash({ command: "exit 3" })` resolves where on
 * 0.86.1 it threw.
 *
 * ADR-0024's contract promises the model that "a failing call REJECTS with `ToolCallError`
 * instead of resolving", and the binding result shape is `{ content, details }` — it has no
 * `isError` field to forward. Left alone, a 1.0.0 non-zero exit would cross the boundary as a
 * **successful** resolution whose only tell is a sentence at the end of its stdout, which is the
 * silent failure the testing constraints forbid. So the signal is translated back into the
 * channel the contract already describes, at the boundary, where the tool is called directly and
 * no agent loop exists to interpret `isError` for us.
 *
 * The same function caps the REJECT channel, which is NOT the pre-1.0.0-only path it looks like:
 * `isError` arrived in 0.99.0 but only `bash` moved onto it, and every other builtin still rejects
 * on every supported version. The binding catch feeds this the error message, so both failure
 * channels share one shape and one cap. The empty branch below is reachable there in principle —
 * an Error with an empty message — which is why it returns a sentence rather than empty.
 */
export function bindingFailureMessage(toolName: string, text: string): string {
  const trimmed = text.trim();
  // Through the `isError` channel the empty branch is unreachable today: `bash` is the only
  // builtin that sets it (core/tools/bash.js:300) and it appends its status sentence
  // unconditionally, so an `isError` result always carries text. It is pinned through the THROW
  // channel instead — a builtin rejecting with an empty Error, whose catch feeds this the
  // message. The tail slice is pinned on both channels: `binding-contract.test.ts` drives a
  // >5000-char non-zero exit and asserts the leading marker is gone and the trailing one
  // survives, and `bindings.test.ts` drives a rejecting `ls` through the real table.
  if (trimmed.length === 0) return `${toolName} reported a failure with no message`;
  const body =
    trimmed.length <= FAILURE_MESSAGE_MAX_CHARS
      ? trimmed
      : `…${trimmed.slice(-FAILURE_MESSAGE_MAX_CHARS)}`;
  return `${toolName} failed: ${body}`;
}

/**
 * Build the binding table for one run.
 *
 * Tools are created once per table and reused across calls, matching pi's own extension
 * examples (`createXxxTool(cwd)` caches nothing internally, so one instance per run is
 * the intended granularity).
 */
export function createBuiltinBindings(options: CreateBuiltinBindingsOptions): BindingTable {
  // Resolved before the branch below, so an unknown opt-in name is refused on every call path —
  // including the curated-`names` one, where the opt-in list is not consulted for membership.
  const granted = new Set(resolveOptInBindingNames(options.optIns));
  const names =
    options.names ??
    BUILTIN_BINDING_NAMES.filter(
      (name) => DEFAULT_BINDING_NAMES.includes(name) || granted.has(name),
    );
  // ADR-0016: `pi.dispatch` joins the table unless the caller curated an explicit name list.
  const includeDispatch = options.includeDispatch ?? options.names === undefined;
  const table = new Map<string, Binding>();
  for (const name of names) {
    const factory = BUILTIN_TOOL_FACTORIES[name as BuiltinBindingName];
    if (!factory) {
      throw new TypeError(
        `unknown PTC binding "${name}"; known bindings: ${BUILTIN_BINDING_NAMES.join(", ")}`,
      );
    }
    const tool = factory(options.cwd);
    table.set(name, {
      name,
      execute: async (args, context) => {
        const toolCallId = `ptc:${context.callId}`;
        const toolCall = {
          type: "toolCall",
          id: toolCallId,
          name: tool.name,
          arguments: args,
        } as unknown as ToolCallLike;
        const validated = validateToolArguments(tool, toolCall);
        // The reject channel and the `isError` channel carry the same cap. `AgentToolResult.isError`
        // arrived in 0.99.0 and `bash` is the ONE builtin that moved onto it; the rest still
        // REJECT, so this catch is not the pre-1.0.0-only path it was documented as. Measured on
        // 0.86.1, 1.0.0 and 1.2.0: `ls`/`read`/`grep`/`find` reject for a bad path (ls.js:44
        // `Path not found: …`), and a non-zero bash exit rejects with its full output on 0.86.1
        // but resolves through `isError` on 1.0.0+. Without this catch that raw error crosses the
        // wire unbounded and head-first — the failure shape ADR-0024's diagnostic discipline
        // exists to prevent — on EVERY supported version, not only the old ones.
        let result: Awaited<ReturnType<typeof tool.execute>>;
        try {
          result = await tool.execute(toolCallId, validated as never, context.signal, undefined);
        } catch (error) {
          throw new Error(
            bindingFailureMessage(
              tool.name,
              error instanceof Error ? error.message : String(error),
            ),
          );
        }
        // ADR-0024's contract, kept true across the 1.0.0 `isError` channel: see
        // `bindingFailureMessage` for why the translation happens here rather than downstream.
        if (result.isError === true) {
          throw new Error(
            bindingFailureMessage(
              tool.name,
              (result.content ?? [])
                .filter((block: { type?: string; text?: string }) => {
                  return block.type === "text" && typeof block.text === "string";
                })
                .map((block: { text?: string }) => block.text ?? "")
                .join("\n"),
            ),
          );
        }
        // What crosses the wire is the tool's model-facing payload: `usage` and
        // `terminate` are agent-loop plumbing with no meaning inside a PTC program.
        return {
          content: result.content,
          details: result.details === undefined ? null : result.details,
        };
      },
    });
  }
  // Register the parallel binding alongside the builtin set (ADR-0016). The default
  // surface (no explicit `names`) and any caller passing `includeDispatch: true` get it;
  // an explicit caller-curated list does not, because the caller has signalled they want
  // a specific surface.
  if (includeDispatch) {
    table.set(DISPATCH_BINDING_NAME, {
      name: DISPATCH_BINDING_NAME,
      execute: async (args, context) => {
        const toolCallId = `ptc:${context.callId}`;
        const toolCall = {
          type: "toolCall",
          id: toolCallId,
          name: DISPATCH_BINDING_NAME,
          arguments: args,
        } as unknown as ToolCallLike;
        let validated: unknown;
        try {
          validated = validateToolArguments(DISPATCH_TOOL_LIKE, toolCall);
        } catch (error) {
          // Validation failure is a refused call, not a thrown exception: the binding never
          // throws (ADR-0016 §3), so the program sees the same rejected DispatchResult shape
          // dispatch() itself returns. A missing agent gets the actionable refusal that lists
          // what is registered (pitfall #2) instead of pi's raw schema error.
          const raw: Record<string, unknown> | undefined =
            typeof args === "object" && args !== null && !Array.isArray(args)
              ? (args as Record<string, unknown>)
              : undefined;
          const rawAgent = raw?.agent;
          const rawScope = raw?.agentScope;
          // ADR-0043: one suppression decision for BOTH refusals below, read from the same raw
          // arguments and through the same `resolveWhy` `dispatch()` uses. Neither refusal reached
          // a child, so both consumed the caller's `why`, and both therefore have to state that --
          // otherwise a program that passed a `why` and got refused here cannot tell "my reason was
          // dropped" from "I passed no reason", which is the whole distinction the field exists
          // for. `withReadOnlyTier` was already on both branches; this is the missing half.
          const suppressed = whySuppressedOf(raw, context.dispatchDeps?.whyEnabled !== false);
          // Only the GIVEN-but-unusable case lands here (issue #185). An omitted agent validates
          // cleanly now and reaches `dispatchBinding`, which resolves the generalist child -- so
          // adding a "no agent given" branch here would be a second, divergent answer to a
          // question the dispatcher already owns.
          if (isMalformedAgentName(rawAgent)) {
            return withWhySuppressed(
              withReadOnlyTier(
                missingAgentResult({
                  cwd: options.cwd,
                  agentScope:
                    rawScope === "user" || rawScope === "project" || rawScope === "both"
                      ? rawScope
                      : "user",
                }),
                readOnlyTierOf(raw),
              ),
              suppressed,
            );
          }
          return withWhySuppressed(
            withReadOnlyTier(
              {
                text: "",
                status: "rejected",
                started: false,
                // The name the caller gave, or `""` when this refusal is about some OTHER field.
                // `rawAgent` is `unknown` here and `agentName` is typed `string`: returning the raw
                // value put `undefined` into a string field on the now-reachable path where a
                // different field fails validation and no agent was named (issue #185 made that path
                // reachable by removing the early missing-agent guard).
                agentName: typeof rawAgent === "string" ? rawAgent : "",
                durationMs: 0,
                exitCode: 1,
                // ADR-0032: the total channel field, for the same reason every other refusal has
                // it — this shape never carries a report, and a program must not have to infer that.
                reportChannel: "none",
                errorMessage: error instanceof Error ? error.message : String(error),
              },
              readOnlyTierOf(raw),
            ),
            suppressed,
          );
        }
        return dispatchBinding(
          validated as DispatchInput,
          {
            signal: context.signal,
            callId: context.callId,
            cwd: options.cwd,
            depth: context.depth,
            maxDispatchDepth: context.maxDispatchDepth,
            ...(context.callerId === undefined ? {} : { callerId: context.callerId }),
            ...(context.sessionDir === undefined ? {} : { sessionDir: context.sessionDir }),
            ...(context.parentTaskId === undefined ? {} : { parentTaskId: context.parentTaskId }),
          },
          context.dispatchDeps,
        );
      },
    });
  }
  return table;
}
