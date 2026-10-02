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
  ExtensionCommandContext,
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
  FALLBACK_SURFACE_MODE,
  initialModeState,
  PTC_MODE_CONFIG_FILE,
  PTC_MODE_ENTRY_TYPE,
  PTC_MODE_STATUS_KEY,
  readDefaultModeConfig,
  readSurfaceModeConfig,
  resolveBaseOnStart,
  setSurfaceMode,
  surfaceModeConflict,
  SURFACE_MODES,
} from "./mode/ptc-mode.ts";
import type {
  CodemodePresence,
  CodemodeSwitchResolution,
  ModeHideStrategy,
  PersistedModeState,
  SurfaceMode,
} from "./mode/ptc-mode.ts";
import { buildPtcSkillsSection, skillsSectionDropped } from "./mode/skills-section.ts";
import { createPtcSubagentTool } from "./tools/subagent.ts";

export {
  bindingSource,
  buildModeInstruction,
  decideModeEntry,
  DEFAULT_HIDE_STRATEGY,
  detectExternalLoadoutChange,
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
  readSurfaceModeConfig,
  resolveBaseOnStart,
  resolveCodemodeActivation,
  resolveCodemodeSwitch,
  sameToolSet,
  setSurfaceMode,
  surfaceModeConflict,
  SURFACE_MODES,
} from "./mode/ptc-mode.ts";
export type {
  CodemodePresence,
  CodemodeSwitch,
  CodemodeSwitchResolution,
  CodemodeSwitchSource,
  DefaultModeConfig,
  ModeBlockReason,
  ModeEntryDecision,
  ModeEntryInput,
  ModeHideStrategy,
  PersistedModeState,
  PtcModeState,
  SurfaceModeConfig,
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
   * Test seam for ADR-0025's surface mode. When set it wins over the agent-dir `ptc.json`,
   * so a test never reads the developer's real settings -- and the four test files that all
   * build this factory through one stub would otherwise inherit whatever the machine happens
   * to have. Undefined in production, where the file is the only source.
   */
  surfaceMode?: SurfaceMode;
  /**
   * ADR-0026 test seam: what the codemode probe found. Undefined in production, where the
   * probe really runs. A test that exercises the DETECTED default states the pi it
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
}

export default function ptcSubagents(pi: ExtensionAPI, options: PtcSubagentsOptions = {}): void {
  const mode = initialModeState();

  /**
   * ADR-0025: which model-facing tools this package registers, read ONCE here so the
   * `registerTool` calls below can act on it. Reading it later would mean the tools already
   * exist when the setting arrives, and the only way to honour the setting would be to
   * unregister - which pi has no call for. A malformed value falls back to the DETECTED default,
   * not to a constant (ADR-0026 decision 5) -- on a pi that ships codemode that means
   * `subagents`, not `full` -- and is reported at session start, not silently applied.
   *
   * The seam branch pins the surface outright, so it carries no `codemode`: a caller that named
   * a surface never asked the pi anything, so there is no probe result to report. That is what
   * makes `surface.codemode !== undefined` the exact test for "the surface was detected" below.
   */
  // ADR-0026 reads the surface once, here, because registration has to happen in the factory and
  // `cwd` only matters for the `!` bucket's globs. It is left at its `process.cwd()` default
  // deliberately: that is the directory pi's own `DefaultPackageManager` resolves project-scope
  // globs against for a session launched from a shell, and the one case where the two can differ —
  // an SDK embedder passing an explicit `cwd` — is recorded in ADR-0027 as a known limit rather
  // than papered over by threading a value an extension cannot observe.
  const surface =
    options.surfaceMode === undefined
      ? readSurfaceModeConfig(getAgentDir(), options.codemode, options.codemodeSwitch)
      : { surfaceMode: options.surfaceMode, source: "file" as const };
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

  /**
   * ADR-0025 `off`: the user asked for a stock pi session, so this package does nothing at
   * all. Returning HERE, before the background runtime is built, is the whole point -- an
   * "off" that still registered handlers and merely injected an empty section would be off in
   * name only. Everything below this line is unreachable in that mode, and the test asserts it
   * by looking for the absence of every handler rather than at any output.
   */
  if (surface.surfaceMode === "off") return;

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
   * ADR-0025: the orchestration surface. In `off` and `subagents` these two do not exist,
   * so the model is told about exactly one way to compose tool calls -- ours, or pi's
   * `codemode`. Registering both and letting the model choose per request is the duplicate
   * surface this setting exists to remove.
   */
  if (surface.surfaceMode === "full") {
    pi.registerTool(
      createPtcRunCodeTool({
        getBindingSourceNames,
        getPool: () => turnPools.get("run_code"),
        depth: ptcDepth,
        ...(parentTaskId === undefined ? {} : { parentTaskId }),
        getDispatchDeps: () => background.dispatchDeps,
      }),
    );
    pi.registerTool(
      createPtcWorkflowTool({
        getBindingSourceNames,
        getPool: () => turnPools.get("workflow"),
        depth: ptcDepth,
        ...(parentTaskId === undefined ? {} : { parentTaskId }),
        getDispatchDeps: () => background.dispatchDeps,
      }),
    );
  }

  /*
   * ADR-0025 `subagents`: the top-level subagent face, registered only here. It is the reason
   * this mode exists -- `pi.dispatch` lives inside a program, so without it a session that
   * hands orchestration to `codemode` would have no way to start a subagent at all.
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

  pi.on("turn_start", async () => {
    turnActive = true;
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

  /**
   * `/ptc surface [off|subagents|full]`.
   *
   * The surface is read once, in the factory, and pi has no `unregisterTool` — so a change cannot
   * take effect in the running session. What CAN take effect is a reload, and that is pi's own
   * `/reload`: `DefaultResourceLoader.reload()` calls `clearExtensionCache()`
   * (`resource-loader.js:353`) and re-runs every factory, and `AgentSession.reload()`
   * (`agent-session.js:2899`) then rebuilds the runner and re-emits `session_start` with reason
   * `reload` — which is precisely the moment the surface is decided. `ctx.reload()` is the same
   * path from inside an extension, so the user does not have to type a second command.
   *
   * The notification is emitted BEFORE the reload, never after: `ctx.reload()` invalidates this
   * command context (`runner.js:482` says so in as many words), so anything read from `ctx`
   * afterwards is stale by contract rather than by accident.
   */
  const handleSurfaceCommand = async (
    value: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> => {
    const agentDir = getAgentDir();
    if (value === "") {
      const current = readSurfaceModeConfig(agentDir);
      const detected =
        current.detected === undefined || current.detected === current.surfaceMode
          ? ""
          : " (detection would say " + JSON.stringify(current.detected) + ")";
      ctx.ui.notify(
        "Extension surface: " +
          JSON.stringify(current.surfaceMode) +
          ", from " +
          current.source +
          detected +
          ". Set it with /ptc surface " +
          SURFACE_MODES.join("|") +
          "; the change needs a reload, which this command performs.",
        "info",
      );
      return;
    }

    const written = setSurfaceMode(agentDir, value);
    if (!written.ok) {
      ctx.ui.notify("pi-ptc-subagents: " + written.error + ". Nothing was changed.", "warning");
      return;
    }
    if (!written.changed) {
      ctx.ui.notify(
        "The surface is already " + JSON.stringify(value) + " — nothing written, nothing reloaded.",
        "info",
      );
      return;
    }

    const lines = [
      "Surface " +
        (written.previous === undefined
          ? "(unset, so detected)"
          : JSON.stringify(written.previous)) +
        " → " +
        JSON.stringify(value) +
        " in " +
        written.path +
        ". Reloading so it takes effect now.",
    ];
    // Said before the reload, and only when it is true: the mode needs ptc_run_code or
    // ptc_workflow to enter at all (`decideModeEntry` policy 3), so a `subagents` or `off`
    // surface ends a running mode rather than carrying it across.
    if (mode.enabled && value !== "full") {
      lines.push("PTC mode was ON and cannot survive this surface — run /ptc on afterwards.");
    }
    if (value === "subagents") {
      lines.push(
        "subagents hands orchestration to pi's codemode, so it needs codemode in this session's " +
          "tool list; if it is not there the startup warning will say so.",
      );
    }
    ctx.ui.notify(lines.join("\n"), "info");
    await ctx.reload();
  };

  pi.registerCommand("ptc", {
    description:
      "Show or toggle PTC mode, or set the extension surface (/ptc surface off|subagents|full)",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action === "surface" || action.startsWith("surface ")) {
        await handleSurfaceCommand(action.slice("surface".length).trim(), ctx);
        return;
      }
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
    // The surface mode is read in the factory body, before there is a ctx to notify through, so
    // its problem is reported here rather than dropped. Both readers parse the SAME file, so an
    // unparseable one produces the same sentence twice -- which reads as two problems when it is
    // one. Report the surface error only when it says something the mode error did not.
    if (surface.error !== undefined && surface.error !== config.error) {
      ctx.ui.notify(`pi-ptc-subagents: ${surface.error}`, "warning");
    }

    /*
     * ADR-0026: the surface was NOT read from the file, so it was DETECTED -- and a detection
     * that silently came back false is the one failure mode that design has. A pi that
     * restructures its `dist` makes the probe return `not-found`, the default quietly becomes
     * `full`, and the user gets zero diagnostics. This is the only reader of
     * `surface.codemode` in the package, and it is what makes the field carried there real
     * rather than decorative.
     *
     * `!detected.present` is exactly "the probe could not answer". The healthy case -- probe
     * found codemode, `detectedSurfaceMode` turned that into `subagents` -- is what a modern
     * pi should resolve to, and a notice on every one of those sessions would be noise, so it
     * never reaches here. What is left is a probe with a `how` to report, and naming it is the
     * point: "pi restructured" is then distinguishable from "no pi next to argv[1]" from a shim
     * that would not resolve.
     *
     * `info`, not `warning`: a pi that genuinely ships no codemode lands here too, and
     * `full` is the right answer for it, so a warning on every one of those sessions would be
     * crying wolf. The line states the two things that are actually true -- how the probe came
     * out, and what the default therefore is -- and points at the one line of JSON that makes
     * the answer deterministic whatever the pi does.
     *
     * TUI-only, like every other notice in this file: `ctx.ui.notify` emits nothing in
     * `--print`, so a scripted session that detected `full` gets no line at all. ADR-0025
     * records that as a known limitation of the surface-mode warnings.
     */
    const detected = surface.codemode;
    if (detected !== undefined && !detected.present) {
      ctx.ui.notify(
        "pi-ptc-subagents: no surfaceMode is set, and the codemode probe reported " +
          detected.how +
          ", so the surface defaults to " +
          FALLBACK_SURFACE_MODE +
          ". That is the safe direction, not an error. If this pi really does ship pi's own " +
          'codemode, set "surfaceMode" in ' +
          PTC_MODE_CONFIG_FILE +
          " -- an explicit key always wins over detection.",
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
     * ADR-0027: the explicit key WINS -- that is what an override is for -- so this only
     * reports. The case worth a warning is the one where the two disagree about who
     * orchestrates: a user who disabled pi's codemode and pinned `surfaceMode: "subagents"`
     * has asked for a surface that assumes an orchestrator which is not loaded, and will
     * find `ptc_run_code` missing with nothing to replace it.
     *
     * `info`, not `warning`: the pinned value was honoured, so nothing is broken. `off` never
     * reaches here (see `surfaceModeConflict`), and agreeing values never reach here either.
     */
    if (
      surface.source === "file" &&
      surface.detected !== undefined &&
      surfaceModeConflict(surface.surfaceMode, surface.detected)
    ) {
      const sw = surface.codemodeSwitch;
      ctx.ui.notify(
        "pi-ptc-subagents: surfaceMode is pinned to " +
          JSON.stringify(surface.surfaceMode) +
          ", but this pi resolves to " +
          JSON.stringify(surface.detected) +
          (sw === undefined
            ? ""
            : " (pi's codemode is on disk and its switch is " + sw.switch + ")") +
          ". The pinned value is in force. Change it in " +
          PTC_MODE_CONFIG_FILE +
          " if that is not what you meant.",
        "info",
      );
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
     * compared. `source === "file"` means the user decided, so their answer stands even if it is
     * the wrong one for this session.
     */
    if (detected !== undefined && surface.source !== "file") {
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
            ", and your model is being offered two orchestration tools. Set an explicit " +
            '"surfaceMode" in ' +
            PTC_MODE_CONFIG_FILE +
            " to pick one.",
          "warning",
        );
      }
      if (detected.present && !known) {
        /*
         * ADR-0029: the surface is REPORTED, not spelled out, and the value reported is
         * `surface.surfaceMode` rather than `surface.detected`.
         *
         * Two reasons, both of which the previous hard-coded `"subagents"` got wrong. With the
         * activation axis added, the detected surface is not always `subagents` in this branch --
         * activation can be predicted `active` from a project `defaultTools` that pi then ignored
         * because the project is untrusted (`settings-manager.js:327`), and the table answers
         * `full` there. And `SurfaceModeConfig.detected` is populated only on the `source: "file"`
         * path, which this branch is explicitly not, so reading it would print `undefined`.
         */
        ctx.ui.notify(
          "pi-ptc-subagents: the codemode probe found pi's codemode on disk, but this " +
            "session does not register it (--no-extensions or --exclude-tools codemode), so " +
            "the surface is " +
            JSON.stringify(surface.surfaceMode) +
            (surface.surfaceMode === "subagents"
              ? " with no orchestrator. Set " +
                JSON.stringify("surfaceMode") +
                " to " +
                JSON.stringify(FALLBACK_SURFACE_MODE) +
                " in " +
                PTC_MODE_CONFIG_FILE +
                " to use ptc_run_code instead."
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
      ctx.ui.notify(
        "pi-ptc-subagents: surfaceMode is subagents, but codemode is not active in this " +
          "session, so there is no orchestration tool. Add codemode to your pi tool list " +
          '(the --tools flag or the default tools setting), or set surfaceMode to "full" to ' +
          "use ptc_run_code instead.",
        "warning",
      );
    }

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
