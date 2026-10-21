/**
 * `ptc_run_code` — the unstructured PTC surface.
 *
 * The model writes the body of an async function; inside it, pi's built-in tools are reachable as
 * `tools.<name>(args)` (ADR-0005's set, minus anything the install has not opted in — see
 * ADR-0040, whose §What this costs names this exact surface; the registered `description` states
 * that rule and points at the `ptcBindings` global, which is the per-run truth, not the description
 * itself), plus
 * the parallel binding `pi.dispatch` under its literal dot name (`tools["pi.dispatch"](args)`,
 * ADR-0016 — the shipped surface always binds it), and the program's return value plus
 * `console.log` output are what come back. There are no helpers
 * on this surface: `log` / `phase` / `parallel` / `pipeline` belong to `ptc_workflow` (G1 #13 →
 * decision B; a call to a helper that does not exist is a plain `ReferenceError` through the
 * normal code-run error path).
 *
 * Scope notes, so this stays a faithful subset of DSH's `run_code`:
 * - DSH's `sandbox_permissions` / `justification` are deliberately absent — they exist to request
 *   a wider sandbox from an approval pipeline this package does not have (ADR-0007 ships no OS
 *   sandbox, and the map decision on #8 dropped the approval path).
 * - `timeoutMs: 0` does not disable the deadline; it falls back to `DEFAULT_CONFIG.timeoutMs`,
 *   exactly as DSH's resolver does (R1 §3). The description names the default and the ceiling.
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineCompatTool, type ToolExposure } from "./pi-compat-types.ts";
import { Type } from "typebox";
import type { TNumber, TOptional, TObject, TString } from "typebox";
import { createBuiltinBindings } from "../runtime/bindings.ts";
import { runPtcProgram, type PtcRunOutcome } from "../runtime/dispatcher.ts";
import { readContextModel } from "../runtime/session-model.ts";
import type { WorkerPool } from "../runtime/worker-pool.ts";
import { DEFAULT_CONFIG } from "../runtime/limits.ts";
import { BINDING_CONTRACT } from "./binding-contract.ts";
import { PTC_CHILD_SEARCH_NOTE } from "../search/contract.ts";
import {
  codeRunFailedError,
  createSubCallUpdater,
  PTC_BINDING_REACH_NOTE,
  PTC_RUN_CODE_SNIPPET,
  PTC_TOOL_GUIDELINES,
  renderToolResult,
  resolveBindingNames,
  resolveToolCwd,
} from "./common.ts";
import type { PtcToolDetails, PtcToolOptions } from "./common.ts";
import { createPtcRenderers } from "./render.ts";

const DESCRIPTION_BASE = [
  "Run a TypeScript program that composes pi's tools in one shot. Required arguments: `code` —",
  "the body of an async function (top-level `return` and `await` work; type annotations are",
  "advisory, the code runs type-stripped) — and `description`, a 5-10 word summary of what the",
  "program does.",
  "",
  "Inside the program, call this session's enabled built-in tools as `tools.<name>(args)` — e.g.",
  '`await tools.read({ path: "src/index.ts" })`.',
  "The bound names are this session's active built-in tools, less any binding the install has not",
  "explicitly opted in — this surface is narrower than the session's tool list on purpose;",
  "independent calls may overlap under `Promise.all`.",
  "",
  "The parallel binding `pi.dispatch` is always available, registered under its literal dot name —",
  'inside the program, call it with string indexing, e.g. `await tools["pi.dispatch"]({ task: "..." })`;',
  "**the `agent` name is optional** — omit it and the child is a fresh generalist pi with pi's own",
  'prompt and toolset; add `agent: "reviewer"` only to narrow it to a registered definition,',
  "because a name with no definition behind it is refused. `tools.pi.dispatch` does not exist. It",
  "fans work out to child pi agents, and independent",
  "foreground dispatches compose under `Promise.all` exactly like the built-in calls. The run's",
  "actual bound names (this run, not a static list) are on the `ptcBindings` global, so the program",
  "never has to guess what is bound.",
  "",
  PTC_BINDING_REACH_NOTE,
  "",
  BINDING_CONTRACT,
  "",
  "Only the program's return value and its `console.log` output come back. This surface has no",
  "helpers: `log` / `phase` / `parallel` / `pipeline` exist only in `ptc_workflow`.",
  "",
  "Image-bearing tool results inside the program (a `tools.read` on a PNG, say) are attached to you",
  "after the run, so never return image data as the completion value — that only spends your context",
  "on base64.",
].join("\n");

/**
 * Splice the child's-search sentence into a description, when the search module is on.
 *
 * **It has to be per session, not a constant.** The sentence is a claim about what a dispatched
 * child can do, and that is true only when the search switch is on — a parent told otherwise
 * would dispatch a child that cannot search. The switch is read once at extension load, so the
 * claim is stable for the session.
 */
function withChildSearchNote(description: string, childCanSearch: boolean): string {
  if (!childCanSearch) return description;
  return `${description}\n\n${PTC_CHILD_SEARCH_NOTE}`;
}

/** Schema type written out explicitly for `isolatedDeclarations` (emit must not infer it). */
type RunCodeParameters = TObject<{
  code: TString;
  description: TString;
  timeoutMs: TOptional<TNumber>;
}>;

const PARAMETERS: RunCodeParameters = Type.Object({
  code: Type.String({
    description: "The program: the body of an async TypeScript function.",
  }),
  description: Type.String({
    description:
      "Clear, concise description of what this program does in active voice, 5-10 words (shown in the UI).",
  }),
  timeoutMs: Type.Optional(
    Type.Number({
      description:
        `Elapsed deadline in milliseconds for the whole run, including tool calls. ` +
        `Omit it (or pass 0) for the default of ${DEFAULT_CONFIG.timeoutMs / 1000} s; ` +
        `anything above ${DEFAULT_CONFIG.maxTimeoutMs / 1000} s is capped. ` +
        `The deadline bounds the whole run: if it expires, in-flight foreground dispatches ` +
        `spawned by the program are terminated with it.`,
    }),
  ),
});

/**
 * `PtcToolOptions` plus this tool's per-turn pool seam (ADR-0017 §1).
 *
 * The extension owns one `TurnPools` per agent turn and passes a getter for the
 * `run_code` surface's pool. The getter is read **per execute**, not at registration,
 * because the pool is replaced at every turn boundary. Omitting it means one fresh
 * worker per run — the pre-pool behaviour, and what direct library use gets.
 *
 * With a pool, consecutive runs of the same turn **share one warm worker**: that is
 * what pooling buys, and it is why "every run gets a fresh worker" is no longer true
 * on this path. What that sharing does and does not guarantee is worth being exact
 * about. `acquire()` guarantees *ownership*: a worker is in flight to exactly one run
 * until that run releases it, and a second acquire at capacity queues behind the wait
 * list rather than reusing an occupied worker (ADR-0017 §4). It does **not** guarantee
 * that only one program is physically executing in the isolate — the host abandons a
 * run by closing its control port and releasing the worker without waiting for the
 * program to unwind, so a **superseded** run's program can still be finishing inside
 * the worker while the next run is already in flight (ADR-0017 §10(a) / §10(h)). What
 * the pool promises is "one run at a time owns a worker's control port and result
 * channel", not "one program at a time".
 *
 * Isolation of the shared realm therefore does not come from the ending run's reset
 * handshake — a superseded run's `reset()` is a generation-guarded no-op (ADR-0017 §5 /
 * §10(a)). It comes from the next run's init-side clearing, which unconditionally
 * reinstalls the frozen env and console, restores `globalThis` to the boot-time warm
 * baseline and resets the run bookkeeping before the program starts (ADR-0017 §10(d)).
 */
export interface PtcRunCodeToolOptions extends PtcToolOptions {
  getPool?: () => WorkerPool | undefined;
  /**
   * How the model reaches this tool. Defaults to `"direct"`.
   *
   * **`"codemode"` on the line where pi's own `codemode` orchestrates.** On that line the model
   * is already given an orchestrator, and declaring this tool beside it would be the duplicate
   * composition surface ADR-0025 exists to remove — but `codemode` reach is not "hidden": it
   * makes the tool **callable from a `codemode` script**, which is what turns PTC into that
   * script's execution layer. Measured on pi 0.99.0 / 0.99.1 / 0.99.2 / 1.0.0 / 1.0.4 / 1.1.0:
   * `AgentSession._getCallableTools` admits `exposure === "codemode"`, and codemode's own filter
   * (`codemode/tool.js` `getCodemodeCallableTools`) drops only the `codemode` tool itself.
   *
   * **A pi older than 0.99.0 ignores the field.** `ToolExposure` does not exist there — `grep -r
   * exposure` over `@earendil-works/pi-coding-agent@0.86.1`'s `dist/` returns nothing, and neither
   * does `AgentSession._getCallableTools`. Such a pi ships no `codemode` at all, so nothing can
   * call a `codemode`-reach tool and the tools there fall back to being declared to the model,
   * which is the behaviour that line wants anyway. **The low end therefore needs no probe**: the
   * field is inert exactly where the fallback is correct.
   */
  exposure?: ToolExposure;
}

/**
 * Build the `ptc_run_code` tool definition.
 *
 * Called once by the extension factory. Each execute builds its own binding table against the
 * run's own cwd and reads `getPool()` for the surface's (possibly absent) pool — see
 * `PtcRunCodeToolOptions` for what pooling does and does not change about isolation.
 */
export function createPtcRunCodeTool(
  options: PtcRunCodeToolOptions = {},
): ToolDefinition<RunCodeParameters, PtcToolDetails> {
  return defineCompatTool({
    name: "ptc_run_code",
    label: "PTC Run Code",
    exposure: options.exposure,
    description: withChildSearchNote(DESCRIPTION_BASE, options.childCanSearch === true),
    promptSnippet: PTC_RUN_CODE_SNIPPET,
    promptGuidelines: [...PTC_TOOL_GUIDELINES],
    parameters: PARAMETERS,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const cwd = resolveToolCwd(ctx);
      const names = resolveBindingNames(
        options.getBindingSourceNames?.(),
        options.getOptInBindings?.(),
      );
      const startedAt = Date.now();
      const pool = options.getPool?.();
      // ADR-0022 R1: hand the host session dir to background children. Read defensively
      // because direct library callers may pass a context without a session manager.
      const sessionDir = ctx.sessionManager?.getSessionDir?.();
      // ADR-0022 §9/BG-14: the session-scoped dispatch deps, so a background spawn writes into
      // the session registry and shares its slot counter. Absent for direct library callers.
      const dispatchDeps = options.getDispatchDeps?.();
      // ADR-0044: the model this session is currently running, inherited by a dispatch the
      // program makes when it names none at the call site and its agent definition names none.
      // Read structurally, because the declared 0.86.0 floor's type surface may not declare
      // `ctx.model`; absent means "do not inherit" and keeps pi's configured default.
      const sessionModel = readContextModel(ctx);
      // Live sub-call pushes: while the program runs, the tree is visible (ADR-0021 §4).
      const updater = createSubCallUpdater({ surface: "run_code", startedAt, onUpdate });
      let outcome: PtcRunOutcome;
      try {
        outcome = await runPtcProgram({
          code: params.code,
          surface: "run_code",
          cwd,
          // The shipped surface always exposes the parallel binding (ADR-0016); the
          // binding-source names only curate the built-in subset.
          bindings: createBuiltinBindings({
            cwd,
            names,
            includeDispatch: true,
          }),
          ...(sessionDir === undefined ? {} : { sessionDir }),
          ...(dispatchDeps === undefined ? {} : { dispatchDeps }),
          ...(options.depth === undefined ? {} : { depth: options.depth }),
          // ADR-0022 §3/reopen R-m12: this process's own parent task id, read once by the
          // entrypoint from PI_PTC_TASK_ID; stamps a nested spawn's TaskRecord.parentTaskId.
          ...(options.parentTaskId === undefined ? {} : { parentTaskId: options.parentTaskId }),
          // ADR-0044: the session tier of the dispatch model precedence, threaded to the
          // `pi.dispatch` binding through the dispatcher's binding context.
          ...(sessionModel === undefined ? {} : { sessionModel }),
          ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
          ...(signal === undefined ? {} : { signal }),
          ...(options.config === undefined ? {} : { config: options.config }),
          ...(pool === undefined ? {} : { pool }),
          onSubCallChange: (snapshot) => updater.update(snapshot),
        });
      } finally {
        // A throttled partial must never land after the terminal result below.
        updater.cancel();
      }
      if (outcome.error !== undefined) throw codeRunFailedError(outcome);
      return renderToolResult({ outcome, surface: "run_code", durationMs: Date.now() - startedAt });
    },

    // Compact TUI rendering — see `render.ts` and ADR-0013. `renderShell` stays at the default
    // `ToolExecutionComponent` shell so PTC rows match the visual rhythm of `read`/`bash`.
    ...createPtcRenderers("run_code"),
  });
}
