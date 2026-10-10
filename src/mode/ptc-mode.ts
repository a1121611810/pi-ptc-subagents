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
import { basename, dirname, join, relative, sep } from "node:path";
import { minimatch } from "minimatch";
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
 * which registered tools are *active*).
 *
 * These are DETECTED values, not settings. The list is two long because detection is the only
 * thing that produces them: `subagents` keeps the subagent face and lets pi's `codemode`
 * orchestrate, `full` keeps the whole set. There was a third, `off`, and a `surfaceMode` key
 * that could pin any of the three (ADR-0025); both are gone, and
 * {@link detectSurfaceMode} is now a pure function of what pi is — see its doc for why the
 * escape hatch the setting provided is not one this package can replace.
 */
export const SURFACE_MODES = ["subagents", "full"] as const;
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
 * Whether the pi that launched us will actually LOAD its `codemode` extension.
 *
 * - `"absent"` — nothing in any settings file names it, so pi's own default applies, which is to
 *   load it (`settings.md`: "They load by default").
 * - `"enabled"` — an explicit `+builtin:codemode`, or `-e builtin:codemode` on the command line.
 * - `"disabled"` — `-builtin:codemode` or `!builtin:codemode` in a settings file, or `--no-extensions`.
 *
 * This is a different question from {@link CodemodePresence}, which asks whether the directory is
 * on disk. Both are needed, and conflating them is what ADR-0027 fixes: pi 0.99.0 added
 * `-builtin:<name>`, so "the directory exists" and "codemode will run" stopped being the same
 * answer, and a probe that only asks the first one hands orchestration to a tool that is not there.
 */
export type CodemodeSwitch = "absent" | "enabled" | "disabled";

/** How the switch was decided, so a test can tell a measured answer from a failed read. */
export type CodemodeSwitchSource = "cli" | "project" | "user" | "default" | "invalid";

/** The switch plus enough provenance to explain it in a notice. */
export interface CodemodeSwitchResolution {
  switch: CodemodeSwitch;
  source: CodemodeSwitchSource;
  /** Set when a settings file could not be read as a JSON object; the switch still resolves. */
  error?: string;
}

/**
 * The two directories pi resolves the `!` bucket's globs against.
 *
 * `matchesAnyPattern` also tests `relative(baseDir, path)` and the basename, so a glob whose
 * answer depends on where pi's directories sit is only correct for the directories pi actually
 * used. These are the two it uses: `join(cwd, CONFIG_DIR_NAME)` for project scope -- pi 1.0.0's
 * `CONFIG_DIR_NAME` is `".pi"`, `package-manager.js:720` -- and `agentDir` for user scope (`:719`).
 */
export interface CodemodeBaseDirs {
  project: string;
  user: string;
}

/** The exact entry pi's own resolver matches a built-in extension on (`source-info.js`). */
const CODEMODE_BUILTIN_ENTRY = "builtin:codemode";

/**
 * pi's own matchers, reproduced against the installed `minimatch` rather than approximated.
 *
 * An earlier version compared a pattern's LITERAL PREFIX against the target and documented the
 * over-match as an accepted cost. That was the wrong shape of fix: the `!` bucket is a continuum
 * (globs, character classes, extglobs, nested negations, backslash escapes, multi-segment paths),
 * so every round of review found one more member, and each fix was a new case in a list that could
 * never be finished. Four rounds produced four costful defects that way -- R1-01, R3-01, R4-01 and
 * R4-02 -- and the reviewer's own read was that the approximation, not the case list, was the
 * defect.
 *
 * pi matches this bucket with `minimatch` and depends on it to do so, so mirroring the call is both
 * shorter and exact. What remains is not an approximation of pi's behaviour but a copy of it, and
 * `tests/unit/codemode-switch-differential.test.ts` re-measures the copy against pi's resolver so
 * a future pi release turns that file red rather than letting the copy drift.
 *
 * Sources, pi 1.0.0: `matchesAnyPattern` at `dist/core/package-manager.js:473-493`,
 * `normalizeExactPattern` / `matchesAnyExactPattern` at `:496-517`. The `SKILL.md` branch of both is
 * omitted because a built-in path never has that basename.
 */

/** pi's `toPosixPath` (`package-manager.js:79-81`). */
function toPosixPath(p: string): string {
  return p.split(sep).join("/");
}

/** pi's `normalizeExactPattern` (`:496-499`) — strips a leading `./` or `.\`, then posixises. */
function normalizeExactPattern(pattern: string): string {
  const stripped =
    pattern.startsWith("./") || pattern.startsWith(".\\") ? pattern.slice(2) : pattern;
  return toPosixPath(stripped);
}

/** pi's `matchesAnyPattern` (`:473-493`), minus the `SKILL.md` branch. */
function matchesAnyPattern(
  filePath: string,
  patterns: readonly string[],
  baseDir: string,
): boolean {
  const rel = toPosixPath(relative(baseDir, filePath));
  const name = basename(filePath);
  const filePathPosix = toPosixPath(filePath);
  return patterns.some((pattern) => {
    const normalized = toPosixPath(pattern);
    return (
      minimatch(rel, normalized) ||
      minimatch(name, normalized) ||
      minimatch(filePathPosix, normalized)
    );
  });
}

/** pi's `matchesAnyExactPattern` (`:500-517`), minus the `SKILL.md` branch. */
function matchesAnyExactPattern(
  filePath: string,
  patterns: readonly string[],
  baseDir: string,
): boolean {
  if (patterns.length === 0) return false;
  const rel = toPosixPath(relative(baseDir, filePath));
  const filePathPosix = toPosixPath(filePath);
  return patterns.some((pattern) => {
    const normalized = normalizeExactPattern(pattern);
    return normalized === rel || normalized === filePathPosix;
  });
}

/**
 * pi's `getOverridePatterns` (`:520-522`): the entries that carry a sign at all.
 *
 * One deliberate divergence. pi's filter calls `.startsWith` on every entry, so a NON-STRING in a
 * hand-edited `extensions` array makes it throw a `TypeError` and pi never starts. This skips such
 * entries instead — measured, not assumed: `extensions: [42]` throws in pi and resolves here.
 *
 * It diverges in the safe direction and is not worth copying. When pi throws there is no session
 * for a more faithful answer to matter in, and throwing here would turn a malformed settings file
 * into a package that cannot load at all. Recorded rather than papered over, because the rest of
 * this section is a copy, and a silent difference inside a copy is what costs a review round.
 */
function signedTargets(
  entries: readonly unknown[],
): ReadonlyArray<{ sign: string; target: string }> {
  const out: { sign: string; target: string }[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const sign = entry[0];
    if (sign !== "+" && sign !== "-" && sign !== "!") continue;
    out.push({ sign, target: entry.slice(1) });
  }
  return out;
}

/**
 * The switch the PROJECT `extensions` array implies, from pi's
 * `applyAutoloadDisabledPatterns` (`:593-606`): iterate in order, and let each MATCHING entry
 * overwrite the last — so a `!` after a `+` wins, and position is meaningful. `+` / `-` are matched
 * exactly, `!` by glob.
 */
function switchFromProjectExtensions(value: unknown, baseDir: string): CodemodeSwitch | undefined {
  if (!Array.isArray(value)) return undefined;
  let result: CodemodeSwitch | undefined;
  for (const { sign, target } of signedTargets(value)) {
    const enabled = sign !== "-" && sign !== "!";
    const matched =
      sign === "+" || sign === "-"
        ? matchesAnyExactPattern(CODEMODE_BUILTIN_ENTRY, [target], baseDir)
        : matchesAnyPattern(CODEMODE_BUILTIN_ENTRY, [target], baseDir);
    if (matched) result = enabled ? "enabled" : "disabled";
  }
  return result;
}

/**
 * The switch the USER `extensions` array implies, from pi's `isEnabledByOverrides` (`:523-539`):
 * the array is split into `!` / `+` / `-` buckets and pi ASSIGNS through them in that fixed order,
 * so position is irrelevant and `-` outranks `+`. Written as three assignments rather than a chain
 * of early returns, because pi has no early return either.
 */
function switchFromUserExtensions(value: unknown, baseDir: string): CodemodeSwitch | undefined {
  if (!Array.isArray(value)) return undefined;
  const signed = signedTargets(value);
  const of = (sign: string): string[] => signed.filter((e) => e.sign === sign).map((e) => e.target);
  const excludes = of("!");
  const forceIncludes = of("+");
  const forceExcludes = of("-");
  let enabled: CodemodeSwitch | undefined;
  if (matchesAnyPattern(CODEMODE_BUILTIN_ENTRY, excludes, baseDir)) enabled = "disabled";
  if (matchesAnyExactPattern(CODEMODE_BUILTIN_ENTRY, forceIncludes, baseDir)) enabled = "enabled";
  if (matchesAnyExactPattern(CODEMODE_BUILTIN_ENTRY, forceExcludes, baseDir)) enabled = "disabled";
  return enabled;
}

/**
 * Whether the command line explicitly loads `builtin:codemode`.
 *
 * Only the two spellings pi's own parser accepts: `-e builtin:codemode` and
 * `--extension builtin:codemode`, both taking the NEXT argument (`dist/cli/args.js`:
 * `arg === "--extension" || arg === "-e"` then `args[++i]`). The attached short form
 * `-ebuiltin:codemode` is deliberately NOT recognised here, because pi rejects it outright
 * with "Unknown option" -- mirroring that is what keeps this from inventing a behaviour the
 * host does not have.
 *
 * `-ne` is handled by the caller, after this, because pi resolves the pair in that order: an
 * explicit `-e` re-enables what `--no-extensions` turned off.
 */
function cliLoadsCodemode(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-e" || arg === "--extension") {
      if (args[index + 1] === CODEMODE_BUILTIN_ENTRY) return true;
    }
  }
  return false;
}

/** Read a settings file that may be absent, unreadable, or not a JSON object. */
function readSettingsObject(path: string): { value: unknown; error?: string } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // Absent is the normal case for the project-scope file and must not be an error.
    return { value: undefined };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { value: undefined, error: `${path} must contain a JSON object` };
    }
    return { value: parsed };
  } catch (error) {
    return {
      value: undefined,
      error: `${path} is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

export function resolveCodemodeSwitch(
  argv: readonly string[],
  projectSettings: unknown,
  userSettings: unknown,
  baseDirs: CodemodeBaseDirs = { project: process.cwd(), user: process.cwd() },
): CodemodeSwitchResolution {
  const args = argv.slice(1);
  if (cliLoadsCodemode(args)) return { switch: "enabled", source: "cli" };
  if (args.some((arg) => arg === "-ne" || arg === "--no-extensions")) {
    return { switch: "disabled", source: "cli" };
  }

  const projectExtensions = (projectSettings as { extensions?: unknown } | undefined)?.extensions;
  const fromProject = switchFromProjectExtensions(projectExtensions, baseDirs.project);
  if (fromProject !== undefined) return { switch: fromProject, source: "project" };

  const userExtensions = (userSettings as { extensions?: unknown } | undefined)?.extensions;
  const fromUser = switchFromUserExtensions(userExtensions, baseDirs.user);
  if (fromUser !== undefined) return { switch: fromUser, source: "user" };

  return { switch: "absent", source: "default" };
}

/**
 * Read pi's own settings files and resolve the switch.
 *
 * Project settings live at `<cwd>/.pi/settings.json` and user settings at
 * `<agentDir>/settings.json` — the two `DefaultPackageManager` reads, via
 * `join(this.cwd, CONFIG_DIR_NAME)` and `this.agentDir`.
 */
export function readCodemodeSwitch(
  agentDir: string,
  cwd: string,
  argv: readonly string[] = process.argv,
): CodemodeSwitchResolution {
  const project = readSettingsObject(join(cwd, ".pi", "settings.json"));
  const user = readSettingsObject(join(agentDir, "settings.json"));
  const resolved = resolveCodemodeSwitch(argv, project.value, user.value, {
    project: join(cwd, ".pi"),
    user: agentDir,
  });
  const error = project.error ?? user.error;
  return error === undefined ? resolved : { ...resolved, source: "invalid", error };
}

// --------------------------------------------------------------------------------------
// Activation: will `codemode` be in the model's tool list? (ADR-0029)
// --------------------------------------------------------------------------------------

/**
 * The name pi registers its orchestrator under. The probe below asks whether this exact name is
 * in the loadout; the decision-4 warning at `session_start` asks the same question of the real
 * one, which is what bounds how exact this probe has to be.
 */
export const CODEMODE_TOOL_NAME = "codemode";

/**
 * Whether `codemode` will be CALLABLE, as a third question distinct from whether pi ships the
 * directory (ADR-0026) and whether it will load the extension (ADR-0027).
 *
 * - `"active"` — a loadout names it OR pi's MCP extension will auto-enable it from `mcp.json`
 *   (ADR-0033), so the model can call it.
 * - `"inactive"` — nothing names it and nothing auto-enables it, which on a real install is the
 *   DEFAULT: pi registers `codemode` with `defaultActive: false`
 *   (`dist/extensions/codemode/index.js:26`).
 *
 * `"inactive"` is what every failure of this probe on the positive side resolves to, and that is
 * the design rather than a fallback: `subagents` is chosen only on positive evidence that the tool
 * is callable. See ADR-0029, "The bound that makes the weaker guarantee sufficient".
 */
export type CodemodeActivation = "active" | "inactive";

/**
 * How the answer was decided, so a test can tell a configured answer from pi's default.
 * `"mcp"` is ADR-0033: the loadout mirror said `inactive` and the MCP auto-enable evidence
 * said pi will activate `codemode` anyway.
 */
export type CodemodeActivationSource = "cli" | "project" | "user" | "default" | "invalid" | "mcp";

/** The answer plus enough provenance to explain it in a notice. */
export interface CodemodeActivationResolution {
  activation: CodemodeActivation;
  source: CodemodeActivationSource;
  /** Set when a settings file could not be read as a JSON object; the answer still resolves. */
  error?: string;
  /**
   * Set when an `mcp.json` could not be read as a JSON object (ADR-0033); that file contributed
   * nothing to the answer, and the answer still resolves.
   */
  mcpError?: string;
}

/** pi's default active tool names (`settings-manager.js:35`). None of them is `codemode`. */
const PI_DEFAULT_TOOL_NAMES: readonly string[] = ["read", "bash", "edit", "write"];

/** pi's `isToolModifier` (`settings-manager.js:36`) — a string opening with `+` or `-`. */
function isToolModifier(entry: unknown): entry is string {
  return typeof entry === "string" && (entry.startsWith("+") || entry.startsWith("-"));
}

/** pi's own `getDefaultTools` filter: a non-string in the array is dropped, not rejected. */
function stringEntries(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * pi's `mergeDefaultTools` (`settings-manager.js:43`), with the direction fixed by
 * `deepMergeSettings(this.globalSettings, this.projectSettings)` (`:196`): the USER list is the
 * base and the PROJECT list the override.
 *
 * A project list made only of modifiers concatenates onto the base, so a project can add
 * `+codemode` without restating the user list. A project list containing any plain name replaces
 * the base outright, because plain names are what decide a list rather than edit one.
 */
function mergeDefaultTools(base: unknown, overrides: unknown): unknown {
  if (overrides === undefined) return base;
  if (!Array.isArray(base) || !Array.isArray(overrides) || !overrides.every(isToolModifier)) {
    return overrides;
  }
  return [...base, ...overrides];
}

/**
 * pi's `resolveDefaultTools` (`settings-manager.js:55`).
 *
 * Plain names ARE the list. When every entry is a modifier there is nothing to start from, so the
 * list starts as pi's four defaults instead — which is what makes `defaultTools: ["+codemode"]`
 * mean "the usual four, plus codemode" rather than "a list containing only codemode".
 */
function resolveDefaultTools(entries: readonly string[]): string[] {
  const plain = entries.filter((entry) => !isToolModifier(entry));
  const tools = plain.length > 0 || entries.length === 0 ? plain : [...PI_DEFAULT_TOOL_NAMES];
  for (const entry of entries) {
    if (!isToolModifier(entry)) continue;
    const name = entry.slice(1);
    const index = tools.indexOf(name);
    if (entry.startsWith("+") && index === -1 && name) tools.push(name);
    else if (entry.startsWith("-") && index !== -1) tools.splice(index, 1);
  }
  return tools;
}

/*
 * A note on every `file:line` in this region, because they are only true of one version.
 *
 * They are measured against **pi 1.0.0**, the version in `node_modules` — the one this repo
 * compiles and typechecks against, and therefore the one a reader can re-measure without leaving
 * the checkout. pi **1.1.0** moves several of them: `--tools` 110 → 114, the `--` test 23 → 24,
 * `_isAllowedTool` (`core/agent-session.js`) 1099 → 1118, and the `sdk.js` loadout expression
 * 148 → 157. Nothing about the behaviour differs; only the addresses do, and an address that is
 * wrong for the version in front of the reader is worse than no address at all. So when you re-measure
 * one, re-measure against 1.0.0 or say which version you used.
 *
 * (This is the same trap ADR-0026's presence probe already records: it cites 0.99.1's `loader.js`
 * and says so, on purpose.)
 */

/** pi's comma-separated tool-list syntax (`args.js:110,116` on pi 1.0.0): split, trimmed, blanks dropped. */
function splitCliToolList(value: string): string[] {
  return value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/**
 * Every flag pi's parser consumes a following argument for, so a value that LOOKS like a tool
 * flag is never re-read as one.
 *
 * pi writes those branches `args[++i]` (`dist/cli/args.js:63-189`), which advances the cursor past
 * the value; `--mode` and `--use-theme` spell the same advance as a bare `i++` (`:46`, `:171`), and
 * `-p` guards its value before advancing (`:139`). The whole flag loop is `:21-251`.
 *
 * This reader originally used `args[index + 1]` and did not advance, so it saw flags pi
 * had already swallowed as values. That is not a cosmetic difference: `pi --exclude-tools --tools
 * codemode` gives this reader `allowlist: ["codemode"]` and therefore `active`, while pi sets
 * `excludeTools` to the literal `"--tools"` and never looks at `tools` at all — so pi decides from
 * `defaultTools`, and the session is wrong in the direction that costs the user both orchestration
 * tools.
 *
 * The set is deliberately an OVER-approximation of pi's branches rather than a transcription of
 * them. A name listed here that pi happens to treat as valueless only makes this reader skip an
 * argument, which can only hide a tool flag and so pushes the answer toward `inactive` — the safe
 * direction, and the one ADR-0029's fallback exists for. A name MISSING here is the dangerous kind
 * of error, which is why the list errs long.
 *
 * `--` is not in this set because it is not a value-consuming flag; it ends flag parsing outright
 * (`args.js:23`, whose `break` is `:32`), which {@link cliToolFlags} handles separately.
 */
const PI_VALUE_CONSUMING_FLAGS: ReadonlySet<string> = new Set([
  "--api-key",
  "--append-system-prompt",
  "--exclude-tools",
  "--export",
  "--extension",
  "--fork",
  "--model",
  "--models",
  "--name",
  "--prompt-template",
  "--provider",
  "--session",
  "--session-dir",
  "--session-id",
  "--skill",
  "--system-prompt",
  "--thinking",
  "--tools",
  "-e",
  "-n",
  "-t",
  "-xt",
]);

/**
 * The two flags pi only consumes a value from when that value does NOT look like a flag.
 *
 * `--mode` (`args.js:40-46`), `--use-theme` (`:164-171`) and `--list-models` (`:186-189`) all
 * test `value === undefined || value.startsWith("-")` and skip the advance when it does.
 * They were originally listed in the unconditional set above with the claim that they "spell the
 * same advance as a bare `i++`", which is false in exactly the case that matters: `--mode -t
 * codemode` leaves `-t codemode` for pi's main loop, and treating that as consumed here would hide
 * a tool flag.
 */
const PI_CONDITIONALLY_CONSUMING_FLAGS: ReadonlySet<string> = new Set([
  "--mode",
  "--use-theme",
  "--list-models",
]);

/**
 * `-p` / `--print` has a THIRD rule, and it is the one that is easiest to get wrong.
 *
 * pi's branch (`args.js:134-141`) consumes the next token only when it is not `@file` and either
 * does not start with `-` or starts with `---` — the last clause existing so `--print ---` still
 * reads a message that begins with dashes. So `-p -t` does NOT consume, and the `-t` behind it is
 * pi's own tool allowlist. Treating `-p` as an ordinary value-consuming flag hides that allowlist,
 * which is the wrong direction: with `defaultTools` naming codemode, the answer flips from
 * `subagents` to `full` and the model gets a second orchestration tool pi never offered.
 */
function piPrintConsumesNext(args: readonly string[], index: number): boolean {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("@")) return false;
  return !value.startsWith("-") || value.startsWith("---");
}

/**
 * pi's `--`-style flags that swallow a following token that does not itself look like a flag.
 *
 * `dist/cli/args.js:227,235-237`: the unknown-flag branch stores `--name` with its value when the next
 * token starts with neither `-` nor `@`, and advances `i` past it. pi then never treats that token
 * as a flag, so neither may this reader. Treating it as one is the same class of error as the `-e NAME` case above.
 */
function piUnknownLongFlagEatsNext(args: readonly string[], index: number): boolean {
  const next = args[index + 1];
  return next !== undefined && !next.startsWith("-") && !next.startsWith("@");
}

/** The three CLI flags that decide which tools pi allows, and which of them are active. */
export interface CliToolFlags {
  /** `--tools` / `-t`, or `undefined` when the flag is absent or dangling. */
  allowlist: string[] | undefined;
  /** `--exclude-tools` / `-xt`, empty when absent or dangling. */
  denylist: string[];
  /**
   * True when pi will start the session with an EMPTY active tool list. Set by BOTH
   * `--no-tools` / `-nt` AND `--no-builtin-tools` / `-nbt`.
   */
  noTools: boolean;
}

/**
 * Every CLI switch that can remove `codemode`, read the way pi reads it.
 *
 * The previous version of this read only `--tools`, which was correct for as long as `--tools`
 * was the only flag that could take a tool away. It is not, and the two it missed both land on
 * the SAME side — they make this package hand its orchestration tools to a `codemode` that is not
 * there, and `subagents` reaches them at `exposure: "codemode"`, which means a `codemode` that
 * does not exist reaches them from nowhere. So both were read as `active` where pi would not
 * activate it:
 *
 * - **`-xt codemode`** filters the registry outright — `_isAllowedTool` is
 *   `(!allowed || allowed.has(name)) && !excluded?.has(name)` (`agent-session.js:1099-1100`) —
 *   so the tool is not merely inactive, it is absent.
 * - **`-t codemode -xt codemode`** is the order-sensitive one. pi builds the initial active set
 *   as `(tools ?? configured).filter(name => !excluded.has(name))` (`sdk.js:148`): the denylist
 *   is applied AFTER the list that contains the name, so exclusion beats inclusion. An old
 *   `allowlist.includes(codemode)` check cannot see that.
 *
 * `--no-tools` / `-nt` is read too, and it is NOT an empty allowlist. `-t ""` still *allows*
 * every name and activates none; `-nt` empties `_allowedToolNames`, so nothing is allowed to
 * register at all (`sdk.js:145`).
 *
 * `--no-builtin-tools` / `-nbt` sets this flag as well, and that one is worth the record because
 * it was written here as deliberately NOT read, on the reasoning that pi maps it to
 * `noTools: "builtin"` (`main.js:430`) which is not `"all"`, and that `codemode` is not one of the
 * eight built-in tools anyway. Both halves are true and the conclusion drawn from them was wrong.
 * `sdk.js:148` tests `options.noTools` for TRUTH, not for `"all"`:
 *
 * ```js
 * (options.tools ?? (options.noTools ? [] : (configuredDefaultToolNames ?? DEFAULT_TOOL_NAMES)))
 * ```
 *
 * so `"builtin"` empties the initial active list exactly as `"all"` does, and a user who has
 * `defaultTools: ["+codemode"]` and launches with `-nbt` gets an INACTIVE codemode. Measured on
 * pi 1.1.0 with this package's own `dist/index.js`: `-nbt` leaves `codemode` registered
 * (`allowedToolNames` stays undefined, so `_isAllowedTool` admits it) and inactive
 * (`initialActiveToolNames` is `[]`), which is a state the flag name does not suggest and which no
 * amount of reading `sdk.js:145` in isolation reveals. `tests/unit/cli-tool-flags.test.ts` pins it.
 */
export function cliToolFlags(args: readonly string[]): CliToolFlags {
  let allowlist: string[] | undefined;
  let denylist: string[] = [];
  let noTools = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    // pi breaks out of the flag loop at `--` (`args.js:23`, `break` at `:32`), so nothing after it is a flag.
    if (arg === "--") break;
    if (arg === "--no-tools" || arg === "-nt" || arg === "--no-builtin-tools" || arg === "-nbt") {
      noTools = true;
      continue;
    }
    if (arg === "--tools" || arg === "-t") {
      const value = args[index + 1];
      if (value !== undefined) {
        allowlist = splitCliToolList(value);
        index += 1;
      }
      continue;
    }
    if (arg === "--exclude-tools" || arg === "-xt") {
      const value = args[index + 1];
      if (value !== undefined) {
        denylist = splitCliToolList(value);
        index += 1;
      }
      continue;
    }
    // Every other branch pi writes as `args[++i]` consumes its value. Skipping it here is what
    // keeps a value that happens to spell `--tools` from being read as a tool flag.
    if (PI_VALUE_CONSUMING_FLAGS.has(arg)) {
      if (args[index + 1] !== undefined) index += 1;
      continue;
    }
    if (PI_CONDITIONALLY_CONSUMING_FLAGS.has(arg)) {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) index += 1;
      continue;
    }
    if (arg === "-p" || arg === "--print") {
      if (piPrintConsumesNext(args, index)) index += 1;
      continue;
    }
    if (arg.startsWith("--") && piUnknownLongFlagEatsNext(args, index)) index += 1;
  }
  return { allowlist, denylist, noTools };
}

/**
 * Resolve the LOADOUT half of whether `codemode` will be in the model's tool list: the
 * command-line switches, then the merged `defaultTools`, then pi's own default. This is the
 * ADR-0029 mirror; the MCP auto-enable evidence (ADR-0033) is unioned on top by
 * {@link applyMcpAutoEnableEvidence}, which {@link readCodemodeActivation} calls.
 *
 * The precedence below is pi's, in pi's order, and it is not the order the flags are written in:
 *
 * 1. **`-t`** decides the list, and it beats `-nt` — `options.tools ?? (options.noTools ? [] : …)`
 *    (`sdk.js:148`). `-nt -t codemode` activates `codemode`.
 * 2. **`-xt` vetoes whatever list won**, including the allowlist, because the denylist is the
 *    `.filter` applied to that list rather than another source (`sdk.js:147-148`). This is the
 *    check whose absence made `-t codemode -xt codemode` read as active.
 * 3. **`-nt` and `-nbt`** with no allowlist empty the initial active list (`sdk.js:148`), so
 *    `codemode` is not active whatever `defaultTools` says. Under `-nt` it is not even registered
 *    (`sdk.js:145`); under `-nbt` it is registered and inactive. Same answer, different states.
 * 4. Otherwise `defaultTools` decides, vetoed by `-xt` exactly as in (2), because the same
 *    `.filter` is applied to the configured list.
 *
 * The last of those is the load-bearing one and is what makes absence of evidence mean
 * `inactive`: pi registers `codemode` inactive, so a session that configured nothing does not get
 * it, and delegating orchestration to a tool the model cannot call is the failure this exists to
 * prevent.
 */
export function resolveCodemodeActivation(
  argv: readonly string[],
  projectSettings: unknown,
  userSettings: unknown,
): CodemodeActivationResolution {
  const cli = cliToolFlags(argv.slice(1));
  const denied = cli.denylist.includes(CODEMODE_TOOL_NAME);

  if (cli.allowlist !== undefined) {
    return {
      activation: cli.allowlist.includes(CODEMODE_TOOL_NAME) && !denied ? "active" : "inactive",
      source: "cli",
    };
  }
  if (cli.noTools) return { activation: "inactive", source: "cli" };

  const projectRaw = (projectSettings as { defaultTools?: unknown } | undefined)?.defaultTools;
  const userRaw = (userSettings as { defaultTools?: unknown } | undefined)?.defaultTools;
  const merged = mergeDefaultTools(userRaw, projectRaw);
  if (merged === undefined) return { activation: "inactive", source: "default" };

  const answer =
    !denied && resolveDefaultTools(stringEntries(merged)).includes(CODEMODE_TOOL_NAME)
      ? "active"
      : "inactive";
  return { activation: answer, source: projectRaw !== undefined ? "project" : "user" };
}

/**
 * Read pi's own settings files and resolve the activation, from the same two files and in the
 * same order as {@link readCodemodeSwitch}, and union the MCP auto-enable evidence on top
 * (ADR-0033) — the MCP extension activates `codemode` by calling `pi.setActiveTools`, which no
 * settings file records.
 */
export function readCodemodeActivation(
  agentDir: string,
  cwd: string,
  argv: readonly string[] = process.argv,
): CodemodeActivationResolution {
  const project = readSettingsObject(join(cwd, ".pi", "settings.json"));
  const user = readSettingsObject(join(agentDir, "settings.json"));
  const resolved = applyMcpAutoEnableEvidence(
    resolveCodemodeActivation(argv, project.value, user.value),
    readMcpAutoEnableEvidence(agentDir, cwd),
  );
  const error = project.error ?? user.error;
  return error === undefined ? resolved : { ...resolved, source: "invalid", error };
}

// --------------------------------------------------------------------------------------
// MCP auto-enable evidence: pi's MCP extension activates codemode from mcp.json (ADR-0033)
// --------------------------------------------------------------------------------------

/** The exposure names pi's MCP config accepts, in pi's order (`dist/core/mcp-servers.js:7`). */
const MCP_EXPOSURES: readonly string[] = ["codemode", "deferred", "direct", "hidden"];

/**
 * pi's one exposure alias (`mcp-servers.js:9`): an older config spells the default exposure
 * `codemode-deferred`, and validation rewrites it to `codemode` before anything reads it.
 */
const MCP_EXPOSURE_ALIASES: Readonly<Record<string, string>> = { "codemode-deferred": "codemode" };

/** pi's server-name charset (`mcp-servers.js:18`). */
const MCP_SERVER_NAME = /^[A-Za-z0-9_-]+$/;

function resolveMcpExposureAlias(value: unknown): unknown {
  return typeof value === "string" ? (MCP_EXPOSURE_ALIASES[value] ?? value) : value;
}

function isMcpExposure(value: unknown): boolean {
  return typeof value === "string" && MCP_EXPOSURES.includes(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isPlainRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

/** Whether a `url` is one pi transports over, from pi's url check (`mcp-servers.js:137-139`). */
function isHttpTransportUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  return /^https?:$/.test(new URL(value).protocol);
}

/** The three fields of a server entry the auto-enable question reads, after alias resolution. */
interface MirroredMcpServer {
  enabled: boolean | undefined;
  /** Alias-resolved. `undefined` is pi's default, which IS `codemode` (`index.js:60-62`). */
  exposure: string | undefined;
  /** Alias-resolved per-tool overrides. */
  toolExposure: Record<string, string> | undefined;
}

/**
 * The structural subset of pi's `validateMcpServerConfig` (`dist/core/mcp-servers.js:107-169`)
 * that decides whether a server entry survives into the registry, carrying only the fields the
 * auto-enable question reads.
 *
 * Deliberately a SUBSET. Mirrored check-for-check: the name charset, the object shape, `exposure`
 * and `toolExposure` value validity after alias resolution, the `enabled` / `description` /
 * `timeout` types, the `sse` rejection, and the transport requirements (`args` a string array,
 * `env` and `headers` string records, `cwd` a string, `url` an http(s) URL). NOT mirrored: the
 * `oauth` object validation and the `auth.provider` rules (`:143-155`) — the only omissions, and
 * both live in the validator rather than in the file reader, whose one scope rule (a project may
 * not carry `auth` on a URL server, `config.js:66-69`) is mirrored in {@link foldMcpConfigFile}.
 *
 * The omission can only OVER-predict activation — an entry pi rejects for those reasons alone is
 * counted here as evidence, while pi drops it and never auto-enables. That is the loud, safe
 * direction: the decision-4 warning measures the real loadout and fires. It can never
 * under-predict, which is the silent double-surface defect this evidence exists to close. An
 * entry pi drops for a mirrored reason contributes nothing, exactly as in pi.
 *
 * Scoped claim, because the sentence above is about THIS SUBSET and not about the probe: pi's
 * server list is `loadMcpConfig`'s output PLUS whatever extensions registered through
 * `pi.registerMcpServer()` (`index.js:853`, where the two lists are merged; the activation call at
 * `:857`, the registry at `:232-247`), so a server registered that way activates
 * codemode with no `mcp.json` anywhere and no probe can see it. That is a real under-report, and
 * it is the live path the drift notice exists for rather than a failure of the mirror below.
 */
function mirrorMcpServerConfig(name: string, raw: unknown): MirroredMcpServer | undefined {
  if (!MCP_SERVER_NAME.test(name)) return undefined;
  if (!isPlainRecord(raw)) return undefined;
  const exposure = resolveMcpExposureAlias(raw.exposure);
  const toolExposure = isPlainRecord(raw.toolExposure)
    ? Object.fromEntries(
        Object.entries(raw.toolExposure).map(([tool, value]) => [
          tool,
          resolveMcpExposureAlias(value),
        ]),
      )
    : raw.toolExposure;
  if (exposure !== undefined && !isMcpExposure(exposure)) return undefined;
  if (toolExposure !== undefined) {
    if (!isPlainRecord(toolExposure)) return undefined;
    if (!Object.values(toolExposure).every((value) => isMcpExposure(value))) return undefined;
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") return undefined;
  if (raw.description !== undefined && typeof raw.description !== "string") return undefined;
  if (raw.timeout !== undefined && (typeof raw.timeout !== "number" || !(raw.timeout > 0))) {
    return undefined;
  }
  if (raw.type === "sse") return undefined;
  const server: MirroredMcpServer = {
    enabled: raw.enabled as boolean | undefined,
    exposure: exposure as string | undefined,
    toolExposure: toolExposure as Record<string, string> | undefined,
  };
  const type = raw.type;
  if (
    typeof raw.url === "string" &&
    (type === undefined || type === "http" || type === "streamable-http")
  ) {
    if (!isHttpTransportUrl(raw.url)) return undefined;
    if (raw.headers !== undefined && !isStringRecord(raw.headers)) return undefined;
    return server;
  }
  if (typeof raw.command === "string" && (type === undefined || type === "stdio")) {
    if (
      raw.args !== undefined &&
      !(Array.isArray(raw.args) && raw.args.every((arg) => typeof arg === "string"))
    ) {
      return undefined;
    }
    if (raw.env !== undefined && !isStringRecord(raw.env)) return undefined;
    if (raw.cwd !== undefined && typeof raw.cwd !== "string") return undefined;
    return server;
  }
  return undefined;
}

interface McpEvidenceState {
  /** The last boolean seen wins, which is how a project value overrides the global one. */
  autoEnableCodemode: boolean | undefined;
  servers: Map<string, { namespace: string; server: MirroredMcpServer }>;
  error: string | undefined;
}

/** Which of the two files is being folded — pi reads one rule differently per scope. */
type McpConfigScope = "global" | "project";

/**
 * Record a probe failure without losing an earlier one.
 *
 * pi keeps an `errors` ARRAY (`config.js:78`) and pushes one entry per failing file (`config.js:40-53`),
 * so two
 * broken `mcp.json` files are two reported problems. A single carried string with
 * last-write-wins reported one of them and let the user believe the other was fine — the
 * global file is folded first, so the project file's error always erased it. Semicolon-joined
 * because the resolution's `error` is one string (the session-start notice emits one line);
 * nothing here decides anything on its own, so the join is the whole of the loss.
 */
function noteMcpError(state: McpEvidenceState, message: string): void {
  state.error = state.error === undefined ? message : `${state.error}; ${message}`;
}

/**
 * pi's `readConfigFile` (`dist/extensions/mcp/config.js:34-72`) with its `errors` array collapsed
 * into the one carried error. An absent file contributes nothing and says nothing (pi's
 * `existsSync` check, `:36-37`); a file that exists and cannot be READ is carried as the error
 * pi would have pushed (`:39-44` wraps the read and the parse in one `try`). A server pi drops —
 * invalid name, shape or config — contributes nothing, exactly as in pi; the reason is not
 * carried because pi reports it once at startup and a second copy of the same line would be
 * noise, while the probe's own I/O failures ARE carried.
 */
function foldMcpConfigFile(
  path: string,
  raw: string | undefined,
  readError: string | undefined,
  scope: McpConfigScope,
  state: McpEvidenceState,
): void {
  if (raw === undefined) {
    // pi's `existsSync` guard skips an absent file without a word (`config.js:36-37`). A file
    // that EXISTS but could not be read is a different case: pi's read and parse share one
    // `try` (`:39-44`), so it reports one, and so do we.
    if (readError !== undefined) noteMcpError(state, readError);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    noteMcpError(
      state,
      `${path} is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
    return;
  }
  if (
    !isPlainRecord(parsed) ||
    (parsed.mcpServers !== undefined && !isPlainRecord(parsed.mcpServers))
  ) {
    noteMcpError(state, `${path} must contain a JSON object with an "mcpServers" object`);
    return;
  }
  if (typeof parsed.autoEnableCodemode === "boolean") {
    state.autoEnableCodemode = parsed.autoEnableCodemode;
  } else if (parsed.autoEnableCodemode !== undefined) {
    noteMcpError(state, `${path}: autoEnableCodemode must be a boolean`);
  }
  for (const [name, value] of Object.entries(parsed.mcpServers ?? {})) {
    const server = mirrorMcpServerConfig(name, value);
    if (server === undefined) continue;
    // pi's one scope rule, and it lives in the file reader rather than in the validator: a
    // project may not put `auth` on a URL server, so a repository cannot choose where its
    // credential goes (`config.js:66-69`). Mirrored rather than listed as an omission, because
    // it is one comparison and its absence would make a trusted project's file count a server
    // pi drops.
    if (scope === "project" && isPlainRecord(value) && "url" in value && value.auth) continue;
    // pi's namespace clash rule (`config.js:60-64`): names differing only in `-` / `_` would
    // share `mcp__<server>`, and the LATER server is dropped.
    const namespace = `mcp__${name.replace(/-/g, "_")}`;
    const clash = [...state.servers.entries()].some(
      ([other, entry]) => other !== name && entry.namespace === namespace,
    );
    if (clash) continue;
    // Same-name project entries REPLACE the global one, which is what `Map.set` does here.
    state.servers.set(name, { namespace, server });
  }
}

/** One `mcp.json`, as {@link resolveMcpAutoEnableEvidence} takes it. */
export interface McpConfigFileInput {
  path: string;
  /** The file's raw content, or `undefined` when the file is absent or unreadable. */
  raw: string | undefined;
  /**
   * Why the file could not be READ (a permission, a directory, a symlink loop), or `undefined`
   * when it was absent or read fine. The two are different facts: pi skips an absent file
   * silently (`config.js:36-37`) and pushes an error for a file it could not read
   * (`config.js:39-44`, which wraps the read and the parse in one `try`), so collapsing them
   * here would make a probe failure look like a decision.
   */
  readError?: string;
}

/** Whether pi's MCP extension will activate `codemode` from this config, and what it cost to know. */
export interface McpAutoEnableEvidence {
  autoEnablesCodemode: boolean;
  /** Set when an `mcp.json` could not be read as a JSON object; that file contributed nothing. */
  error?: string;
}

/**
 * pi's `ensureDiscoveryActive` decision as a pure function of the two `mcp.json` files
 * (`dist/extensions/mcp/index.js:352-389`).
 *
 * The fold order is pi's `loadMcpConfig` (`config.js:77-87`): the global file, then the project
 * file, so a project `autoEnableCodemode` replaces the global one and a project server replaces
 * the global server of the same name.
 *
 * pi computes this "from the config, so the tool is active before the servers connect"
 * (`index.js:353-354`) — which is what makes a config mirror exact rather than approximate:
 * whether a server CONNECTS is not an input, so a server that fails to connect does not stop pi
 * from activating `codemode`, and a config naming one is enough evidence for us. The remaining pi
 * condition is the tool being registered at all (`hasCodemode`, `:367`), which is the presence
 * and switch probes this package already runs.
 */
export function resolveMcpAutoEnableEvidence(
  globalFile: McpConfigFileInput,
  projectFile: McpConfigFileInput,
): McpAutoEnableEvidence {
  const state: McpEvidenceState = {
    autoEnableCodemode: undefined,
    servers: new Map(),
    error: undefined,
  };
  foldMcpConfigFile(globalFile.path, globalFile.raw, globalFile.readError, "global", state);
  foldMcpConfigFile(projectFile.path, projectFile.raw, projectFile.readError, "project", state);
  const needsCodemode = [...state.servers.values()].some(({ server }) => {
    if (server.enabled === false) return false;
    // `configuredExposures` (`index.js:64-66`): the server's own exposure (default `codemode`)
    // union the per-tool overrides.
    const exposures = new Set<string>([
      server.exposure ?? "codemode",
      ...Object.values(server.toolExposure ?? {}),
    ]);
    return exposures.has("codemode");
  });
  return {
    autoEnablesCodemode: state.autoEnableCodemode !== false && needsCodemode,
    ...(state.error !== undefined ? { error: state.error } : {}),
  };
}

/**
 * Read the two files pi's `loadMcpConfig` reads (`config.js:79-81`): `<agentDir>/mcp.json`, then
 * `<cwd>/.pi/mcp.json`.
 *
 * The project file is read unconditionally, accepting the same over-prediction hazard ADR-0029
 * records for project settings: an untrusted project's `mcp.json` is ignored by pi
 * (`loadMcpConfig` takes `projectTrusted`, `config.js:80`) and counted by this probe. That too
 * can only claim `active` when pi says `inactive` — the direction the decision-4 warning bounds.
 */
export function readMcpAutoEnableEvidence(agentDir: string, cwd: string): McpAutoEnableEvidence {
  const read = (path: string): McpConfigFileInput => {
    try {
      return { path, raw: readFileSync(path, "utf8") };
    } catch (error) {
      // Absent is the normal case and is silent, exactly as in pi's `existsSync` guard. A file
      // that exists and cannot be read is not the same fact: pi's read and parse share one `try`
      // (`config.js:39-44`) and report it, so the probe has to as well — otherwise "codemode will
      // stay inactive" and "we could not tell" would resolve to the same answer, and only one of
      // them is a decision. `ENOENT` is the only absence; every other code is a read failure
      // (`EACCES`, `EISDIR` — a directory named `mcp.json` is real — `ELOOP`, …).
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOENT"
        ? { path, raw: undefined }
        : {
            path,
            raw: undefined,
            readError: `${path} could not be read (${error instanceof Error ? error.message : String(error)})`,
          };
    }
  };
  return resolveMcpAutoEnableEvidence(
    read(join(agentDir, "mcp.json")),
    read(join(cwd, ".pi", "mcp.json")),
  );
}

/**
 * Union the loadout mirror with the MCP evidence. pi's MCP extension ADDS `codemode` to whatever
 * loadout resolved — `pi.setActiveTools([...active, ...activate])` (`index.js:377-378`) — so
 * either source being positive means the model can call it, and a CLI allowlist excluding
 * `codemode` does not veto it.
 *
 * When both agree the loadout's provenance wins: it is the answer the user configured, and naming
 * it in a notice would point at the file they edited rather than at a default. `"mcp"` means the
 * loadout said `inactive` and the evidence said otherwise.
 */
export function applyMcpAutoEnableEvidence(
  loadout: CodemodeActivationResolution,
  mcp: McpAutoEnableEvidence,
): CodemodeActivationResolution {
  const withError = mcp.error === undefined ? loadout : { ...loadout, mcpError: mcp.error };
  if (loadout.activation === "active" || !mcp.autoEnablesCodemode) return withError;
  // Spread the incoming answer rather than building a fresh object: an `error` it carries is a
  // probe failure of the OTHER source, and the evidence has nothing to say about it. Dropping it
  // here is the same silent loss `mcpError` exists to prevent, one field over.
  return {
    ...loadout,
    activation: "active",
    source: "mcp",
    ...(mcp.error !== undefined ? { mcpError: mcp.error } : {}),
  };
}

/**
 * The surface to use when the user has expressed no preference. Not a constant: a pi that ships
 * `codemode` already offers the model a second way to orchestrate, and answering that by
 * handing our orchestration surface away is the whole point of `subagents` mode (ADR-0026) —
 * but only while that `codemode` is actually going to run (ADR-0027).
 *
 * The five cases, as a table (ADR-0029 adds the last row):
 *
 * | codemode on disk | switch         | activation | surface     | why                                        |
 * | ---------------- | -------------- | ---------- | ----------- | ------------------------------------------ |
 * | no               | any            | any        | `full`      | nothing to hand it to                      |
 * | yes              | disabled       | any        | `full`      | the extension we would hand away is not loading |
 * | yes              | enabled/absent | active     | `subagents` | loaded, and the model can call it           |
 * | yes              | enabled/absent | inactive   | `full`      | loaded but not callable — do not delegate  |
 *
 * The fourth row is the default on a real install, and it is the reason this takes three
 * arguments: pi registers `codemode` with `defaultActive: false`, so "pi ships it" and "pi loads
 * it" are both true on an ordinary session that configured nothing, and neither means the model
 * can call it. `active` may rest on either evidence class — a loadout naming codemode, or
 * ADR-0033's MCP auto-enable evidence — because both say the same thing about the model.
 */
export function detectedSurfaceMode(
  presence: CodemodePresence,
  codemodeSwitch: CodemodeSwitch,
  codemodeActivation: CodemodeActivation,
): SurfaceMode {
  if (!presence.present) return FALLBACK_SURFACE_MODE;
  if (codemodeSwitch === "disabled") return FALLBACK_SURFACE_MODE;
  if (codemodeActivation !== "active") return FALLBACK_SURFACE_MODE;
  return "subagents";
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

/** The detected surface, plus every probe result `session_start` reports on. */
export interface DetectedSurface {
  /** What this package registers. Decided by {@link detectedSurfaceMode}; never configured. */
  surfaceMode: SurfaceMode;
  /** Whether this pi ships a `codemode` at all. */
  codemode: CodemodePresence;
  /** Whether pi will load it (ADR-0027). */
  codemodeSwitch: CodemodeSwitchResolution;
  /** Whether the model will be able to call it (ADR-0029), the third axis of the table. */
  codemodeActivation: CodemodeActivationResolution;
}

/**
 * Decide the surface by asking the pi. A pure function of the three probes and nothing else.
 *
 * This used to read a `surfaceMode` key first and only fall back to the probes, and the argument
 * for that was an escape hatch: pi has `registerTool` but no `unregisterTool`, so a surface chosen
 * wrongly cannot be corrected once the factory has returned — a session that got the wrong answer
 * keeps it until it restarts. That argument is real, and it is also why the hatch is gone rather
 * than merely narrowed:
 *
 * - **The wrong answer is now reported rather than prevented.** `session_start` measures the live
 *   registry against all three probes and says so when they disagree (ADR-0029), which a pinned
 *   value used to suppress.
 * - **The direction that actually hurts is not reachable by a setting anyway.** A pin can only
 *   make the surface *more* capable than detection, never less: every way the probes come back
 *   wrong (`subagents` chosen for a `codemode` that cannot run) resolves to `full`, and no value
 *   the file could hold would have produced a better outcome than the one already chosen.
 * - **Disabling is pi's job now.** The `off` value existed because a package that cannot be
 *   switched off is a package that stays loaded forever. `pi config` turns a package's extensions
 *   off without loading them — measured, not assumed: on pi 1.1.0 a `packages` entry whose
 *   `extensions` is `[]` or `["!dist/index.js"]` does not load the extension at all, while
 *   `["+dist/index.js"]` and an absent key both do. That is a channel this package cannot offer
 *   for itself, because the switch that uses it is pi's.
 *
 * The `presence` and `codemodeSwitch` arguments stay parameters rather than hidden calls, so a
 * test can state the pi it is reasoning about instead of depending on the machine it runs on.
 *
 * The probes are resolved here rather than in default parameters, so every call pays for all
 * three — the shortcut that used to exist (`a default parameter is evaluated on EVERY call`)
 * saved real work only when a key short-circuited the probes entirely, and there is no key left.
 * The cost, named rather than rounded: each of the two settings-reading probes reads the SAME two
 * files, so one detection is four settings reads over two files plus the two `mcp.json` reads
 * ADR-0033 added. The duplication is pre-existing and deliberate — each probe is copied from pi
 * whole and kept self-contained — so the number is recorded, not optimised.
 */
export function detectSurfaceMode(
  agentDir: string,
  presence?: CodemodePresence,
  codemodeSwitch?: CodemodeSwitchResolution,
  codemodeActivation?: CodemodeActivationResolution,
  cwd: string = process.cwd(),
): DetectedSurface {
  const probed = presence ?? probeCodemodePresence();
  const sw = codemodeSwitch ?? readCodemodeSwitch(agentDir, cwd);
  const act = codemodeActivation ?? readCodemodeActivation(agentDir, cwd);
  return {
    surfaceMode: detectedSurfaceMode(probed, sw.switch, act.activation),
    codemode: probed,
    codemodeSwitch: sw,
    codemodeActivation: act,
  };
}

/** A `surfaceMode` left in `ptc.json` by a release that still had the key. */
export interface LegacySurfaceKey {
  /** The path it was found in, or `undefined` when there was no file to look in. */
  path: string;
  /** The value that was there, or the JSON rendering when it was not a string. */
  value: unknown;
}

/**
 * Read a `surfaceMode` key that this package no longer acts on, so `session_start` can say so.
 *
 * The key shipped in v1.6.0 and the three values it took are gone, which means a user who set
 * `"off"` to keep this package out of their sessions would find it back on the next upgrade with
 * nothing to explain why. Nothing here restores the behaviour: the returned value is only ever
 * turned into a notice that names the replacement. The alternative — honouring `off` forever as a
 * compatibility shim — is the switch this change exists to delete, and it would leave the package
 * carrying two ways to be disabled, one of which silently does nothing.
 *
 * Returns `undefined` for an absent file, an absent key, and for a file this cannot parse or that
 * is not an object. Those last two are NOT reported here: a `ptc.json` too broken to read has no
 * `surfaceMode` to be stale about, and the parse failure belongs to whoever owns that file
 * (`defaultMode` still lives there, and {@link readDefaultModeConfig} is what reports it).
 */
export function readLegacySurfaceKey(agentDir: string): LegacySurfaceKey | undefined {
  const path = join(agentDir, PTC_MODE_CONFIG_FILE);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const value = (parsed as { surfaceMode?: unknown }).surfaceMode;
  return value === undefined ? undefined : { path, value };
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
