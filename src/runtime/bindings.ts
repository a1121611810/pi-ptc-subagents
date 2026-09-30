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
  isMissingAgentName,
  missingAgentResult,
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
 * Bindings exposed when the caller does not pass an explicit name list.
 *
 * `bash` is included on purpose: DSH's PTC preset still mounts `tool-bash`/`tool-pwsh`
 * (R1 §2 — PTC mode hides the tools from the wire list and re-exposes the same registry
 * as bindings), so a PTC program written against DSH may run shell commands. Leaving it
 * out would silently shrink the surface relative to DSH. Callers that want a read-only
 * PTC surface pass an explicit subset.
 */
export const DEFAULT_BINDING_NAMES: readonly BuiltinBindingName[] = BUILTIN_BINDING_NAMES;

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
  ): Promise<{ content?: unknown; details?: unknown }>;
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
  cwd: TOptional<TString>;
  agentScope: TOptional<TUnion<[TLiteral<"user">, TLiteral<"project">, TLiteral<"both">]>>;
  model: TOptional<TString>;
  thinkingLevel: TOptional<TString>;
  background: TOptional<TBoolean>;
  label: TOptional<TString>;
}>;

/**
 * The parallel binding's argument schema. Exported so ADR-0025's top-level `ptc_subagent`
 * can declare the SAME arguments rather than a second hand-written copy that could drift: the
 * two are different call sites for one dispatcher, and a test pins their key sets equal.
 */
export const DISPATCH_PARAMETERS: DispatchParameters = Type.Object({
  agent: Type.String({ minLength: 1 }),
  task: Type.String({ minLength: 1 }),
  cwd: Type.Optional(Type.String()),
  agentScope: Type.Optional(
    Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("both")]),
  ),
  model: Type.Optional(Type.String()),
  thinkingLevel: Type.Optional(Type.String()),
  background: Type.Optional(Type.Boolean()),
  label: Type.Optional(Type.String()),
});

/** Minimal `Tool` shape for pi's validator. */
const DISPATCH_TOOL_LIKE = {
  name: DISPATCH_BINDING_NAME,
  description:
    "Dispatch a task to a registered pi agent as a child subprocess (foreground await or background task).",
  parameters: DISPATCH_PARAMETERS,
};

export interface CreateBuiltinBindingsOptions {
  /** Per-run working directory: the F4 `RunConfig.cwd`, used to build every tool. */
  cwd: string;
  /** Subset of {@link BUILTIN_BINDING_NAMES}; defaults to all of them (bash included). */
  names?: readonly string[];
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
 * Build the binding table for one run.
 *
 * Tools are created once per table and reused across calls, matching pi's own extension
 * examples (`createXxxTool(cwd)` caches nothing internally, so one instance per run is
 * the intended granularity).
 */
export function createBuiltinBindings(options: CreateBuiltinBindingsOptions): BindingTable {
  const names = options.names ?? DEFAULT_BINDING_NAMES;
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
        const result = await tool.execute(
          toolCallId,
          validated as never,
          context.signal,
          undefined,
        );
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
          if (isMissingAgentName(rawAgent)) {
            return missingAgentResult({
              cwd: options.cwd,
              agentScope:
                rawScope === "user" || rawScope === "project" || rawScope === "both"
                  ? rawScope
                  : "user",
            });
          }
          return {
            text: "",
            status: "rejected",
            started: false,
            agentName: rawAgent,
            durationMs: 0,
            exitCode: 1,
            errorMessage: error instanceof Error ? error.message : String(error),
          };
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
