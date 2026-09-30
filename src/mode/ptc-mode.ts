/**
 * PTC default mode — the session-level tool-restriction state machine.
 *
 * ## What "mode" means here
 *
 * While enabled, the session's visible tool loadout is narrowed so the model reaches
 * `read` / `bash` / `edit` / `write` / `grep` / `find` / `ls` only from *inside* a program
 * (`tools.<name>(args)`). That is DSH's PTC-preset shape, and it is what makes the mode visible
 * in the TUI: the transcript stops showing file-operation rows and shows PTC rows instead.
 *
 * The mode is decided per session (`session_start`), announced once, and always reversible.
 *
 * ## Why bindings need a base snapshot (the trap this module exists to avoid)
 *
 * `resolveBindingNames()` computes bindings as `BUILTIN_BINDING_NAMES ∩ pi.getActiveTools()`
 * (T7, ADR-0005 addendum). But `pi.getActiveTools()` reads the *live* loadout — the very set this
 * mode narrows. Hiding the built-ins therefore empties the binding table, and every
 * `tools.read(...)` fails with "not bound": the extension would neuter itself.
 *
 * The fix is a **base snapshot**. `base` is captured *before* the mode hides anything, and
 * bindings derive from `base` rather than the live loadout while the mode is on. T7's invariant
 * survives, because `base` is itself read from `pi.getActiveTools()`: a session launched with
 * `--tools read` has `base = ["read"]`, so bindings stay `["read"]`. The mode never widens access
 * beyond what the session was launched with — it only makes its **own** narrowing transparent to
 * the binding table.
 *
 * ## Fail-safe on external loadout changes
 *
 * Another extension can call `setActiveTools()` (pi's own `preset.ts` and `tools.ts` examples do).
 * `ourLoadout` records the exact array this mode wrote, so a mismatch means someone else owns the
 * loadout now. The mode then exits and restores `base` instead of fighting over it.
 *
 * ## Where the mode never runs
 *
 * Print / JSON / RPC sessions (`ctx.mode !== "tui"`) are left alone: forcing the shape on CI
 * scripts buys nothing and breaks them. A session that was *launched* with an explicit tool
 * restriction is left alone too — see `decideModeEntry`.
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { BUILTIN_BINDING_NAMES } from "../runtime/bindings.ts";

/** The two surfaces this package exposes. `/ptc on` needs at least one of them active. */
export const PTC_MODE_TOOL_NAMES: readonly string[] = ["ptc_run_code", "ptc_workflow"];

/**
 * Tools that must all be present for the **automatic** entry path to proceed.
 *
 * These four are pi's default session surface (`agent-session.js`: "["read", "bash", "edit",
 * "write"]"), so "all four present" means "this session was not narrowed". Comparing against
 * `BUILTIN_BINDING_NAMES` instead would be wrong: that list is the set of names that *can* be
 * bound, not what a default session has (`grep` / `find` / `ls` are bindable but off by default),
 * so requiring all seven would misread every ordinary session as restricted and never turn on.
 */
export const MODE_REQUIRED_TOOL_NAMES: readonly string[] = ["read", "bash", "edit", "write"];

/** `customType` for the persisted mode entry (`pi.appendEntry`). */
export const PTC_MODE_ENTRY_TYPE = "ptc-mode";

/** Footer status key (`ctx.ui.setStatus`). */
export const PTC_MODE_STATUS_KEY = "ptc-mode";

/** Config file name, resolved against pi's agent dir (`~/.pi/agent/`). */
export const PTC_MODE_CONFIG_FILE = "ptc.json";

/** How much of the loadout the mode hides. */
export type ModeHideStrategy = "builtins-only" | "all-but-ptc";

/**
 * Which tools the mode hides while it is on.
 *
 * - `"builtins-only"` (default) — hide the seven built-in tools; tools contributed by *other*
 *   extensions (`web_search`, `todo`, `subagent`, …) stay visible and directly callable. The
 *   model is forced to program for file and shell work, which is the bulk of a coding session,
 *   without losing capabilities this package cannot re-expose: extension tools have no bindings
 *   (`pi.getAllTools()` returns metadata only — no `execute`), so hiding one makes it
 *   unreachable for the whole session.
 * - `"all-but-ptc"` — hide everything except the two PTC surfaces. Closest to a strict reading of
 *   DSH's preset, at the cost of making other extensions' tools unreachable until `/ptc off`.
 */
export const DEFAULT_HIDE_STRATEGY: ModeHideStrategy = "builtins-only";

/** Live mode state. `base` / `ourLoadout` are `undefined` while the mode is off. */
export interface PtcModeState {
  enabled: boolean;
  /** Loadout captured before the mode narrowed anything; bindings derive from this. */
  base: readonly string[] | undefined;
  /** Exactly the array handed to `setActiveTools`; a mismatch means someone else changed it. */
  ourLoadout: readonly string[] | undefined;
}

/** Fresh, disabled state. */
export function initialModeState(): PtcModeState {
  return { enabled: false, base: undefined, ourLoadout: undefined };
}

/**
 * A persisted mode record lives in the session (`pi.appendEntry`), so `/ptc off` survives a
 * resume and a `/reload` can put the loadout back the way it found it.
 */
export interface PersistedModeState {
  enabled: boolean;
  base?: readonly string[];
}

// --------------------------------------------------------------------------------------
// Config: ~/.pi/agent/ptc.json  →  { "defaultMode": false }
// --------------------------------------------------------------------------------------

/** Result of reading the opt-out config, with enough detail to warn about a broken file. */
export interface DefaultModeConfig {
  defaultMode: boolean;
  source: "file" | "default" | "invalid";
  error?: string;
}

/**
 * Read `defaultMode` from the agent-dir config file.
 *
 * Absent file → on (this package is default-on by design; see CONTEXT.md). A present file with a
 * non-boolean `defaultMode`, or unparseable JSON, is reported as `invalid` **and still defaults to
 * on** — the caller should surface the problem rather than silently changing behavior.
 */
export function readDefaultModeConfig(agentDir: string): DefaultModeConfig {
  const path = join(agentDir, PTC_MODE_CONFIG_FILE);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { defaultMode: true, source: "default" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      defaultMode: true,
      source: "invalid",
      error: `${path} is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { defaultMode: true, source: "invalid", error: `${path} must contain a JSON object` };
  }
  const value = (parsed as { defaultMode?: unknown }).defaultMode;
  if (value === undefined) {
    return { defaultMode: true, source: "default" };
  }
  if (typeof value !== "boolean") {
    return {
      defaultMode: true,
      source: "invalid",
      error: `${path}: "defaultMode" must be a boolean, received ${typeof value}`,
    };
  }
  return { defaultMode: value, source: "file" };
}

/**
 * Which model-facing tools this package registers, independent of PTC mode (which decides
 * which registered tools are *active*). Read from the same agent-dir file as
 * {@link readDefaultModeConfig}, beside the `defaultMode` key. ADR-0025.
 *
 * The order below is the order of increasing responsibility: `off` hands the whole
 * orchestration question back to pi, `subagents` keeps only the subagent face and lets pi's
 * `codemode` orchestrate, `full` keeps today's set.
 */
export const SURFACE_MODES = ["off", "subagents", "full"] as const;
export type SurfaceMode = (typeof SURFACE_MODES)[number];

/**
 * Where a pi that could not be asked resolves to. Every way the probe can come back wrong -- no
 * argv, a shim that will not resolve, a pi packaged somewhere unguessable, a permission error --
 * lands here, and `full` is today's behaviour. `subagents` as a failure mode would silently take
 * away the orchestration tool a session was relying on, so the direction is the design
 * (ADR-0026 decision 3).
 *
 * Named rather than inlined at the one place that computes it, because `session_start` reports
 * the resolved value and two spellings of "the fallback" would be two things to drift.
 */
export const FALLBACK_SURFACE_MODE: SurfaceMode = "full";

/**
 * The surface to use when the user has expressed no preference. Not a constant: a pi that ships
 * `codemode` already offers the model a second way to orchestrate, and answering that by
 * handing our orchestration surface away is the whole point of `subagents` mode (ADR-0026).
 *
 * A probe that found codemode gets `subagents`; every other outcome gets
 * {@link FALLBACK_SURFACE_MODE}, for the reasons on that constant.
 */
export function detectedSurfaceMode(presence: CodemodePresence): SurfaceMode {
  return presence.present ? "subagents" : FALLBACK_SURFACE_MODE;
}

/**
 * Whether the pi that launched us ships its own `codemode` orchestration tool.
 *
 * pi's own tool listing is NOT usable here, and that is why this probe exists at all.
 * `getAllTools()` and `getActiveTools()` are `notInitialized` stubs until `bindCore` runs
 * (`loader.js:106-108`), which happens after every factory body has returned. Calling one from
 * a factory throws, and `initializeExtension` catches that throw while `loadExtension` answers
 * `{ extension: null, error }` (`loader.js:493-520`) -- a throwing factory makes the extension
 * fail to load entirely, not degrade to an empty tool list. Registration has to happen in the
 * factory, so the default has to be knowable there.
 *
 * Those line numbers are pi **0.99.1**'s `dist/core/extensions/loader.js`, read from a real
 * install, and that is the version this reasoning is about rather than the one this repo compiles
 * against: the 0.86.1 in `devDependencies` has the same two regions at 106-108 and 445-473.
 *
 * So this walks the filesystem from the entry script instead. `process.argv[1]` is whatever the
 * user typed, which for a package-manager install is a shim, so it is resolved first. The answer
 * is "does this pi ship codemode", NOT "can this session call it": codemode registers with
 * `defaultActive: false`, so it is absent from `getActiveTools()` even when fully present.
 * `session_start` is where the second question gets asked, and where a session handed to an
 * orchestrator that is not there gets told.
 */
export function probeCodemodePresence(argv: readonly string[] = process.argv): CodemodePresence {
  const entry = argv[1];
  if (entry === undefined || entry === "") return { present: false, how: "no-entry" };
  let resolved: string;
  try {
    resolved = realpathSync(entry);
  } catch {
    return { present: false, how: "unresolvable-entry" };
  }
  const bundleDir = dirname(resolved);
  for (const relative of CODEMODE_PROBE_PATHS) {
    const candidate = join(bundleDir, ...relative);
    try {
      if (statSync(candidate).isDirectory()) {
        return { present: true, how: "found" };
      }
    } catch {
      // Not there, or not readable. Try the next layout; the caller sees a false at the end.
    }
  }
  return { present: false, how: "not-found" };
}

/**
 * Where the codemode extension sits, relative to the directory holding pi's entry script.
 *
 * Measured: on a real 0.99.1 install the FIRST entry is the one that answers -- `extensions/`
 * sits one level above `dist/bundle/` -- and it is the only one that has been seen on a real
 * install. The other two are hypotheses about a pi packaged differently, and the honest state of
 * their coverage is uneven: the third has a test, but that test builds the layout by hand rather
 * than observing an install, so "a test caught it" would be a claim nobody can check; the second
 * has no test at all. They are here because a miss on either calls a pi that does ship codemode a
 * pi that does not and flips the default to full, and the real-pi e2e probe test is where such a
 * miss would surface. The cost of guessing is one extra `statSync` on a path that is normally
 * absent; the cost of missing the layout is a silent fallback.
 */
const CODEMODE_PROBE_PATHS: readonly (readonly string[])[] = [
  ["..", "extensions", "codemode"],
  ["..", "..", "extensions", "codemode"],
  ["extensions", "codemode"],
];

export interface CodemodePresence {
  /** Whether the directory was found. */
  present: boolean;
  /** How the answer was reached, so a test can tell a measured yes from a failed probe. */
  how: "found" | "not-found" | "no-entry" | "unresolvable-entry";
}

/** Result of reading the surface mode, with enough detail to warn about a broken file. */
export interface SurfaceModeConfig {
  surfaceMode: SurfaceMode;
  source: "file" | "default" | "invalid";
  error?: string;
  /**
   * What the probe found, on the paths where the surface was NOT decided by the file. Absent
   * when the user set the key: that call never consults the probe (see
   * {@link readSurfaceModeConfig}), so there is nothing to report.
   */
  codemode?: CodemodePresence;
}

/**
 * Read `surfaceMode` from the agent-dir config file.
 *
 * A pure function over the filesystem, shaped like {@link readDefaultModeConfig} on purpose:
 * an absent file, an absent key, unparseable JSON, a non-object, a wrong-typed value and an
 * out-of-set value all resolve to the detected default rather than a hardcoded one, and every
 * malformed shape additionally reports `invalid` with a reason. A malformed setting must never
 * half-apply - which tools exist is not something to change on a guess.
 *
 * The `presence` argument is a parameter rather than a hidden call, so a test can state the pi it
 * is reasoning about instead of depending on the machine it runs on. Omit it and the real probe
 * answers, but only on a path that actually needs the answer: it is resolved inside the
 * fallback branches rather than in a default parameter, because a default parameter is evaluated
 * on EVERY call -- including the ones an explicit `surfaceMode` key short-circuits, where the
 * user paid a `realpathSync` plus up to three `statSync` to set one line of JSON and get a
 * constant.
 */
export function readSurfaceModeConfig(
  agentDir: string,
  presence?: CodemodePresence,
): SurfaceModeConfig {
  const path = join(agentDir, PTC_MODE_CONFIG_FILE);
  const detected = (): { surfaceMode: SurfaceMode; codemode: CodemodePresence } => {
    const probed = presence ?? probeCodemodePresence();
    return { surfaceMode: detectedSurfaceMode(probed), codemode: probed };
  };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { ...detected(), source: "default" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      surfaceMode: detected().surfaceMode,
      source: "invalid",
      error: `${path} is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      surfaceMode: detected().surfaceMode,
      source: "invalid",
      error: `${path} must contain a JSON object`,
    };
  }
  const value = (parsed as { surfaceMode?: unknown }).surfaceMode;
  if (value === undefined) {
    return { ...detected(), source: "default" };
  }
  if (typeof value !== "string") {
    return {
      surfaceMode: detected().surfaceMode,
      source: "invalid",
      error: `${path}: "surfaceMode" must be a string, received ${typeof value}`,
    };
  }
  if (!SURFACE_MODES.includes(value as SurfaceMode)) {
    return {
      surfaceMode: detected().surfaceMode,
      source: "invalid",
      error: `${path}: "surfaceMode" must be one of ${SURFACE_MODES.join(" | ")}, received ${JSON.stringify(value)}`,
    };
  }
  return { surfaceMode: value as SurfaceMode, source: "file" };
}

// --------------------------------------------------------------------------------------
// Entry decision
// --------------------------------------------------------------------------------------

/** Why the mode declined to turn on. Surfaced in the entry notification / debug logs. */
export type ModeBlockReason = "not-tui" | "config-off" | "tools-unavailable" | "restricted-session";

/** Either the loadout to apply, or the reason the mode stayed off. */
export type ModeEntryDecision =
  | { enter: true; base: readonly string[]; loadout: readonly string[] }
  | { enter: false; reason: ModeBlockReason };

/** Inputs to the entry decision. `active` is `pi.getActiveTools()` at decision time. */
export interface ModeEntryInput {
  /** `ctx.mode` — only `"tui"` participates. */
  mode: string;
  /** Resolved `defaultMode` from the config file. */
  defaultMode: boolean;
  /** The session's current tool loadout. */
  active: readonly string[];
  /** True for `/ptc on`, which overrides the config and the restricted-session policy. */
  manual: boolean;
  /** Overrides `DEFAULT_HIDE_STRATEGY` (tests, or a future settings surface). */
  hide?: ModeHideStrategy | undefined;
}

/** Normalize to a de-duplicated name list, preserving order. */
function uniqueNames(names: readonly string[]): string[] {
  return [...new Set(names)];
}

/** Order- and duplicate-insensitive set equality, for loadout comparison. */
export function sameToolSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((name, index) => name === right[index]);
}

/**
 * The loadout applied while the mode is on, given the session's current one.
 *
 * Always keeps the PTC surfaces; what else survives depends on the hide strategy (see
 * `DEFAULT_HIDE_STRATEGY`). Order follows `active`, so the visible list reads the way the session
 * was configured.
 */
export function modeLoadout(active: readonly string[], hide: ModeHideStrategy): string[] {
  const isPtc = (name: string): boolean => PTC_MODE_TOOL_NAMES.includes(name);
  if (hide === "all-but-ptc") return uniqueNames(active.filter(isPtc));
  const builtins: ReadonlySet<string> = new Set(BUILTIN_BINDING_NAMES);
  return uniqueNames(active.filter((name) => isPtc(name) || !builtins.has(name)));
}

/**
 * Decide whether the mode turns on for this session.
 *
 * The policy, in order:
 * 1. **TUI only** — print / JSON / RPC sessions are never touched.
 * 2. **Config** — `{"defaultMode": false}` opts out; `/ptc on` overrides it.
 * 3. **PTC tools must exist** — if this session has them disabled, there is nothing to run.
 * 4. **Explicit restriction wins** — a session launched with `--tools` / `--exclude-tools` /
 *    `--no-builtin-tools` that is missing any of `MODE_REQUIRED_TOOL_NAMES` (pi's default four)
 *    stays as launched. Narrowing *further* would be the extension overriding a deliberate user
 *    instruction, and the PTC surface would be degraded anyway (bindings = `BUILTIN ∩ base`).
 *    `/ptc on` overrides this: the manual path enters with the restricted loadout as `base`, so
 *    bindings stay inside the user's allowlist.
 */
export function decideModeEntry(input: ModeEntryInput): ModeEntryDecision {
  const { mode, defaultMode, active, manual } = input;
  if (mode !== "tui") return { enter: false, reason: "not-tui" };
  if (!defaultMode && !manual) return { enter: false, reason: "config-off" };
  if (!PTC_MODE_TOOL_NAMES.some((name) => active.includes(name))) {
    return { enter: false, reason: "tools-unavailable" };
  }
  if (!manual) {
    const missing = MODE_REQUIRED_TOOL_NAMES.filter((name) => !active.includes(name));
    if (missing.length > 0) return { enter: false, reason: "restricted-session" };
  }
  return {
    enter: true,
    base: uniqueNames(active),
    loadout: modeLoadout(active, input.hide ?? DEFAULT_HIDE_STRATEGY),
  };
}

// --------------------------------------------------------------------------------------
// Runtime helpers
// --------------------------------------------------------------------------------------

/**
 * Tool names the binding table should be built from.
 *
 * While the mode is on this is the base snapshot (so the built-ins the mode just hid remain
 * callable from inside a program); otherwise it is simply the live loadout, i.e. T7's rule.
 */
export function bindingSource(state: PtcModeState, active: readonly string[]): readonly string[] {
  return state.enabled && state.base !== undefined ? state.base : active;
}

/**
 * Whether the live loadout is no longer the one this mode wrote — i.e. another extension (or the
 * user) took ownership of the tool set. Always false while the mode is off.
 */
export function detectExternalLoadoutChange(
  state: PtcModeState,
  active: readonly string[],
): boolean {
  if (!state.enabled || state.ourLoadout === undefined) return false;
  return !sameToolSet(state.ourLoadout, active);
}

/**
 * Reconstruct the base loadout on `session_start`.
 *
 * Two shapes are possible:
 * - The session is still narrowed from a previous run of this mode (a `/reload`, or a resumed
 *   session): the live loadout is a subset of the PTC tools and the persisted record says the mode
 *   was on. The persisted `base` is then authoritative — but only to *undo our own hiding*.
 * - Otherwise the live loadout is whatever this pi process was launched with, and it wins. That is
 *   what keeps a new `--tools …` choice from being overridden by an older session's snapshot.
 */
export function resolveBaseOnStart(
  persisted: PersistedModeState | undefined,
  active: readonly string[],
): { base: readonly string[]; restoreFirst: boolean } {
  const looksNarrowedByUs =
    active.length > 0 && active.every((name) => PTC_MODE_TOOL_NAMES.includes(name));
  if (persisted?.enabled === true && looksNarrowedByUs && persisted.base !== undefined) {
    return { base: persisted.base, restoreFirst: true };
  }
  return { base: active, restoreFirst: false };
}

// --------------------------------------------------------------------------------------
// Instruction injected into the conversation once per mode entry
// --------------------------------------------------------------------------------------

/**
 * Build the system-visible briefing for the mode.
 *
 * Generated from the *actual* binding list rather than hardcoded, because bindings vary by session
 * (`base` is whatever the session was launched with) and a stale list would have the model calling
 * names that are not bound.
 */
export function buildModeInstruction(bindings: readonly string[], hide: ModeHideStrategy): string {
  const builtinNote =
    hide === "all-but-ptc"
      ? "Every built-in tool is hidden from you, and so are other extensions' tools."
      : "The built-in tools (read, bash, edit, write, grep, find, ls) are hidden from you.";
  const callable = bindings.map((name) => `tools.${name}(args)`);
  const examples = bindings
    .slice(0, 2)
    .map((name) =>
      name === "read"
        ? 'await tools.read({ path: "src/index.ts" })'
        : name === "bash"
          ? 'await tools.bash({ command: "pnpm test" })'
          : `await tools.${name}({ /* … */ })`,
    )
    .join("\n");

  return [
    "[PTC MODE ACTIVE]",
    "This session runs in PTC mode. " + builtinNote,
    "",
    "Work by writing one TypeScript program per task and running it:",
    "  - ptc_run_code for a plain program (its return value and console.log come back to you)",
    "  - ptc_workflow when the task has named phases and you want narration (log / phase /",
    "    parallel / pipeline are available there)",
    "",
    `The program body is an async function. Available inside it: ${callable.join(", ")}, plus the`,
    'parallel binding `tools["pi.dispatch"](args)` — always bound, and its dot name needs string',
    "indexing (`tools.pi.dispatch` does not exist). The run's actual bound names are on the",
    "`ptcBindings` global, so a program never has to guess what is bound this run.",
    examples.length > 0 ? `Examples:\n${examples}` : "",
    "",
    "Batch a task's steps into ONE program instead of issuing many tool calls — gathering",
    "intermediate output yourself and returning only what matters is the point of this mode.",
    "Image-bearing tool results inside a program are attached to you after the run — never return",
    "base64 image data as your program's value.",
    "If the PTC surfaces cannot express what you need, say so and the user can run /ptc off.",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}
