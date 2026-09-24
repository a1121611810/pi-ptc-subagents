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
import { resolveBindingNames, resolveDepthFromEnv } from "./tools/common.ts";
import { TurnPools } from "./runtime/turn-pools.ts";
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
  initialModeState,
  PTC_MODE_ENTRY_TYPE,
  PTC_MODE_STATUS_KEY,
  readDefaultModeConfig,
  resolveBaseOnStart,
} from "./mode/ptc-mode.ts";
import type { ModeHideStrategy, PersistedModeState } from "./mode/ptc-mode.ts";
import { buildPtcSkillsSection, skillsSectionDropped } from "./mode/skills-section.ts";

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
  readDefaultModeConfig,
  resolveBaseOnStart,
  sameToolSet,
} from "./mode/ptc-mode.ts";
export type {
  DefaultModeConfig,
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
}

export default function ptcSubagents(pi: ExtensionAPI, options: PtcSubagentsOptions = {}): void {
  const mode = initialModeState();
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

  /* ------------------------ BG-14: session-scoped background runtime ------------------------ */

  /**
   * Created ONCE, before any session; the session delegate is swapped by `bindSession` on
   * `session_start`. The three `ptc_task_*` tools and the two PTC surfaces capture its stable
   * delegates, so they never have to be re-registered. This factory body creates objects only —
   * `pi.*` is never called here (R2); the delivery below runs from event handlers.
   */
  const background: BackgroundTaskRuntime =
    options.backgroundRuntime ?? createBackgroundTaskRuntime();

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

  /** Drain one subscriber's undelivered events, keep the completions, render + send. */
  const deliverSubscriber = async (subscriberId: ULID): Promise<void> => {
    const items = await background.drainNotifications(subscriberId);
    // ADR-0022 §8 "谁停谁报告": canceled tasks are suppressed (BG-15 owns the policy).
    const deliverable = items.filter((item) => shouldDeliverTaskNotification(item.record));
    if (deliverable.length === 0) return;
    for (const batch of splitTaskNotificationBatches(deliverable)) {
      sendBatch(
        renderTaskNotifications(batch, {
          batchId: createULID(),
          deliveredAtMs: background.clock(),
        }),
      );
    }
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

  pi.registerTool(
    createPtcRunCodeTool({
      getBindingSourceNames,
      getPool: () => turnPools.get("run_code"),
      depth: ptcDepth,
      getDispatchDeps: () => background.dispatchDeps,
    }),
  );
  pi.registerTool(
    createPtcWorkflowTool({
      getBindingSourceNames,
      getPool: () => turnPools.get("workflow"),
      depth: ptcDepth,
      getDispatchDeps: () => background.dispatchDeps,
    }),
  );

  /*
   * Always-on management tools (ADR-0022 "What we add" #6): registered at factory time, OUTSIDE
   * the PTC mode loadout. `/ptc off` only gates new spawns; it must never hide the lifecycle face
   * of in-flight tasks. The mode's `modeLoadout` keeps non-built-in names, so these survive both
   * entry and exit (proved in tests/unit/extension-background.test.ts).
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

  pi.registerCommand("ptc", {
    description:
      "Show or toggle PTC mode (built-in tools reachable only from inside a PTC program)",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
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
