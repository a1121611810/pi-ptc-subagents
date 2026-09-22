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
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

import { dispatch as dispatchBinding, type DispatchInput } from "./dispatch.ts";

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

/**
 * Bindings exposed when the caller does not pass an explicit name list.
 *
 * `bash` is included on purpose: DSH's PTC preset still mounts `tool-bash`/`tool-pwsh`
 * (R1 §2 — PTC mode hides the tools from the wire list and re-exposes the same registry
 * as bindings), so a PTC program written against DSH may run shell commands. Leaving it
 * out would silently shrink the surface relative to DSH. Callers that want a read-only
 * PTC surface pass an explicit subset.
 */
/** Parallel binding name (ADR-0016). Always bound alongside the builtin set;
 * opt-out is the callers responsibility via an explicit subset to
 * createBuiltinBindings (today the subset is restricted to builtin names,
 * so opt-out is effectively use a future flag). */
export const DISPATCH_BINDING_NAME = "pi.dispatch" as const;

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

export interface CreateBuiltinBindingsOptions {
  /** Per-run working directory: the F4 `RunConfig.cwd`, used to build every tool. */
  cwd: string;
  /** Subset of {@link BUILTIN_BINDING_NAMES}; defaults to all of them (bash included). */
  names?: readonly string[];
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
  // Register the parallel binding alongside the builtin set (ADR-0016).
  // The binding is added unconditionally when the caller accepts the default set,
  // but an explicit subset (the read-only PTC surface pattern, R3) is honoured:
  // `pi.dispatch` is not mixed into a caller-curated list, because the caller
  // has signalled they want a specific surface.
  if (names === DEFAULT_BINDING_NAMES) {
    table.set(DISPATCH_BINDING_NAME, {
      name: DISPATCH_BINDING_NAME,
      execute: async (args, context) => {
        return dispatchBinding(args as DispatchInput, {
          signal: context.signal,
          callId: context.callId,
          cwd: options.cwd,
          depth: context.depth,
          maxDepth: context.maxDispatchDepth,
        });
      },
    });
  }
  return table;
}
