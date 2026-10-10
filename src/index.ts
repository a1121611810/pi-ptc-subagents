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
import type {
  ExtensionAPI,
  ExtensionContext,
  NormalizedBuildSystemPromptOptions,
} from "@earendil-works/pi-coding-agent";
import { createPtcRunCodeTool } from "./tools/run-code.ts";
import { createPtcWorkflowTool } from "./tools/workflow.ts";
import {
  createPtcTaskListTool,
  createPtcTaskOutputTool,
  createPtcTaskStopTool,
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
  resolveBaseOnStart,
} from "./mode/ptc-mode.ts";
import type {
  CodemodeActivationResolution,
  CodemodePresence,
  CodemodeSwitchResolution,
  ModeHideStrategy,
  PersistedModeState,
} from "./mode/ptc-mode.ts";
import { buildPtcSkillsSection, skillsSectionDropped } from "./mode/skills-section.ts";
import { createPtcSubagentTool } from "./tools/subagent.ts";
import { createChildReportTool } from "./tools/child-report-tool.ts";

export {
  bindingSource,
  buildModeInstruction,
  cliToolFlags,
  decideModeEntry,
  DEFAULT_HIDE_STRATEGY,
  detectExternalLoadoutChange,
  detectSurfaceMode,
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
  PersistedModeState,
  PtcModeState,
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
function describeEntry(base: readonly string[], hide: ModeHideStrategy): string {
  const hidden =
    hide === "all-but-ptc"
      ? "all other tools"
      : "built-in tools (now reachable only as tools.<name> inside a program)";
  return [
    `PTC mode on — ${hidden} hidden.`,
    `Bindings available inside a program: ${resolveBindingNames(base).join(", ") || "(none)"}.`,
    "Run /ptc off to restore the normal tool set.",
  ].join("\n");
}

export {
  BUILTIN_BINDING_NAMES,
  createBuiltinBindings,
  DEFAULT_BINDING_NAMES,
} from "./runtime/bindings.ts";
export type {
  Binding,
  BindingContext,
  BindingTable,
  CreateBuiltinBindingsOptions,
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
   * production, where `readCodemodeActivation` reads pi's real settings files AND this
   * process's `argv`.
   *
   * This seam exists because the `surfaceMode` pin it replaced did. That pin was there to keep a
   * test off the developer's machine: the activation probe reads `defaultTools` out of
   * `~/.pi/agent/settings.json`, so a test file that pins nothing decides its own surface by
   * however the machine running it happens to be configured. Removing the pin without adding this
   * would have moved that failure back in, silently, to every stub-built factory.
   */
  codemodeActivation?: CodemodeActivationResolution;
}

export default function ptcSubagents(pi: ExtensionAPI, options: PtcSubagentsOptions = {}): void {
  const mode = initialModeState();

  /**
   * ADR-0026: which model-facing tools this package registers, read ONCE here so the
   * `registerTool` calls below can act on it. Reading it later would mean the tools already
   * exist when the answer arrives, and the only way to honour a different one would be to
   * unregister - which pi has no call for. It is DETECTED, never read from a setting: there is
   * no `surfaceMode` key and no way to pin a surface, so the only question is what this pi is.
   * See `detectSurfaceMode` for why the escape hatch that used to be here is not one this
   * package can replace.
   *
   * The result is a function of three probes rather than of a file, which is what makes
   * `surface.codemode !== undefined` no longer a test for "was this detected" -- it is always
   * defined. The reporting below reads each probe directly instead.
   */
  // ADR-0026 reads the surface once, here, because registration has to happen in the factory and
  // `cwd` only matters for the `!` bucket's globs. It is left at its `process.cwd()` default
  // deliberately: that is the directory pi's own `DefaultPackageManager` resolves project-scope
  // globs against for a session launched from a shell, and the one case where the two can differ —
  // an SDK embedder passing an explicit `cwd` — is recorded in ADR-0027 as a known limit rather
  // than papered over by threading a value an extension cannot observe.
  const surface = detectSurfaceMode(
    getAgentDir(),
    options.codemode,
    options.codemodeSwitch,
    options.codemodeActivation,
  );
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
    createBackgroundTaskRuntime({ concurrency: resolveConfig({}).dispatchConcurrency });

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

  /*
   * ADR-0025: the orchestration surface. `off` returns above, so it never reaches here.
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
  if (surface.surfaceMode === "full" || surface.surfaceMode === "subagents") {
    // `full` orchestrates itself and declares the tools; `subagents` hands composition to pi's
    // `codemode` and offers these as its execution layer.
    const programmingToolExposure = surface.surfaceMode === "full" ? "direct" : "codemode";
    pi.registerTool(
      createPtcRunCodeTool({
        getBindingSourceNames,
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
  if (surface.surfaceMode === "subagents") {
    pi.registerTool(
      createPtcSubagentTool({
        cwd: process.cwd(),
        depth: ptcDepth,
        maxDispatchDepth: DEFAULT_CONFIG.maxDispatchDepth,
        ...(parentTaskId === undefined ? {} : { parentTaskId }),
        getDispatchDeps: () => background.dispatchDeps,
      }),
    );
  }

  /*
   * Always-on management tools (ADR-0022 "What we add" #6): registered at factory time, OUTSIDE
   * the PTC mode loadout. `/ptc off` only gates new spawns; it must never hide the lifecycle face
   * of in-flight tasks. The mode's `modeLoadout` keeps non-built-in names, so these survive both
   * entry and exit (proved in tests/unit/extension-background.test.ts).
   *
   * ADR-0025: unconditional from here on. The one mode that would not keep this face, `off`,
   * has already returned at the top of the factory, so "always-on" stays literally true for
   * every mode that reaches this line -- including `subagents`, where a task spawned through
   * the top-level subagent tool is inspectable exactly the same way.
   */
  pi.registerTool(createPtcTaskListTool(background.registry));
  pi.registerTool(createPtcTaskOutputTool(background.registry, background.outputStorage));
  pi.registerTool(
    createPtcTaskStopTool(background.registry, background.lifecycle, { clock: background.clock }),
  );

  /*
   * ADR-0032's report tool (ticket #101). Registered here, after the `off` early return, so it
   * exists in every surface that has one — but ACTIVE only where it has a caller.
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

  const paintStatus = (ctx: ExtensionContext): void => {
    ctx.ui.setStatus(
      PTC_MODE_STATUS_KEY,
      mode.enabled ? ctx.ui.theme.fg("accent", MODE_STATUS_TEXT) : undefined,
    );
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
      ctx.ui.notify("PTC mode off — built-in tools are directly callable again.", "info");
    }
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

  pi.registerCommand("ptc", {
    description: "Show or toggle PTC mode",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      // NOTE: `/ptc off` below turns PTC MODE off, which is unrelated to the extension surface.
      // The `surface` subcommand that used to sit here went with the `surfaceMode` setting; there
      // is no surface to set, and the surface in force is reported at `session_start`.
      if (action === "off") {
        if (!mode.enabled) {
          ctx.ui.notify("PTC mode is already off.", "info");
          return;
        }
        exitMode(ctx, { announce: true, customType: PTC_MODE_ENTRY_TYPE });
        return;
      }
      if (action !== "on") {
        ctx.ui.notify(
          mode.enabled
            ? `PTC mode is ON — run /ptc off to restore built-in tools.\nBindings: ${resolveBindingNames(mode.base).join(", ") || "(none)"}`
            : "PTC mode is OFF — run /ptc on to enter it.",
          "info",
        );
        return;
      }
      if (mode.enabled) {
        ctx.ui.notify("PTC mode is already on.", "info");
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
        ctx.ui.notify(
          decision.reason === "tools-unavailable"
            ? "Cannot enter PTC mode: ptc_run_code / ptc_workflow are not active in this session."
            : "Cannot enter PTC mode in this run mode.",
          "warning",
        );
        return;
      }
      enterMode(
        decision.base,
        decision.loadout,
        ctx,
        describeEntry(decision.base, MODE_HIDE_STRATEGY),
      );
    },
  });

  pi.on("session_start", async (_event, ctx) => {
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

    const config = readDefaultModeConfig(getAgentDir());
    if (config.error !== undefined) {
      ctx.ui.notify(`pi-ptc-subagents: ${config.error}`, "warning");
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
     * ADR-0027: a settings file we could not read is reported the same way a broken `ptc.json`
     * is -- as a warning that names the file -- rather than being allowed to change which
     * tools exist silently. The switch it describes has already fallen through to the next
     * source by the time this runs.
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
         * The mirror, and round 4 caught that only the over-estimate was handled. The probe is a
         * filesystem guess, so it fails in BOTH directions: a pi that restructures its `dist`, or a
         * layout no candidate covers, answers `not-found` while pi plainly registers codemode. The
         * session then registers `ptc_run_code` AND `ptc_workflow` beside a live codemode -- the
         * duplicate model-facing surface this whole setting exists to remove -- and the `info`
         * notice above calls that "the safe direction, not an error", which is the opposite of what
         * the user just got. `known` is the registry's own answer and it costs one line to use.
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
         * What can put a session in the `subagents` half of this branch was measured rather than
         * reasoned about, and the answer is narrower than the comment that used to stand here.
         * That comment claimed the table answers `full` when a project `defaultTools` names
         * `codemode` and pi ignored the project because it was untrusted. It does not:
         * `readSettingsObject` reads `.pi/settings.json` with no trust check, so this package sees
         * `active` and picks `subagents` exactly as it would have if the project were trusted.
         * Measured on pi 1.1.0 with a project-only `defaultTools: ["+codemode"]`: `-na` gives
         * `codemodeActive: false` while this package has chosen `subagents`, and `-a` gives
         * `codemodeActive: true` with the same choice. That is the residual wrong-way answer, and
         * it is why the advice below names ways to make `codemode` callable rather than a setting
         * in this package: there is no setting here any more.
         *
         * The two flags this branch used to name no longer describe it either. `--exclude-tools
         * codemode` IS read now (`cliToolFlags`), so it resolves to `inactive` and the table answers
         * `full` before reaching here — which is what the real-pi runs show. `--no-extensions` is
         * still the case that lands here with `codemode` on disk and unregistered.
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
    const wantMode = persisted?.enabled ?? decision.enter;

    if (decision.enter && wantMode) {
      enterMode(base, decision.loadout, ctx, describeEntry(base, MODE_HIDE_STRATEGY));
      return;
    }
    paintStatus(ctx);
    if (!decision.enter && decision.reason !== "not-tui" && persisted === undefined) {
      if (decision.reason === "restricted-session") {
        ctx.ui.notify(
          "PTC mode skipped: this session was launched with an explicit tool restriction.",
          "info",
        );
      }
    }
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

  pi.on("before_agent_start", async (event, ctx) => {
    // A live pi always supplies these; the test stub emits a bare event, hence the undefined case.
    const options = event.systemPromptOptions;
    syncSkillsSection(options, skillsSectionDropped(pi.getActiveTools()));
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
        content: buildModeInstruction(resolveBindingNames(mode.base), MODE_HIDE_STRATEGY),
        display: false,
      },
    };
  });
}
