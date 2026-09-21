/**
 * `ptc_workflow` — the structured PTC surface.
 *
 * Same worker, same bindings, same Node surface as `ptc_run_code`; what it adds is a plan
 * (`meta` with an ordered phase list), plain-JSON input (`args`, bound as the program's `args`
 * global) and the four workflow helpers: `log` / `phase` / `parallel` / `pipeline` (G1 #13 →
 * decision B — there is no `agent()`, not even a stub).
 *
 * Three decisions recorded here rather than re-litigated per call:
 * - **Language**: the same type-stripping pipeline as `ptc_run_code`. The worker compiles both
 *   surfaces through one `compileProgram`, and the pipeline is type-*strip* only — it adds no
 *   runtime semantics that a workflow could not tolerate. There is no JS-only mode because there
 *   is no concrete reason for one (the old pi-ptc "JS-only" idea is explicitly not inherited).
 * - **Phase strictness**: warning, not error. A `phase(title)` outside `meta.phases` is a plan
 *   drift — usually a typo or a forgotten declaration — but the run has already happened by the
 *   time the titles are known, and failing then would discard a completed result over a cosmetic
 *   mismatch. Each distinct unlisted title is reported once, as a `Warning:` line in `content`
 *   and in `details.warnings`. When `meta.phases` is absent there is no declared plan to drift
 *   from, so nothing is reported.
 * - **`args`**: validated as plain JSON before dispatch (see `validateWorkflowArgs`), because a
 *   function/symbol/`undefined`/cycle would otherwise be silently dropped or mangled by the
 *   structured clone on its way to the worker.
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { createBuiltinBindings } from "../runtime/bindings.ts";
import { runPtcProgram } from "../runtime/dispatcher.ts";
import type { PtcRunOutcome } from "../runtime/dispatcher.ts";
import { codeRunFailedError, renderToolResult, resolveBindingNames, resolveToolCwd } from "./common.ts";
import type { PtcToolOptions } from "./common.ts";

const DESCRIPTION = [
  "Run a structured TypeScript workflow: a named plan that reports phases and narration as it",
  "goes. `script` is the body of an async function, `meta` names it (`{ name, description, phases? }`,",
  "where `phases` is the ordered plan), and optional `args` is plain-JSON input bound to the",
  "program's `args` global.",
  "",
  "Helpers inside the script: `log(message)` narrates progress; `phase(title)` frames the workflow",
  "(titles outside `meta.phases` are reported as warnings); `parallel(thunks)` runs thunks",
  "concurrently, a failed item becoming `null`; `pipeline(items, ...stages)` chains stages per item",
  "with the same per-item `null` on failure. There is no `agent()` helper.",
  "",
  "Tools are reachable as `tools.<name>(args)` exactly as in `ptc_run_code`, and the bound names",
  "mirror the session's enabled tools. What comes back is the script's return value, its",
  "`log`/`phase` narration and its `console.log` output.",
].join("\n");

const PARAMETERS = Type.Object({
  meta: Type.Object(
    {
      name: Type.String({ description: "Short workflow name, shown in the UI." }),
      description: Type.String({ description: "What this workflow does, in active voice." }),
      phases: Type.Optional(
        Type.Array(Type.Object({ name: Type.String({ description: "Phase title, matched against phase(title) calls." }) }), {
          description: "Ordered plan of the workflow's phases. phase() titles outside this list are reported as warnings.",
        }),
      ),
    },
    { description: "Workflow metadata: what this run is and which phases it declares." },
  ),
  script: Type.String({ description: "The program: the body of an async TypeScript function." }),
  args: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        "Plain-JSON input bound to the program's `args` global. No functions, symbols, undefined values or cycles.",
    }),
  ),
});

/** Parameters after pi's schema validation; `args` is still unvalidated plain JSON to be checked. */
export type PtcWorkflowParams = Static<typeof PARAMETERS>;

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

/**
 * Reject anything that is not plain JSON, with a path-qualified reason.
 *
 * The rule is the worker's own result rule (`toJsonValue`) applied one direction earlier, so both
 * ends agree on what "plain JSON" means: objects with `Object.prototype` (or null), arrays,
 * strings, finite numbers, booleans and null. Class instances, functions, symbols, bigints,
 * non-finite numbers, circular references and `undefined` values are all rejected — `undefined`
 * because the ticket calls it out and because a structured clone would drop it silently, leaving
 * the script reading a key that is not there.
 */
export function validateWorkflowArgs(args: unknown): void {
  if (args === undefined) return;
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new TypeError(`ptc_workflow args must be a plain JSON object, received ${describeValue(args)}`);
  }
  for (const key of Object.keys(args)) {
    const problem = findJsonProblem((args as Record<string, unknown>)[key], `args.${key}`, new Set());
    if (problem !== undefined) throw new TypeError(`ptc_workflow args must be plain JSON: ${problem}`);
  }
}

/** Path-qualified reason a value cannot cross the wire as plain JSON, or `undefined` when it can. */
function findJsonProblem(value: unknown, path: string, seen: Set<object>): string | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return undefined;
  if (typeof value === "undefined") return `${path} is undefined`;
  if (typeof value === "number") {
    return Number.isFinite(value) ? undefined : `${path} is ${String(value)}, which is not representable as JSON`;
  }
  if (typeof value !== "object") return `${path} is ${describeValue(value)}`;

  const container = value as object;
  if (seen.has(container)) return `${path} is a circular reference`;
  seen.add(container);
  try {
    if (Array.isArray(container)) {
      for (let index = 0; index < container.length; index += 1) {
        const problem = findJsonProblem(container[index], `${path}[${index}]`, seen);
        if (problem !== undefined) return problem;
      }
      return undefined;
    }
    const prototype = Object.getPrototypeOf(container);
    if (prototype !== Object.prototype && prototype !== null) {
      const name = (container as { constructor?: { name?: string } }).constructor?.name;
      return `${path} is a ${typeof name === "string" && name.length > 0 ? name : "non-plain object"}, not plain JSON`;
    }
    for (const key of Object.keys(container)) {
      const problem = findJsonProblem((container as Record<string, unknown>)[key], `${path}.${key}`, seen);
      if (problem !== undefined) return problem;
    }
    return undefined;
  } finally {
    seen.delete(container);
  }
}

/**
 * Collect the plan-drift warnings for one workflow run: distinct `phase()` titles the declared
 * `meta.phases` list does not mention, in first-seen order.
 */
export function unlistedPhaseWarnings(outcome: PtcRunOutcome, declared: readonly string[] | undefined): string[] {
  if (declared === undefined || declared.length === 0) return [];
  const known = new Set(declared);
  const reported = new Set<string>();
  const warnings: string[] = [];
  for (const title of outcome.phases) {
    if (known.has(title) || reported.has(title)) continue;
    reported.add(title);
    warnings.push(`phase "${title}" is not listed in meta.phases (declared: ${[...known].join(", ")})`);
  }
  return warnings;
}

/**
 * Build the `ptc_workflow` tool definition.
 *
 * `args` is validated before `runPtcProgram` is called, so a malformed payload never spawns a
 * worker. Everything after dispatch is identical to `ptc_run_code`, plus the phase roll-up.
 */
export function createPtcWorkflowTool(options: PtcToolOptions = {}) {
  return defineTool({
    name: "ptc_workflow",
    label: "PTC Workflow",
    description: DESCRIPTION,
    parameters: PARAMETERS,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      validateWorkflowArgs(params.args);
      const cwd = resolveToolCwd(ctx);
      const names = resolveBindingNames(options.getActiveToolNames?.());
      const startedAt = Date.now();
      const outcome = await runPtcProgram({
        code: params.script,
        surface: "workflow",
        cwd,
        bindings: createBuiltinBindings({ cwd, names }),
        ...(params.args === undefined ? {} : { args: params.args }),
        ...(signal === undefined ? {} : { signal }),
        ...(options.config === undefined ? {} : { config: options.config }),
      });
      if (outcome.error !== undefined) throw codeRunFailedError(outcome);
      const declared = params.meta.phases?.map((phase) => phase.name);
      return renderToolResult({
        outcome,
        surface: "workflow",
        warnings: unlistedPhaseWarnings(outcome, declared),
        durationMs: Date.now() - startedAt,
      });
    },
  });
}
