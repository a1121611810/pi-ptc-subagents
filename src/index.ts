/**
 * pi-ptc-subagents — DSH PTC mode (Programmable Tool Calling) for pi.
 *
 * This module is the extension entrypoint pi loads (`package.json` → `pi.extensions`).
 * The PTC machinery it exposes is complete and tested (T3): wire protocol, dispatcher,
 * bindings and the two worker surfaces. On top of it sit the two model-facing tools:
 *
 *   - `ptc_run_code` — bindings + Node + `console.log`, program's return value is the result
 *   - `ptc_workflow` — the same plus `log` / `phase` / `parallel` / `pipeline` and `args`
 *
 * There is no `agent()` helper on either surface (G1 #13 → decision B): calling it produces
 * a plain `ReferenceError` through the normal code-run error path.
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { WebSearchConfig } from "./mode/ptc-mode.ts";
import { createDeepSeekClient } from "./search/client.ts";
import { resolveDeepSeekCredential } from "./search/credentials.ts";
import { createSearchQuota } from "./search/quota.ts";
import { createSearchResultMemory, type WebDsSearchDeps } from "./search/run.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
  NormalizedBuildSystemPromptOptions,
} from "@earendil-works/pi-coding-agent";
import { createPtcRunCodeTool } from "./tools/run-code.ts";
import { createPtcWorkflowTool } from "./tools/workflow.ts";
import { createWebDsSearchTool } from "./tools/web-ds-search.ts";
import {
  createPtcTaskListTool,
  createPtcTaskOutputTool,
  createPtcTaskStopTool,
  PTC_TASK_TOOL_NAMES,
} from "./tools/ptc-task.ts";
import {
  resolveBindingNames,
  resolveDepthFromEnv,
  resolveParentTaskIdFromEnv,
} from "./tools/common.ts";
import { TurnPools } from "./runtime/turn-pools.ts";
import { resolveConfig } from "./runtime/limits.ts";
import { DEFAULT_CONFIG } from "./runtime/limits.ts";
import {
  createBackgroundTaskRuntime,
  type BackgroundTaskRuntime,
} from "./runtime/background-runtime.ts";
import { createULID } from "./runtime/child-process-lifecycle.ts";
import { readContextModel, type SessionModel } from "./runtime/session-model.ts";
import { OPT_IN_BINDING_NAMES } from "./runtime/bindings.ts";
import {
  renderTaskNotifications,
  shouldDeliverTaskNotification,
  splitTaskNotificationBatches,
} from "./runtime/task-notification.ts";
import type { TaskRecord, ULID } from "./runtime/task-storage.ts";
import {
  bindingSource,
  buildModeInstruction,
  decideModeEntry,
  DEFAULT_HIDE_STRATEGY,
  detectExternalLoadoutChange,
  detectSurfaceMode,
  FALLBACK_SURFACE_MODE,
  initialModeState,
  PTC_MODE_ENTRY_TYPE,
  PTC_MODE_STATUS_KEY,
  readDefaultModeConfig,
  readLegacySurfaceKey,
  readOptInBindingsConfig,
  readWebSearchConfig,
  readWhyEnabledConfig,
  resolveBaseOnStart,
} from "./mode/ptc-mode.ts";
import type {
  CodemodeActivationResolution,
  CodemodePresence,
  CodemodeSwitchResolution,
  DetectedSurface,
  ModeHideStrategy,
  OptInBindingsConfig,
  PersistedModeState,
  WhyEnabledConfig,
} from "./mode/ptc-mode.ts";
import { buildPtcSkillsSection, skillsSectionDropped } from "./mode/skills-section.ts";
import { buildDispatchSection, DISPATCH_SECTION_NAME } from "./mode/dispatch-section.ts";
import { createPtcSubagentTool } from "./tools/subagent.ts";
import { createChildReportTool } from "./tools/child-report-tool.ts";

export {
  bindingSource,
  buildModeInstruction,
  decideModeEntry,
  DEFAULT_HIDE_STRATEGY,
  detectExternalLoadoutChange,
  detectSurfaceMode,
  detectedSurfaceMode,
  initialModeState,
  modeLoadout,
  MODE_REQUIRED_TOOL_NAMES,
  PTC_MODE_CONFIG_FILE,
  PTC_MODE_ENTRY_TYPE,
  PTC_MODE_STATUS_KEY,
  PTC_MODE_TOOL_NAMES,
  probeCodemodePresence,
  readCodemodeSwitch,
  readDefaultModeConfig,
  readLegacySurfaceKey,
  readOptInBindingsConfig,
  readWebSearchConfig,
  readWhyEnabledConfig,
  resolveBaseOnStart,
  resolveCodemodeActivation,
  resolveCodemodeSwitch,
  sameToolSet,
} from "./mode/ptc-mode.ts";
export type {
  CodemodePresence,
  CodemodeSwitch,
  CodemodeSwitchResolution,
  CodemodeSwitchSource,
  DefaultModeConfig,
  DetectedSurface,
  LegacySurfaceKey,
  ModeBlockReason,
  ModeEntryDecision,
  ModeEntryInput,
  ModeHideStrategy,
  OptInBindingsConfig,
  PersistedModeState,
  PtcModeState,
  WebSearchConfig,
} from "./mode/ptc-mode.ts";
export {
  buildPtcSkillsSection,
  PTC_SKILL_LOAD_INSTRUCTION,
  SKILL_READING_TOOL_NAMES,
  skillsSectionDropped,
} from "./mode/skills-section.ts";
export { MAX_LINE_CHARS, renderModelValue, sanitizeText, stripAnsi } from "./tools/text.ts";
/** Footer status label shown while the mode is on. */
const MODE_STATUS_TEXT = "PTC";

/**
 * Which tools the mode hides. The shipped extension always uses the default; it is a named
 * constant so a future settings surface (or a test) has one place to change it.
 */
const MODE_HIDE_STRATEGY: ModeHideStrategy = DEFAULT_HIDE_STRATEGY;

/**
 * What to tell the user when the mode turns on. Names what became unreachable, because that is the
 * part that surprises people — and the binding list, because that is the part they need in order
 * to know what a program can still do.
 */
function describeEntry(
  base: readonly string[],
  hide: ModeHideStrategy,
  optIns?: readonly string[],
): string {
  const hidden =
    hide === "all-but-ptc"
      ? "all other tools"
      : "built-in tools (now reachable only as tools.<name> inside a program)";
  return [
    `PTC mode on — ${hidden} hidden.`,
    `Bindings available inside a program: ${resolveBindingNames(base, optIns).join(", ") || "(none)"}.`,
    "Run /ptc off to restore the normal tool set.",
  ].join("\n");
}

export {
  BUILTIN_BINDING_NAMES,
  createBuiltinBindings,
  DEFAULT_BINDING_NAMES,
  isOptInBindingName,
  OPT_IN_BINDING_NAMES,
  resolveOptInBindingNames,
} from "./runtime/bindings.ts";
export type {
  Binding,
  BindingContext,
  BindingTable,
  CreateBuiltinBindingsOptions,
  OptInBindingName,
} from "./runtime/bindings.ts";
export { runPtcProgram } from "./runtime/dispatcher.ts";
export type { PtcRunOutcome, PtcImage, RunPtcProgramOptions } from "./runtime/dispatcher.ts";
export {
  WorkerPool,
  type WorkerPoolOptions,
  type WorkerPoolStats,
  type WorkerPoolWorkerOptions,
} from "./runtime/worker-pool.ts";
export { TurnPools, type TurnPoolsOptions } from "./runtime/turn-pools.ts";
export {
  createWorkerEnv,
  DEFAULT_CONFIG,
  effectiveTimeoutMs,
  resolveConfig,
  WORKER_ENV_ALLOW_LIST,
} from "./runtime/limits.ts";
export type { PtcConfig, PtcSurface } from "./runtime/limits.ts";
export {
  PTC_ERROR_KIND,
  PTC_LOG_LEVEL,
  HOST_FRAME_KIND,
  WORKER_FRAME_KIND,
} from "./runtime/protocol.ts";
export type { PtcErrorKind, PtcErrorShape, PtcJsonValue } from "./runtime/protocol.ts";

/**
 * Optional seams for the extension factory. Production calls `ptcSubagents(pi)`; tests may inject
 * a pre-built background runtime (with a mock child lifecycle) so no real `pi` process is spawned.
 */
export interface PtcSubagentsOptions {
  /** Use this session-scoped background runtime instead of constructing one. */
  backgroundRuntime?: BackgroundTaskRuntime;
  /**
   * ADR-0026 test seam: what the codemode probe found. Undefined in production, where the
   * probe really runs. A test that exercises the DETECTED surface states the pi it
   * assumes rather than inheriting whatever process.argv the test runner happens to have,
   * which is how the previous version of that test passed for the wrong reason.
   */
  codemode?: CodemodePresence;
  /**
   * ADR-0027 test seam: whether pi will actually LOAD its own codemode. Undefined in
   * production, where `readCodemodeSwitch` reads pi's real settings files. Separate from
   * `codemode` on purpose — a pi can ship the directory and still be told not to load it,
   * and that is the case this seam exists to state.
   */
  codemodeSwitch?: CodemodeSwitchResolution;
  /**
   * ADR-0029 test seam: whether `codemode` will be in the model's tool list. Undefined in
   * production, where `readCodemodeActivation` reads pi's own active tool set and the MCP
   * evidence — no settings file and no `argv` on this axis any more (ADR-0035).
   *
   * This seam exists because the `surfaceMode` pin it replaced did. That pin was there to keep a
   * test off the developer's machine: the probe it fed read a settings file out of the developer's
   * own agent dir, so a test file that pinned nothing decided its own surface by however the
   * machine running it happened to be configured. Removing the pin without adding this would have
   * moved that failure back in, silently, to every stub-built factory.
   *
   * The machine-dependence is gone — the loadout is handed in rather than read off disk — but the
   * seam stays, because a test whose subject IS the axis needs to state an answer pi would not
   * produce on its own (`null` runs the real probe; see `tests/helpers/ptc.ts`).
   */
  codemodeActivation?: CodemodeActivationResolution;
}

export default function ptcSubagents(pi: ExtensionAPI, options: PtcSubagentsOptions = {}): void {
  const mode = initialModeState();

  /**
   * ADR-0050: whether this session may start a NEW child.
   *
   * **Separate from `mode.enabled`, and it has to be.** The mode is the NARROWING (ADR-0010), and
   * it only exists on the `full` surface in a TUI: measured 2026-10-20, the `subagents` surface
   * never enters it (`tools-unavailable`), because `ptc_run_code` is not model-facing there. A
   * switch hung off `mode.enabled` would therefore read "off" for the whole session on that
   * surface — and that surface's ONLY orchestration route is `ptc_subagent`, so it would have no
   * way to start a child at all.
   *
   * It is session-scoped, like ADR-0043's `why` switch: `/ptc off` writes it into a session
   * entry, so it survives a resume and a reload, and it never touches a file.
   */
  let dispatchEnabled = true;

  /**
   * ADR-0050: whether the three task tools are currently withheld from the model.
   *
   * They are withheld exactly when there is nothing for them to do — PTC is off and no task is in
   * flight. With a task running they stay, because that task has to stay inspectable and
   * stoppable: the off switch is about what starts from here on, and it must not strand what is
   * already running.
   */
  let taskToolsHidden = false;

  /**
   * The loadout as it was before the task tools were withheld, so putting them back is exact.
   *
   * An APPEND would be wrong: a loadout that never had the three would gain them, and the
   * narrowed loadout is derived from the live one — so a phantom tool would ride along for the
   * rest of the session.
   */
  let loadoutBeforeHiding: readonly string[] | undefined;

  /**
   * The session's detected surface, assigned once by `session_start` before anything can reach it.
   *
   * It used to be a `const` computed here, on the grounds that registration happens in the factory
   * and so the answer has to exist before the factory returns. That was true about the SEQUENCE and
   * wrong about the CAUSE: the answer did not have to exist, it had to be *reconstructed*, because
   * during extension load `ExtensionAPI`'s read methods are stubs that throw `Extension runtime not
   * initialized`. Measured on every pi this package supports.
   *
   * At `session_start` the runtime is bound, the loadout is readable, and pi has already applied
   * project trust to it — so the surface is read rather than mirrored. That is also what makes
   * registration movable: the thing registration had to wait for no longer has to be guessed.
   *
   * It is DETECTED, never read from a setting: there is no `surfaceMode` key and no way to pin a
   * surface, so the only question is what this pi is. See `detectSurfaceMode` for why the escape
   * hatch that used to be here is not one this package can replace.
   *
   * The definite-assignment assertion is safe for one reason: a tool cannot execute, and the
   * cross-checks cannot run, before the handler that registers them has been invoked.
   */
  let surface!: DetectedSurface;

  /**
   * ADR-0044: the caller session's current model, as the host last read it off pi's tool
   * context. The `ptc_subagent` call row uses it to state the inherited model when the call names
   * none. It is a snapshot refreshed at session start and at every turn start: a model switch
   * cannot interleave with a streaming turn, so the value a dispatch issued in this turn sees is
   * the value the turn started with. Absent = the host could not read one (old pi, library use).
   */
  let currentSessionModel: SessionModel | undefined;

  // Set on entry, cleared after the briefing has been injected, so the instruction lands once
  // per mode entry instead of on every turn.
  let briefingPending = false;

  /**
   * Per-turn worker pools (ADR-0017 §1–§2): one warm set per surface, created lazily by the
   * first PTC run of the turn and retired at the turn's end. The holder is swapped rather
   * than mutated so a `turn_end` drain can never race a run that is still holding a worker —
   * the outgoing holder owns everything the ending turn created.
   */
  let turnPools = new TurnPools();

  /**
   * Bindings come from the mode's base snapshot while PTC mode is on, and from the live loadout
   * otherwise (T7, #21). See `src/mode/ptc-mode.ts` for why the snapshot is required: the mode
   * hides the built-ins, which would otherwise empty the binding table and make every
   * `tools.<name>(...)` call fail.
   */
  const getBindingSourceNames = (): readonly string[] => bindingSource(mode, pi.getActiveTools());

  /**
   * #73: opt-in bindings, read ONCE at extension load rather than per run.
   *
   * The file lives at a fixed path (`~/.pi/agent/ptc.json`) and is a grant the operator edits
   * deliberately, not a per-session negotiation — reading it per run would mean a program could see
   * a different surface from the prompt that described it. An unreadable or malformed file grants
   * nothing (see `readOptInBindingsConfig`); the problem is reported at `session_start` rather than
   * swallowed, because a user who asked for `bash` and did not get it needs to be told why.
   */
  const optInConfig: OptInBindingsConfig = readOptInBindingsConfig(getAgentDir());
  const optInBindings = optInConfig.optInBindings;
  const getOptInBindings = (): readonly string[] => optInBindings;

  /**
   * ADR-0043: whether a dispatched child may be handed the caller's `why`, read ONCE here for the
   * same reason `optInBindings` is — this FILE is read once. It is not a promise that the value can
   * never change during a session, because it does: `/ptc why` overwrites
   * `background.dispatchDeps.whyEnabled` mid-session (see `applyWhy`), by design, and that is a
   * different object from this one. What holds is narrower and is the reason it stays a load-time
   * read: every mid-run change is an EXPLICIT, RECORDED user action — `/ptc why` writes a session
   * entry through `pi.appendEntry` — so a program whose first dispatch saw one value and whose
   * third saw another has a session entry naming the moment it changed, rather than a switch that
   * drifted on its own between two reads of a file.
   *
   * The per-call-read concern is the part that survives unchanged, and it is why
   * {@link DispatchDeps.whyEnabled} is carried rather than consulted per dispatch: a value read
   * fresh on every call would let the third dispatch of a run disagree with the first for reasons
   * no reader of the transcript could reconstruct.
   *
   * The failure direction is the opposite of `optInBindings`, and that is the point: a broken value
   * leaves the block **ON** (see {@link readWhyEnabledConfig}), because a default-on switch whose
   * parse failure silently removes a feature would put the symptom on a child's prompt, nowhere
   * near the file that caused it. The `session_start` notice below is what makes it a loud failure.
   *
   * Read separately from `optInConfig` even though both come from the same file: one read owns one
   * key, and a reader that returned the whole parsed object would let one malformed key decide
   * another's value.
   */
  const whyConfig: WhyEnabledConfig = readWhyEnabledConfig(getAgentDir());

  /**
   * ADR-0048: the DeepSeek search module's switch and quota, read ONCE at extension load for
   * the same reason `optInBindings` is — the file is an operator decision, and a program must
   * not see a surface different from the one the prompt describing it was built from.
   *
   * **The switch defaults to OFF.** The capability has a network egress and a per-call bill, so
   * the absence of a decision is not a decision to allow it (the same direction `bash` fails in,
   * ADR-0040).
   */
  const searchConfig: WebSearchConfig = readWebSearchConfig(getAgentDir());

  /**
   * Depth baseline for PTC runs this pi process starts (ADR-0016 Recursive section).
   * Inside a pi process spawned by `pi.dispatch`, the env carries `PI_PTC_DEPTH`; a
   * normal pi session has none, and the parent turn's runs stay at depth 0.
   */
  const ptcDepth = resolveDepthFromEnv();

  /**
   * ADR-0022 §3/reopen R-m12: this process's own background task id, read once from the child
   * environment `dispatch()` stamped (`PI_PTC_TASK_ID`). A top-level pi session has none. It
   * travels with each PTC run so a nested `pi.dispatch({ background: true })` records its parent.
   */
  const parentTaskId = resolveParentTaskIdFromEnv();

  /* ------------------------ BG-14: session-scoped background runtime ------------------------ */

  /**
   * Created ONCE, before any session; the session delegate is swapped by `bindSession` on
   * `session_start`. The three `ptc_task_*` tools and the two PTC surfaces capture its stable
   * delegates, so they never have to be re-registered. This factory body creates objects only —
   * `pi.*` is never called here (R2); the delivery below runs from event handlers.
   */
  // ADR-0026 round 4: since the cap moved into dispatch(), the SESSION counter is the one budget
  // for every dispatch front, so it is the one that has to be sized. Constructed without options it
  // silently took DEFAULT_CONFIG.dispatchConcurrency.
  //
  // Read the round-4 measurement "dispatchConcurrency went from 2 to 8, the knob died" with care:
  // it is a half-truth. There is NO session-level source for this key -- `resolveConfig` takes a
  // programmatic override, `runPtcProgram({config})` is a library option, and the extension never
  // passes one. So in a session this was 8 before this line and is 8 after it; what changed is
  // that the number now comes from one place instead of two that could disagree. A library caller
  // that DID pass a config still sees it sized per program by the dispatcher's own counter, which
  // a session's counter shadows -- and that shadowing is the decision, not an accident.
  const background: BackgroundTaskRuntime =
    options.backgroundRuntime ??
    createBackgroundTaskRuntime({
      concurrency: resolveConfig({}).dispatchConcurrency,
      whyEnabled: whyConfig.whyEnabled,
      // ADR-0049: the search module's switch, read once at load like `whyEnabled`. It decides
      // whether a STRICT child keeps the search tool — the tool only reads the web, and the
      // tier's promise is that the child cannot write. Measured 2026-10-20: without this the
      // child lost the tool entirely and reported having no web access at all.
      searchEnabled: searchConfig.enabled,
    });

  /** R2: whether an agent turn is in flight. `turn_start` sets it; `agent_settled` clears it. */
  let turnActive = false;

  const backgroundWarn = (message: string): void => {
    console.warn("[pi-ptc.background] " + message);
  };

  /** Send one rendered batch through the R2 channel for the current activity. */
  const sendBatch = (content: string): void => {
    // `renderTaskNotifications` returns "" for an empty batch: never send an empty message.
    if (content.length === 0) return;
    if (turnActive) {
      // Mid-turn injection steers the running agent (R2 verified channel).
      pi.sendMessage(
        { customType: "bg-task-notification", content, display: false },
        { deliverAs: "steer" },
      );
      return;
    }
    // Idle wake: sendUserMessage always starts a turn (R2 verified channel).
    pi.sendUserMessage(content);
  };

  /** Drain one subscriber's undelivered events, keep the completions, render + send, then ack. */
  const deliverSubscriber = async (subscriberId: ULID): Promise<void> => {
    const { items, acks } = await background.drainNotifications(subscriberId);
    // ADR-0022 §8 "谁停谁报告": canceled tasks are suppressed (BG-15 owns the policy).
    const deliverable = items.filter((item) => shouldDeliverTaskNotification(item.record));
    // Send FIRST, acknowledge after (ADR-0022 §5/§6). A throwing send propagates before the ack,
    // so the cursor stays put and the next drain re-delivers the event. An all-suppressed batch
    // sends nothing and advances immediately.
    for (const batch of splitTaskNotificationBatches(deliverable)) {
      sendBatch(
        renderTaskNotifications(batch, {
          batchId: createULID(),
          deliveredAtMs: background.clock(),
        }),
      );
    }
    await background.acknowledgeNotifications(acks);
  };

  /** Distinct owners (`spawnSource.callerId`) of every known task. */
  const knownOwners = async (): Promise<ULID[]> => {
    const records = await background.registry.query({ limit: Number.MAX_SAFE_INTEGER });
    const owners = new Set<ULID>();
    for (const record of records) {
      const owner = record.spawnSource.callerId;
      if (owner.length > 0) owners.add(owner as ULID);
    }
    return [...owners];
  };

  /** Drain every known owner; the `agent_settled` trigger. */
  const deliverAllOwners = async (): Promise<void> => {
    for (const owner of await knownOwners()) await deliverSubscriber(owner);
  };

  /** Deliver the records `bindSession` reconciled at startup through the same path. */
  const deliverLost = async (lost: readonly TaskRecord[]): Promise<void> => {
    const owners = new Set<ULID>();
    for (const record of lost) {
      const owner = record.spawnSource.callerId;
      if (owner.length > 0) owners.add(owner as ULID);
    }
    for (const owner of owners) await deliverSubscriber(owner);
  };

  /**
   * Terminal-transition trigger (ADR-0022 §6): the runtime calls `notifyIdle` when a task reaches
   * a terminal state, and this handler is where `pi.*` runs. When a turn is active the handler
   * steers; when idle it wakes with a user message.
   */
  background.pipeline.onIdleWake((subscriberId) => {
    void deliverSubscriber(subscriberId as ULID).catch((error: unknown) => {
      backgroundWarn(
        "notification delivery failed: " + (error instanceof Error ? error.message : String(error)),
      );
    });
  });

  /**
   * Register everything this session offers, once, for the surface just detected.
   *
   * A function declaration rather than an inline block so `session_start` can call it from wherever
   * the handler reads best, and so the registration body keeps the order it had when it was written
   * straight into the factory — the comments in it are a narrative in that order, and re-ordering
   * them would cost more than the indirection.
   *
   * `detected` is a parameter rather than a read of the enclosing `surface`, so nothing in here can
   * observe that variable before this call has assigned it.
   */
  function registerForSession(detected: DetectedSurface): void {
    /*
     * ADR-0025: the orchestration surface, as this session's detection resolved it. There is no
     * value that skips this block — ADR-0034 removed the `off` value that used to return above,
     * and ADR-0035 moved the decision into the `session_start` handler that calls this.
     *
     * **These two are registered on `subagents` too, and that is not the duplicate surface this
     * comment used to describe.** The claim was that two orchestrators beside each other makes the
     * model choose per request, and that is true of two `direct` tools. It is not what happens here:
     * on `subagents` the pair is registered at `codemode` reach, which does **not** declare them to
     * the model (`AgentSession._isDeclarable` admits only `direct` and `model-only`, measured on
     * 0.99.0 through 1.1.0). What it does is make them **callable from a `codemode` script**.
     *
     * So the two lines are not two orchestrators competing. `full` is this package as the thing
     * that composes tool calls; `subagents` is pi's `codemode` composing tool calls, with this
     * package's program reachable underneath it as the execution layer. The capability that makes
     * the second worth having is the one `codemode` cannot provide at all: its sandbox has no
     * module loader, so a script there cannot spawn a process — `pi.dispatch`, background tasks
     * with a six-state lifecycle, and the frozen six-name environment all live in the PTC worker.
     *
     * **A pi older than 0.99.0 is unaffected.** `ToolExposure` does not exist there, so the field
     * is ignored and both tools are declared to the model — which is right, because such a pi
     * ships no `codemode` and resolves to `full` anyway. Measured across
     * 0.86.1 / 0.87.1 / 0.99.0 / 0.99.1 / 0.99.2 / 1.0.0 / 1.0.4 / 1.1.0.
     */
    if (detected.surfaceMode === "full" || detected.surfaceMode === "subagents") {
      // `full` orchestrates itself and declares the tools; `subagents` hands composition to pi's
      // `codemode` and offers these as its execution layer.
      const programmingToolExposure = detected.surfaceMode === "full" ? "direct" : "codemode";
      pi.registerTool(
        createPtcRunCodeTool({
          getBindingSourceNames,
          getOptInBindings,
          childCanSearch: searchConfig.enabled,
          getPool: () => turnPools.get("run_code"),
          depth: ptcDepth,
          exposure: programmingToolExposure,
          ...(parentTaskId === undefined ? {} : { parentTaskId }),
          getDispatchDeps: () => background.dispatchDeps,
        }),
      );
      pi.registerTool(
        createPtcWorkflowTool({
          getBindingSourceNames,
          getOptInBindings,
          childCanSearch: searchConfig.enabled,
          getPool: () => turnPools.get("workflow"),
          depth: ptcDepth,
          exposure: programmingToolExposure,
          ...(parentTaskId === undefined ? {} : { parentTaskId }),
          getDispatchDeps: () => background.dispatchDeps,
        }),
      );
    }

    /*
     * ADR-0025 `subagents`: the top-level subagent face, registered only here. It is the reason
     * this mode exists -- `pi.dispatch` lives inside a program, so dispatching needs a program
     * underneath pi's `codemode`; this face is the one that does not.
     *
     * **It stays `direct` beside the pair above, and that asymmetry is the point.** The pair reach
     * a `codemode` script, which is where a model composing tool calls already is; this one is
     * declared to the model so that starting a subagent needs no script at all. `subagent` is the
     * capability whose whole purpose is being callable without an orchestrator — a `codemode`
     * reach would make it callable only by the thing that cannot use it.
     */
    if (detected.surfaceMode === "subagents") {
      pi.registerTool(
        createPtcSubagentTool({
          cwd: process.cwd(),
          depth: ptcDepth,
          maxDispatchDepth: DEFAULT_CONFIG.maxDispatchDepth,
          ...(parentTaskId === undefined ? {} : { parentTaskId }),
          getDispatchDeps: () => background.dispatchDeps,
          getSessionModel: () => currentSessionModel,
        }),
      );
    }

    /*
     * Always-on management tools (ADR-0022 "What we add" #6), OUTSIDE the PTC mode loadout.
     * The mode gates nothing about dispatch — it narrows which built-in tools the model may call
     * directly, and a child dispatched with the mode off still runs — so hiding this face would
     * strand a running child with no way to read or stop it. The mode's `modeLoadout` keeps
     * non-built-in names, so these survive both entry and exit
     * (proved in tests/unit/extension-background.test.ts).
     *
     * ADR-0025: unconditional from here on, and now literally so. The one mode that would not keep
     * this face, `off`, was removed by ADR-0034 -- there is no value that skips this function, and
     * no early return anywhere above it. "Always-on" therefore holds for every detected surface,
     * including `subagents`, where a task spawned through the top-level subagent tool is
     * inspectable exactly the same way.
     *
     * (This paragraph used to say `off` "has already returned at the top of the factory". That was
     * true of the factory it was written in and false of the function it now sits in, which is what
     * happens when a block moves and its comments do not — ADR-0035 moved this one.)
     */
    pi.registerTool(createPtcTaskListTool(background.registry));
    pi.registerTool(createPtcTaskOutputTool(background.registry, background.outputStorage));
    pi.registerTool(
      createPtcTaskStopTool(background.registry, background.lifecycle, { clock: background.clock }),
    );

    /*
     * ADR-0032's report tool (ticket #101). Registered here, inside the one registration path, so
     * it exists in every surface — but ACTIVE only where it has a caller.
     *
     * `defaultActive` is `ptcDepth > 0`, and `ptcDepth` is this process's own depth baseline read
     * from `PI_PTC_DEPTH`: 0 in a parent session, 1+ inside a `pi.dispatch` child. A parent has no
     * child to report, so the tool is registered there and never offered to its model — which is
     * the whole of "the tool is not active in the parent's ordinary surface" (`ToolDefinition.
     * defaultActive`: pi activates a `direct` tool on registration unless this says otherwise).
     *
     * The other half of activation is in `buildArgv`, which merges this tool's name into the child's
     * `--tools` list. Both halves are needed and neither covers the other's case: pi reads
     * `--tools` as an allowlist, so an agent that declares its own tools would filter the report
     * tool straight back out without the merge, while an agent that declares none gets no flag at
     * all and depends on `defaultActive`. See `childToolList`.
     */
    pi.registerTool(createChildReportTool(ptcDepth > 0));
  }

  /**
   * ADR-0033: the activation drift no config probe can see. pi's MCP extension activates `codemode`
   * by calling `pi.setActiveTools` when an `mcp.json` server asks for it — a runtime call no
   * settings file records. The evidence probe (ADR-0033) predicts that from the config, which
   * covers the common case; what it cannot cover is a codemode activated by anything else (an
   * extension calling `setActiveTools`, an `mcp.json` this probe could not read). Then the probe
   * says `inactive`, the surface defaults to `full`, and the model is being offered two
   * orchestration tools — the measured defect ADR-0025 exists to remove.
   *
   * So this compares the two things instead of trusting one: the probe's answer, and
   * `pi.getActiveTools()`. Checked at session start AND on the first turn, because the MCP
   * extension's own `session_start` may run after ours (extension order is not ours to choose),
   * so the first turn is the second chance. Once fired, never again — per turn would be crying
   * wolf.
   *
   * `warning`, not `info`, matching the probe-missed notice in `session_start`: same double
   * surface, same one-line fix. TUI-only, like every other notice here (`ctx.ui.notify` emits
   * nothing in `--print`) — ADR-0025's known limitation, restated rather than solved.
   *
   * There is no exemption here any more, and there was never much to exempt: a pinned surface set
   * `source: "file"` and this guard returned early, which is precisely the surface ADR-0034
   * deleted. What replaced it is the opposite trade — a wrong answer is now REPORTED rather than
   * suppressed by a value the user wrote, and the only silence left is the once-only latch above.
   */
  let codemodeDriftNotified = false;
  const notifyCodemodeDrift = (ctx: ExtensionContext): void => {
    if (codemodeDriftNotified) return;
    if (surface.codemodeActivation.activation !== "inactive") return;
    if (!pi.getActiveTools().includes("codemode")) return;
    codemodeDriftNotified = true;
    ctx.ui.notify(
      "pi-ptc-subagents: pi's codemode is active in this session, but nothing this package " +
        "reads predicted it — no tool list names it and no readable mcp.json auto-enables it — " +
        "so the surface defaulted to " +
        FALLBACK_SURFACE_MODE +
        ", and your model is being offered two orchestration tools. pi activates codemode at " +
        "runtime in ways no settings file records (its MCP extension is one). Run pi with " +
        "codemode active (-t codemode, or add it to defaultTools) to get the subagents surface " +
        "instead.",
      "warning",
    );
  };

  pi.on("turn_start", async (_event, ctx) => {
    // ADR-0044: refresh before any dispatch can run this turn; a switch between turns lands here.
    currentSessionModel = readContextModel(ctx);
    turnActive = true;
    notifyCodemodeDrift(ctx);
  });

  pi.on("agent_settled", async () => {
    turnActive = false;
    try {
      await deliverAllOwners();
    } catch (error) {
      backgroundWarn(
        "agent_settled delivery failed: " +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  });

  /**
   * Retire the turn's pools. `drain()` terminates the warm workers, so nothing outlives the
   * turn that spawned it; the next PTC run starts a fresh, lazily-created set. Idle workers are
   * already `unref()`-ed by the pool, so a turn that ends without this hook firing can never
   * keep the process alive either.
   */
  pi.on("turn_end", async () => {
    const draining = turnPools;
    turnPools = new TurnPools();
    await draining.drain();
  });

  /**
   * Register the DeepSeek search tool — **inside a dispatched child only**.
   *
   * ## The parent does not have this capability at all
   *
   * **Not "registered but hidden" — ABSENT.** The parent session never registers the tool, and
   * it never resolves a DeepSeek credential either: `ptcDepth > 0` is checked before anything
   * else happens here, so a parent process does not even hold the key. That is the whole point of
   * handing the capability to the sub-agent (ADR-0047): the parent keeps a clean context and does
   * not grow a dependency on the tool's shape — it depends on the dispatch-and-report contract it
   * already has.
   *
   * **The child's own model calls the tool directly** (`exposure: "direct"`), so a search costs the
   * child one tool call, not a program.
   *
   * ## Why the credential verdict is awaited here
   *
   * The verdict needs pi's own resolution — `ModelRuntime.getAuth` is the only public path to a
   * RESOLVED key, and resolving means running a `!command` and interpolating a `$VAR` — which is
   * asynchronous. The factory is synchronous, so the verdict lands at `session_start`, the first
   * moment a session exists.
   *
   * **The capability is registered even when the credential is missing.** That is ADR-0048's
   * second state: a model that can see that search exists but is unavailable can tell the user
   * what is missing, and a model that cannot see search at all cannot. The description says so,
   * and a call returns the same sentence.
   */
  let searchNoticeShown = false;
  const registerSearchModule = async (ctx: ExtensionContext): Promise<void> => {
    // **The parent stops here.** No tool, no credential, no network capability in this process.
    if (ptcDepth <= 0) return;
    if (!searchConfig.enabled) return;
    // The session's search quota. **One per pi process**, and a dispatched child IS a separate
    // process, so the quota bounds the CHILD — see ADR-0047 §配额 for what that means for a
    // parent that dispatches several children. The counter only grows on a SUCCESSFUL call, and a
    // call in flight holds a slot so concurrent calls cannot all pass the check first
    // (`search/quota.ts`).
    const searchQuota = createSearchQuota({
      maxCallsPerSession: searchConfig.maxCallsPerSession,
    });
    // The resolver never throws — a failed resolution is reported, not raised — so the notice
    // channel is handed to it rather than wrapped around it.
    const credential = await resolveDeepSeekCredential({
      agentDir: getAgentDir(),
      onWarn: (message) => ctx.ui.notify(`pi-ptc-subagents: ${message}`, "warning"),
    });
    const deps: WebDsSearchDeps = {
      ...(credential.configured && credential.key !== undefined
        ? { client: createDeepSeekClient({ apiKey: credential.key }) }
        : {}),
      quota: searchQuota,
      maxCallsPerSession: searchConfig.maxCallsPerSession,
      // The session's memory of the last search's results: what makes `open` and `find` free.
      memory: createSearchResultMemory(),
    };
    pi.registerTool(
      createWebDsSearchTool({
        deps,
        unavailable: !credential.configured || credential.key === undefined,
      }),
    );
    if (!credential.configured && !searchNoticeShown) {
      searchNoticeShown = true;
      ctx.ui.notify(
        "pi-ptc-subagents: 搜索模块已开启，但 pi 的凭据里没有可用的 DeepSeek key" +
          "（auth.json 的 deepseek 条目、models.json 的 providers.deepseek.apiKey、" +
          "DEEPSEEK_API_KEY 都没有）。搜索会失败——工具已注册但不可用。",
        "warning",
      );
    }
  };

  /*
   * The PTC status line: one key, painted from the mode's state, and nothing else.
   *
   * It carried a second part until #187 -- an agent-availability marker that outlived the startup
   * notice it mirrored, so that "the subagent never ran" stayed readable twenty minutes later
   * instead of having to be re-derived from a transcript. The marker went with the notice, because
   * both reported an empty agent registry as a problem and it stopped being one the moment an
   * omitted `agent` began dispatching a generalist child. The observability rule that produced it
   * still holds; it simply has no subject here now.
   */
  const paintStatus = (ctx: ExtensionContext): void => {
    const parts: string[] = [];
    if (mode.enabled) parts.push(ctx.ui.theme.fg("accent", MODE_STATUS_TEXT));
    ctx.ui.setStatus(PTC_MODE_STATUS_KEY, parts.length > 0 ? parts.join("  ") : undefined);
  };

  const enterMode = (
    base: readonly string[],
    loadout: readonly string[],
    ctx: ExtensionContext,
    announcement: string,
  ): void => {
    mode.enabled = true;
    mode.base = base;
    mode.ourLoadout = loadout;
    pi.setActiveTools([...loadout]);
    briefingPending = true;
    pi.appendEntry(PTC_MODE_ENTRY_TYPE, { enabled: true, base: [...base] });
    paintStatus(ctx);
    ctx.ui.notify(announcement, "info");
  };

  const exitMode = (
    ctx: ExtensionContext,
    opts: { announce: boolean; customType: string },
  ): void => {
    const base = mode.base;
    mode.enabled = false;
    mode.base = undefined;
    mode.ourLoadout = undefined;
    briefingPending = false;
    if (base !== undefined) pi.setActiveTools([...base]);
    pi.appendEntry(opts.customType, { enabled: false });
    paintStatus(ctx);
    if (opts.announce) {
      ctx.ui.notify(
        "PTC mode off — built-in tools are directly callable again. Dispatching a child and the " +
          "background-task tools still work; the mode never gated those.",
        "info",
      );
    }
  };

  /**
   * Withhold the three task tools from the model, or put them back (ADR-0050).
   *
   * `setActiveTools` is the only lever pi leaves for this: a registered tool cannot be
   * unregistered (the mode narrows the loadout the same way), and the three are registered at
   * session_start, so they are active until this runs.
   *
   * It never overlaps the narrowing: turning PTC off turns the narrowing off too, so the loadout
   * being narrowed here is always the restored one.
   */
  const applyTaskToolVisibility = (hidden: boolean): void => {
    if (taskToolsHidden === hidden) return;
    const active = pi.getActiveTools();
    if (hidden) {
      // Remember the loadout as it was, so putting the tools back is EXACT rather than an
      // append: a loadout that never had them must not gain them.
      loadoutBeforeHiding = active;
      pi.setActiveTools(active.filter((name) => !PTC_TASK_TOOL_NAMES.includes(name)));
    } else {
      pi.setActiveTools([...(loadoutBeforeHiding ?? active)]);
    }
    taskToolsHidden = hidden;
  };

  /**
   * How many background tasks are still running in this session (ADR-0050).
   *
   * The off switch has to know one thing: whether something is already running. That is what
   * decides whether the task tools stay in the model's face, and what the warning is about.
   */
  const countInFlightTasks = async (): Promise<number> => {
    const records = await background.registry.query({ status: ["running", "stopping"] });
    return records.length;
  };

  /** Restore the persisted mode record, if this session has one. */
  const readPersistedMode = (ctx: ExtensionContext): PersistedModeState | undefined => {
    const entries = ctx.sessionManager.getEntries();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry?.type !== "custom" || entry.customType !== PTC_MODE_ENTRY_TYPE) continue;
      const data = entry.data as { enabled?: unknown; base?: unknown } | undefined;
      const base = Array.isArray(data?.base)
        ? data.base.filter((name): name is string => typeof name === "string")
        : undefined;
      return {
        enabled: data?.enabled === true,
        ...(base === undefined ? {} : { base }),
      };
    }
    return undefined;
  };

  /**
   * The last dispatch record in this session, or `undefined` when it has none (ADR-0050).
   *
   * Backwards, for the same reason `readPersistedMode` scans backwards: the LAST record is the
   * user's most recent explicit intent.
   */
  const readPersistedDispatch = (ctx: ExtensionContext): { enabled: boolean } | undefined => {
    const entries = ctx.sessionManager.getEntries();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry?.type !== "custom" || entry.customType !== PTC_DISPATCH_ENTRY_TYPE) continue;
      const data = entry.data as { enabled?: unknown } | undefined;
      return { enabled: data?.enabled === true };
    }
    return undefined;
  };

  /**
   * Restore the dispatch switch from the session record (ADR-0050).
   *
   * The same three properties ADR-0043's `why` restore has: effective for the NEXT dispatch (the
   * one shared deps object every front reads), durable for the session (the entry itself), and
   * nothing else (no file is written, and the narrowing is not touched here).
   *
   * The task tools follow the switch, and they are withheld only when there is nothing for them
   * to do — a task that is still running keeps them, because it has to stay stoppable.
   */
  const applyPersistedDispatch = async (
    persisted: { enabled: boolean } | undefined,
  ): Promise<void> => {
    if (persisted === undefined) return;
    dispatchEnabled = persisted.enabled;
    background.dispatchDeps.dispatchEnabled = persisted.enabled;
    const inFlight = persisted.enabled ? 0 : await countInFlightTasks();
    applyTaskToolVisibility(!persisted.enabled && inFlight === 0);
  };

  pi.registerCommand("ptc", {
    description: "Show or toggle PTC mode",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      // NOTE: `/ptc off` below is PTC MODE and `/ptc why` is ADR-0043's dispatch-`why` switch --
      // two switches. `surface` went with `surfaceMode`; the one in force reports at session start.
      if (action === "why" || action.startsWith("why ")) return applyWhy(action.slice(4), ctx);
      if (action === "off") {
        // ADR-0050: PTC off stops NEW children AND restores the built-in tools. The narrowing
        // goes with it, because "off" has to mean one thing.
        if (!mode.enabled && !dispatchEnabled) {
          ctx.ui.notify("PTC is already off.", "info");
          return;
        }
        // The flag FIRST: `dispatch()` reads it per call, so this takes effect before the user's
        // next turn rather than at the next extension load.
        dispatchEnabled = false;
        background.dispatchDeps.dispatchEnabled = false;
        pi.appendEntry(PTC_DISPATCH_ENTRY_TYPE, { enabled: false });
        if (mode.enabled) {
          exitMode(ctx, { announce: false, customType: PTC_MODE_ENTRY_TYPE });
        }
        // The task tools stay exactly as long as there is something for them to do.
        const inFlight = await countInFlightTasks();
        applyTaskToolVisibility(inFlight === 0);
        paintStatus(ctx);
        const one = inFlight === 1;
        ctx.ui.notify(
          inFlight > 0
            ? `PTC off — no new child can be started from here on. The ${inFlight} background ${one ? "task" : "tasks"} already running ${one ? "is" : "are"} NOT affected: ${one ? "it keeps" : "they keep"} running and stay manageable through ptc_task_list / ptc_task_output / ptc_task_stop.`
            : "PTC off — no new child can be started from here on, and the background-task tools are gone because nothing was running.",
          "info",
        );
        return;
      }
      if (action !== "on") {
        ctx.ui.notify(
          mode.enabled
            ? `PTC mode is ON — run /ptc off to restore built-in tools and stop new children.\nBindings: ${resolveBindingNames(mode.base, optInBindings).join(", ") || "(none)"}`
            : dispatchEnabled
              ? "PTC mode is OFF — built-in tools are directly callable, and new children can still be started. Run /ptc off to stop dispatching, or /ptc on to enter the mode."
              : "PTC is OFF — no new child can be started, and the background-task tools are gone unless a task is still running. Run /ptc on to allow dispatching again.",
          "info",
        );
        return;
      }
      // ADR-0050: "on" re-enables dispatching as well as the narrowing, and the two are not the
      // same switch — so this runs whether or not the narrowing is already on.
      const reEnabledDispatch = !dispatchEnabled;
      if (reEnabledDispatch) {
        dispatchEnabled = true;
        background.dispatchDeps.dispatchEnabled = true;
        pi.appendEntry(PTC_DISPATCH_ENTRY_TYPE, { enabled: true });
        // Put the task tools back BEFORE the mode decision below: that decision reads the live
        // loadout as its `base`, and a base without them would keep them hidden for the rest of
        // the session.
        applyTaskToolVisibility(false);
      }
      if (mode.enabled) {
        ctx.ui.notify(
          reEnabledDispatch
            ? "PTC is on — new children can be started again (the narrowing was already on)."
            : "PTC mode is already on.",
          "info",
        );
        return;
      }
      // Manual entry bypasses the config and the restricted-session policy; a restricted session
      // simply enters with its own (smaller) loadout as `base`, so bindings stay inside it.
      const decision = decideModeEntry({
        mode: ctx.mode,
        defaultMode: true,
        active: pi.getActiveTools(),
        manual: true,
        hide: MODE_HIDE_STRATEGY,
      });
      if (!decision.enter) {
        const why =
          decision.reason === "tools-unavailable"
            ? "Cannot enter PTC mode: ptc_run_code / ptc_workflow are not active in this session."
            : "Cannot enter PTC mode in this run mode.";
        ctx.ui.notify(
          reEnabledDispatch ? `${why} New children can be started again.` : why,
          "warning",
        );
        return;
      }
      enterMode(
        decision.base,
        decision.loadout,
        ctx,
        describeEntry(decision.base, MODE_HIDE_STRATEGY, optInBindings),
      );
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    /*
     * Detect the surface and register, FIRST — before anything below can await.
     *
     * `session_start` is the first moment this extension has a bound runtime, and therefore the
     * first moment `pi.getActiveTools()` answers instead of throwing. That call is where the
     * surface comes from now: pi has already applied the command line, `defaultTools`, AND its
     * project-trust decision, so the answer cannot disagree with what the model will actually be
     * offered. See `readCodemodeActivation` for what was deleted along with it and why the
     * MCP axis is still read off disk.
     *
     * Registration follows detection because that is the direction that works: pi can add a tool
     * from here (it refreshes its own registry) but cannot remove one, so deciding what to register
     * after the answer exists is the only order that does not have to guess. Both of these lines
     * are deliberately ahead of the `await` below — anything after a suspension point could observe
     * a session whose tools do not exist yet.
     *
     * `cwd` is left at its `process.cwd()` default, as before: it only matters for the `!` bucket's
     * globs, and the one case where they can differ (an SDK embedder passing an explicit `cwd`) is
     * recorded in ADR-0027 as a known limit rather than papered over.
     */
    // ADR-0044: the call row's inherited-model fact comes from the session, and this is the first
    // moment one exists. Read it before registration, because the tool registration captures the
    // getter that reads this snapshot.
    currentSessionModel = readContextModel(ctx);
    surface = detectSurfaceMode(
      getAgentDir(),
      pi.getActiveTools(),
      options.codemode,
      options.codemodeSwitch,
      options.codemodeActivation,
    );
    registerForSession(surface);

    // The DeepSeek search module (ADR-0047 / ADR-0048). Registered AFTER the surface, and
    // after the await that resolves the credential — pi can add a tool at any point in a
    // session, but it cannot remove one, so this is the order that does not have to guess.
    // **In a parent session this registers nothing at all** — see `registerSearchModule`.

    // BG-14: bind the session-scoped background runtime before anything else. The records this
    // returns were reconciled to `lost`; delivering them through the one notification path is the
    // ADR-0022 §8 startup guarantee, not a bespoke message. A bind failure is surfaced as a
    // warning through `ctx.ui.notify` and leaves the previous (in-memory) delegate usable.
    turnActive = false;
    const lost = await background.bindSession(ctx.sessionManager?.getSessionDir?.(), (message) =>
      ctx.ui.notify(message, "warning"),
    );
    try {
      await deliverLost(lost);
    } catch (error) {
      backgroundWarn(
        "startup reconcile delivery failed: " +
          (error instanceof Error ? error.message : String(error)),
      );
    }

    // The search module's registration comes AFTER the background bind, because BG-14's
    // "bind before anything else" is a documented invariant of this handler and an await in
    // front of it would break the order that comment states.
    await registerSearchModule(ctx);

    const config = readDefaultModeConfig(getAgentDir());
    if (config.error !== undefined) {
      ctx.ui.notify(`pi-ptc-subagents: ${config.error}`, "warning");
    }
    /*
     * ADR-0043: the same notice for the `why` switch, and the same reason it cannot be silent. A
     * user who wrote `"whyEnabled": "false"` and still sees the block has no other way to learn
     * that the key was the problem — and the symptom they see is on a CHILD's prompt, which is the
     * least obvious place to go looking for a typo in their own config.
     *
     * The message says what the KEY did, not what the session ended up with. It used to claim the
     * block "stays ON", which is false at exactly the moment it fires: `applyPersistedWhy` runs
     * further down this same handler and writes a persisted `/ptc why off` over
     * `background.dispatchDeps.whyEnabled`, so with `ptc.json` = `{"whyEnabled": "false"}` and an
     * off record in the session, this session has it OFF while the notice insists otherwise. The
     * notice exists to be the path from a symptom to its cause, and naming a state the session is
     * not in sends the user looking in the wrong place. "This key was ignored, and `/ptc why` is
     * what decides" is the claim that is true either way — and `/ptc why` with no argument reports
     * which value is actually in force and where it came from, so the notice points at the one
     * command that answers the question it raises.
     *
     * Read from the value captured at extension load, for the same reason as `optInConfig` below.
     */
    if (searchConfig.error !== undefined) {
      ctx.ui.notify(
        `pi-ptc-subagents: ${searchConfig.error}. The search module's switch was read as ` +
          "OFF and its quota as the default, so no dispatched child will get the search tool.",
        "warning",
      );
    }
    if (whyConfig.error !== undefined) {
      ctx.ui.notify(
        `pi-ptc-subagents: ${whyConfig.error}. That key was ignored rather than acted on, so it ` +
          `cannot have switched the dispatch \`why\` block off — \`/ptc why\` is what decides that, ` +
          `and \`/ptc why\` on its own reports the value in force and where it came from.`,
        "warning",
      );
    }
    /*
     * #73: an `optInBindings` list that does not parse grants nothing, which is safe but silent —
     * and a user who wrote `"optInBindings": ["bash"]` and still finds no `tools.bash` has no other
     * way to learn that the key was the problem. The notice names the valid names, because the
     * failure mode this guards is a typo or a name that was never an opt-in in the first place.
     *
     * Read from the value captured at extension load rather than re-read here: `optInConfig` is the
     * single read of this file's opt-in key, and re-reading it would mean the surface a run builds
     * and the one this message describes could come from two different reads.
     */
    if (optInConfig.error !== undefined) {
      ctx.ui.notify(
        `pi-ptc-subagents: ${optInConfig.error}. No opt-in binding was granted, so the PTC surface ` +
          `stays narrowed. Opt-in bindings: ${OPT_IN_BINDING_NAMES.join(", ")}.`,
        "warning",
      );
    }
    /*
     * The `surfaceMode` key is gone (ADR-0025 withdrawn), and `ptc.json` may still carry one from a
     * release that had it. Reading it here is the ONLY thing this package does with that key: it is
     * not honoured, because honouring `"off"` forever is the switch this change deletes, and a
     * package that silently came back after being switched off is worse than one that says so.
     *
     * The replacement is `pi config`, and it is a strictly better one -- pi does not LOAD the
     * extension to honour it, so none of this package runs at all, which no value of a key this
     * package reads could achieve. Measured on pi 1.1.0 against this package's own `dist/index.js`:
     * a `packages` entry whose `extensions` is `[]` or `["!dist/index.js"]` does not load it, while
     * `["+dist/index.js"]` and an absent key both do.
     *
     * `warning`, not `info`: the key is being ignored and the behaviour it asked for is not in
     * force. TUI-only, like every other notice here -- a `--print` session gets no line, which is
     * the same limitation every surface notice in this file carries.
     */
    const legacySurface = readLegacySurfaceKey(getAgentDir());
    if (legacySurface !== undefined) {
      ctx.ui.notify(
        "pi-ptc-subagents: " +
          legacySurface.path +
          ' still has a "surfaceMode" key (' +
          JSON.stringify(legacySurface.value) +
          "), and it is no longer read: the surface is detected from what pi is, and no key pins " +
          "it. To keep this package out of your sessions entirely, turn it off in pi -- run " +
          "`pi config` and disable this package's extensions there (its `extensions` entry set to " +
          "[] stops pi loading it at all). To silence this notice, delete the key.",
        "warning",
      );
    }

    /*
     * ADR-0026: the surface is DETECTED, so a detection that silently came back false is the one
     * failure mode that design has. A pi that restructures its `dist` makes the probe return
     * `not-found`, the surface quietly becomes `full`, and the user gets zero diagnostics.
     *
     * `!present` is exactly "the probe could not answer". The healthy case -- probe found codemode,
     * `detectedSurfaceMode` turned that into `subagents` -- never reaches here, because a notice on
     * every modern-pi session would be noise. What is left is a probe with something to report, and
     * naming it is the point: "pi restructured" is then distinguishable from "no pi next to
     * argv[1]" from a shim that would not resolve.
     *
     * `info`, not `warning`: a pi that genuinely ships no codemode lands here too, and `full` is
     * the right answer for it, so a warning on every one of those sessions would be crying wolf.
     * TUI-only, like every other notice in this file.
     */
    const detected = surface.codemode;
    if (!detected.present) {
      ctx.ui.notify(
        "pi-ptc-subagents: the codemode probe reported " +
          detected.how +
          ", so the surface is " +
          FALLBACK_SURFACE_MODE +
          ". That is the safe direction, not an error.",
        "info",
      );
    }

    /*
     * #187 removed the agent-availability notice that used to sit here. It reported that no agent
     * was registered and therefore that `ptc_subagent` had nothing to dispatch -- which was true
     * only while `agent` was required, and became a false alarm about a working tool the moment an
     * omitted `agent` started dispatching a generalist child.
     *
     * Nothing replaced it, deliberately. An empty registry is the normal state of a fresh install,
     * and a notice that fires on the normal state is what teaches people to stop reading notices.
     * `tests/extension.test.ts` holds the absence, so re-adding a check here turns that test red.
     */

    if (surface.codemodeSwitch?.error !== undefined) {
      ctx.ui.notify(`pi-ptc-subagents: ${surface.codemodeSwitch.error}`, "warning");
    }

    /*
     * ADR-0033: an `mcp.json` we could not read is reported for the same reason a settings file
     * is — the probe's input silently vanishing would otherwise make "codemode will stay inactive"
     * indistinguishable from "we could not tell", and the first is a decision while the second is
     * a probe failure. The file contributed nothing to the activation answer, so the surface still
     * resolves; the notice says which.
     */
    if (surface.codemodeActivation?.mcpError !== undefined) {
      ctx.ui.notify(`pi-ptc-subagents: ${surface.codemodeActivation.mcpError}`, "warning");
    }

    /*
     * The probe's other wrong answer. It walks the FILESYSTEM, so it cannot see the two ways pi
     * offers to withhold a tool it has on disk: `--no-extensions`, and `--exclude-tools codemode`.
     * Either way the probe answers `present`, `detectedSurfaceMode` hands the session to
     * `codemode`, and pi registers no such tool -- leaving `ptc_subagent` with no orchestrator. The
     * ADR-0025 decision-4 warning below cannot cover it: that one asks whether codemode is
     * ACTIVE, and with the tool absent both questions are false for the same reason.
     *
     * So this asks the filesystem probe cannot: not "is the tool offered" but "does pi know this
     * tool at all". `getAllTools` is available here and only here -- it is a `notInitialized` stub
     * during loading (ADR-0026) -- so this is the first and only point where the two can be
     * compared.
     */
    {
      const known = pi.getAllTools().some((tool) => tool.name === "codemode");
      if (!detected.present && known) {
        /*
         * The probe is a filesystem guess, so it fails in BOTH directions: a pi that restructures
         * its `dist`, or a layout no candidate covers, answers `not-found` while pi plainly
         * registers codemode. The session then registers `ptc_run_code` AND `ptc_workflow` beside a
         * live codemode -- the duplicate model-facing surface this package exists to avoid -- and
         * the `info` notice above calls that "the safe direction, not an error", which is the
         * opposite of what the user just got. `known` is the registry's own answer and it costs one
         * line to use.
         *
         * (This used to open "The mirror, and round 4 caught that only the over-estimate was
         * handled". The mirror is deleted, ADR-0035, and what it names is simply the probe: the
         * second half of that sentence is the part worth keeping, and it is unchanged.)
         */
        ctx.ui.notify(
          "pi-ptc-subagents: this session registers pi's codemode, but the probe did not find " +
            "it (" +
            detected.how +
            "), so the surface defaulted to " +
            FALLBACK_SURFACE_MODE +
            ", and your model is being offered two orchestration tools. Enable codemode for " +
            "real (-t codemode) to get the subagents surface instead.",
          "warning",
        );
      }
      if (detected.present && !known) {
        /*
         * ADR-0029: the surface is REPORTED, not spelled out, and the value reported is
         * `surface.surfaceMode` — which, now that there is no `source: "file"` path to read
         * `surface.detected` from, is also the only value there is.
         *
         * What can put a session in the `subagents` half of this branch, restated after ADR-0035
         * because the previous account of it described code that no longer exists. That account
         * said the residual wrong-way answer was a project `defaultTools` this package read off
         * disk while pi ignored the project for being untrusted. It could say that because it was
         * true: activation was reconstructed from the files, so this package saw `active` and chose
         * `subagents` whether or not pi had been told to trust the folder.
         *
         * Activation is now READ from pi's own loadout, which already has the trust decision
         * applied, so a project setting pi declined to read is simply absent from the answer and
         * resolves `inactive` — that branch is `full` before reaching here. `--exclude-tools
         * codemode` is likewise gone from this branch: pi honours the denylist, so the loadout does
         * not name codemode and the table answers `full` first. (The deleted `cliToolFlags` used to
         * be named here as the reason `--exclude-tools` was handled; the reason is now that pi is
         * the one being asked, which is the same conclusion reached without the reconstruction.)
         *
         * What lands here is the case the earlier comment already identified correctly and still
         * does: `--no-extensions`, where codemode is on disk and pi does not register it at all.
         * That is the one this notice is for, and it is now the only one.
         */
        ctx.ui.notify(
          "pi-ptc-subagents: the codemode probe found pi's codemode on disk, but this " +
            "session does not register it (--no-extensions), so " +
            "the surface is " +
            JSON.stringify(surface.surfaceMode) +
            (surface.surfaceMode === "subagents"
              ? " with no orchestrator: ptc_run_code and ptc_workflow are reachable only from " +
                "codemode, and this session has none. Launch with codemode active (pi -t codemode), " +
                "or turn this package off with pi config."
              : "."),
          "warning",
        );
      }
    }

    /*
     * ADR-0025 decision 4: `subagents` hands orchestration to pi's `codemode`, so a session
     * without it is left holding a subagent tool and no way to compose anything. Warn once, at
     * entry, and still register: taking the user's subagents away is a worse answer than a
     * message. `getActiveTools`, not `getAllTools` -- pi registers `codemode` as a built-in
     * extension that is present-but-inactive until a loadout or the default tool list names
     * it, so a registry query would report a tool the model cannot actually call.
     *
     * Gap, stated rather than hidden: `ctx.ui.notify` is TUI-only, so a `--print` session in
     * this state gets no warning. ADR-0025 lists it as a known limitation.
     */
    if (surface.surfaceMode === "subagents" && !pi.getActiveTools().includes("codemode")) {
      // The warning's premise is "this session has no orchestration tool", so the question is what
      // the MODEL is offered, and `getActiveTools()` is exactly that set — pi's own docstring:
      // "Get the names of the active tools, which are the tools declared to the model."
      // `getAllTools()` would answer a different question (what is registered).
      const declaredToModel = pi.getActiveTools();
      const hasDeclaredProgrammingTool =
        declaredToModel.includes("ptc_run_code") || declaredToModel.includes("ptc_workflow");
      // **A pi older than 0.99.0 never reaches the warning, and that is the point.** There
      // `ToolExposure` does not exist, so the pair registered above is declared to the model
      // rather than held at `codemode` reach — the session HAS an orchestration tool, it is
      // `ptc_run_code`, and telling that user to "add codemode" would name a tool their pi does
      // not ship, while "use ptc_run_code instead" names the tool they already have. Both halves
      // of the sentence would be wrong, so the whole notice is withheld rather than reworded.
      if (!hasDeclaredProgrammingTool) {
        ctx.ui.notify(
          "pi-ptc-subagents: the detected surface is subagents, but codemode is not active in " +
            "this session, so there is no orchestration tool. Add codemode to your pi tool " +
            "list (the --tools flag or the default tools setting), or turn this package off " +
            "with pi config.",
          "warning",
        );
      }
    }

    // ADR-0033: the probe answered, then pi's real loadout gets the last word — here and on the
    // first turn, because the MCP extension may activate codemode after this handler ran.
    notifyCodemodeDrift(ctx);

    const persisted = readPersistedMode(ctx);
    const persistedDispatch = readPersistedDispatch(ctx);
    const active = pi.getActiveTools();
    const { base, restoreFirst } = resolveBaseOnStart(persisted, active);
    // Undo our own narrowing before deciding, so the decision sees the loadout this pi process
    // was actually launched with rather than the one a previous mode invocation left behind.
    if (restoreFirst) pi.setActiveTools([...base]);

    const decision = decideModeEntry({
      mode: ctx.mode,
      defaultMode: config.defaultMode,
      active: base,
      manual: false,
      hide: MODE_HIDE_STRATEGY,
    });
    // A persisted record is the user's most recent explicit intent: `/ptc off` survives a resume
    // even when the config still says default-on.
    //
    // ADR-0050: the two records always agree in practice (`/ptc off` writes both, `/ptc on`
    // clears both), but the narrowing and the dispatch switch are NOT one switch — so the mode
    // decision also honours the dispatch record. The invariant that keeps the two loadout
    // manipulations from overlapping is the one this line establishes: **dispatch off ⇒ the
    // narrowing is off**, so the task tools are never withheld from a narrowed loadout (whose
    // snapshot would then keep them withheld for the rest of the session).
    const wantMode = (persistedDispatch?.enabled ?? true) && (persisted?.enabled ?? decision.enter);
    applyPersistedWhy(ctx);
    if (decision.enter && wantMode) {
      enterMode(
        base,
        decision.loadout,
        ctx,
        describeEntry(base, MODE_HIDE_STRATEGY, optInBindings),
      );
    } else {
      paintStatus(ctx);
      if (!decision.enter && decision.reason !== "not-tui" && persisted === undefined) {
        if (decision.reason === "restricted-session") {
          ctx.ui.notify(
            "PTC mode skipped: this session was launched with an explicit tool restriction.",
            "info",
          );
        }
      }
    }
    // Last, because it manipulates the loadout: the mode decision above reads the live loadout
    // as its `base`, and a base missing the task tools would keep them missing.
    await applyPersistedDispatch(persistedDispatch);
  });

  /**
   * BG-14 teardown (ADR-0022 §8): a session end is an implicit stop for every in-flight task.
   * They are session-anchored, not run-anchored, so the run AbortSignal never reaches them; this
   * hook is where they are reclaimed `running/stopping -> lost (session_ended_while_running)` and
   * their live children are reaped with the dispatcher's shared SIGTERM -> grace -> SIGKILL ladder.
   */
  pi.on("session_shutdown", async () => {
    turnActive = false;
    try {
      await background.shutdown("session_ended_while_running");
    } catch (error) {
      backgroundWarn(
        "session shutdown failed: " + (error instanceof Error ? error.message : String(error)),
      );
    }
  });

  /**
   * Put back the skills section pi withholds while the mode hides `read`/`bash` (ADR-0011).
   *
   * pi advertises skills only when the session can open a skill file at all (`read` or `bash`
   * among the selected tools), so a PTC session silently loses the whole `<available_skills>`
   * list: the model stops knowing skills exist. Writing `sections.skills` here is the seam pi
   * leaves open — custom sections are merged after its own, so this one wins.
   *
   * The same options object is reused across turns and sessions of a resume, so the injection is
   * undone the moment the mode stops hiding those tools: a `/ptc off` must not leave PTC-flavoured
   * loading instructions behind while `read` is directly callable again.
   */
  let skillsSectionInjected = false;
  const syncSkillsSection = (
    options: NormalizedBuildSystemPromptOptions | undefined,
    hidden: boolean,
  ): void => {
    if (options === undefined) return;
    if (!mode.enabled || !hidden) {
      if (skillsSectionInjected) {
        delete options.sections.skills;
        skillsSectionInjected = false;
      }
      return;
    }
    const section = buildPtcSkillsSection(options.skills);
    if (section.length === 0) return;
    options.sections.skills = section;
    skillsSectionInjected = true;
  };

  /**
   * Put the dispatch section in the system prompt — how to reach a child, on this surface.
   *
   * The same seam the skills section uses, for the same reason: a tool's own description only
   * reaches the model while that tool is offered to it, and on the `subagents` surface the pair
   * that carries the calling convention is not offered. Measured 2026-10-20: a parent on that
   * surface had no way to learn the convention, wrote `await tools["pi.dispatch"]` into a
   * `codemode` script, and got `TypeError: tools.pi.dispatch does not exist`.
   *
   * **Written on every turn, and removed when there is nothing to say.** The options object is
   * reused across turns, so a section written for one surface must not outlive the surface it was
   * written for; the removal is the same one `syncSkillsSection` does.
   */
  const syncDispatchSection = (options: NormalizedBuildSystemPromptOptions | undefined): void => {
    if (options === undefined) return;
    const section = buildDispatchSection({
      surfaceMode: surface.surfaceMode,
      childCanSearch: searchConfig.enabled,
      dispatchEnabled,
    });
    if (section.length === 0) {
      delete options.sections[DISPATCH_SECTION_NAME];
      return;
    }
    options.sections[DISPATCH_SECTION_NAME] = section;
  };

  pi.on("before_agent_start", async (event, ctx) => {
    // A live pi always supplies these; the test stub emits a bare event, hence the undefined case.
    const options = event.systemPromptOptions;
    syncSkillsSection(options, skillsSectionDropped(pi.getActiveTools()));
    syncDispatchSection(options);
    if (!mode.enabled) return;
    if (detectExternalLoadoutChange(mode, pi.getActiveTools())) {
      // Another extension owns the loadout now; hand it back rather than fight over it.
      exitMode(ctx, { announce: false, customType: PTC_MODE_ENTRY_TYPE });
      syncSkillsSection(options, skillsSectionDropped(pi.getActiveTools()));
      ctx.ui.notify("PTC mode off — another extension changed the active tool set.", "warning");
      return;
    }
    if (!briefingPending) return;
    briefingPending = false;
    return {
      message: {
        customType: "ptc-mode-briefing",
        content: buildModeInstruction(
          resolveBindingNames(mode.base, optInBindings),
          MODE_HIDE_STRATEGY,
          { childCanSearch: searchConfig.enabled },
        ),
        display: false,
      },
    };
  });

  /**
   * ADR-0043: the `why` decision THIS SESSION made, or `undefined` while `ptc.json` still owns it.
   *
   * Session scope is the whole contract, not an implementation detail: the value lives in a session
   * entry and never in the config file, so a new session starts from `ptc.json` again. That is the
   * line between `/ptc why off` and hand-editing `"whyEnabled"` -- one decides about this
   * conversation, the other about every future one -- and it is why nothing below opens the file.
   *
   * Held beside its only two accessors rather than beside the load-time `whyConfig` it shadows,
   * because those two are the whole surface of this switch and a reader has to see them together
   * to check they agree.
   */
  let whySession: boolean | undefined;

  /**
   * Restore this session's `why` record over the value `readWhyEnabledConfig` produced, at
   * `session_start`.
   *
   * The same standing a `/ptc off` record has over `defaultMode` (see the `wantMode` line the
   * caller reads): the user's most recent explicit intent about THIS session outranks the file, and
   * "most recent" is why {@link readPersistedWhy} scans backwards -- `/ptc why on` after
   * `/ptc why off` leaves two entries and the second one is the one that counts.
   *
   * Silent when there is no record, because there is nothing to reconcile: `ptc.json` already
   * decided, and a notice about a switch the user never touched is the crying wolf the
   * `surfaceMode` notice above is careful not to be.
   */
  function applyPersistedWhy(ctx: ExtensionContext): void {
    const persisted = readPersistedWhy(ctx);
    if (persisted === undefined) return;
    whySession = persisted.enabled;
    // The same object `getDispatchDeps` hands all three fronts, mutated rather than replaced --
    // `background.dispatchDeps` is readonly, and it is read per dispatch, so this is the one write
    // that reaches the next dispatch without an extension reload.
    background.dispatchDeps.whyEnabled = persisted.enabled;
  }

  /**
   * The last `why` record in this session, or `undefined` when it has none.
   *
   * Backwards, for the reason `readPersistedMode` scans backwards: the LAST record is the user's
   * most recent intent, and a forward scan would answer with the first one they ever made.
   *
   * **A malformed `enabled` is not a record at all**, so it is skipped and the scan continues —
   * the same rule `readWhyEnabledConfig` applies to a malformed `whyEnabled` in the config file,
   * and for the same reason: the safe direction is the one that cannot silently take the feature
   * away, and a reader that resolved `"true"` or a missing payload to `false` would remove the
   * block for a session that never asked for that. Skipping rather than defaulting also leaves the
   * PROVENANCE honest: when no readable record exists, `ptc.json` governs and the query says so,
   * instead of a record nobody could read claiming to be the source.
   *
   * An earlier draft read this as `data?.enabled === true`, which resolves every non-`true` value
   * — `"true"`, `1`, a missing key — to OFF, on the grounds that `readPersistedMode` does the same
   * for the mode record. That is the wrong precedent: it copies a decision made for a DIFFERENT
   * switch, whose failure mode was never argued on this axis, and it inverts the one principle
   * this switch was built on.
   */
  function readPersistedWhy(ctx: ExtensionContext): { enabled: boolean } | undefined {
    const entries = ctx.sessionManager.getEntries();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry?.type !== "custom" || entry.customType !== PTC_WHY_ENTRY_TYPE) continue;
      const enabled = (entry.data as { enabled?: unknown } | undefined)?.enabled;
      // Not `return { enabled: true }`: a record we cannot read is not a weaker version of an
      // instruction, it is the absence of one, and the file's value stands.
      if (typeof enabled !== "boolean") continue;
      return { enabled };
    }
    return undefined;
  }

  /**
   * One sentence describing the switch, used by BOTH the toggles and the bare query.
   *
   * One formatter because a user who runs `/ptc why off` and then `/ptc why` has to read the same
   * state described the same way, and two formatters for one fact is how they come to disagree.
   *
   * The source is half the sentence rather than a footnote: after `/ptc why off` the file still
   * says what it always said, so a user who opens `ptc.json` to find out why this session behaves
   * differently is looking at the wrong file unless the report says which one is in force.
   */
  function whyReport(enabled: boolean, source: "session" | "config"): string {
    return [
      `The dispatch \`why\` block is ${enabled ? "ON" : "OFF"}`,
      source === "session" ? "(set by this session)" : "(set by ptc.json)",
      enabled
        ? "-- a dispatched child receives your reason. Run /ptc why off to stop handing it over."
        : "-- a dispatched child does not receive your reason. Run /ptc why on to hand it over.",
    ].join(" ");
  }

  /**
   * `/ptc why [on|off]` -- ADR-0043's session switch, and the only thing it touches.
   *
   * Three properties a one-line `deps.whyEnabled = x` would each get wrong, which is why they are
   * three lines here:
   *
   *   1. **Effective for the NEXT dispatch.** `background.dispatchDeps` is the single object every
   *      dispatch front reads, so assigning there is what makes this take effect before the user's
   *      next turn rather than at the next extension load.
   *   2. **Durable for the session.** `pi.appendEntry` is the whole persistence, and it is the same
   *      call `exitMode` makes: a session record survives a `/reload` and a resume, so the flag does
   *      not silently lapse when the user reloads an extension.
   *   3. **Nothing else.** No file is written, PTC mode is not touched, and an argument that is
   *      not a value leaves every field above exactly as it was -- including the entry list, which
   *      is the part a "close enough" handler still appends to.
   *
   * Repeating the current value is a NO-OP rather than a second entry, and it still REPORTS rather
   * than warns: the entry would say what the file already says, and writing it would move the
   * reported source from `ptc.json` to this session without the user having changed anything. The
   * report is kept rather than replaced by a terser "already off" for the same reason `/ptc off`
   * does not need one -- `/ptc why` doubles as the query, so every branch answers the question.
   */
  function applyWhy(arg: string, ctx: ExtensionContext): void {
    const value = arg.trim().toLowerCase();
    const current = whySession ?? whyConfig.whyEnabled;
    const source: "session" | "config" = whySession === undefined ? "config" : "session";
    if (value === "") {
      ctx.ui.notify(whyReport(current, source), "info");
      return;
    }
    if (value !== "on" && value !== "off") {
      ctx.ui.notify(
        '/ptc why takes "on" or "off", or nothing at all to report the current value -- not ' +
          `"${arg.trim()}". Nothing changed.`,
        "warning",
      );
      return;
    }
    const enabled = value === "on";
    if (current === enabled) {
      ctx.ui.notify(whyReport(enabled, source), "info");
      return;
    }
    whySession = enabled;
    background.dispatchDeps.whyEnabled = enabled;
    pi.appendEntry(PTC_WHY_ENTRY_TYPE, { enabled });
    ctx.ui.notify(whyReport(enabled, "session"), "info");
  }
}

/**
 * `customType` for this session's `why` record (`pi.appendEntry`).
 *
 * Separate from `PTC_MODE_ENTRY_TYPE` and it has to be: both readers scan the SAME entry list
 * backwards for their own type, so a shared one would let `/ptc why off` restore as a mode record
 * on the next `session_start` -- and `/ptc off` restore as a `why` decision. Two entry types, two
 * independent switches, and neither recoverable as the other.
 *
 * Declared here rather than beside `PTC_MODE_ENTRY_TYPE` in `src/mode/ptc-mode.ts` because that
 * module is PTC MODE's state machine; this switch has nothing to say about the loadout, and
 * everything it touches lives in this file.
 */
export const PTC_WHY_ENTRY_TYPE = "ptc-why";

/**
 * `customType` for this session's dispatch record (`pi.appendEntry`).
 *
 * ADR-0050. Separate from `PTC_MODE_ENTRY_TYPE` for the same reason `PTC_WHY_ENTRY_TYPE` is:
 * both readers scan the SAME entry list backwards for their own type, so a shared one would let
 * one switch restore as another. The narrowing and the dispatch switch are two switches — the
 * `subagents` surface never narrows at all, and still dispatches — and neither is recoverable
 * as the other.
 *
 * Declared here rather than beside `PTC_MODE_ENTRY_TYPE` in `src/mode/ptc-mode.ts` because that
 * module is PTC MODE's state machine; this switch is about what this session may start, and it
 * has nothing to say about the loadout.
 */
export const PTC_DISPATCH_ENTRY_TYPE = "ptc-dispatch";
