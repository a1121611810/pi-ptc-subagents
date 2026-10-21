/**
 * pi.dispatch: the parallel binding that spawns a fresh pi subprocess per call.
 *
 * ADR-0016 (2026-09-23) is the contract, and this file is the whole implementation:
 * agent-markdown discovery (`discoverAgent`, with the agentScope user/project split),
 * the recursion-depth hint appended to the child's system prompt (`appendDepthHint`),
 * the argv the child pi is launched with (`buildArgv`), and `dispatch()` itself —
 * spawn, JSON-line event parsing, usage accumulation, the close-outcome decision
 * (`decideCloseOutcome`), and SIGTERM → SIGKILL signal propagation when the run that
 * issued the dispatch is cancelled.
 *
 * Behaviourally compatible with pi's examples/extensions/subagent/index.ts reference
 * (--mode json, -p, --no-session, --append-system-prompt <tmpfile>), but not cooperative:
 * does not require the user to install pi's subagent extension. See ADR-0016 section 2.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-ai";

import {
  RealChildProcessLifecycle,
  createULID,
  type ChildExitValue,
  type ChildHandle,
  type ChildProcessLifecycle,
  type ChildSpawnOptions,
  type ParsedAgentEvent,
} from "./child-process-lifecycle.ts";
// The report vocabulary (ADR-0032) lives in its own module so `task-storage.ts`, which persists a
// report onto a TaskRecord, can name the shape without importing back up into this layer.
// Re-exported below because `dispatch()` returns a report and every existing import site reads it
// from this module. The EXTRACTION stays here; only the types moved.
import type {
  ChildReport,
  ChildReportChannel,
  ChildReportExtraction,
  ChildReportFinding,
  ChildReportPayload,
} from "./child-report.ts";
// The report tool's NAME and the contract's SHAPE are values, not types: `buildArgv` has to
// put the name in the child's tool list, and the prompt has to state the shape. Both come from
// the same import-free vocabulary module the types do, so this edge pulls in nothing that could
// cycle (see the note at the head of `child-report.ts`).
import { CHILD_REPORT_SHAPE, CHILD_REPORT_TOOL_NAME } from "./child-report.ts";
// The search tool's NAME, from the search module's own import-free vocabulary module (ADR-0049).
// `buildArgv` has to name it in the child's tool list, exactly as it names the report tool, and
// that module imports nothing -- so this edge cannot cycle.
import { WEB_DS_SEARCH_TOOL_NAME } from "../search/contract.ts";
import { DEFAULT_CONFIG } from "./limits.ts";
import {
  DefaultTaskRegistry,
  OUTPUT_PREVIEW_MAX_BYTES,
  type DispatchHandle,
  type RegistryLogger,
  type TaskRegistry,
} from "./task-registry.ts";
import type { OutputStorage } from "./output-storage.ts";
import { formatSessionModel, type SessionModel } from "./session-model.ts";
import { InMemoryTaskStorage, type TaskSpawnSource, type ULID } from "./task-storage.ts";

// Re-exports keep existing imports working after BG-03 moved these definitions.
// `tests/dispatch-helpers.test.ts` imports `parseAgentEvent` / `safeKill` from this
// module; rather than churn the test file, we re-export them.
export { parseAgentEvent, safeKill } from "./child-process-lifecycle.ts";
export type {
  ChildReport,
  ChildReportChannel,
  ChildReportExtraction,
  ChildReportFinding,
  ChildReportPayload,
};

/**
 * Shared lifecycle adapter for the foreground `pi.dispatch` path. BG-03 extracted the
 * spawn / kill / JSONL-parse / exit-wait dance into a typed seam so the background
 * dispatch (ADR-0022) can drive the same handles from a different caller. The foreground
 * path is mocked through `node:child_process` (which `RealChildProcessLifecycle` calls
 * into); the background path can swap the adapter per call through
 * {@link DispatchDeps.lifecycle}.
 */
const DISPATCH_LIFECYCLE: ChildProcessLifecycle = new RealChildProcessLifecycle();

/**
 * Per-run in-flight `pi.dispatch` counter (ADR-0016 §2 + ADR-0022 §9). The dispatcher's
 * foreground gate owns the canonical counter today; this class is the small exported seam
 * ADR-0022 §9 asks for so the background branch can hold a slot for a child's whole
 * lifetime and release it only on the terminal transition — a background task keeps
 * counting against `dispatchConcurrency` after `dispatch()` has already returned. The
 * dispatcher can adopt this type without a behaviour change.
 */
export class DispatchSlotCounter {
  readonly limit: number;
  #active: number;
  /**
   * Tokens currently holding a slot. Only keyed acquires are tracked here; the dispatcher's
   * foreground per-call gate keeps using the anonymous form. A token makes acquire/release
   * idempotent PER TASK, which is what stops a late pump release from freeing a different
   * live task's slot after `shutdown` already released the reclaimed task.
   */
  readonly #holders = new Set<string>();

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 0) {
      throw new TypeError(
        `DispatchSlotCounter: limit must be a non-negative integer, got ${String(limit)}`,
      );
    }
    this.limit = limit;
    this.#active = 0;
  }

  /** Number of slots currently held. */
  get active(): number {
    return this.#active;
  }

  /** Reserve one in-flight slot (optionally keyed by a per-task holder token); `false` means the cap is reached (hard reject, no queue). */
  tryAcquire(holder?: string): boolean {
    if (holder !== undefined && this.#holders.has(holder)) return false;
    if (this.#active >= this.limit) return false;
    if (holder !== undefined) this.#holders.add(holder);
    this.#active += 1;
    return true;
  }

  /**
   * Release one slot; per-token idempotent (a late release for the same task is a no-op) and
   * never negative. An anonymous release only frees an anonymous reservation.
   */
  release(holder?: string): void {
    if (holder !== undefined) {
      if (!this.#holders.delete(holder)) return;
      this.#active -= 1;
      return;
    }
    if (this.#active > this.#holders.size) this.#active -= 1;
  }
}

/**
 * Fallback counter for a background dispatch that was not handed the dispatcher's per-run
 * counter. It keeps ADR-0022 §9's cap in force (default `dispatchConcurrency` = 8) instead
 * of silently skipping it; production wires the per-run counter through
 * {@link DispatchDeps.slots}.
 */
const FALLBACK_DISPATCH_SLOTS: DispatchSlotCounter = new DispatchSlotCounter(
  DEFAULT_CONFIG.dispatchConcurrency,
);

/**
 * Injected dependencies. The background branch uses this object for everything; the foreground
 * branch uses `slots` (the one cap both fronts share since ADR-0026 round 3) and
 * `lifecycle`. Every field is optional so existing zero-argument call sites keep working, and
 * both branches fall back to the module-level {@link DISPATCH_LIFECYCLE}. Tests pass an
 * in-memory registry and a mock lifecycle so no real `pi` process is ever spawned.
 */
export interface DispatchDeps {
  /** Session-level TaskRegistry (ADR-0022 §3). Defaults to a lazy in-memory registry. */
  taskRegistry?: TaskRegistry;
  /** Child lifecycle for the background spawn. Defaults to the shared real adapter. */
  lifecycle?: ChildProcessLifecycle;
  /** Per-run in-flight counter shared with the dispatcher's foreground gate (ADR-0022 §9). */
  slots?: DispatchSlotCounter;
  /** Time source for TaskRecord stamps. Defaults to `Date.now`. */
  clock?: () => number;
  /** Logger for the background pump's failure path. Defaults to a `console.warn` logger. */
  logger?: RegistryLogger;
  /**
   * ADR-0022 §3: where the pump persists a task's drained stdout. When present, the terminal
   * transition records `outputRef` / `outputBytes` / `outputPreview` so `ptc_task_output`
   * can dereference the bytes (BG-07).
   */
  outputStorage?: OutputStorage;
  /**
   * ADR-0043: whether the caller may hand the child a `why`. Absent means ON, which is this
   * package's default and the state ADR-0042's measurement was taken in — so every existing
   * zero-argument call site keeps the behaviour it had before the switch existed.
   *
   * The FILE is read ONCE, at extension load, and carried here rather than consulted per call for
   * the reason #73 already records for `optInBindings`: a switch read per call would let the third
   * dispatch of a run see a different answer from the first, with nothing in the transcript
   * recording that it changed.
   *
   * "Read once" is about this file, not about the value being frozen for the session — `/ptc why`
   * overwrites this exact field mid-session by design (spec D8, ADR-0043), and the `whyConfig`
   * JSDoc in `index.ts` carries that half. What keeps the two together is that the write is
   * recorded: `/ptc why` appends a session entry, so a program that saw the value change knows
   * from the transcript that a user changed it rather than finding it had moved underneath a run.
   */
  whyEnabled?: boolean;
  /**
   * ADR-0049: whether the DeepSeek search module is ON for this session.
   *
   * Carried for the same reason as {@link whyEnabled} — it is a session-level switch read once at
   * extension load, and the answer changes what the child's tool list may be.
   *
   * **It is what decides whether a STRICT child keeps the search tool.** The strict tier narrows
   * the child to read-only tools (ADR-0041), and the search tool IS one: it reads the web and
   * writes nothing. Measured 2026-10-20 on the `subagents` surface: a parent that asked for a
   * read-only child lost the child's search tool entirely, because pi reads the child's `--tools`
   * list as an ALLOWLIST and the strict list did not name it — so the child reported "this session
   * has no web search, web fetch, or bash tool" and gave up. The capability was not bypassed; it
   * was ABSENT. A narrowing that removes a read-only capability the caller was told the child has
   * is a silent failure, and this one is reachable by the most ordinary dispatch shape.
   *
   * Absent means the search module is off, which is the shipped default (ADR-0048: the absence of
   * a decision is not a decision to allow it) — so a strict child is unchanged unless an operator
   * turned the module on for the install, and that install already accepted child network egress
   * and a per-child bill.
   */
  searchEnabled?: boolean;
  /**
   * ADR-0050: whether this session may start a NEW child.
   *
   * **Absent means ON**, which is the shipped default: the only thing that turns it off is
   * `/ptc off`, a deliberate session-scoped switch the user flips (the same shape, and the same
   * "mutate the one deps object every front reads" mechanics, as {@link whyEnabled}).
   *
   * It is checked ONCE per call, above every gate, so a request that may not start a child never
   * mints a task id, never reserves a concurrency slot and never spawns a process. Both fronts
   * get it, because both go through this function: the binding a program calls and the
   * top-level subagent tool.
   *
   * The switch does NOT touch children that are already running. A child is its own process and
   * the mode's lifecycle never reaches it, so "off" is about what starts from here on.
   */
  dispatchEnabled?: boolean;
}

/**
 * Lazy session-level fallback registry for background dispatches that were not handed one.
 * Production passes the session registry through {@link DispatchDeps.taskRegistry}; the
 * fallback exists so a direct `dispatch(..., { background: true })` call without DI still
 * registers and advances a task instead of dropping it (ADR-0022 §3, "no silent failure").
 */
let fallbackTaskRegistry: DefaultTaskRegistry | undefined;

function resolveTaskRegistry(deps: DispatchDeps, clock: () => number): TaskRegistry {
  if (deps.taskRegistry !== undefined) return deps.taskRegistry;
  fallbackTaskRegistry ??= new DefaultTaskRegistry(new InMemoryTaskStorage(), { clock });
  return fallbackTaskRegistry;
}

/** Default pump logger: surface a background lifecycle failure instead of swallowing it. */
const DEFAULT_DISPATCH_LOGGER: RegistryLogger = {
  info: (): void => undefined,
  warn: (msg: string): void => {
    console.warn("[pi.dispatch] " + msg);
  },
};

/**
 * The CLI command used to invoke a fresh pi subprocess for one dispatch.
 *
 * Always `"pi"` — pi-ptc is a library, not a CLI, and `dispatch` must spawn the
 * separate `pi` binary regardless of how the host process was launched. An
 * earlier copy of this function mirrored pi's own subagent extension and tried
 * to reuse `process.execPath + process.argv[1]`, which works only when the host
 * is `pi` itself; in any other host (test scripts, the dispatcher host process,
 * etc.) the function would spawn the host script in place of `pi`, producing
 * infinite recursion and a stdout pipe that never drains (so `proc.on('close')`
 * never fires). The caller surfaces a missing-binary condition via the child's
 * `error` event — `spawn` itself does not throw synchronously on ENOENT, the
 * async `error` listener does.
 */
const PI_COMMAND = "pi";

/** Per-call input. Mirrors pi's subagent extension's parameters (single-mode only). */
export interface DispatchInput {
  /**
   * Name of the definition to dispatch, or absent for a generalist child.
   *
   * Absent is a legal, meaningful input rather than a missing one (issue #185): the child is
   * already a full-capability pi, since the dispatch prompt is APPENDED to pi's own system
   * prompt and no `--tools` flag is passed unless a definition declares `tools:`. A definition
   * can therefore only narrow the child, so requiring one asked every caller to name a
   * narrowing that does not exist. Omit it to get pi's own prompt and pi's own toolset.
   */
  agent?: string;
  task: string;
  /**
   * ADR-0042: why this dispatch slice exists, in the caller's words. Renamed from `goal` by
   * ADR-0043: the agent ecosystem already spends `goal` on an objective or a loop, and
   * `background` was the other candidate but is already an argument on this schema meaning
   * "detach the child".
   *
   * Not the whole conversation and not the user's original request — the caller's intent for THIS
   * slice. The child is told it is context for doing the task well, not authority to change the
   * task, because an earlier wayfinder decision (#208, ticket #211) settled that a child gets
   * better execution rather than a mandate to re-litigate the task.
   *
   * Optional, and deliberately unbounded: the caller already paid for this text in its own
   * context, and a refusal branch here would be a new failure mode with no observed trigger. Not
   * persisted on the TaskRecord — unlike `usage`, this is a caller-held fact, not a host-measured
   * one.
   */
  why?: string;
  cwd?: string;
  agentScope?: "user" | "project" | "both";
  model?: string;
  thinkingLevel?: ThinkingLevel;
  /**
   * ADR-0022 §1: long-lived background spawn. When `true`, {@link dispatch} returns a
   * {@link DispatchHandle} immediately and a detached pump drives the child's TaskRecord
   * lifecycle; every other call keeps the ADR-0016 `DispatchResult` semantics.
   */
  background?: boolean;
  /**
   * ADR-0022 §1: human label carried by the handle and the TaskRecord. Defaults to the
   * task text truncated to 64 characters.
   */
  label?: string;
  /**
   * ADR-0041: ask for a read-only child. Two tiers, two spellings, no third: a boolean was
   * tried first and removed, because pi's validator COERCES a `Type.Boolean()` member of the
   * schema and `readOnly: 0` then silently became "no tier" — a full-capability child for a
   * caller who asked to be read-only. An absent or `null` value means no tier; `false` is not a
   * spelling of anything and is refused.
   *
   * The two tiers are a capability narrowing and a posture, and the difference is meant to
   * be visible at a glance: `strict` replaces the child's tool list (so it cannot write),
   * `lenient` leaves that list exactly as it would have been and only tells the child to
   * work without modifying anything. `bash` is deliberately absent from the strict set —
   * a child holding `bash` could write through it, which would make the guarantee fictional.
   *
   * Call-site precedence is TOTAL for `strict`: a strict tier set here decides the child's
   * tool list outright and an agent definition's declared `tools:` is not consulted. Nothing
   * can therefore arrive as a different tier than the one asked for. The result still reports
   * what took effect ({@link DispatchResult.readOnlyTier}) — not because it could differ from
   * this, but because an override nobody can read is an override that reads as "this agent
   * declares tools: read, bash" when it did not.
   *
   * The claim is scoped to `strict` because it is the only tier that touches the list. A
   * `lenient` tier is routed by {@link childToolList} down the same branch an untiered dispatch
   * takes — the definition's declared `tools:` included — because lenient's promise is that the
   * list is byte-identical to an untiered dispatch, and honouring the definition is part of what
   * untiered means. Read lenient as "wins over the definition" and you would predict a narrowing
   * that does not happen.
   */
  readOnly?: ReadOnlyTier;
}

/**
 * ADR-0041: the two read-only tiers. `strict` narrows what the child can be handed;
 * `lenient` narrows nothing and only states the posture.
 *
 * **Strings only, and that is load-bearing rather than a style choice.** Measured against pi's
 * `validateToolArguments`: a union that includes `Type.Boolean()` COERCES — `1` and `"true"`
 * arrive as `true`, `0` and `"false"` arrive as `false` — while a union of string literals
 * refuses every one of them. The boolean short spelling therefore bought a silent type coercion
 * on the parameter whose entire job is to be unambiguous, and it cost more than the token it
 * saved. A pure string enum is also the shape tool schemas support most widely, which a mixed
 * `boolean | enum` union is not.
 */
export type ReadOnlyTier = "strict" | "lenient";

/**
 * ADR-0041: what a strict child is narrowed to. The four read tools pi ships, and nothing
 * that can write — no `bash`, no `edit`, no `write`. Declared as a value rather than inlined
 * at the use site so the ADR, the glossary entry and the implementation name one list.
 */
export const READ_ONLY_TOOL_NAMES: readonly string[] = ["read", "grep", "find", "ls"];

/**
 * ADR-0041: the one place a tier is recognised. One spelling means there is nothing to fold and
 * no second state to store, compare or forget — the reason this function exists at all is that
 * `undefined` ("no tier") must be decided in exactly one place.
 *
 * It is not the boundary check. That lives in the schema, and the schema is strict because the
 * union is string-only; see {@link isUsableReadOnlyRequest} for what is left for the seam the
 * schema does not govern.
 */
export function resolveReadOnlyTier(readOnly: DispatchInput["readOnly"]): ReadOnlyTier | undefined {
  return readOnly === "strict" || readOnly === "lenient" ? readOnly : undefined;
}

/**
 * ADR-0041: the boundary check, for the seam the schema does not govern.
 *
 * `unknown`, deliberately. `readOnly` is declared `ReadOnlyTier`, but that is a compile-time
 * claim about a value that reaches `dispatch()` from callers which build their own arguments
 * rather than going through a schema — the test suite among them.
 *
 * **On both production fronts this is no longer load-bearing, and the reason is a schema
 * decision rather than a guard.** pi COERCES a `Type.Boolean()` union: `1`, `"true"` and `"1"`
 * arrive as `true`, `0` and `"false"` as `false`, and by the time any code here sees them the
 * caller's own spelling is gone. That is why the union is string-only — a union of string
 * literals refuses all four, measured — and why the boolean short spelling was dropped: it bought
 * a silent coercion on the one parameter whose entire job is to be unambiguous.
 *
 * So what is left is defence in depth, and it is worth keeping for one reason: `dispatch()` is a
 * module-level function, and "the only callers happen to validate first" is a property of today's
 * callers rather than of the function's contract.
 *
 * `undefined` and `null` are USABLE: they are the two spellings of "I asked for nothing", and
 * the schema maps both to an absent value. `false` is NOT usable any more — it used to mean "no
 * tier", and under a string enum it is simply a wrong-typed value, so it is refused rather than
 * quietly honoured.
 */
export function isUsableReadOnlyRequest(readOnly: unknown): boolean {
  return (
    readOnly === undefined || readOnly === null || readOnly === "strict" || readOnly === "lenient"
  );
}

/**
 * The refusal for a `readOnly` value no tier implements (ADR-0041 §Constraint compliance).
 *
 * A `DispatchResult`, never a throw: ADR-0016 §3 requires the binding never throws, and
 * `dispatch()` is the binding's implementation. `started: false` puts it in the sub-call tree's
 * `rejected` bucket (the harness said no), beside the depth and concurrency gates rather than
 * beside a child that ran and failed.
 *
 * The message names the parameter, the value it received and the values it accepts, because the
 * value the caller sent is the one thing it cannot see from the message otherwise — the same
 * tone as {@link missingAgentResult}, which lists what IS registered for the same reason.
 *
 * `agentName: "unknown"`, matching the other pre-spawn gates: nothing was resolved, because
 * nothing was looked up.
 */
export function invalidReadOnlyRequestResult(readOnly: unknown): DispatchResult {
  // JSON for the containers and `String` for everything else, which is also what makes the value
  // in the message the SAME string the caller's own input renders as -- `String(["strict"])` is
  // "strict" while `JSON.stringify(["strict"])` is `["strict"]`, and only one of those two tells
  // the caller which value was refused.
  const rendered =
    typeof readOnly === "object" && readOnly !== null ? JSON.stringify(readOnly) : String(readOnly);
  return {
    text: "",
    status: "rejected",
    started: false,
    agentName: "unknown",
    durationMs: 0,
    exitCode: -1,
    reportChannel: "none",
    errorMessage:
      "invalid readOnly value: " +
      rendered +
      ' (readOnly accepts "strict" or "lenient"; null and undefined ask for no tier)',
  };
}

/**
 * Stamp the tier that took effect onto a result the path produced (ADR-0041 §"The tier that
 * took effect is reported").
 *
 * One helper rather than a field on each of the five refusal factories, for two reasons. The
 * factories are shared with the background front and with `bindings.ts`, and threading a tier
 * argument through every one of them would make "does a refusal state the tier" a per-call-site
 * question. Here it is one call, and a refusal that forgets to call it is visible as a missing
 * field rather than as a fourth spelling of the answer.
 *
 * Applied to refusals as well as outcomes on purpose: the value states the tier the CALL resolved
 * to, and a refusal means no child was launched with it — not that a different tier was applied.
 *
 * A spread, never an assigned `undefined`: an explicitly-`undefined` key and an absent key are
 * different things on this surface, and only the absent one keeps `readOnlyTier === undefined`
 * from reading as "asked for nothing, tier unknown" — a claim nobody can act on.
 */
export function withReadOnlyTier(
  result: DispatchResult,
  tier: ReadOnlyTier | undefined,
): DispatchResult {
  return tier === undefined ? result : { ...result, readOnlyTier: tier };
}

/**
 * ADR-0043: decide what the child hears, and — in the same breath — whether the caller has to be
 * told it heard nothing.
 *
 * These two answers are computed together on purpose. They are one decision, and a version that
 * computed them in two places would let a blank value be "suppressed" (a warning about a value
 * nobody sent) or a real value be dropped without the record (the silent failure this exists to
 * prevent).
 *
 * A BLANK value is never suppressed. The caller wrote nothing, so nothing was withheld, and
 * stamping the field there would train a reader to ignore it — the same reason an empty
 * `<pi-ptc-why>` block is never emitted.
 *
 * The value is handed on already trimmed because {@link whyBlock} trims it anyway, and trimming
 * here is what lets "was there actually anything to send" be a question about content rather than
 * about whitespace.
 *
 * It takes the VALUE rather than the whole {@link DispatchInput}, and that is what lets
 * `bindings.ts` ask the same question about the RAW arguments its two pre-`dispatch()` refusals
 * are holding: reading `input.why` off a fabricated input would be the second spelling of the rule
 * this function exists to keep in one place.
 */
export function resolveWhy(
  why: DispatchInput["why"],
  enabled: boolean,
): { why: string | undefined; suppressed: boolean } {
  // TOTAL, deliberately, and the type is not what makes it so. Two callers reach this with values
  // the schema has not approved yet: the binding's pre-`dispatch()` catch hands over the RAW
  // arguments, and `dispatch()` now resolves before its `readOnly` guard. `true?.trim` is not a
  // function, so a `typeof` test is the only thing standing between a wrong-typed `why` and a
  // thrown TypeError — which would replace the rejected `DispatchResult` both fronts promise with
  // an exception neither contract allows.
  //
  // A value that is not a string is therefore treated as NO value: it is not a `why` the contract
  // can carry, so nothing was withheld and no suppression is claimed. Treating it as present would
  // claim a delivery that could never have happened.
  const trimmed = typeof why === "string" ? why.trim() : "";
  if (trimmed.length === 0) return { why: undefined, suppressed: false };
  if (!enabled) return { why: undefined, suppressed: true };
  return { why: trimmed, suppressed: false };
}

/**
 * ADR-0043: stamp "a `why` was passed and this session dropped it" onto a result.
 *
 * Shaped exactly like {@link withReadOnlyTier} — absent means the claim does not apply — so a
 * refusal carries it too. A refusal still consumed the caller's `why`, and a caller comparing two
 * results should not have to know which shape it got to learn that.
 */
export function withWhySuppressed(result: DispatchResult, suppressed: boolean): DispatchResult {
  return suppressed ? { ...result, whySuppressed: true } : result;
}

/** Token usage accumulated from the child's message_end events. Optional. */
export interface DispatchUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

/** Structured return value of pi.dispatch(...). Shape mirrors Promise.allSettled records. */
export interface DispatchResult {
  text: string;
  status: "fulfilled" | "rejected";
  /**
   * Whether the child pi process was actually brought up.
   *
   * `status: "rejected"` covers two very different things — the harness declining to start
   * (depth gate, concurrency gate, unknown agent, a spawn that never happened) and a child that
   * ran and failed. The sub-call
   * tree colours the first `rejected` (the harness said no) and the second `error` (the work
   * failed), so it needs the distinction rather than inferring it from `status` alone.
   */
  started: boolean;
  agentName: string;
  durationMs: number;
  exitCode: number;
  usage?: DispatchUsage;
  /**
   * The provider that actually served the child, observed off its assistant `message_end`
   * events (the last turn wins).
   *
   * ABSENT means no assistant turn NAMED a provider -- it is not the claim "the model is
   * unknown while the child ran". Either there was no assistant turn to observe, or the pi
   * that ran the child does not report the pair on assistant messages (the wire field arrives
   * with pi 1.0.0; the declared floor is 0.86.0), or the turns that were observed named no
   * provider. PRESENT is the host having read the value off the wire; a dispatch that names
   * no model runs on pi's configured default, and before this field the caller had no way to
   * learn which default that was -- a wrong-model incident was invisible on the one surface
   * that had room to state it.
   */
  observedProvider?: string;
  /**
   * The model id the child actually ran, observed like {@link observedProvider}. Present even
   * when the provider field is absent -- a transcript may carry a model without a provider,
   * and dropping a half-observation would be worse than reporting it qualified by nothing.
   */
  observedModel?: string;
  stderr?: string;
  errorMessage?: string;
  /**
   * ADR-0053: the id of the task record this dispatch created.
   *
   * The registry is the ONLY trace a dispatch leaves (ADR-0053 decision 1), so the id is how
   * the caller finds the child afterwards: `ptc_task_output` and `ptc_task_stop` both take it.
   *
   * ABSENT means this dispatch left no record — a refusal that never got past a gate. The
   * gates run BEFORE the record is created, so "no id" is the honest signal that no child
   * was ever started and there is nothing to look up.
   *
   * **Why it is named `recordId` and not `taskId`.** The background HANDLE calls its id
   * `taskId` (ADR-0022 §4), and the two shapes are meant to converge on one object (spec
   * decision 3). But `src/tools/subagent.ts` recognises a background handle by the presence
   * of a STRING `taskId` on the outcome — so a foreground result that carried `taskId` would
   * make every foreground `pi_task_codemode` call report itself as a background handle and hand
   * the model "Started background task …" instead of the child's answer. This field is named
   * after the RECORD it names (`TaskRecord.id`), which is what it is, and the door-shape
   * work (#238) unifies the two names once that probe is fixed.
   */
  recordId?: ULID;
  /**
   * ADR-0053: the human label the record was created with — the caller's `label`, or the
   * task text truncated to 64 characters.
   *
   * Carried beside {@link recordId} because a caller that wants to look the task up later
   * needs to know WHICH task it is looking at, and an id alone says nothing about that.
   */
  recordLabel?: string;
  /** The child's child report, when one arrived over either channel. */
  report?: ChildReport;
  /**
   * ADR-0032 "The channel is always stated": TOTAL, present on every result including every
   * refusal. A degradation the caller cannot see is a silent failure (`docs/testing-constraints.md`
   * #3), so `reportChannel: "none"` is stated rather than left to be inferred from the absence
   * of `report`. This ticket only ever produces `"prompt-json"` and `"none"`; `"tool"` is in the
   * type so the report tool (#101) does not have to change it.
   */
  reportChannel: ChildReportChannel;
  /**
   * ADR-0041 §"The tier that took effect is reported": the tier actually applied to this
   * dispatch. PRESENT whenever a tier was requested, ABSENT when none was — so `undefined` is a
   * claim ("no tier was asked for"), not a gap.
   *
   * It is not negotiated, and the value never differs from what was asked for: call-site
   * precedence is total, so `resolveReadOnlyTier` has no second opinion to disagree with. The
   * field exists anyway because that is not the property a caller needs. What a caller needs is
   * to see that a definition's declared `tools:` was OVERRIDDEN — a `readOnlyTier` beside a
   * child whose agent file says `tools: read, bash` is the difference between "the tier narrowed
   * this child" and a tool list nobody can account for.
   *
   * Stamped on refusals too ({@link withReadOnlyTier}): it states the tier the call resolved to,
   * and a refusal means no child was launched with it, not that another tier was applied.
   *
   * The background front carries the same fact as {@link TaskRecord.readOnlyTier}, because a
   * background dispatch returns a `DispatchHandle` and has no result to put this on.
   */
  readOnlyTier?: ReadOnlyTier;
  /**
   * ADR-0043: `true` when the caller passed a `why` and this session's switch dropped it, so the
   * child's prompt carries no `<pi-ptc-why>` block.
   *
   * ABSENT is a claim, not a gap: the caller passed nothing, so nothing was withheld. That is the
   * distinction the field exists to make. Without it, a program that passes a `why` into a session
   * with the switch off cannot tell "the child ignored my context" from "the child never received
   * it" — and ADR-0042 spent 180 runs establishing that the difference is real.
   *
   * The dropped value is NOT recorded anywhere, on this result or on a TaskRecord. The fact that a
   * suppression happened is host-observed and therefore worth persisting; the value was the
   * caller's, and persisting it would be the thing ADR-0042 declined to do.
   */
  whySuppressed?: true;
}

/**
 * Whether a dispatch outcome is the BACKGROUND HANDLE rather than a result or a refusal.
 *
 * **The discriminant is `status`, not the presence of a task id.** ADR-0053 gave
 * {@link DispatchResult} a record id of its own (`recordId`), and a background handle carries
 * its id as `taskId` — so a `"taskId" in value` test can no longer tell the two apart by
 * shape alone. `status` is the one field the two shapes cannot share: a handle is always
 * `"running"`, a result is always `"fulfilled"` or `"rejected"`.
 */
export function isDispatchHandle(value: DispatchHandle | DispatchResult): value is DispatchHandle {
  return value.status === "running";
}

/** Discovery of an agent by name; mirrors pi's subagent extension AgentConfig shape. */
export interface AgentConfigLike {
  readonly name: string;
  readonly source: "user" | "project" | "unknown";
  readonly model?: string;
  readonly systemPrompt: string;
  readonly tools?: readonly string[];
  /**
   * ADR-0032 §The opt-out. `false` opts the agent out of the child report contract; `undefined`
   * is the DEFAULT and means on. Optional rather than required so every existing construction
   * site keeps compiling, and read through {@link isReportContractOn} so none of them can read it
   * the wrong way round.
   */
  readonly childReport?: boolean;
}

/**
 * The config a dispatch uses when the caller named no agent (issue #185).
 *
 * Every field is chosen to be inert:
 *
 * - `name: ""` is what the result reports as `agentName`, so a caller can see that no definition
 *   was resolved rather than being told a plausible-sounding one that does not exist.
 * - `systemPrompt: ""` means the child receives only what the dispatch itself appends (the depth
 *   hint and the dispatch context) on top of pi's own system prompt. Nothing is substituted.
 * - `tools` absent means `childToolList` yields `undefined`, so no `--tools` flag reaches the
 *   child and pi's own full toolset stands. This is the difference between a generalist and a
 *   narrowed agent, and it is the whole of it: a definition can only ever take tools away.
 * - `source: "unknown"` is honest — it came from no directory.
 *
 * A frozen literal rather than a factory: it has no per-dispatch state, and sharing one object
 * makes "the generalist is the same everywhere" a fact rather than a convention.
 */
export const GENERALIST_AGENT: AgentConfigLike = Object.freeze({
  name: "",
  source: "unknown",
  systemPrompt: "",
});

/** Per-run context handed to a dispatch binding; same shape as BindingContext. */
export interface DispatchContext {
  signal?: AbortSignal;
  callId: number;
  /** Run cwd (F4); default for `DispatchInput.cwd` when not overridden. */
  cwd: string;
  /** Depth of the calling PTC run: 0 for the parent turn, 1+ for a child of `pi.dispatch`. */
  depth: number;
  /** Maximum allowed depth for any run reachable from this dispatch (ADR-0016 Recursive section). */
  maxDispatchDepth: number;
  /**
   * ADR-0022 R1: dedicated session directory for background children. When set, the three
   * R1 session flags travel through {@link ChildSpawnOptions}; when absent, the spawn keeps
   * the foreground shape (no session flags).
   */
  sessionDir?: string;
  /**
   * ADR-0022 §5: the TaskRecord owner, which is also the subscription subscriber
   * ("Subscriber == owner"). Defaults to `dispatch:<callId>`.
   */
  callerId?: string;
  /**
   * ADR-0022 §3: parent background task id when this spawn is itself a background child,
   * so the session registry can reconstruct the task tree.
   */
  parentTaskId?: ULID;
  /**
   * ADR-0044: the caller session's current model, when the host could read one off pi's
   * tool-execution context. It is the LAST resort of the dispatch model precedence
   * (`input.model > agent markdown model > session model > pi's configured default`), so
   * `undefined` keeps the pre-ADR-0044 behaviour exactly: a dispatch with no explicit model
   * runs on pi's default.
   *
   * A snapshot, not a live reference: the child is spawned with the value resolved once, so
   * switching the session model afterwards does not retro-change an already-running child.
   */
  sessionModel?: SessionModel;
}

/**
 * The child report clause of the child's appended system prompt (ADR-0032).
 *
 * The shape lives HERE, and the report tool's description points at it rather than repeating it.
 *
 * Ticket #101 moved the shape into the tool description, on the one-home rule. That was wrong,
 * and building #101 is what proved it. The tool exists in the child only when this package loads
 * there — a child loads it only if this package loads there, and pi's `-ne` (or a `pi config`
 * that disables the package) removes extensions — so a child without the tool had nothing left to
 * comply with. (ADR-0034 removed the `surfaceMode: "off"` value that used to be the other way
 * this could fail; the surviving way is pi's own.) The prompt channel
 * stopped being a fallback and became dead code that still had tests.
 *
 * The prompt is the home that survives that, because the HOST controls it unconditionally. The
 * tool is the channel that is RELIABLE when present, not the one that is always present; those
 * are different virtues and conflating them loses the fallback. So: shape here, tool description
 * describes the tool and refers here. Still one copy — the rule was never "prompt vs tool", it
 * was "exactly one".
 */
const CHILD_REPORT_PROMPT_CLAUSE =
  "Before you finish, hand the host a child report. Prefer calling the `" +
  CHILD_REPORT_TOOL_NAME +
  "` tool once with it. If that tool is not available to you, end your reply with a fenced " +
  "```json block containing " +
  CHILD_REPORT_SHAPE +
  ". Either way your prose answer is kept alongside the report and never replaced by it, and " +
  "you must not report usage or token counts — those are measured by the host.";

/**
 * ADR-0041: what the `lenient` tier actually says. It lives in the child's prompt because the
 * child is the party that has to act on it — the caller's `readOnly: "lenient"` reaches this
 * text and nothing else.
 *
 * The clause names what it does NOT do. A child told only "work read-only" would reasonably
 * wonder whether `edit` was removed and misread the absence as a failure; stating that the tools
 * are all still there is what makes the tier's honesty checkable from the prompt rather than
 * taken on trust.
 */
const READ_ONLY_PROMPT_CLAUSE =
  "You were dispatched read-only: do not create, modify or delete files, and do not run commands " +
  "that would. Your tools are otherwise all still available to you — this is an instruction, not " +
  "a restriction, so a task that genuinely needs to write is worth saying so rather than failing " +
  "quietly.";

/**
 * Build the context block appended to every dispatched child's system prompt, after whatever the
 * definition contributed.
 *
 * The name is narrower than the job and is kept deliberately: the depth hint was its first
 * occupant, and by #186 the block also carries what the child IS. Renaming it is a change of its
 * own rather than a passenger on a ticket about the content.
 *
 * The first job is the recursion hint. The agent's own markdown body is the user-supplied content;
 * pi-ptc appends a `<pi-ptc-context depth="N" max-depth="M">...</pi-ptc-context>` block so the
 * child agent can see how much recursion room it has. The shape mirrors DSH's existing
 * subagent-context injection so the field recognises it.
 *
 * Three claims are made here, and each exists because pi's own system prompt makes the opposite
 * one true of a session the user is talking to: that this is a dispatched child rather than that
 * session, that it cannot see or ask the dispatcher anything, and that its final message is what
 * the caller receives. The middle one is what stops a child asking a question nobody will answer;
 * the last is what stops it narrating where an answer was wanted.
 *
 * `options.reportContract` is the ADR-0032 opt-out: `false` leaves the clause out entirely,
 * because an agent that opted out is never asked for a report. It defaults to on, so an agent
 * whose markdown says nothing about it gets the contract (ticket #102).
 *
 * `options.why` is ADR-0042's input-side counterpart to the report: the caller's reason for this
 * dispatch slice. It is appended as its OWN block after `</pi-ptc-context>` rather than folded
 * into it, because everything inside that block is the host speaking, and the child has to be
 * able to tell the host's policy from the caller's content. An absent or blank why emits no
 * block at all: an empty block reads as "there was content and it was withheld".
 */
export function appendDepthHint(
  systemPrompt: string,
  depth: number,
  maxDepth: number,
  options: {
    reportContract?: boolean;
    readOnly?: DispatchInput["readOnly"];
    why?: string | undefined;
  } = {},
): string {
  const reportContract = options.reportContract !== false;
  const readOnly = resolveReadOnlyTier(options.readOnly);
  const hint = [
    '<pi-ptc-context depth="' + depth + '" max-depth="' + maxDepth + '">',
    "You are a PTC run at depth " +
      depth +
      " (root is depth 0). You may write PTC programs and you may",
    "call pi_task_ptc(...) to spawn further children, but each level costs a fresh pi subprocess.",
    "The remaining depth budget is " +
      maxDepth +
      " - " +
      depth +
      ". Beyond it, the PTC door rejects with",
    '{ status: "rejected", errorMessage: "dispatch depth limit reached" }.',
    "You were dispatched by another pi session as a fresh context. You cannot see that session's",
    "conversation and you cannot ask it anything, so if the task you were given is underspecified,",
    "say which part is underspecified and answer the rest rather than inventing the missing",
    "context. Your final message is the deliverable: it is what the caller receives, so put the",
    "answer there rather than narrating how you found it.",
    ...(reportContract ? [CHILD_REPORT_PROMPT_CLAUSE] : []),
    ...(readOnly === "lenient" ? [READ_ONLY_PROMPT_CLAUSE] : []),
    "</pi-ptc-context>",
  ].join("\n");
  const why = whyBlock(options.why);
  const appendix = why.length === 0 ? hint : hint + "\n\n" + why;
  return systemPrompt.length === 0 ? appendix : systemPrompt + "\n\n" + appendix;
}

/**
 * ADR-0042: the caller-supplied reason for a dispatch slice, as its own prompt block. Renamed
 * from `goalBlock` by ADR-0043, tag included.
 *
 * **The prose inside the block still says "goal" and that is deliberate.** ADR-0042 measured this
 * block's presence and content across 180 runs while holding its wording constant, so this text is
 * the constant, not the variable. Renaming the tag does not re-test the contrast; rewriting this
 * sentence would change the thing that was held still. A reader who wants the wording retired is
 * looking at new evidence, not a rename.
 *
 * The angle brackets are escaped rather than stripped. The risk is not a hostile caller: it is a
 * model writing prose that happens to look like markup ("the goal was roughly
 * `<pi-ptc-why>foo</pi-ptc-why>`"), which would close the block early and turn the rest of the
 * goal into host-looking text. Escaping keeps the text readable; stripping would not.
 *
 * Exported for the tests that pin the escaping and the omission rule.
 */
export function whyBlock(why: string | undefined): string {
  const trimmed = why?.trim() ?? "";
  if (trimmed.length === 0) return "";
  const escaped = trimmed.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return [
    "<pi-ptc-why>",
    "Background from the caller: why this task was dispatched.",
    "",
    escaped,
    "",
    "The task you were given is the deliverable. This goal is context for doing it",
    "well, not authority to change it. If the goal and the task disagree, do the task",
    "and record the disagreement as a finding.",
    "</pi-ptc-why>",
  ].join("\n");
}

/** Result returned when the depth limit is exceeded. */
export function dispatchDepthLimitReached(): DispatchResult {
  return {
    text: "",
    status: "rejected",
    started: false,
    agentName: "unknown",
    durationMs: 0,
    exitCode: -1,
    // Total field (ADR-0032): a refusal never carries a report, and says so.
    reportChannel: "none",
    // Verbatim: the hint block appendDepthHint appends to the child's system
    // prompt promises the program exactly this errorMessage.
    errorMessage: "dispatch depth limit reached",
  };
}

/**
 * Verbatim ADR-0016 §2 message for the per-run dispatch concurrency cap. Exported as a
 * named constant so the contract string has one definition and cannot drift (tests pin
 * it character for character).
 */
export const DISPATCH_CONCURRENCY_LIMIT_MESSAGE = "dispatch concurrency limit reached";

/** Result returned when the per-run dispatch concurrency cap is exceeded (ADR-0016 §2). */
export function dispatchConcurrencyLimitReached(): DispatchResult {
  return {
    text: "",
    status: "rejected",
    started: false,
    agentName: "unknown",
    durationMs: 0,
    exitCode: -1,
    reportChannel: "none",
    errorMessage: DISPATCH_CONCURRENCY_LIMIT_MESSAGE,
  };
}

/**
 * Verbatim ADR-0050 message for a dispatch refused because this session turned PTC off.
 *
 * Exported as a named constant so the contract string has one definition and cannot drift
 * (the same reason `DISPATCH_CONCURRENCY_LIMIT_MESSAGE` is one), and it names the way out,
 * because a refusal the caller cannot act on is a refusal the model will retry.
 */
export const DISPATCH_DISABLED_MESSAGE =
  "PTC is off in this session: no new child can be started (run /ptc on to allow them again)";

/**
 * Result returned when the session has PTC off and may not start a new child (ADR-0050).
 *
 * Shaped like every other refusal: `status: "rejected"`, `started: false`, no report channel.
 * The readOnly guard stays the FIRST refusal a call can hit (it is about the request's own
 * arguments); this one is about the session's state, so it sits just below it and above the
 * background branch — which is what makes both fronts get it.
 */
export function dispatchDisabledResult(): DispatchResult {
  return {
    text: "",
    status: "rejected",
    started: false,
    agentName: "unknown",
    durationMs: 0,
    exitCode: -1,
    reportChannel: "none",
    errorMessage: DISPATCH_DISABLED_MESSAGE,
  };
}

/**
 * Grace window between SIGTERM and SIGKILL for every kill site (ADR-0022 §8). The foreground
 * abort path introduced the literal 5000ms; the background stop watcher and the background
 * failure-path reap reuse this one constant so there is a single ladder, not a second number.
 */
export const DISPATCH_KILL_GRACE_MS = 5000;

/**
 * Send SIGTERM to `handle`, schedule SIGKILL after {@link DISPATCH_KILL_GRACE_MS}, and return a
 * function that cancels a pending escalation. `isDone` is checked when the escalation fires, so
 * a child that closed in the meantime is never signalled again; `unref` keeps a detached
 * escalation from holding the host process open.
 */
export function killWithEscalation(
  lifecycle: ChildProcessLifecycle,
  handle: ChildHandle,
  options: { isDone?: () => boolean; unref?: boolean } = {},
): () => void {
  lifecycle.kill(handle, "SIGTERM");
  const timer = setTimeout(() => {
    if (options.isDone?.() === true) return;
    lifecycle.kill(handle, "SIGKILL");
  }, DISPATCH_KILL_GRACE_MS);
  if (options.unref === true) timer.unref();
  return () => clearTimeout(timer);
}

/**
 * Background-specific refusal copy (issue #68 part 4 / wayfinder T4.4): a refused *background*
 * spawn points the model at the management surface, exactly as ADR-0022 §3 expects it to inspect
 * and free in-flight tasks. The shared foreground helpers keep the ADR-0016 wording byte-for-byte.
 */
export const BACKGROUND_DEPTH_LIMIT_MESSAGE =
  "dispatch depth limit reached; next_step: call ptc_task_list to inspect the in-flight background tasks";

export const BACKGROUND_CONCURRENCY_LIMIT_MESSAGE =
  "dispatch concurrency limit reached; next_step: call ptc_task_list to inspect running tasks and ptc_task_stop to free a slot";

/** Background depth refusal: same machine fields as the foreground one, teaching copy added. */
export function backgroundDispatchDepthLimitReached(): DispatchResult {
  return { ...dispatchDepthLimitReached(), errorMessage: BACKGROUND_DEPTH_LIMIT_MESSAGE };
}

/** Background concurrency refusal: same machine fields, teaching copy added. */
export function backgroundDispatchConcurrencyLimitReached(): DispatchResult {
  return {
    ...dispatchConcurrencyLimitReached(),
    errorMessage: BACKGROUND_CONCURRENCY_LIMIT_MESSAGE,
  };
}

/**
 * The stderr line pi's own print mode writes when the final response was cut off
 * at the model's output token limit, captured verbatim from
 * `@earendil-works/pi-coding-agent@1.2.0`'s `dist/modes/print-mode.js:126`:
 *
 * ```
 * console.error("Response was truncated: the model reached its output token limit.");
 * ```
 *
 * That release is also where the exit code changed: a truncated `-p` run used to
 * exit 0 with its partial text, and 1.2.0 prints the partial text, writes this
 * line to stderr, and exits 1. On pi <= 1.1.x the line never appears, so every
 * reader of this constant is dead code there — the predicate below simply never
 * fires, which is why no version gate is needed.
 *
 * Matched as a SUBSTRING, not a whole-line equality: pi may prefix or suffix it
 * (a retry banner, a newline), and the diagnostic value is in the sentence, not
 * in the surrounding bytes.
 */
export const PI_TRUNCATION_WARNING =
  "Response was truncated: the model reached its output token limit.";

/**
 * The errorMessage a truncated child carries, or `undefined` when its stderr does
 * not name truncation. Shared by the foreground `decideCloseOutcome` and the
 * background `resolve-exit` path so the two fronts cannot disagree about wording.
 *
 * `stderr` may be empty on old pi, on a spawn failure, or from a lifecycle adapter
 * that does not capture it; all three are the same `undefined`.
 */
export function truncationFailureMessage(stderr: string | undefined): string | undefined {
  if (stderr === undefined || stderr.length === 0) return undefined;
  return stderr.includes(PI_TRUNCATION_WARNING)
    ? "child response was truncated at the model's output token limit (pi exited non-zero)"
    : undefined;
}

/**
 * Inputs to {@link decideCloseOutcome}: the shape the child's `close` event
 * hands the host, distilled to the fields that drive the resolve decision.
 */
export interface CloseOutcomeInput {
  /** `code ?? -1` from the child's close event. `-1` covers signal kill and no-code exit. */
  exitCode: number;
  /** Accumulated text from the last assistant message_end event. */
  finalText: string;
  /** `true` when `ctx.signal` aborted before this close fired. */
  aborted: boolean;
  /**
   * The child's accumulated stderr, or `undefined` when the caller did not capture it.
   *
   * pi 1.2.0 labels a truncated print-mode run with a stderr warning AND exit 1;
   * without this field such a close lands in the anonymous `rejected` branch and
   * the model is told only that the dispatch failed. The information is not lost —
   * the foreground `DispatchResult.stderr` carries the same bytes — but an
   * errorMessage that names the cause is what a caller reads first.
   */
  stderr?: string;
  /**
   * The failure the child reported about itself, or `undefined` when it reported none.
   *
   * A rate-limited or model-errored child still exits 0: pi writes
   * `stopReason: "error"` + `errorMessage` onto the assistant `message_end` (usually with
   * empty content) and retries until it gives up, so the exit code carries no signal at all
   * and the text is empty. The background pump has always turned that pair into the record's
   * `errorMessage` (issue #70); the foreground path used to discard it and report only
   * "dispatch produced no final text". Passing it here makes the two fronts reach the same
   * verdict on the same transcript.
   */
  childError?: string;
}

/** Result of {@link decideCloseOutcome} — what the dispatcher commits to. */
export interface CloseOutcome {
  status: "fulfilled" | "rejected";
  errorMessage?: string;
}

/**
 * Decide the outcome of one `dispatch(...)` based on the child's `close` event.
 *
 * Cancellation has priority over every other branch: when the host's signal
 * aborted the run, the child exited because we asked it to, and the contract
 * (ADR-0016 §4) is to surface "dispatch cancelled" rather than leave the
 * caller guessing why an aborted run came back `rejected`.
 *
 * Non-cancellation cases follow the original close-handler ladder, with the child's own
 * failure report inserted exactly where the background registry puts it:
 *   - exit 0 with final text → fulfilled (a child that produced an answer is a success, even
 *     if an earlier retry reported an error: the last turn is what the caller receives)
 *   - a non-empty `childError` → rejected with that message UNWRAPPED, so the caller reads
 *     the provider's own diagnosis ("429 …") rather than a paraphrase of it. This outranks
 *     the exit-0 wording because a rate-limited child exits 0 with no text, and it outranks
 *     the truncation inference because a self-reported failure is a better diagnosis than
 *     one inferred from stderr.
 *   - exit 0 without final text → rejected (the model never answered, and said nothing about why)
 *   - any other exit code → rejected; the errorMessage names a truncation when
 *     the child's stderr does (pi 1.2.0's print mode), and is absent otherwise.
 *     The spawn-error path labels its own failures with `failed to spawn pi: ...`
 *     before this function runs, so it never reaches the catch-all.
 *
 * The order mirrors `resolveExitErrorMessage` in `task-registry.ts` on purpose: one
 * transcript must not resolve one way on the foreground front and another way on the
 * background front (the failure issue #70 was about).
 */
export function decideCloseOutcome(input: CloseOutcomeInput): CloseOutcome {
  if (input.aborted) {
    return { status: "rejected", errorMessage: "dispatch cancelled" };
  }
  if (input.exitCode === 0 && input.finalText.length > 0) {
    return { status: "fulfilled" };
  }
  if (input.childError !== undefined && input.childError.length > 0) {
    return { status: "rejected", errorMessage: input.childError };
  }
  if (input.exitCode === 0) {
    return { status: "rejected", errorMessage: "dispatch produced no final text" };
  }
  const truncated = truncationFailureMessage(input.stderr);
  return { status: "rejected", ...(truncated === undefined ? {} : { errorMessage: truncated }) };
}

/**
 * Minimal YAML frontmatter scalar parser. Returns the trimmed value, with surrounding
 * double or single quotes stripped when both are present.
 */
function extractYamlString(yaml: string, key: string): string | undefined {
  const m = yaml.match(new RegExp("^" + key + ":\\s*(.+)$", "m"));
  if (!m) return undefined;
  let v = (m[1] ?? "").trim();
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      v = v.slice(1, -1);
    }
  }
  return v.length === 0 ? undefined : v;
}

/**
 * Minimal YAML list parser: accepts inline `[a, b, c]` and bare `a, b, c`.
 */
function extractYamlList(yaml: string, key: string): string[] | undefined {
  const m = yaml.match(new RegExp("^" + key + ":\\s*(.+)$", "m"));
  if (!m) return undefined;
  const raw = (m[1] ?? "").trim();
  let inner = raw;
  if (inner.startsWith("[") && inner.endsWith("]")) {
    inner = inner.slice(1, -1);
  }
  const parts = inner
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length === 0 ? undefined : parts;
}

/**
 * The frontmatter key that opts an agent out of the child report contract, and the only one
 * (ADR-0032 §The opt-out, ticket #102).
 *
 * A yes/no and deliberately not a schema: a per-agent schema would reopen the two-copies problem
 * ADR-0032 closes and would buy flexibility nobody has asked for.
 */
export const AGENT_CHILD_REPORT_KEY = "childReport";

/**
 * Read the opt-out switch. Absent means ON — the contract is the default and an agent that says
 * nothing about it gets it.
 *
 * Only the literal `false` / `no` opts out. Everything else (including a typo like `flase`, and
 * including a value this parser cannot make sense of) leaves the contract on, because the failure
 * mode of guessing wrong here is a report nobody expected on a result that still carries one, and
 * the failure mode of guessing the other way is a child marked for non-compliance that was never
 * asked. Neither is recoverable by the reader; the first is at least visible.
 *
 * This is deliberately NOT pi's `parseFrontmatter`. This module has always parsed the keys it
 * needs with two small regexes, and switching parsers here would change how every OTHER key is
 * read (quoting, nesting, error reporting) as a side effect of adding one. That is a separate
 * change with its own tests, not something to smuggle in with an opt-out flag.
 */
function readChildReportSwitch(frontmatter: string): boolean | undefined {
  const raw = extractYamlString(frontmatter, AGENT_CHILD_REPORT_KEY);
  if (raw === undefined) return undefined;
  return raw.toLowerCase() === "false" || raw.toLowerCase() === "no" ? false : true;
}

/**
 * Whether this agent is under the report contract (ADR-0032 §The opt-out).
 *
 * Total and one-valued on purpose: every caller asks the same question, so an opted-out agent is
 * never asked for a report by ANY of them — not in the prompt, not in the argv — and the answer
 * cannot disagree with itself between the two call sites.
 */
export function isReportContractOn(agent: Pick<AgentConfigLike, "childReport">): boolean {
  return agent.childReport !== false;
}

/**
 * Parse an agent markdown file: YAML frontmatter (name / description / model / tools /
 * childReport) plus the body, returned as the system prompt. Tolerates a missing or partial
 * frontmatter; the caller falls back to defaults when this returns null.
 *
 * `childReport` is present ONLY when the frontmatter names it. Absent is meaningful — it is how
 * "the contract is on" is spelled, and {@link isReportContractOn} is what reads it, so no call
 * site has to remember which way round the default goes.
 */
export function parseAgentMarkdown(content: string): {
  name: string;
  description?: string;
  model?: string;
  tools?: readonly string[];
  childReport?: boolean;
  systemPrompt: string;
} | null {
  /*
   * T3 (#180): the delimiter is matched LINE-ENDING-AGNOSTIC, and the file is not re-encoded to
   * make it match.
   *
   * The previous pattern spelled `\n` literally, so it accepted exactly one file shape. An agent
   * saved with CRLF (any Windows editor, or a repo with `core.autocrlf`), with a UTF-8 BOM, or
   * with a blank line before the delimiter parsed to `null` -- and `null` reads, from every layer
   * above, as "no such agent". A good definition silently stopped being an agent.
   *
   * The BODY is normalised after the match rather than inside it, because the frontmatter
   * extractors match with the `m` flag and trim what they capture: leaving `\r` in the captured
   * group would be harmless to them and corrosive to the prompt, which is handed to a child as a
   * system prompt where a trailing `\r` on every line is not.
   */
  const fmMatch = content.match(
    /^\uFEFF?[ \t]*(?:\r?\n)?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/,
  );
  if (!fmMatch) return null;
  // `[^]` above can leave a leading blank line in the frontmatter when the file had one; the
  // extractors are anchored per-key so a stray blank line is inert, and the body is trimmed below.
  const frontmatter = (fmMatch[1] ?? "").replace(/\r\n/g, "\n");
  const body = (fmMatch[2] ?? "").replace(/\r\n/g, "\n");
  const name = extractYamlString(frontmatter, "name");
  if (!name) return null;
  const description = extractYamlString(frontmatter, "description") ?? "";
  const model = extractYamlString(frontmatter, "model") ?? "";
  const tools = extractYamlList(frontmatter, "tools");
  const childReport = readChildReportSwitch(frontmatter);
  const out: {
    name: string;
    description?: string;
    model?: string;
    tools?: readonly string[];
    childReport?: boolean;
    systemPrompt: string;
  } = {
    name,
    systemPrompt: body.trim(),
  };
  if (description !== undefined) out.description = description;
  if (model !== undefined) out.model = model;
  if (tools !== undefined) out.tools = tools;
  if (childReport !== undefined) out.childReport = childReport;
  return out;
}

/**
 * Whether a `.md` file's head says it was written AS an agent definition, as opposed to being
 * prose kept beside the agents (#204).
 *
 * `parseAgentMarkdown` returns a bare `null`, so a caller cannot tell "no frontmatter" from
 * "frontmatter without a `name:`" — and that distinction is the whole question. Both readings
 * mean the file is not an agent (#201), but only one of them means the user wrote something and
 * it silently failed, so only one of them may be silent.
 *
 * The discrimination is the FIRST non-blank line, never the whole file. A file is definition-
 * shaped when that line opens a frontmatter block (`---`) or is a `name:` key — the second form
 * being the real one, since a definition saved with its opening delimiter lost still leads with
 * its own `name:`. Anchoring on the head is what keeps prose out: a README whose body uses `---`
 * as a horizontal rule, or mentions `name:` in a sentence, is documentation kept beside the
 * agents, and Claude Code reaches the same verdict and the same silence for exactly this case
 * (docs.claude.com/en/docs/claude-code/sub-agents, "Subagent files Claude Code skips").
 *
 * Deliberately not a `name:` scan anywhere in the file. That is the one discriminator the
 * ecosystem does not use, and it has no false-positive story: any prose file that happens to
 * mention the key would warn on every render of the roster.
 */
function opensLikeAgentDefinition(raw: string): boolean {
  const firstLine = raw
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0);
  if (firstLine === undefined) return false;
  const head = firstLine.trim();
  return head === "---" || /^name[ \t]*:/.test(head);
}

/** One agent definition as {@link scanAgentDefinitions} found it: the full parse, plus where it came from. */
interface ScannedDefinition {
  readonly name: string;
  /** The frontmatter `description`, trimmed; `""` when the definition declares none. */
  readonly description: string;
  readonly source: "user" | "project";
  readonly filePath: string;
  readonly model?: string;
  readonly tools?: readonly string[];
  readonly childReport?: boolean;
  readonly systemPrompt: string;
}

interface AgentScan {
  /** Keyed by the frontmatter `name:`; the first definition to claim a name keeps it. */
  readonly definitions: ReadonlyMap<string, ScannedDefinition>;
  /**
   * Pre-formatted `console.warn` lines. The roster emits them; discovery deliberately does not,
   * because every discovery refusal renders the roster, which emits them there.
   */
  readonly diagnostics: readonly string[];
}

/**
 * The ONE traversal of the agents directories (#205). Both `discoverAgent` and
 * `listRegisteredAgentEntries` read this, and that is the whole point: #201 established the
 * invariant that the names a roster lists are the names a dispatch resolves, and two traversals
 * are two places for the predicate and the scope precedence to be spelled slightly differently.
 *
 * A definition's identity is its frontmatter `name:` and nothing else. The file name is
 * decorative: `beta.md` carrying `name: gamma` is the agent `gamma`. A `.md` carrying no `name:`
 * is not an agent at all -- pi's own subagent loader skips such a definition and never derives
 * identity from the file name -- so there is no fallback to the file name (#201).
 *
 * Two names, two answers, both resolved the same way as everywhere else in the ecosystem:
 *
 * - **Across scopes** — user wins over project, which is the OPPOSITE of pi's own subagent
 *   example README, Claude Code, OpenHands, Roo Code and the Agent Skills client guide, all of
 *   which say project-over-user. The divergence is deliberate (#207): a user's
 *   `~/.pi/agent/agents/` entry is a personal, machine-wide choice, while a `<cwd>/.pi/agents/`
 *   entry is checked into a repository and shared, so letting the shared file silently override
 *   the personal one would make which definition runs depend on who checked out. It only bites
 *   for `agentScope: "both"`, which is not the default.
 * - **Within one scope** — two files declaring one name is a genuine mistake by the user, and
 *   the Agent Skills client guide requires it be resolved deterministically AND that the
 *   shadowed file be reported: "pick one and be consistent. Log a warning when a collision occurs
 *   so the user knows a skill was shadowed." Entries are sorted by file name, so "first" means
 *   first alphabetically rather than in filesystem order -- Claude Code admits its own behaviour
 *   here is readdir order with no documented precedence, which is the non-deterministic option
 *   this deliberately does not take.
 *
 * Per lookup directory:
 *
 * - **Silent** (no entries, no warn -- the path genuinely holds nothing to list): the agents
 *   dir is absent, together with every component above it (the normal case for a project with
 *   no `.pi/agents/`); the case where a component ABOVE it is a plain FILE, which makes it
 *   impossible rather than broken and reports ENOTDIR instead of ENOENT; and a parent symlink
 *   that resolves to a real directory that simply has no agents dir under it. All stay silent
 *   because a refusal must not be cluttered for a project that simply has no agents.
 * - **Observable** (a `console.warn` with the path and the OS code, then continue with the other
 *   side): the path EXISTS but cannot be listed -- a file where the agents dir belongs (ENOTDIR),
 *   a symlink at the agents path pointing at a file (ENOTDIR) or at a deleted target (ENOENT on
 *   both readdir and a following stat), a broken symlink in a PARENT component (ENOENT/ENOTDIR
 *   all the way down, invisible to a final-component lstat), or any other code (permissions, a
 *   symlink loop / ELOOP, EIO).
 *
 * {@link isSilentReaddirMiss} carries the full, exhaustive enumeration of which errno shapes
 * land in each bucket; this summary and it must not drift.
 *
 * A `.md` file that exists but cannot be read (permissions, wrong file type) is skipped with a
 * diagnostic, so the failure is observable (testing-constraints #3). It is not registered under
 * its file name, for the same reason a nameless one is not: `discoverAgent` cannot resolve it
 * either, and a roster entry that nothing can dispatch is the identical contradiction (#201).
 *
 * A `.md` file that reads but does not PARSE is skipped and not registered either -- that part is
 * #201 and unchanged. What #204 added is the third bucket, between "cannot read" and "was never
 * a definition": a file whose head says it was written as a definition and then failed to parse
 * gets its own diagnostic, naming the path. Without it the two readings collapse -- the roster
 * says nothing either way, so "the agent I wrote vanished" is indistinguishable from "there were
 * never any agents" until the user goes and reads the source.
 *
 * {@link opensLikeAgentDefinition} is what separates that bucket from the prose beside it, and it
 * reads the FIRST non-blank line only. A file leading with `---`, or with a `name:` key, is
 * definition-shaped; anything else is documentation kept beside the agents and stays silent.
 * Anchoring on the head is what makes the silence safe -- a README whose body uses `---` as a
 * rule, or mentions `name:` in a sentence, is not a broken definition.
 *
 * The registry is identical in all three buckets. This is about the signal, not the roster, and
 * the roster's silence about a nameless definition is still the true answer (#201).
 *
 * Known limit: these warnings fire only when something renders the roster -- the pre-decision
 * view or a refusal. No session-start scan reads the agents directories, so a broken definition
 * nobody ever asks for by name is never announced. That predates #204 and is not addressed by
 * it.
 */
function scanAgentDefinitions(input: RegisteredAgentsListInput): AgentScan {
  const { userDir, projectDir, userRoot, projectRoot } = resolveAgentDirs(input);
  const dirs: Array<{ dir: string; boundary: string; source: "user" | "project" }> = [];
  if (input.agentScope === "user" || input.agentScope === "both") {
    dirs.push({ dir: userDir, boundary: userRoot, source: "user" });
  }
  if (input.agentScope === "project" || input.agentScope === "both") {
    dirs.push({ dir: projectDir, boundary: projectRoot, source: "project" });
  }
  const definitions = new Map<string, ScannedDefinition>();
  const diagnostics: string[] = [];
  for (const { dir, boundary, source } of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch (error) {
      if (!isSilentReaddirMiss(dir, boundary, error)) {
        diagnostics.push(
          `pi.dispatch: cannot read agent directory ${dir} (${errnoCode(error)}); ` +
            "the agents registered there are not listed",
        );
      }
      continue;
    }
    // Sorted so the within-scope tie-break is "first alphabetically", not filesystem order.
    names.sort();
    for (const entry of names) {
      if (!entry.endsWith(".md")) continue;
      const filePath = path.join(dir, entry);
      let raw: string;
      try {
        raw = fs.readFileSync(filePath, "utf-8");
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        diagnostics.push(`pi.dispatch: cannot read agent file ${filePath}: ${detail}; skipping it`);
        continue;
      }
      const parsed = parseAgentMarkdown(raw);
      // No fallback to the file name (#201). Identity is the frontmatter `name:`, so advertising a
      // file name here would register an agent `discoverAgent` cannot resolve -- in the same
      // message, which is what made the bug unreadable.
      if (!parsed) {
        if (opensLikeAgentDefinition(raw)) {
          diagnostics.push(
            `pi.dispatch: agent file ${filePath} looks like an agent definition but its ` +
              "frontmatter did not parse (no usable `name:`); it is not listed and cannot be " +
              "dispatched",
          );
        }
        continue;
      }
      const incumbent = definitions.get(parsed.name);
      if (incumbent) {
        // Cross-scope shadowing is the documented rule (#207), not a mistake, so it is not a
        // diagnostic. Two files in the SAME scope claiming one name is a mistake, and the Agent
        // Skills client guide requires the loser be reported.
        if (incumbent.source === source) {
          diagnostics.push(
            `pi.dispatch: agent name "${parsed.name}" is declared by both ${incumbent.filePath} ` +
              `and ${filePath}; using ${incumbent.filePath} and shadowing the other (#205)`,
          );
        }
        continue;
      }
      definitions.set(parsed.name, {
        name: parsed.name,
        description: (parsed.description ?? "").trim(),
        source,
        filePath,
        ...(parsed.model !== undefined ? { model: parsed.model } : {}),
        ...(parsed.tools !== undefined ? { tools: parsed.tools } : {}),
        ...(parsed.childReport !== undefined ? { childReport: parsed.childReport } : {}),
        systemPrompt: parsed.systemPrompt,
      });
    }
  }
  return { definitions, diagnostics };
}

/**
 * Discover an agent by name. Mirrors pi's subagent extension agentScope behaviour:
 * user-level (`~/.pi/agent/agents/`) is loaded by default; project-level
 * (`<cwd>/.pi/agents/`) is loaded only when agentScope includes it.
 *
 * Both lookup paths come from {@link resolveAgentDirs} — the same resolver `listRegisteredAgents`
 * and `describeRegisteredAgents` use — so the agent a refusal message lists and the agent a
 * dispatch loads cannot drift. `homeDir` (the optional `options`) is the same test seam
 * `listRegisteredAgents` exposes; omitting it keeps every existing call site on `os.homedir()`.
 */
export function discoverAgent(
  name: string,
  cwd: string,
  agentScope: "user" | "project" | "both",
  options?: { homeDir?: string },
): AgentConfigLike | null {
  const { definitions } = scanAgentDefinitions({ cwd, agentScope, homeDir: options?.homeDir });
  const found = definitions.get(name);
  if (found === undefined) return null;
  const out: AgentConfigLike = {
    name: found.name,
    source: found.source,
    systemPrompt: found.systemPrompt,
  };
  if (found.model !== undefined) (out as { model?: string }).model = found.model;
  if (found.tools !== undefined) (out as { tools?: readonly string[] }).tools = found.tools;
  if (found.childReport !== undefined) {
    (out as { childReport?: boolean }).childReport = found.childReport;
  }
  return out;
}

/**
 * Inputs to {@link listRegisteredAgents}: the same two lookup axes `discoverAgent` uses.
 * `homeDir` is a test seam so the listing is unit-testable without touching the real HOME.
 */
export interface RegisteredAgentsListInput {
  cwd: string;
  agentScope: "user" | "project" | "both";
  /** Overrides `os.homedir()` (the user-level agent root). Tests only. */
  homeDir?: string;
}

/** The two lookup axes both agent listers use, resolved once so they cannot drift. */
function resolveAgentDirs(input: RegisteredAgentsListInput): {
  userDir: string;
  projectDir: string;
  userRoot: string;
  projectRoot: string;
} {
  const home = input.homeDir ?? os.homedir();
  return {
    userDir: path.join(home, ".pi", "agent", "agents"),
    projectDir: path.join(input.cwd, ".pi", "agents"),
    userRoot: home,
    projectRoot: input.cwd,
  };
}

/** The OS error code of a thrown fs error (`"ENOENT"`, `"ENOTDIR"`, …), or its string form. */
function errnoCode(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : String(error);
}

/**
 * True when `dir` itself exists but is not a usable directory — a file sitting in the agents
 * path, a symlink whose target is a file, or a dangling symlink.
 *
 * `statSync` follows symlinks, so a DANGLING link fails it exactly like a truly absent path;
 * `lstatSync` does not, and is the only thing that separates "the entry is there but unusable"
 * from "nothing is there". Without that second look a `.pi/agents -> <deleted>` link is
 * indistinguishable from a never-configured project.
 *
 * Scope: the FINAL component only. A broken link ABOVE it is invisible here (every `lstat` of
 * `dir` fails through the link) — {@link hasUnresolvableSymlinkAncestor} covers that case.
 */
function existsButIsNotADirectory(dir: string): boolean {
  try {
    return !fs.statSync(dir).isDirectory();
  } catch {
    try {
      // Reachable as a directory entry (typically a dangling symlink): present but unusable.
      fs.lstatSync(dir);
      return true;
    } catch {
      // Absent, or a parent component is not a directory — nothing is there to report.
      return false;
    }
  }
}

/**
 * Hard cap on the ancestor walk, so a pathological or relative `boundary` can never turn the
 * silence check into an unbounded climb. The real paths are `<cwd>/.pi/agents` and
 * `<home>/.pi/agent/agents` — 2 and 3 components below their boundary — so 8 is generous.
 */
const MAX_ANCESTOR_WALK = 8;

/**
 * True when a component STRICTLY BELOW `boundary` is a symlink that cannot be resolved, so
 * `dir` is unreachable even though the path was configured.
 *
 * `<cwd>/.pi -> <deleted>` is the shape this exists for: `readdirSync(<cwd>/.pi/agents)` and
 * `lstatSync(<cwd>/.pi/agents)` both report ENOENT because the whole prefix is broken, so
 * {@link existsButIsNotADirectory} — which only looks at the final component — reports "absent".
 * The walk finds the DEEPEST ancestor that `statSync` still resolves to a DIRECTORY, then
 * `lstat`s every component below it: an entry that exists (`lstat` ok) while the full path does
 * not resolve is a configured path broken by a symlink, so it is observable.
 *
 * Only SYMLINKS count. A component that resolves to a plain FILE makes `dir` impossible rather
 * than broken — that is the absent-dir case and it must stay silent (both reviewers measured it),
 * so a resolved file is skipped rather than used as the base, and a file parent reads as silent
 * while a symlink parent (dangling, or pointing at a file) warns.
 *
 * Bounded on both ends: it never climbs above `boundary`, and it gives up silently when nothing
 * at or below `boundary` resolves (a prefix that simply does not exist — the normal case, and
 * the one a `cwd` that was never created produces).
 */
function hasUnresolvableSymlinkAncestor(dir: string, boundary: string): boolean {
  const target = path.resolve(dir);
  const stop = path.resolve(boundary);
  const parentOf = (p: string): string => path.dirname(p);
  // Phase 1: climb from `target` to `stop`, looking for the deepest resolvable ancestor.
  let resolvable = target;
  let found = false;
  for (let step = 0; step <= MAX_ANCESTOR_WALK; step += 1) {
    try {
      // A resolved FILE is not a usable base either: it makes everything below it impossible
      // rather than broken. Skipping it (instead of stopping there) is what keeps the plain-file
      // parent silent while a symlink that resolves to a file still warns below.
      if (fs.statSync(resolvable).isDirectory()) {
        found = true;
        break;
      }
    } catch {
      // keep climbing
    }
    if (resolvable === stop) break;
    const next = parentOf(resolvable);
    if (next === resolvable) break;
    resolvable = next;
  }
  if (found) {
    // Phase 2: everything strictly below the deepest resolvable ancestor is the suspect span.
    for (
      let probe = target;
      probe !== resolvable && probe !== parentOf(probe);
      probe = parentOf(probe)
    ) {
      if (isSymlinkEntry(probe)) return true;
    }
    return false;
  }
  // Nothing at or below `boundary` resolves. That is a genuinely absent prefix UNLESS the
  // boundary itself is a broken symlink, which is a configured path that cannot be listed.
  return resolvable === stop && isSymlinkEntry(stop);
}

/** True when `p` is an existing filesystem entry that is itself a symlink (dangling included). */
function isSymlinkEntry(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * True when a failed `readdirSync(dir)` means "there is no agents dir here" rather than "the
 * agents dir is there and something is wrong with it".
 *
 * ENOENT and ENOTDIR cannot be separated by the code alone, so the enumeration below is
 * EXHAUSTIVE over the shapes the fs boundary produces. `boundary` is the lookup axis root
 * (`cwd` for the project dir, the home dir for the user dir) and bounds the ancestor walk.
 *
 * **Silent** (absent — the normal case; a refusal must not be cluttered by it):
 *   - the agents dir, and every component above it, simply does not exist (ENOENT, incl. a
 *     `cwd` that was never created);
 *   - a component ABOVE the agents dir is a plain FILE (ENOTDIR) — the agents dir cannot exist
 *     at all, which is the same absence wearing a different code;
 *   - a component above is a symlink that RESOLVES to a directory and the agents dir is
 *     missing beneath it — a real configuration with nothing registered in it.
 *
 * **Observable** (`console.warn` with the path and the OS code, then continue — constraint #3):
 *   - a file at the agents path (ENOTDIR) — it exists, it is just not a directory;
 *   - a symlink at the agents path pointing at a file (ENOTDIR) or at nothing at all (ENOENT
 *     on readdir, `lstat` ok) — both are present-but-unusable;
 *   - a broken symlink in a PARENT component (ENOENT or ENOTDIR all the way down) — the path
 *     was configured and cannot resolve;
 *   - any other code (EACCES, ELOOP, EIO, …) — a real failure, never an absence.
 */
function isSilentReaddirMiss(dir: string, boundary: string, error: unknown): boolean {
  const code = errnoCode(error);
  if (code !== "ENOENT" && code !== "ENOTDIR") return false;
  if (existsButIsNotADirectory(dir)) return false;
  return !hasUnresolvableSymlinkAncestor(dir, boundary);
}

/**
 * One registered agent, carrying the two things the bare name cannot: what the definition
 * says the agent is FOR, and which lookup directory it came from.
 *
 * The description is the field that decides whether a model ever dispatches an agent, and
 * until {@link describeRegisteredAgentRoster} existed nothing in production read it. The
 * parser fills it, `discoverAgent` copies only `name`/`model`/`tools`/`childReport`/
 * `systemPrompt`, and the lister returned bare names — so a definition could describe
 * itself perfectly and still be invisible to the one party that could act on it. The model
 * only learned an agent existed after guessing its name, failing, and reading the refusal.
 */
export interface RegisteredAgentEntry {
  name: string;
  /** The frontmatter `description`, trimmed; `""` when the definition declares none. */
  description: string;
  /**
   * Which lookup directory it was found in. `discoverAgent` tries user before project, so
   * a name present in both resolves to the user copy — the listing must say the same thing,
   * or the roster would advertise a scope that does not resolve it.
   */
  source: "user" | "project";
}

/**
 * The agents registered under the effective scope, for the roster a model reads before it
 * decides whether to dispatch. A thin projection of {@link scanAgentDefinitions}, which owns
 * every rule this used to spell out -- identity, scope precedence, the within-scope tie-break,
 * and the three diagnostic buckets. It exists to emit that scan's diagnostics and to drop the
 * fields the roster does not render, so nothing here can drift from what a dispatch resolves.
 */
export function listRegisteredAgentEntries(
  input: RegisteredAgentsListInput,
): RegisteredAgentEntry[] {
  const { definitions, diagnostics } = scanAgentDefinitions(input);
  for (const message of diagnostics) console.warn(message);
  return [...definitions.values()].map((definition) => ({
    name: definition.name,
    description: definition.description,
    source: definition.source,
  }));
}

/**
 * The agent NAMES registered under the effective scope. Derived from
 * {@link listRegisteredAgentEntries} rather than walking the directories a second time: two
 * traversals would be two places for the user/project precedence to be spelled slightly
 * differently, and the refusal that lists names would then disagree with the roster.
 */
export function listRegisteredAgents(input: RegisteredAgentsListInput): string[] {
  return listRegisteredAgentEntries(input)
    .map((entry) => entry.name)
    .sort();
}

/**
 * The roster a model reads BEFORE it decides whether to dispatch: every registered agent,
 * what its definition says it is for, and which scope reaches it.
 *
 * This is the outlet `description` never had. `listRegisteredAgents` answers "which names
 * exist", which is only useful to someone who already suspects a name — it reaches the
 * model through a refusal, i.e. after a wrong guess. A model cannot pick an agent it has
 * never heard of, so the pre-decision channel has to carry the descriptions too.
 *
 * The scope label is not decoration. `agentScope` defaults to `"user"`, so a project agent
 * silently fails to resolve unless the caller passes the matching scope; a roster that
 * listed names without it would be a table of things to call that mostly do not work.
 *
 * Rendered from {@link listRegisteredAgentEntries} — the same traversal the refusal uses —
 * so the roster and the refusal cannot disagree about what is registered.
 */
export function describeRegisteredAgentRoster(input: RegisteredAgentsListInput): string {
  const entries = listRegisteredAgentEntries(input);
  // Leads with the omission, because that is the answer to "do I need one of these?" -- the
  // question a model asks when it is deciding whether to dispatch at all (issue #185).
  const lead =
    "`agent` is optional: omit it for a fresh generalist pi with pi's own system prompt and its " +
    "full toolset. Name a definition to NARROW the child instead.";
  if (entries.length === 0) {
    return lead + " None are registered here, so there is nothing to name.";
  }
  const lines = entries.map((entry) => {
    const purpose = entry.description.length > 0 ? entry.description : "(no description given)";
    return `- ${entry.name} (${entry.source} scope): ${purpose}`;
  });
  return (
    lead +
    "\nRegistered definitions — pass `agentScope` matching the scope shown, since it defaults " +
    'to "user" and does not see the others:\n' +
    lines.join("\n")
  );
}

/**
 * The actionable suffix every agent-related dispatch refusal appends (field report
 * pitfall #2, 2026-09-29): the bare `unknown agent: undefined` message named nothing the
 * model could act on. Lists what IS registered under the effective scope, both lookup
 * paths, and the minimal agent-file shape (frontmatter `name:` + system prompt body).
 *
 * The file-shape guidance lives HERE and not in the tool description, which is what that
 * description's own comment claims: both point at the refusal rather than restating it, so a
 * copy cannot go stale — and `tests/unit/subagent-description.test.ts` fails if one appears in
 * the description. #205 changed what the guidance has to say (the file name is not an identity;
 * the `name:` header is), so it landed here, on the same one-home side of that rule.
 */
export function describeRegisteredAgents(input: RegisteredAgentsListInput): string {
  const { userDir, projectDir } = resolveAgentDirs(input);
  const registered = listRegisteredAgents(input);
  const names = registered.length > 0 ? "[" + registered.join(", ") + "]" : "(none)";
  return (
    `registered agents: ${names} — ` +
    `agents load from ${userDir} (user scope) or ${projectDir} ` +
    `(project scope); register one as an agent markdown file: frontmatter header ` +
    "(`---\\nname: <agent-name>\\n---`) followed by the system prompt body. " +
    "the `name:` header IS the agent's name: naming the file after it is the convention, " +
    "but the two are independent, so a definition is dispatchable under the name it declares " +
    "even when the file is named otherwise"
  );
}

/**
 * The refusal for a dispatch whose `agent` was GIVEN but is unusable — not a string, or empty.
 *
 * Absent is deliberately not this case: an absent name dispatches a generalist child (issue
 * #185). So the message has to name both ways out, because "the name you gave me is unusable"
 * and "you did not have to give me one" are different problems and the caller can only tell
 * which one it has if the refusal says so.
 */
export function missingAgentResult(input: RegisteredAgentsListInput): DispatchResult {
  return {
    text: "",
    status: "rejected",
    started: false,
    agentName: "",
    durationMs: 0,
    exitCode: 1,
    reportChannel: "none",
    errorMessage:
      "agent, when given, must be a non-empty string — omit it entirely to dispatch a " +
      "generalist child; " +
      describeRegisteredAgents(input),
  };
}

/**
 * True when an `agent` value is present but unusable — not a string, or a string that is empty
 * or all whitespace.
 *
 * Distinct from {@link isAbsentAgentName} on purpose, and the distinction is the whole point of
 * issue #185: **absent** selects the generalist child, while **present but unusable** is a
 * malformed call and is refused. Collapsing them would make a caller's typo silently dispatch
 * something it did not ask for — and the wire can deliver anything, which is what the guard was
 * written for in the first place (field report pitfall #2, 2026-09-29).
 */
export function isMalformedAgentName(agent: unknown): boolean {
  return agent !== undefined && (typeof agent !== "string" || agent.trim().length === 0);
}

/**
 * True when the caller named no agent at all, which dispatches a generalist child.
 *
 * `undefined` is the only shape that means "not named" at THIS layer, and that is a statement about
 * the value the predicate is handed rather than about what a client sent. Measured 2026-10-12,
 * because the distinction is easy to get backwards:
 *
 * pi's validator runs `normalizeOptionalNulls` over the arguments of every tool call
 * (`validateToolArguments`, `@earendil-works/pi-ai`), and it runs on BOTH fronts — the tool front
 * through pi's own tool dispatch, the binding front through our call inside `bindings.ts`. So
 * `{ task, agent: null }` is delivered to our code as `{ task }`. A null on an optional field is
 * the platform's encoding of "not provided", and by the time either front sees it there is no null
 * left to refuse. Reading this predicate alone would suggest a stray null is malformed; it is
 * in-process, and it cannot arrive from a wire.
 *
 * A non-null non-string does reach us and IS refused (see {@link isMalformedAgentName}); the
 * validator coerces a number to its string form, which then fails to resolve as an agent name.
 */
export function isAbsentAgentName(agent: unknown): agent is undefined {
  return agent === undefined;
}

/**
 * What a dispatch resolved to. A union rather than `AgentConfigLike | null`, because the null
 * would erase the one fact every caller then needs: "nothing resolved" can only happen when a
 * name WAS given, and the refusal has to print that name. Carrying it in the type is what keeps
 * the refusal from having to re-derive it (or worse, reach back to `input.agent` and reintroduce
 * the `undefined` the union just eliminated).
 */
type DispatchAgentResolution =
  | { readonly kind: "resolved"; readonly agent: AgentConfigLike }
  | { readonly kind: "unknown"; readonly name: string };

/**
 * Resolve the definition a dispatch runs as: the named one when a name was given, the
 * generalist when none was.
 *
 * One helper rather than a ternary inlined at each front, because the two fronts disagreeing
 * about what an omission means is precisely the failure this would otherwise invite -- and they
 * already share `missingAgentResult` for the same reason.
 */
function resolveDispatchAgent(
  input: DispatchInput,
  cwd: string,
  agentScope: "user" | "project" | "both",
): DispatchAgentResolution {
  if (isAbsentAgentName(input.agent)) return { kind: "resolved", agent: GENERALIST_AGENT };
  const found = discoverAgent(input.agent, cwd, agentScope);
  if (!found) return { kind: "unknown", name: input.agent };
  return { kind: "resolved", agent: found };
}

/**
 * The refusal for a dispatch whose `agent` names nothing registered under the effective
 * scope. Shared verbatim by the foreground and background paths so the model and the
 * sub-call tree keep one vocabulary (ADR-0021 §6); each call site keeps its own slot /
 * timing semantics — this builds only the refusal message. `durationMs` lets the
 * foreground path report elapsed time while the pre-spawn background refusal stays 0.
 */
export function unknownAgentResult(
  agent: string,
  agentScope: "user" | "project" | "both",
  cwd: string,
  durationMs = 0,
): DispatchResult {
  return {
    text: "",
    status: "rejected",
    started: false,
    agentName: agent,
    durationMs,
    exitCode: 1,
    reportChannel: "none",
    errorMessage:
      "unknown agent: " +
      agent +
      " (agentScope=" +
      agentScope +
      ", cwd=" +
      cwd +
      "). " +
      describeRegisteredAgents({ cwd, agentScope }),
  };
}

/**
 * The child's tool list: whatever its agent markdown declared, plus the report tool when the
 * contract is on (ADR-0032 "Activation is load-bearing", ticket #101).
 *
 * Returns `undefined` when there is nothing to say, which is the case `buildArgv` turns into "no
 * `--tools` flag at all" — pi's own defaults, unchanged.
 *
 * The report tool is MERGED rather than appended, so an agent that restricted its child keeps
 * exactly the restriction it asked for plus the one tool the contract needs. That direction
 * matters: pi reads `--tools` as an ALLOWLIST (`sdk.js` → `allowedToolNames`, filtered by
 * `AgentSession._isAllowedTool`), so naming the report tool alongside an agent's own list
 * activates it, while leaving it out would filter it away again — the silent failure this merge
 * exists to prevent.
 *
 * An opted-out agent gets its declared list and nothing else: never asked means never activated,
 * and a tool the model may call but was never asked for is exactly the "registered, documented,
 * never called" state this whole mechanism is built to avoid.
 *
 * An agent that declares NO tools gets no flag at all, and is activated by the other half of the
 * pair: the report tool registers with `defaultActive` set from `PI_PTC_DEPTH`, so it is live in
 * every dispatched child. Neither half covers the other's case, which is why both exist — see
 * `src/tools/child-report-tool.ts`.
 *
 * ADR-0041 §Call-site precedence is total: a **strict** tier set at the call site decides the list
 * outright and the agent's declared `tools:` is never consulted. That direction is the whole point
 * of the parameter — the caller asked for a mode, not for a role — and it is why there is no merge
 * to reconcile here. The outcome is stated on the result (`readOnlyTier`), so the override is
 * visible rather than silent; it cannot differ from the request, which is the point of it being
 * reported and not of it being negotiable.
 *
 * The claim is about STRICT alone, and the distinction is not pedantic. A `lenient` tier reaches
 * the branch below and is handled exactly as "no tier" was — definition's `tools:` and all — because
 * lenient's promise is that the tool list is byte-identical to an untiered dispatch, and honouring
 * the definition is part of what untiered means. So there is no precedence question to settle for
 * lenient: the tier does not touch the list, and reading it as "wins over the definition" would
 * predict a narrowing that does not happen.
 */
export function childToolList(
  agent: Pick<AgentConfigLike, "tools" | "childReport">,
  readOnly?: DispatchInput["readOnly"],
  searchEnabled?: boolean,
): readonly string[] | undefined {
  const tier = resolveReadOnlyTier(readOnly);
  if (tier === "strict") {
    // Derived rather than a constant, for the same reason the merge below is derived: an
    // agent that opted out of the report contract must not be handed the report tool, or it
    // ends up with a tool the flag activated and nothing ever asked it to call.
    //
    // ADR-0049: the search tool joins the strict set when the search module is on. It is a
    // READ tool -- it fetches pages and writes nothing -- so including it keeps the tier's
    // promise ("it cannot write anything") intact, and excluding it does not narrow the
    // child's reach in any way the tier is about. Measured 2026-10-20: a parent that asked
    // for a read-only child LOST the child's search tool entirely (pi reads `--tools` as an
    // allowlist), so the child reported having no web tool and gave up. The capability was
    // not bypassed; it was absent, and silently so.
    const readOnlyTools =
      searchEnabled === true
        ? [...READ_ONLY_TOOL_NAMES, WEB_DS_SEARCH_TOOL_NAME]
        : READ_ONLY_TOOL_NAMES;
    return isReportContractOn(agent) ? [...readOnlyTools, CHILD_REPORT_TOOL_NAME] : readOnlyTools;
  }
  // `lenient` falls through untouched. It narrows nothing, and a tier that quietly removed a
  // tool would be a half-strict wearing the name of a promise it cannot keep.
  const declared = agent.tools ?? [];
  if (!isReportContractOn(agent)) return declared.length > 0 ? declared : undefined;
  if (declared.length === 0) return undefined;
  return declared.includes(CHILD_REPORT_TOOL_NAME)
    ? declared
    : [...declared, CHILD_REPORT_TOOL_NAME];
}

/**
 * Build the argv handed to the child pi subprocess. Model / thinking / tools / agentScope
 * precedence: dispatch input (call site) > agent markdown frontmatter > nothing.
 *
 * Model precedence has one more tier (ADR-0044): `input.model > agent.model > sessionModel >
 * pi's configured default`. The session tier is the caller's CURRENT session model, which the
 * host reads structurally off pi's tool-execution context -- so a dispatch that names nothing
 * explicitly runs the model the caller is running instead of silently falling through to a
 * global default the user may not have chosen. `sessionModel` is the optional fourth
 * parameter, so existing direct callers (and the tests that pin argv without a context) keep
 * the three-tier shape and the argv they had before.
 *
 * The agent's system prompt (with the depth hint appended) is materialised to a tmpfile
 * and passed via --append-system-prompt, exactly as the subagent extension does.
 */
export function buildArgv(
  input: DispatchInput,
  agent: AgentConfigLike,
  promptFilePath: string,
  sessionModel?: SessionModel,
  searchEnabled?: boolean,
): string[] {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  // `||`, not `??`: a discovered agent whose markdown declares no `model:` reports that as the
  // EMPTY STRING (`parseAgentMarkdown`), so a nullish-only chain would let "the agent names no
  // model" shadow the session tier and silently drop the inheritance. The contract's middle tier
  // is a model the agent NAMED; an empty value names nothing. The same reading covers an empty
  // `input.model`: a caller that passes no model is not asking for the string "".
  const model =
    input.model || agent.model || (sessionModel ? formatSessionModel(sessionModel) : undefined);
  if (model) args.push("--model", model);
  /*
   * Default to --thinking off: a dispatched child is a tool call, not a long-form reasoning
   * task. Thinking blocks the model from emitting text for many seconds; the parent turn keeps
   * its own thinking settings, the child inherits only what the parent's DispatchInput.
   * thinkingLevel says (and defaults to "off" otherwise).
   */
  const thinking = input.thinkingLevel ?? "off";

  args.push("--thinking", thinking);
  // Note: agentScope is honoured at our layer via discoverAgent(); pi itself does not
  // accept an --agent-scope flag (the subagent extension does not pass one either), and
  // in --no-session mode pi loads user-scope agents from ~/.pi/agent/agents by default.
  // Project agents would need a different mechanism (e.g. PI_CODING_AGENT_DIR override).
  const tools = childToolList(agent, input.readOnly, searchEnabled);
  if (tools !== undefined) {
    args.push("--tools", tools.join(","));
  }
  args.push("--append-system-prompt", promptFilePath);
  args.push("Task: " + input.task);
  return args;
}

/**
 * Write the system prompt (with depth hint appended) to a tmpfile. The caller is
 * responsible for cleanup; we use mkdtemp + 0o600 to keep the prompt private, then
 * best-effort cleanup in the dispatch() Promise.
 *
 * Overridable so the region between the foreground slot acquire and the Promise that owns the
 * release can be driven to throw on demand. Round 4 fixed a leak in that region and the ledger
 * row was marked closed with no test holding it, because the only ways to make this function
 * throw were a TMPDIR pointed at a file -- which breaks EVERY temp-dir-using test in
 * tests/unit/ at once, so it cannot isolate this path -- and nothing injectable. A seam that can
 * be aimed at one call is what makes the slot coming back a testable claim rather than a
 * measured one.
 */
let promptFileWriter: (
  agentName: string,
  prompt: string,
) => Promise<{ dir: string; filePath: string }> = writePromptToTempFile;

/**
 * Point the prompt writer somewhere else, or pass `undefined` to restore the real one.
 *
 * BOTH branches go through this seam. That was not true when it was added: only the foreground
 * did, which is why the round-6 finding -- the background catch's KEYED slot release is unpinned --
 * could not be closed by a test. The background release is worse to lose than the foreground one:
 * it is keyed by task id and the two releasers (the pump's terminal transition and `shutdown`) only
 * ever fire for a task that got that far. On the spawn/registration/IO failure path there is no
 * such task, so a dropped release is permanent for the life of the session.
 */
export function setPromptFileWriter(
  override:
    | ((agentName: string, prompt: string) => Promise<{ dir: string; filePath: string }>)
    | undefined,
): void {
  promptFileWriter = override ?? writePromptToTempFile;
}

async function writePromptToTempFile(
  agentName: string,
  prompt: string,
): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-dispatch-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, "prompt-" + safeName + ".md");
  await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

/**
 * Best-effort cleanup of the tmpfile + dir used for the system prompt. Errors are
 * deliberately swallowed: leaving a tmpfile around is preferable to crashing the run.
 */
function cleanupTmp(tmp: { dir: string; filePath: string }): void {
  try {
    fs.unlinkSync(tmp.filePath);
  } catch {
    /* ignore */
  }
  try {
    fs.rmdirSync(tmp.dir);
  } catch {
    /* ignore */
  }
}

/**
 * Extract the assistant text from one child event, mirroring the foreground final-text rule
 * (`message_end` assistant text parts; the last part wins). The detached background pump
 * drains the child's stdout through this so a chatty child cannot back-pressure the spawn
 * turn, keeps the last text, and persists it through OutputStorage on the terminal
 * transition (ADR-0022 §3/§7).
 */
function assistantText(event: ParsedAgentEvent): string | undefined {
  if (event.type !== "message_end" || event.message?.role !== "assistant") return undefined;
  const content = event.message.content;
  if (!Array.isArray(content)) return undefined;
  let text: string | undefined;
  for (const part of content) {
    if (part && part.type === "text" && typeof part.text === "string") {
      text = part.text;
    }
  }
  return text;
}

/**
 * Fold one assistant `message_end` into the host's token counter (ADR-0032: `usage` is observed,
 * never declared). Returns `current` unchanged for every other event, so both fronts call this
 * once per event in their drain loops and cannot drift on what counts as usage.
 *
 * One function rather than the two copies the foreground and background loops would otherwise
 * each carry: the persisted background report's `usage` and the foreground `DispatchResult`'s are
 * supposed to be the same measurement, and "the same code" is a stronger guarantee than a
 * comment saying so.
 */
function accumulateUsage(
  current: DispatchUsage | undefined,
  event: ParsedAgentEvent,
): DispatchUsage | undefined {
  if (event.type !== "message_end") return current;
  const message = event.message;
  if (message?.role !== "assistant" || message.usage === undefined) return current;
  const total: DispatchUsage = current ?? {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
  };
  total.input += message.usage.input ?? 0;
  total.output += message.usage.output ?? 0;
  total.cacheRead += message.usage.cacheRead ?? 0;
  total.cacheWrite += message.usage.cacheWrite ?? 0;
  total.cost += message.usage.cost?.total ?? 0;
  total.turns += 1;
  return total;
}

/**
 * The provider/model a child was observed running, accumulated from its assistant turns.
 *
 * Both fields are optional because the wire is observational: a transcript may carry a model
 * without a provider, and an older pi may carry neither.
 */
export interface ObservedChildModel {
  provider?: string;
  model?: string;
}

/**
 * Fold one assistant `message_end` into the observed-model record (last turn wins).
 *
 * Same shape of rule as {@link accumulateUsage} and the same reason for existing as one
 * function: the foreground result's `provider`/`model` and the background record's must be
 * the same observation of the same transcript, and a shared fold is stronger evidence of that
 * than two loops that agree today. Non-assistant events and empty/absent fields are no-ops --
 * a retry sequence ends on the turn that actually served the answer, which is the turn a
 * caller wants named.
 *
 * Updating per FIELD rather than replacing the pair matters for a transcript that reports the
 * provider on one turn and the model on another: the last value seen for each is kept.
 */
export function accumulateChildModel(
  current: ObservedChildModel | undefined,
  event: ParsedAgentEvent,
): ObservedChildModel | undefined {
  if (event.type !== "message_end" || event.message?.role !== "assistant") return current;
  const provider = isNonEmptyString(event.message.provider) ? event.message.provider : undefined;
  const model = isNonEmptyString(event.message.model) ? event.message.model : undefined;
  if (provider === undefined && model === undefined) return current;
  const next: ObservedChildModel = { ...current };
  if (provider !== undefined) next.provider = provider;
  if (model !== undefined) next.model = model;
  return next;
}

/** A string that is actually there; the observation channels carry absent as `undefined`. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * The failure pi reported about the child's own turn, if any (issue #70).
 *
 * A child that hits a rate limit or a model error still exits 0: pi writes the reason onto the
 * assistant `message_end` as `stopReason: "error"` + `errorMessage` with an empty `content`,
 * retries a few times, and exits clean. The exit code therefore carries no signal at all, and
 * `assistantText` (correctly) returns nothing — so without this the background pump had no way
 * to tell a silent failure from a silent success. Real captured shape, pi 0.87.1:
 *
 * ```json
 * {"type":"message_end","message":{"role":"assistant","stopReason":"error",
 *  "errorMessage":"429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",...}}",
 *  "content":[]}}
 * ```
 *
 * Only `stopReason === "error"` counts. A normal turn ends with `stopReason: "stop"`, and
 * treating every stopReason as a failure would mark healthy children failed.
 */
/**
 * One fenced block found in a child's final text, with the fence's info string and its body.
 */
interface FencedBlock {
  info: string;
  body: string;
}

/**
 * Split one message into its fenced blocks, in source order.
 *
 * A fence opened and never closed yields a block whose body runs to the end of the text. That is
 * deliberate: a child cut off mid-report is exactly the malformed case the contract has to name,
 * and closing the block for it would hand the parser a body that happens to be valid JSON.
 */
function fencedBlocks(text: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  let open: { marker: string; info: string; body: string[] } | undefined;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (open === undefined) {
      const opener = /^(`{3,}|~{3,})(.*)$/.exec(trimmed);
      if (opener) {
        open = { marker: (opener[1] ?? "")[0] as string, info: (opener[2] ?? "").trim(), body: [] };
      }
      continue;
    }
    if (new RegExp("^" + open.marker + "{3,}\\s*$").test(trimmed)) {
      blocks.push({ info: open.info, body: open.body.join("\n") });
      open = undefined;
    } else {
      open.body.push(line);
    }
  }
  if (open !== undefined) blocks.push({ info: open.info, body: open.body.join("\n") });
  return blocks;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate one decoded child-report payload (ADR-0032).
 *
 * Lenient about keys the child invented, strict about the ones the contract names: a payload
 * missing or mistyping any required field is NOT a report. Returns `undefined` for those, which
 * the callers turn into `reportChannel: "none"` — the degradation stays visible instead of
 * arriving half-parsed.
 *
 * Exported because the report tool's `structuredContent` (#101) validates through the same
 * function; two validators for one shape is the two-copies problem ADR-0032 rejects.
 */
export function validateChildReport(value: unknown): ChildReportPayload | undefined {
  if (!isPlainObject(value)) return undefined;
  const { summary, findings, files_touched } = value as Record<string, unknown>;
  if (typeof summary !== "string") return undefined;

  if (!Array.isArray(findings)) return undefined;
  const validatedFindings: ChildReportFinding[] = [];
  for (const finding of findings) {
    if (!isPlainObject(finding)) return undefined;
    if (typeof finding.what !== "string" || typeof finding.evidence !== "string") {
      return undefined;
    }
    validatedFindings.push({ what: finding.what, evidence: finding.evidence });
  }

  if (!Array.isArray(files_touched)) return undefined;
  const validatedFiles: string[] = [];
  for (const file of files_touched) {
    if (typeof file !== "string") return undefined;
    validatedFiles.push(file);
  }

  // `usage` is deliberately NOT read here. See ChildReportPayload: it is host-observed, and a
  // child-supplied one is discarded rather than trusted.
  return {
    summary,
    findings: validatedFindings,
    files_touched: validatedFiles,
  };
}

/**
 * The prompt channel (ADR-0032 channel 2, the fallback): read a child report out of one child's
 * final text. Prose is NOT consumed and NOT a candidate — only a fenced block is, and only the
 * LAST one, because the contract says the child ends its reply with the block.
 *
 * Everything that is not a report comes back as `reportChannel: "none"` with no `report`: no
 * fence, unparseable JSON, a valid-JSON-but-wrong-shape payload, a truncated fence. The child
 * still resolved with its prose, so this is a downgrade, not a failure.
 */
export function extractChildReportFromText(text: string): ChildReportExtraction {
  const blocks = fencedBlocks(text);
  const last = blocks[blocks.length - 1];
  if (last === undefined) return { reportChannel: "none" };
  let decoded: unknown;
  try {
    decoded = JSON.parse(last.body);
  } catch {
    return { reportChannel: "none" };
  }
  const report = validateChildReport(decoded);
  if (report === undefined) return { reportChannel: "none" };
  return { report, reportChannel: "prompt-json" };
}

/**
 * The tool channel (ADR-0032 channel 1, the preferred one): read a child report off the
 * `tool_execution_end` event the report tool's own call produces, through the SAME
 * {@link validateChildReport} the prompt channel uses.
 *
 * `pi` emits the tool's full `AgentToolResult` verbatim on that event
 * (`pi-agent-core/types.d.ts` `ToolExecutionEndEvent`: `toolCallId` / `toolName` / `result` /
 * `isError`), and `result.structuredContent` is where the declared payload sits. A `toolName` that
 * is not ours is not our event and is left alone — a child calling `bash` does not produce a
 * report, and a report cannot be smuggled in through some other tool.
 *
 * Returns `undefined` for everything that is not a report: no event, another tool, an errored
 * call, a missing or malformed `structuredContent`. The caller keeps whatever the prompt channel
 * found, so a bad tool call degrades to the fallback instead of erasing it.
 */
export function extractChildReportFromToolEvent(
  event: ParsedAgentEvent,
): ChildReportPayload | undefined {
  if (event.type !== "tool_execution_end") return undefined;
  if (event.toolName !== CHILD_REPORT_TOOL_NAME) return undefined;
  if (event.isError === true) return undefined;
  return validateChildReport(event.result?.structuredContent);
}

/**
 * The running state of one child's report scan: the prompt channel's answer and the tool
 * channel's, kept apart until the transcript ends.
 *
 * Two slots rather than one because the two channels are not the same kind of thing. The prompt
 * channel is re-read per assistant text part and the LAST part wins — that is what makes
 * `DispatchResult.text` and the report describe the same message. The tool channel fires once per
 * CALL, and the last call wins for the same reason. Collapsing them into one variable as events
 * arrive is what would make the answer depend on interleaving: a tool call after the final text
 * part would be wiped by nothing, but a text part after the tool call would wipe the tool.
 */
export interface ChildReportScan {
  /** What the prompt channel has found so far. */
  prompt: ChildReportExtraction;
  /** What the tool channel has found so far, if it has fired. */
  tool: ChildReportPayload | undefined;
}

/** A fresh scan: no channel has fired yet. */
export function newChildReportScan(): ChildReportScan {
  return { prompt: { reportChannel: "none" }, tool: undefined };
}

/**
 * Fold ONE `tool_execution_end` into a running scan. Every other event type is a no-op here, so
 * both dispatch loops can call this unconditionally for every event they see and keep the
 * tool channel from becoming a special case in one front and not the other.
 */
export function scanChildReportToolEvent(scan: ChildReportScan, event: ParsedAgentEvent): void {
  const report = extractChildReportFromToolEvent(event);
  if (report !== undefined) scan.tool = report;
}

/**
 * The scan's answer, and the precedence rule in one place (ADR-0032 "when that channel fires it
 * WINS over the prompt channel in the same transcript").
 *
 * The tool channel wins because it is JSON produced against a declared schema rather than text
 * scraped off a fence — but only when it actually fired. A transcript in which it never fired
 * yields the prompt channel's answer unchanged, which is what keeps the fallback a fallback
 * rather than a formality (ADR-0032's bet: the tool is absent whenever this package does not load
 * in the child).
 */
export function finishChildReportScan(scan: ChildReportScan): ChildReportExtraction {
  if (scan.tool !== undefined) return { report: scan.tool, reportChannel: "tool" };
  return scan.prompt;
}

/**
 * The extraction seam, as a pure fold over a child's parsed events.
 *
 * Pure on purpose: it takes the events a transcript fixture yields and returns the extraction, so
 * the whole contract can be exercised with literal JSONL and no spawn. The two dispatch loops
 * stream and cannot buffer a transcript, so they run the same three calls — {@link newChildReportScan},
 * {@link scanChildReportToolEvent} / {@link extractChildReportFromText}, {@link finishChildReportScan}
 * — over their own event stream instead. One rule, three entry points, no second opinion.
 */
export function extractChildReport(events: readonly ParsedAgentEvent[]): ChildReportExtraction {
  const scan = newChildReportScan();
  for (const event of events) {
    scanChildReportToolEvent(scan, event);
    const text = assistantText(event);
    if (text !== undefined) scan.prompt = extractChildReportFromText(text);
  }
  return finishChildReportScan(scan);
}

function childAssistantError(event: ParsedAgentEvent): string | undefined {
  if (event.type !== "message_end" || event.message?.role !== "assistant") return undefined;
  const message = event.message;
  if (message.stopReason !== "error") return undefined;
  const detail = message.errorMessage;
  if (typeof detail === "string" && detail.trim().length > 0) return detail.trim();
  return "child reported stopReason: error";
}

/**
 * Background branch of {@link dispatch} (ADR-0022 §1/§3/§4/§9). It applies the same depth
 * and concurrency gates as the foreground path, spawns the child, registers a `running`
 * TaskRecord, starts a detached pump driving the terminal transition from the child's close
 * event, and returns the spawn-time {@link DispatchHandle} immediately.
 *
 * Pre-spawn refusals reuse the exact foreground shapes (`dispatchDepthLimitReached` /
 * `dispatchConcurrencyLimitReached` / the unknown-agent result) so the model and the
 * sub-call tree keep one vocabulary (ADR-0021 §6).
 */
async function dispatchBackground(
  input: DispatchInput,
  ctx: DispatchContext,
  deps: DispatchDeps,
  readOnlyTier: ReadOnlyTier | undefined,
): Promise<DispatchHandle | DispatchResult> {
  // ADR-0043: resolved once, ABOVE every gate, for the same reason `readOnlyTier` is resolved
  // above every gate on the foreground front. A refusal still consumed the caller's `why` — it was
  // never delivered to any child — so a caller comparing a refusal against a fulfilled dispatch
  // should not have to know which shape it got to learn that.
  const resolvedWhy = resolveWhy(input.why, deps.whyEnabled !== false);
  const finish = (result: DispatchResult): DispatchResult =>
    withWhySuppressed(withReadOnlyTier(result, readOnlyTier), resolvedWhy.suppressed);

  const childDepth = ctx.depth + 1;
  if (childDepth > ctx.maxDispatchDepth) {
    // Background refusal (issue #68 part 4): teach the model to inspect in-flight tasks.
    return finish(backgroundDispatchDepthLimitReached());
  }
  // Pitfall #2, split by issue #185: a name that was GIVEN and is unusable is a caller bug and
  // is reported before any slot is minted or held. A name that was NOT given is not a bug at
  // all — it selects the generalist child, resolved below like any other agent.
  if (isMalformedAgentName(input.agent)) {
    return finish(
      missingAgentResult({
        cwd: input.cwd ?? ctx.cwd,
        agentScope: input.agentScope ?? "user",
      }),
    );
  }
  // ADR-0022 §4/§9: mint the task id BEFORE acquiring its slot so the reservation is keyed by
  // the task that owns it. The pump and `shutdown` both release by this id; the release is
  // idempotent per task, so whichever runs second cannot free another live task's slot.
  const taskId = createULID();
  const slots = deps.slots ?? FALLBACK_DISPATCH_SLOTS;
  if (!slots.tryAcquire(taskId)) {
    return finish(backgroundDispatchConcurrencyLimitReached());
  }

  const clock = deps.clock ?? ((): number => Date.now());
  const logger = deps.logger ?? DEFAULT_DISPATCH_LOGGER;
  const cwd = input.cwd ?? ctx.cwd;
  const agentScope = input.agentScope ?? "user";
  const lifecycle = deps.lifecycle ?? DISPATCH_LIFECYCLE;
  const callerId = ctx.callerId ?? "dispatch:" + String(ctx.callId);
  const registry = resolveTaskRegistry(deps, clock);
  const outputStorage = deps.outputStorage;

  // Resolved OUTSIDE the try, immediately after the slot is taken: the catch below reports the
  // resolved name, so the resolution has to outlive the block it used to sit in. The ordering
  // against the other gates is unchanged -- depth, malformed name, acquire, then this -- so a
  // caller who is at the concurrency cap still hears about the cap.
  const resolution = resolveDispatchAgent(input, cwd, agentScope);
  if (resolution.kind === "unknown") {
    slots.release(taskId);
    return finish(unknownAgentResult(resolution.name, agentScope, cwd));
  }
  const agent = resolution.agent;

  let childHandle: ChildHandle | undefined;
  let tmp: { dir: string; filePath: string } | undefined;
  try {
    // The registry adopts the already-minted id as the TaskRecord id, so the handle the
    // program carries, the persisted record and the slot token all agree at creation.
    const label = input.label ?? input.task.slice(0, 64);
    const reportContract = isReportContractOn(agent);
    const fullPrompt = appendDepthHint(agent.systemPrompt, childDepth, ctx.maxDispatchDepth, {
      reportContract,
      readOnly: input.readOnly,
      why: resolvedWhy.why,
    });
    const written = await promptFileWriter(agent.name, fullPrompt);
    tmp = written;
    // ADR-0044: the session tier is resolved here, at spawn, so a model switch later in the
    // caller's session cannot retro-change a child that is already running.
    const argv = buildArgv(input, agent, written.filePath, ctx.sessionModel, deps.searchEnabled);

    const spawnOptions: ChildSpawnOptions = {
      cwd,
      // ADR-0016 Recursive section: the child run's depth baseline travels in the
      // environment so the pi-ptc extension loaded inside the child starts its PTC runs at
      // childDepth instead of at 0.
      // ADR-0016 Recursive section + issue #68 part 2: the child carries its own depth and its
      // own task id, so a nested background dispatch can stamp TaskRecord.parentTaskId.
      env: { ...process.env, PI_PTC_DEPTH: String(childDepth), PI_PTC_TASK_ID: taskId },
      promptFile: written.filePath,
    };
    // R1 session-file flags travel through the lifecycle options. When no sessionDir is
    // available the options keep the foreground shape (none of the three fields set).
    if (ctx.sessionDir !== undefined) {
      spawnOptions.sessionDir = ctx.sessionDir;
      spawnOptions.sessionId = taskId;
      spawnOptions.sessionName = "bgdispatch:" + taskId;
    }

    childHandle = lifecycle.spawn([PI_COMMAND, ...argv], spawnOptions);
    const handle: ChildHandle = childHandle;

    const spawnSource: TaskSpawnSource = { kind: "ptc-program", callerId };
    await registry.transition(
      {
        kind: "spawn",
        handle: { taskId, label, status: "running" },
        record: {
          label,
          agentName: agent.name,
          depth: childDepth,
          startedAt: Math.max(0, Math.floor(clock())),
          finishedAt: undefined,
          durationMs: undefined,
          outputRef: undefined,
          outputBytes: undefined,
          outputPreview: undefined,
          stopReason: undefined,
          errorMessage: undefined,
          exitCode: undefined,
          spawnSource,
          parentTaskId: ctx.parentTaskId,
          // ADR-0041 §"The tier that took effect is reported" on the background front. The
          // background dispatch returns a DispatchHandle and has no DispatchResult to carry it,
          // so the record is where the tier has to live; `ptc_task_output` projects it back out
          // exactly as it projects `reportChannel`. Written AT SPAWN rather than at the terminal
          // transition, because the tier is a fact about the request, not about how it ended —
          // a failed or canceled read-only child was still dispatched read-only. Spread so an
          // untiered dispatch persists no key at all.
          ...(readOnlyTier === undefined ? {} : { readOnlyTier }),
          // ADR-0043 on the background front, for the same reason the tier lives here: a
          // background dispatch returns a DispatchHandle, so this record is the only place a
          // background caller can learn its `why` was dropped. Same spread-as-absent rule, so an
          // unsuppressed dispatch persists no key at all.
          ...(resolvedWhy.suppressed ? { whySuppressed: true as const } : {}),
          // ADR-0022 §3 (v1, R-m12): `sessionFile` is left UNSET. The extension cannot know
          // pi's session-file path, and a fabricated value would be worse than an absent one;
          // a future reader that can learn it may fill the field in.
        },
      },
      { clock, callerId, logger },
    );

    // Stop watcher (ADR-0022 §8, issue #68 §1): the tool only writes running -> stopping; the
    // pump owns the signal. Subscribe right after the spawn is persisted and deliver SIGTERM to
    // the live child, escalating to SIGKILL after the shared grace window.
    let childExited = false;
    let cancelStopEscalation: (() => void) | undefined;
    const unsubscribeStopObserver = registry.onTransition((record, event) => {
      if (record.id !== taskId || event.status !== "stopping") return;
      // A stop that arrives after the child closed is a no-op (no signal, no double kill).
      if (childExited || cancelStopEscalation !== undefined) return;
      cancelStopEscalation = killWithEscalation(lifecycle, handle, {
        isDone: () => childExited,
        unref: true,
      });
    });

    // Detached pump (ADR-0022 §2/§3/§8): drain the child's stdout so it cannot back-pressure,
    // persist it through the OutputStorage seam, then resolve the terminal state from the close
    // event. The terminal decision lives in the registry so a stop that lands between the close
    // and the write still wins (R-M1). It is deliberately not awaited, so the spawn turn returns
    // the handle at once.
    void (async (): Promise<void> => {
      let output = "";
      let childError: string | undefined;
      // ADR-0044 Decision 2: the model the child actually ran, observed off its assistant
      // turns -- the background counterpart of the foreground `finalize` stamp below. A
      // dispatch that named no model runs on pi's configured default, and a background caller
      // otherwise has no surface that could ever name it.
      let childModel: ObservedChildModel | undefined;
      // ADR-0032: the same scan the foreground loop runs, so the two fronts cannot disagree
      // about whether a transcript carried a child report — over EITHER channel.
      const scan: ChildReportScan = newChildReportScan();
      // ADR-0032: the host's own token counter, accumulated over the child's assistant
      // `message_end` blocks. A child cannot report its own usage, so this is the only source
      // the persisted report's `usage` can come from — same rule, same accumulation, as the
      // foreground `finalize`.
      let usage: DispatchUsage | undefined;
      try {
        for await (const event of lifecycle.events(handle)) {
          scanChildReportToolEvent(scan, event);
          const text = assistantText(event);
          if (text !== undefined) {
            output = text;
            scan.prompt = extractChildReportFromText(text);
          }
          usage = accumulateUsage(usage, event);
          childModel = accumulateChildModel(childModel, event);
          // The last error wins: a child that retried and then gave up reports the reason that
          // ended it, not the first transient one.
          const error = childAssistantError(event);
          if (error !== undefined) childError = error;
        }
        // The child has closed: no further signal may be delivered, and a pending escalation is
        // cleared before it can fire against a reaped handle (issue #68 §1).
        childExited = true;
        cancelStopEscalation?.();

        const exitValue: ChildExitValue = await lifecycle.exit(handle);
        const exitCode = exitValue.code ?? -1;
        // Captured here, not drained from events(): pi's JSONL carries assistant turns on
        // stdout, and the one diagnostic that reaches a model-facing errorMessage from
        // stderr is pi 1.2.0's print-mode truncation warning (see PI_TRUNCATION_WARNING).
        // The foreground close handler reads the same buffer via the same method, so the
        // two fronts cannot disagree about whether a close was a truncation.
        const childStderr = await lifecycle.stderr(handle);
        // The child's own stopReason: "error" still outranks it in the registry — a
        // self-reported model failure is a better diagnosis than our stderr inference.
        //
        // Guarded on a NON-ZERO exit so the two fronts cannot disagree, which is what
        // decideCloseOutcome already encodes: it returns "dispatch produced no final text"
        // for an exit-0 close regardless of stderr, so computing the diagnostic here for
        // an exit-0 close would hand the registry a reason the foreground refused to give.
        // A truncated child on pi <= 1.1.x exits 0 with partial text and is NOT diagnosed
        // as a truncation on either front — that is the shared rule, not a gap in one of them.
        const stderrDiagnostic = exitCode === 0 ? undefined : truncationFailureMessage(childStderr);

        // ADR-0022 §3/§7: project the drained bytes onto the record and persist the raw text
        // so ptc_task_output can dereference outputRef. The preview is inlined only at or
        // below the 2048-byte Map+preview ceiling (OUTPUT_PREVIEW_MAX_BYTES).
        const outputBytes = Buffer.byteLength(output, "utf8");
        const outputPreview = outputBytes <= OUTPUT_PREVIEW_MAX_BYTES ? output : undefined;
        let outputRef: string | undefined;
        if (outputStorage !== undefined) {
          try {
            await outputStorage.writeOutput(taskId, output);
            outputRef = outputStorage.outputRef(taskId);
          } catch (persistError) {
            // Never let a persistence failure swallow the terminal state (testing-constraints
            // #3): surface it and still write the record.
            const persistMessage =
              persistError instanceof Error ? persistError.message : String(persistError);
            logger.warn(
              "background dispatch output persistence for task " +
                taskId +
                " failed: " +
                persistMessage,
            );
          }
        }

        // ADR-0022 §8 signal layering / R-M1: the registry resolves the terminal state under its
        // write lock — a model stop already at `stopping` wins and resolves `canceled`, while
        // a running child resolves from the exit code and whether it produced text. No
        // read-then-write race in the pump. `childError` is the reason the child itself gave
        // (issue #70): an exit-0 child that reported `stopReason: "error"` and no assistant
        // text is a failure, and the record has to say why.
        // Same substitution as the foreground `finalize`: an opted-out agent is not marked for
        // a report it was never asked for. ADR-0032 parity is a claim about the CHANNEL value,
        // and the two fronts have to state it identically.
        const extraction: ChildReportExtraction = reportContract
          ? finishChildReportScan(scan)
          : { reportChannel: "opted-out" };
        const resolved = await registry.transition(
          {
            kind: "resolve-exit",
            taskId,
            exitCode,
            reportChannel: extraction.reportChannel,
            // ADR-0032's counter on its own carrier (issue #199): the host's own count,
            // accumulated off the child's `message_end` blocks exactly as the foreground loop
            // does — a model cannot know its token count, so it is observed, never declared.
            // Passed UNCONDITIONALLY: outside the report spread below and outside any outcome
            // check, so a `none` / `opted-out` / failed / canceled child still accounts for what
            // it cost. The registry applies it on every close outcome it can produce; `undefined`
            // here means the child never emitted a usage block, and leaves the field absent
            // rather than writing a zeroed one.
            usage,
            // ADR-0044 Decision 2: the observed provider/model ride the close command so the
            // registry can put them on the record. Applied on every close outcome, like
            // `usage` -- a failed or canceled child still ran a model, and that is exactly the
            // incident shape this field exists to make visible. Absent means no assistant turn
            // NAMED one (no turn was observed, or the pi does not report the pair).
            observedProvider: childModel?.provider,
            observedModel: childModel?.model,
            // The report's four-field `usage` view is derived from that SAME accumulator
            // instance, so the two carriers cannot disagree about input / output / cost / turns
            // when both are present. The registry applies the pair only when this close resolves
            // `succeeded`, so handing it a report on a failed child is not a way to persist one.
            ...(extraction.report === undefined
              ? {}
              : {
                  report: {
                    ...extraction.report,
                    usage: {
                      input: usage?.input ?? 0,
                      output: usage?.output ?? 0,
                      cost: usage?.cost ?? 0,
                      turns: usage?.turns ?? 0,
                    },
                  },
                }),
            outputRef,
            outputBytes,
            outputPreview,
            childError,
            ...(stderrDiagnostic === undefined ? {} : { stderrDiagnostic }),
          },
          { clock, callerId, logger },
        );
        // A failed close is already visible to the model on the record, but the host operator's
        // only other signal is the child's output log — which is empty for the very failure that
        // matters most (a provider error before the child said anything). One warning names the
        // task and the reason the record carries, so the failure is never silent on this side
        // either (docs/testing-constraints.md #3). Successful and model-stopped closes stay quiet.
        if (resolved.record.status === "failed" && resolved.record.errorMessage !== undefined) {
          logger.warn(
            "background dispatch task " + taskId + " failed: " + resolved.record.errorMessage,
          );
        }
      } catch (err) {
        // A pump failure must not vanish. A task already driven terminal by a model stop
        // lands here on the illegal running -> terminal edge; log it so it is observable.
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(
          "background dispatch pump for task " +
            taskId +
            " failed after " +
            String(output.length) +
            " chars of buffered output: " +
            message,
        );
      } finally {
        unsubscribeStopObserver();
        cancelStopEscalation?.();
        cleanupTmp(written);
        // Release the task's own token; `shutdown` may already have released it (no-op then).
        slots.release(taskId);
      }
    })();

    return { taskId, label, status: "running" };
  } catch (err) {
    // Spawn / registration / IO failure: release the slot, reap a child that did come up,
    // and keep the ADR-0016 "never throws" contract with a rejected DispatchResult.
    const message = err instanceof Error ? err.message : String(err);
    if (childHandle !== undefined) {
      // R-M5: the failure-path reap shares the SIGTERM -> grace -> SIGKILL ladder with the
      // foreground abort and the stop watcher; unref keeps the detached escalation off the
      // host's event loop.
      killWithEscalation(lifecycle, childHandle, { unref: true });
    }
    if (tmp !== undefined) cleanupTmp(tmp);
    slots.release(taskId);
    logger.warn("background dispatch failed for agent " + agent.name + ": " + message);
    return finish({
      text: "",
      status: "rejected",
      started: childHandle !== undefined,
      // The RESOLVED name, not `input.agent`: for a generalist there is no input name to report,
      // and reporting the raw argument would print `undefined` into a field the schema types as a
      // string.
      agentName: agent.name,
      durationMs: 0,
      exitCode: -1,
      reportChannel: "none",
      errorMessage: "background dispatch failed: " + message,
    });
  }
}

/**
 * Spawn one pi subprocess for one dispatch.
 *
 * Behavioural contract (ADR-0016 sections 1, 3, 4) for the foreground path, and ADR-0022
 * for the `{ background: true }` path:
 *   - Foreground (`input.background !== true`) resolves with a {@link DispatchResult}:
 *     `fulfilled` when the child exits 0 with assistant text; `rejected` on non-zero
 *     exit, signal kill, spawn failure, unknown agent, or no usable final text.
 *   - Background (`input.background === true`) resolves with a {@link DispatchHandle}
 *     immediately after the child and its `running` TaskRecord are registered; a detached
 *     pump drives the terminal transition. The pre-spawn refusals (depth gate, concurrency
 *     gate, unknown agent) still resolve with the foreground {@link DispatchResult}
 *     rejection shapes, which is why the overload below returns a union.
 *   - Never rejects. The caller can pattern-match on `status` the same way it would
 *     pattern-match a Promise.allSettled record.
 *   - Honours signal with SIGTERM, then SIGKILL after a 5s grace window (foreground).
 *
 * The overloads narrow by `input.background`: a literal `{ background: true }` yields the
 * handle-or-refusal union; every other call keeps the plain `DispatchResult` of ADR-0016.
 */
export function dispatch(
  input: Omit<DispatchInput, "background"> & { background: true },
  ctx: DispatchContext,
  deps?: DispatchDeps,
): Promise<DispatchHandle | DispatchResult>;
export function dispatch(
  input: DispatchInput,
  ctx: DispatchContext,
  deps?: DispatchDeps,
): Promise<DispatchResult>;
export async function dispatch(
  input: DispatchInput,
  ctx: DispatchContext,
  deps: DispatchDeps = {},
): Promise<DispatchResult | DispatchHandle> {
  // ADR-0043: the `why` decision, resolved ONCE and ABOVE every gate — the `readOnly` guard below
  // included. It used to be resolved below that guard, so the guard's refusal (the FIRST refusal a
  // call can hit) returned before the value was in scope and came back with no `whySuppressed`,
  // while the depth, concurrency and agent refusals beside it all carried one. A program polling
  // that field could not tell "my reason was dropped" from "I passed no reason" on precisely the
  // call it had just been told was malformed. The refusal never reached a child either, so it
  // consumed the reason exactly as every other refusal does.
  const resolvedWhy = resolveWhy(input.why, deps.whyEnabled !== false);
  // The one resolution of the request in this function, so the value reported on every result
  // below cannot disagree with the value the argv and the prompt were built from. Moved up beside
  // `resolvedWhy` for the same reason, and it is safe there: `resolveReadOnlyTier` is total, so a
  // wrong-typed value resolves to no tier and the guard below still refuses it — which is why the
  // guard remains the FIRST refusal a call can hit.
  const readOnlyTier = resolveReadOnlyTier(input.readOnly);
  // `finish` is the one wrapper both facts go through, which is what keeps the two fronts from
  // drifting apart on this — the failure this package has already paid for once, on the report
  // channel.
  const finish = (result: DispatchResult): DispatchResult =>
    withWhySuppressed(withReadOnlyTier(result, readOnlyTier), resolvedWhy.suppressed);

  // ADR-0041 §Constraint compliance, FIRST — above the background branch so both fronts get it,
  // and above every gate so nothing is minted, spawned or reserved for a request that is not
  // one. On both PRODUCTION fronts this is defence in depth: the schema is a string enum, so pi's
  // validator already refused `true`, `0`, `"true"` and the rest before this line runs
  // (see {@link isUsableReadOnlyRequest}). What this guards is the seam the schema does not
  // govern — a caller that reaches `dispatch()` and builds its own arguments — where a
  // wrong-typed value would otherwise be read as no tier at all, i.e. a full-capability child
  // for a caller who asked for a read-only one. Refused, never coerced.
  if (!isUsableReadOnlyRequest(input.readOnly)) {
    // Routed through `finish`, like every other refusal: this one consumed the caller's `why`
    // exactly as a depth or concurrency refusal does, because no child was reached to hear it.
    return finish(invalidReadOnlyRequestResult(input.readOnly));
  }

  // ADR-0050: the session turned PTC off, so no NEW child may start from here on. Above the
  // background branch, so both fronts get it, and above every gate below it, so a refused call
  // mints no task id, reserves no slot and spawns no process.
  //
  // It says nothing about children that are ALREADY running: those are separate processes and
  // the off switch never reaches them. They keep running and stay manageable — which is why the
  // task tools stay in the model's face while one of them is still in flight.
  if (deps.dispatchEnabled === false) {
    return finish(dispatchDisabledResult());
  }

  // ADR-0022 §1: the background opt switches the binding's tail. Pre-spawn refusals reuse
  // the foreground shapes, so the union stays even for a statically-background call.
  if (input.background === true) {
    return await dispatchBackground(input, ctx, deps, readOnlyTier);
  }

  // ADR-0016 Recursive dispatch: bound recursion explicitly.
  const childDepth = ctx.depth + 1;
  if (childDepth > ctx.maxDispatchDepth) {
    return finish(dispatchDepthLimitReached());
  }

  const cwd = input.cwd ?? ctx.cwd;
  const agentScope = input.agentScope ?? "user";
  const start = Date.now();

  // Pitfall #2 (field report 2026-09-29), narrowed by issue #185: the unactionable
  // "unknown agent: undefined" is still what a GIVEN-but-unusable name must never degrade to.
  // A name that was not given is no longer an error at all -- it resolves to the generalist
  // child, which is the default this front shares with the background path.
  if (isMalformedAgentName(input.agent)) {
    return finish(missingAgentResult({ cwd, agentScope }));
  }

  // One owner gates the rule for both fronts (ADR-0025 decision 7, issue #88 decision 9).
  // The only previous acquire lived at the dispatcher's own call site, which the codemode
  // door bypasses by calling `dispatch()` directly -- a foreground `pi_task_codemode` therefore
  // reached the spawn site with every slot held. Measured: it tried to spawn pi, and a saturated
  // counter said nothing. Order matches `dispatchBackground`: depth, then missing agent, then
  // acquire.
  //
  // ADR-0053: the reservation is now KEYED by the task id, the same way the background front
  // keys it. The anonymous form is gone because it was wrong, not merely imprecise: it counted
  // "some foreground dispatch is in flight" and could not say WHICH, so a release could not be
  // attributed to the task that earned it. The id is minted above the acquire for that reason --
  // a keyed reservation needs its key before it is taken.
  //
  // The gate is still ABOVE the record creation (ADR-0053 decision 1): a request refused here
  // never started a child, so it leaves no record behind.
  const taskId = createULID();
  const slots = deps.slots ?? FALLBACK_DISPATCH_SLOTS;
  if (!slots.tryAcquire(taskId)) {
    return finish(dispatchConcurrencyLimitReached());
  }

  const resolution = resolveDispatchAgent(input, cwd, agentScope);
  if (resolution.kind === "unknown") {
    slots.release(taskId);
    return finish(unknownAgentResult(resolution.name, agentScope, cwd, Date.now() - start));
  }
  const agent = resolution.agent;

  // ADR-0053 decision 1: every dispatch creates a task record FIRST, the foreground front
  // included. The registry is the only trace a dispatch leaves, so a foreground child that
  // produced no id and left no record was a child the model could never look up again.
  //
  // The record is created BEFORE the child is spawned, so the record's lifetime covers the
  // whole dispatch -- including a spawn that fails. A failed spawn then reads as a failed
  // task rather than as a dispatch that never happened, which is the honest shape: the caller
  // asked for a child, the host tried, and the attempt is on the record.
  const clock = deps.clock ?? ((): number => Date.now());
  const logger = deps.logger ?? DEFAULT_DISPATCH_LOGGER;
  const registry = resolveTaskRegistry(deps, clock);
  const outputStorage = deps.outputStorage;
  const label = input.label ?? input.task.slice(0, 64);
  const callerId = ctx.callerId ?? "dispatch:" + String(ctx.callId);
  const spawnSource: TaskSpawnSource = { kind: "ptc-program", callerId, awaited: true };
  try {
    await registry.transition(
      {
        kind: "spawn",
        handle: { taskId, label, status: "running" },
        record: {
          label,
          agentName: agent.name,
          depth: childDepth,
          startedAt: Math.max(0, Math.floor(clock())),
          finishedAt: undefined,
          durationMs: undefined,
          outputRef: undefined,
          outputBytes: undefined,
          outputPreview: undefined,
          stopReason: undefined,
          errorMessage: undefined,
          exitCode: undefined,
          spawnSource,
          parentTaskId: ctx.parentTaskId,
          // ADR-0041 / ADR-0043: the tier and the suppression are facts about the REQUEST, so
          // they are written at spawn -- exactly as the background front writes them. Spread so
          // an untiered dispatch persists no key at all.
          ...(readOnlyTier === undefined ? {} : { readOnlyTier }),
          ...(resolvedWhy.suppressed ? { whySuppressed: true as const } : {}),
        },
      },
      { clock, callerId, logger },
    );
  } catch (error) {
    // The record IS the dispatch's trace, so a session that cannot write one cannot honestly
    // run a dispatch: the call is refused rather than run unrecorded. The refusal names the
    // reason (testing-constraints #3 -- no silent failure), and the slot goes back.
    slots.release(taskId);
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("foreground dispatch could not register its task record: " + message);
    return finish({
      text: "",
      status: "rejected",
      started: false,
      agentName: agent.name,
      durationMs: Date.now() - start,
      exitCode: -1,
      reportChannel: "none",
      errorMessage: "dispatch could not register its task record: " + message,
    });
  }

  // ADR-0032 §The opt-out: one read, used by every place that would otherwise ask the child for
  // a report. An opted-out agent is not asked in the prompt, is not given the tool in its argv,
  // and is not marked below for having produced no report.
  const reportContract = isReportContractOn(agent);
  const fullPrompt = appendDepthHint(agent.systemPrompt, childDepth, ctx.maxDispatchDepth, {
    reportContract,
    readOnly: input.readOnly,
    why: resolvedWhy.why,
  });

  // Between the acquire above and the Promise whose `finalize` is the one release, there is an
  // await and a call that can both throw -- a TMPDIR that is a file makes mkdtemp ENOTDIR, and
  // buildArgv throws on a malformed argument. Neither path reaches `finalize`, so without this the
  // slot is never returned. Measured at round 4: one such failure left `slots.active` at 1, where
  // the pre-round-3 accounting returned it. The counter here is the SESSION one, so eight of those
  // and the session can never dispatch again. This is the same class of bug the gate fix was for,
  // so it gets the same treatment: the region between acquire and release owns its own cleanup.
  let tmp: { dir: string; filePath: string };
  // The foreground branch resolved the lifecycle from module scope only, so its spawn could not be
  // injected: a test asserting that a saturated counter launches NOTHING had to observe a real
  // child process through a recording `pi` on PATH, because the mock lifecycle in deps was never
  // consulted. One line makes the seam honest for both fronts, and those tests stop touching PATH.
  const lifecycle = deps.lifecycle ?? DISPATCH_LIFECYCLE;
  let argv: readonly string[];
  try {
    tmp = await promptFileWriter(agent.name, fullPrompt);
    argv = buildArgv(input, agent, tmp.filePath, ctx.sessionModel, deps.searchEnabled);
  } catch (error) {
    slots.release(taskId);
    throw error;
  }

  return await new Promise<DispatchResult>((resolve) => {
    let finalText = "";
    let usage: DispatchUsage | undefined;
    // ADR-0032: the last assistant text part both becomes `text` and is re-read for the child
    // report, so the prose and the report can never describe different messages; the tool channel
    // is folded into the same scan, and wins over the prompt channel when both fired.
    const scan: ChildReportScan = newChildReportScan();
    let exitCode = -1;
    let stderrText = "";
    // issue #70: the child's own failure report. The background pump has always folded this;
    // the foreground front used to drop it, which is how a quota-exhausted child's "429 ..."
    // became the generic "dispatch produced no final text" for a whole incident.
    let childError: string | undefined;
    // ADR-0053: the host's own stderr inference (pi 1.2.0's print-mode truncation warning),
    // computed exactly as the background pump computes it and only on a NON-ZERO close — the
    // same rule `decideCloseOutcome` and the registry's `resolveExitErrorMessage` apply, so
    // the three cannot disagree about what a close meant.
    let stderrDiagnostic: string | undefined;
    // ADR-0044 Decision 2: the model the child actually ran, observed off its assistant turns.
    let childModel: ObservedChildModel | undefined;
    let resolved = false;
    let cancelKillEscalation: (() => void) | undefined;
    let handle: ChildHandle | undefined;
    let aborted = false;

    const finalize = (
      status: "fulfilled" | "rejected",
      errorMessage?: string,
      started = true,
    ): void => {
      if (resolved) return;
      resolved = true;
      // The one terminal point of a foreground dispatch, so the one place that frees the slot AND
      // the one place that retires the child. Guarded by `resolved`, so an abort racing an exit
      // cannot double-release.
      //
      // ADR-0053: the release is KEYED by this task's id, the same token the reservation was
      // taken with. An anonymous release could not say which task it was giving back, so a late
      // release could free a slot a DIFFERENT live task was holding.
      slots.release(taskId);
      // Round 5 finding, and it is the reason the seam below is not test-only. Resolving the
      // session lifecycle here means the foreground child joins `TrackingLifecycle.#live`, and that
      // set is pruned ONLY by `exit()`. Without this call every foreground dispatch leaks a handle
      // for the life of the session -- measured, three dispatches left three live handles -- and
      // `shutdown()` then walks them registering a SIGTERM->SIGKILL ladder whose `isDone` is
      // permanently true, so the cancel fires against handles that closed long ago. That is the
      // hazard the reap-cancel exists to prevent, and it is only cleared from inside `exit()`.
      //
      // Fire and forget, and the reason is the abort path: `onAbort` reaches finalize while
      // `killWithEscalation` is still in flight, so awaiting `exit()` here would hold the abort's
      // promise open for up to the escalation window. It is also harmless for the prune:
      // `TrackingLifecycle.exit` deletes the handle in a `finally`, so a rejecting delegate still
      // frees it.
      //
      // NOT swallowed silently. Constraint 3 is about exactly this shape -- a failure that leaves
      // no trace -- and an injected lifecycle is free to treat `exit()` as the thing that releases
      // an OS resource, in which case a silent reject is a silent leak with no signal at all. The
      // background branch resolves the same logger at dispatch.ts:1678; this is that, on the other
      // front.
      //
      // The cost of fire-and-forget: `await dispatch()` can return before the delete lands, so a
      // caller that reads `liveHandles()` immediately may still see this handle. The test that
      // holds the fix polls for the prune rather than sampling once.
      if (handle !== undefined) {
        void lifecycle.exit(handle).catch((error: unknown) => {
          (deps.logger ?? DEFAULT_DISPATCH_LOGGER).warn(
            "exit() failed for a foreground child; the session live set may retain it: " +
              (error instanceof Error ? error.message : String(error)),
          );
        });
      }
      cancelKillEscalation?.();
      if (ctx.signal) ctx.signal.removeEventListener("abort", onAbort);
      cleanupTmp(tmp);
      // An opted-out agent never had the contract offered, so there is no channel to report over
      // and `none` would read as the non-compliance ADR-0032 defines it as. `opted-out` is the
      // statement that is actually true; see ChildReportChannel.
      const extraction: ChildReportExtraction = reportContract
        ? finishChildReportScan(scan)
        : { reportChannel: "opted-out" };
      // ADR-0041 §"The tier that took effect is reported", through the same helper every
      // refusal below uses — one helper, so "does a result state the tier" is a single question
      // with a single answer rather than two spellings that can drift apart. ADR-0043's
      // `whySuppressed` rides the same wrapper, for the same reason.
      const out: DispatchResult = finish({
        text: finalText,
        status,
        started,
        agentName: agent.name,
        durationMs: Date.now() - start,
        exitCode,
        // Total field (ADR-0032): stated on every outcome, including a rejected one.
        reportChannel: extraction.reportChannel,
        // ADR-0053: the id and label of the record this dispatch created, so the caller can look
        // the child up afterwards (`ptc_task_output` / `ptc_task_stop` both take the id).
        recordId: taskId,
        recordLabel: label,
      });
      // `usage` is stamped HERE, from the host's own counter, rather than taken from the child's
      // JSON — see ChildReportPayload. A child that reported no usage block yields zeros rather
      // than a missing field: the report's shape is total, and "this child cost nothing" and
      // "we did not measure" are not the same claim.
      if (extraction.report) {
        out.report = {
          ...extraction.report,
          usage: {
            input: usage?.input ?? 0,
            output: usage?.output ?? 0,
            cost: usage?.cost ?? 0,
            turns: usage?.turns ?? 0,
          },
        };
      }
      if (usage) out.usage = usage;
      // ADR-0044 Decision 2: stamped only for a value the wire named. ABSENT means no assistant
      // turn NAMED a provider/model -- an older pi may report neither, and a refusal that never
      // spawned has no turns at all -- not "we do not know what the child ran".
      if (childModel?.provider !== undefined) out.observedProvider = childModel.provider;
      if (childModel?.model !== undefined) out.observedModel = childModel.model;
      if (stderrText.length > 0) out.stderr = stderrText;
      if (errorMessage) out.errorMessage = errorMessage;
      // A rejected foreground close that the child itself diagnosed is the one case where no
      // model-facing surface used to name the cause (the caller saw a generic sentence and the
      // host operator saw nothing). Log it here, and only here: the abort, depth, concurrency
      // and spawn refusals must stay as quiet as they were.
      if (status === "rejected" && started && childError !== undefined) {
        (deps.logger ?? DEFAULT_DISPATCH_LOGGER).warn("foreground dispatch failed: " + childError);
      }
      // ADR-0053 decision 2: the child's output is persisted and the record is driven to its
      // terminal state BEFORE the caller sees the result.
      //
      // The order is the whole point. The caller returns from `dispatch()` and then asks "what
      // did that child say?" through `ptc_task_output`; if the output were written after the
      // result resolved, that question could be answered against a half-written file and a
      // record that still said "running". So the write and the terminal transition happen
      // first, and only then does the result resolve.
      //
      // The cost is the one the ticket names: a foreground dispatch now pays one output write
      // and one registry write before it returns.
      void (async (): Promise<void> => {
        try {
          await persistTerminalRecord(extraction);
        } catch (error) {
          // The child's work is DONE — refusing the result now would throw away a real answer
          // over a bookkeeping failure. The record stays non-terminal and the reason is
          // reported (testing-constraints #3: no silent failure).
          logger.warn(
            "foreground dispatch could not close its task record " +
              String(taskId) +
              ": " +
              (error instanceof Error ? error.message : String(error)),
          );
        }
        resolve(out);
      })();
    };

    /**
     * ADR-0053 decision 2: write the child's output where the task tools read it, then close
     * the record with the outcome the foreground front decided.
     *
     * The registry resolves the terminal state under its own write lock from the exit code
     * and whether the child produced text — the same rule the background pump hands it, so
     * the two fronts cannot disagree about what a close means.
     */
    const persistTerminalRecord = async (extraction: ChildReportExtraction): Promise<void> => {
      const outputBytes = Buffer.byteLength(finalText, "utf8");
      const outputPreview = outputBytes <= OUTPUT_PREVIEW_MAX_BYTES ? finalText : undefined;
      let outputRef: string | undefined;
      if (outputStorage !== undefined) {
        try {
          await outputStorage.writeOutput(taskId, finalText);
          outputRef = outputStorage.outputRef(taskId);
        } catch (persistError) {
          // Never let a persistence failure swallow the terminal state (testing-constraints
          // #3): surface it and still write the record.
          logger.warn(
            "foreground dispatch output persistence for task " +
              String(taskId) +
              " failed: " +
              (persistError instanceof Error ? persistError.message : String(persistError)),
          );
        }
      }
      // A cancelled dispatch is a CANCELED task, not a failed one. The registry's
      // `resolve-exit` derives "canceled" from a record that is already `stopping`, so the
      // abort path marks the task stopping first — with the reason the caller sees — and the
      // close then resolves it to canceled. A record that reached a terminal state by
      // accident (a failed spawn, a child's own error) never took that edge.
      if (aborted) {
        await registry.transition(
          { kind: "transition", taskId, to: "stopping", reason: "dispatch cancelled" },
          { clock, callerId, logger },
        );
      }
      await registry.transition(
        {
          kind: "resolve-exit",
          taskId,
          exitCode,
          reportChannel: extraction.reportChannel,
          // ADR-0032's counter on its own carrier (issue #199), the host's own count, exactly as
          // the background pump hands it over: a child that produced no usage block leaves the
          // field absent rather than writing a zeroed one.
          usage,
          // ADR-0044 Decision 2: the observed provider/model ride the close command so the
          // registry can put them on the record, on every close outcome.
          observedProvider: childModel?.provider,
          observedModel: childModel?.model,
          ...(extraction.report === undefined
            ? {}
            : {
                report: {
                  ...extraction.report,
                  usage: {
                    input: usage?.input ?? 0,
                    output: usage?.output ?? 0,
                    cost: usage?.cost ?? 0,
                    turns: usage?.turns ?? 0,
                  },
                },
              }),
          outputRef,
          outputBytes,
          outputPreview,
          ...(childError === undefined ? {} : { childError }),
          ...(stderrDiagnostic === undefined ? {} : { stderrDiagnostic }),
        },
        { clock, callerId, logger },
      );
    };

    const onAbort = (): void => {
      if (!handle || resolved) return;
      aborted = true;
      // ADR-0016 §4: SIGTERM, then SIGKILL after the shared grace window. The lifecycle
      // adapter's kill() absorbs "process already gone" throws via safeKill, so the escalation
      // is safe to schedule unconditionally; `isDone` stops it after finalize clears it.
      cancelKillEscalation = killWithEscalation(lifecycle, handle, {
        isDone: () => resolved,
      });
    };

    // Hand the spawn to the lifecycle adapter (BG-03). The adapter wires stdout /
    // stderr pipes, JSONL parsing, and the close / error event handlers; this function
    // is left to accumulate usage / finalText and decide the close outcome.
    try {
      handle = lifecycle.spawn(
        // argv[0] is the command per the ChildProcessLifecycle contract; the rest are
        // forwarded verbatim. PI_COMMAND stays "pi" — see the constant's doc for why
        // we don't reuse process.execPath.
        [PI_COMMAND, ...argv],
        {
          cwd,
          // ADR-0016 Recursive section: the child run's depth baseline travels in the
          // environment so the pi-ptc extension loaded inside the child starts its PTC
          // runs at childDepth instead of at 0; the rest of the environment is inherited
          // from the host (the child needs the same PATH and provider config as pi itself).
          env: { ...process.env, PI_PTC_DEPTH: String(childDepth) },
          promptFile: tmp.filePath,
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      finalize("rejected", "failed to spawn pi: " + message, false);
      return;
    }

    if (ctx.signal) {
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });
    }

    // Drain the adapter's event stream and finalize the result. We run this async
    // work inside the Promise body so `resolve` (and therefore `finalize`) can fire
    // synchronously on the abort path while the iterator is still parked.
    void (async () => {
      if (!handle) return;
      const h = handle;
      try {
        for await (const ev of lifecycle.events(h)) {
          scanChildReportToolEvent(scan, ev);
          childModel = accumulateChildModel(childModel, ev);
          // Same last-error-wins fold as the background pump: a retry sequence ends on the
          // reason that ended it, not the first transient one.
          const error = childAssistantError(ev);
          if (error !== undefined) childError = error;
          if (ev.type === "message_end" && ev.message && ev.message.role === "assistant") {
            const m = ev.message;
            usage = accumulateUsage(usage, ev);
            if (Array.isArray(m.content)) {
              for (const part of m.content) {
                if (part && part.type === "text" && typeof part.text === "string") {
                  finalText = part.text;
                  // Sibling of `finalText`, not a replacement: the prose above is returned
                  // whatever this returns.
                  scan.prompt = extractChildReportFromText(part.text);
                }
              }
            }
          }
        }

        // Events iterator ended — child has closed.
        // The INJECTED lifecycle, not the module-level one: the spawn already goes through
        // `lifecycle` (the seam the round-4 review asked for), so reading the exit through a
        // different adapter would be a second, invisible seam — and the foreground path could
        // not be driven by a lifecycle double at all.
        let exitVal: ChildExitValue;
        try {
          exitVal = await lifecycle.exit(h);
        } catch (err) {
          // The exit read failed, so the dispatch cannot know the child's exit code and cannot
          // report a close. Report it on BOTH surfaces: the operator gets the warning, the
          // caller gets a rejected result. A failure that only reached one of them would be a
          // silent failure on the other (testing-constraints #3).
          const message = err instanceof Error ? err.message : String(err);
          logger.warn("exit() failed for a foreground child: " + message);
          finalize("rejected", "dispatch internal error: " + message);
          return;
        }
        exitCode = exitVal.code ?? -1;
        stderrText = await lifecycle.stderr(h);
        stderrDiagnostic = exitCode === 0 ? undefined : truncationFailureMessage(stderrText);

        // A failed spawn (ENOENT and friends) never brought a child up, so it is a
        // refusal like the depth and concurrency gates — `started: false` is what
        // keeps it out of the sub-call tree's `error` bucket. The adapter marks the
        // stderr with `[spawn-error] <message>` (same convention as the pre-BG-03
        // dispatch code).
        const spawnErrMatch = stderrText.match(/^\[spawn-error\] (.+)$/m);
        if (spawnErrMatch && exitVal.code === null && exitVal.signal === null) {
          finalize("rejected", "failed to spawn pi: " + spawnErrMatch[1], false);
          return;
        }

        const { status, errorMessage } = decideCloseOutcome({
          exitCode,
          finalText,
          aborted,
          // Reuses the same capture the spawn-error check above read, so the adapter's
          // stderr() is called exactly once per close. On pi 1.2.0 a truncated print-mode
          // run lands here with a labelled errorMessage instead of the anonymous reject.
          stderr: stderrText,
          // issue #70: the child's self-reported failure is the one diagnostic that describes
          // an exit-0 silent child (the rate-limit / model-error shape).
          childError,
        });
        finalize(status, errorMessage);
      } catch (err) {
        // The lifecycle adapter's events() / exit() / stderr() do not throw under
        // normal operation; if something unexpected happens, surface it as a rejected
        // result rather than hanging the dispatch Promise.
        const message = err instanceof Error ? err.message : String(err);
        finalize("rejected", "dispatch internal error: " + message);
      }
    })();
  });
}
