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
import { resolveBindingNames, resolveDepthFromEnv } from "./tools/common.ts";
import { TurnPools } from "./runtime/turn-pools.ts";
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

export default function ptcSubagents(pi: ExtensionAPI): void {
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

  pi.registerTool(
    createPtcRunCodeTool({
      getBindingSourceNames,
      getPool: () => turnPools.get("run_code"),
      depth: ptcDepth,
    }),
  );
  pi.registerTool(
    createPtcWorkflowTool({
      getBindingSourceNames,
      getPool: () => turnPools.get("workflow"),
      depth: ptcDepth,
    }),
  );

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
