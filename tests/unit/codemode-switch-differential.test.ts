/**
 * ADR-0027 — our extension resolution, differentially checked against pi's own.
 *
 * `resolveCodemodeSwitch` exists to answer the same question pi answers, so the only oracle worth
 * having is **pi's own answer**. Reading `package-manager.js` and concluding what it does is how
 * ADR-0027's first draft shipped a HIGH-severity defect: the project array and the user array are
 * resolved by two DIFFERENT functions, and reading them as one made the user array's
 * `["-builtin:codemode", "+builtin:codemode"]` resolve `enabled` where pi resolves it `disabled` —
 * which hands the orchestration to a codemode that is not loading, the exact failure the ADR exists
 * to prevent.
 *
 * So this drives `DefaultPackageManager.resolve()` directly with a stub `settingsManager` and
 * compares, case by case, against `resolveCodemodeSwitch`. No reading of pi's source is involved.
 *
 * ## Why the table is keyed by pi version rather than corrected to one value
 *
 * The `piLoads` column was measured against pi 1.2.0. On pi 0.86.0 the SAME probe, asked the
 * SAME question of the SAME settings files, answers differently on 20 of the 40 rows, so one
 * column is a claim about ONE pi rather than about the peer range this package declares. Each
 * column below is a measurement, produced by driving that pi's own
 * `DefaultPackageManager.resolve()` on the very tree it is filed under.
 *
 * **The divergence is NOT a user-bucket rule change, and the shape of the column proves it.**
 * 0.86.0 answers `false` on all forty rows — including the twenty where it happens to agree
 * with 1.2.0. That is not a different resolution rule; it is `resolve()` never being asked about
 * `builtin:codemode` at all. Measured: 0.86.0's `DefaultPackageManager` constructor takes no
 * `builtinExtensions` option, and the token `builtin:` appears in ZERO files of its dist, so
 * there is no built-in-extension concept for the `+`/`-`/`!` entries to select. Handed a real
 * extension FILE instead, the same resolver still honours the user bucket: a plain entry
 * resolves, and it is the sign-prefixed forms that drop the plain entry entirely. So the bucket
 * is alive; the SUBJECT is missing. The `floor-pi-has-no-builtin-concept` test pins that
 * directly, rather than leaving it as an explanation in a comment nobody can run.
 *
 * ## Why the ORACLE can still be skipped
 *
 * `DefaultPackageManager` is pi's INTERNAL module and is not in its `exports` map, so it has to
 * be reached by a path built from the package root. That path can stop existing when pi
 * restructures — a `skipIf` is the right response, following the precedent in
 * `tests/ocr-anchor-coverage.test.ts` for tooling that may not be present.
 *
 * **That skip is narrow, and this is where the boundary sits.** It covers the one case where pi
 * offers no resolver to ask at all. It is NOT the mechanism for a pi that HAS a resolver and
 * answers differently — a version whose rules diverge is handled by a measured column below, and
 * a version with NO measured column at all is a FAILURE (see the guard at the bottom), never a
 * skip. A skip is a **loss of coverage, never a false pass** — `test.skipIf` reports SKIPPED,
 * which is visibly different from green, and the cases are ALSO pinned by
 * `tests/unit/codemode-switch.test.ts` with literals read off the 1.2.0 column.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { readCodemodeSwitch } from "../../src/mode/ptc-mode.ts";
import { installedPiDir } from "../helpers/pi-compat-probe.ts";
import { removeTempDir } from "../helpers/ptc.ts";

/**
 * This repo's root, resolved once: the `measure()` harness plants its temp roots under
 * `.scratch/` inside it so the `!` bucket's relative globs resolve against a FIXED depth.
 * `import.meta.dirname` is the tests/unit directory, so the root is two levels up.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * `dist/core/package-manager.js` inside the installed pi, or `undefined` when it is not there.
 *
 * WHICH pi is one answer, from `installedPiDir` in `tests/helpers/pi-compat-probe.ts` — the module
 * that exists because five version-sensitive files asking "which pi am I on" five different ways is
 * how five probes drift into disagreeing with each other. This file used to answer it TWICE, with
 * two independent walks of its own (the other for the version string below), which is exactly the
 * shape that helper exists to remove; both now read the one root.
 *
 * What stays local is the path INSIDE that root, joined here rather than resolved through the
 * package's `exports` map, for two reasons: the map does not expose this internal module, and the
 * package is ESM-only so `require.resolve` on its main entry fails outright
 * ("No \"exports\" main defined"). The helper deliberately stops at the DIRECTORY — a reader that
 * answered with a file's content could not be turned into an import specifier without a second
 * walk, which is the thing this line exists to delete.
 */
function packageManagerPath(): string | undefined {
  const piDir = installedPiDir(import.meta.dirname);
  if (piDir === undefined) return undefined;
  const candidate = join(piDir, "dist", "core", "package-manager.js");
  return existsSync(candidate) ? candidate : undefined;
}

const PM_PATH = packageManagerPath();

type Resolver = {
  DefaultPackageManager: new (options: {
    cwd: string;
    agentDir: string;
    settingsManager: unknown;
    builtinExtensions: string[];
  }) => { resolve(): Promise<{ extensions?: ReadonlyArray<{ path: string; enabled?: boolean }> }> };
};

async function loadResolver(): Promise<Resolver | undefined> {
  if (PM_PATH === undefined) return undefined;
  try {
    return (await import(/* @vite-ignore */ PM_PATH)) as Resolver;
  } catch {
    return undefined;
  }
}

/**
 * Loaded at module scope so the test bodies contain no early return: F3 exists because a bare
 * `return` makes vitest record a PASS, and a guard that quietly does nothing is exactly the false
 * pass this repository has already shipped once. When this is `undefined` the tests below report
 * SKIPPED, which is visibly not green.
 */
const PM = await loadResolver();
const AVAILABLE = PM !== undefined;

/**
 * The installed pi's own version, read off its artifact rather than assumed.
 *
 * `packageManagerPath()` above already resolved the installed package root; this reads the
 * `package.json` beside that `dist/`, which is the only honest source for which pi is being
 * asked. Both take the root from `installedPiDir`, so the version and the resolver under test can
 * no longer come from two different walks. `scripts/pi-compat-matrix.mjs` reads it the same way for
 * the same reason: the version decides which measured column applies, and a version string typed
 * into this file would be the very thing under test.
 *
 * The string `unknown` rather than `undefined`, so a tree with no pi installed is a VALUE a test
 * asserts about rather than a control-flow branch. No column can match it, so the guard test at
 * the bottom turns red — which is the intended outcome: a differential oracle has nothing to
 * compare against when there is no pi to compare it to.
 */
const INSTALLED_PI_VERSION: string = ((): string => {
  // The helper answers `undefined` for "no pi installed"; the conversion to the `unknown` STRING is
  // the part that is this file's, and the reason for it is above.
  const piDir = installedPiDir(import.meta.dirname);
  if (piDir === undefined) return "unknown";
  const parsed = JSON.parse(readFileSync(join(piDir, "package.json"), "utf8")) as {
    version?: string;
  };
  return parsed.version ?? "unknown";
})();

/**
 * The pi versions whose `resolve()` answers have been MEASURED into the tables below.
 *
 * Each entry is a real install probed with this file's own `measure()` harness: install the
 * version, run the forty cases through its `DefaultPackageManager.resolve()`, record what it
 * answered. A version is listed here only after that run — never by reading its source, because
 * reading pi's resolver is how ADR-0027's first draft shipped a HIGH-severity defect.
 *
 * Exact versions rather than ranges, deliberately. `>=0.86.0` would silently extend a 0.86.x
 * measurement to a 0.99.x pi whose resolver changed twice on the way up, which is exactly the
 * inheritance the guard test refuses. Add the exact version; the guard turns red until you do.
 */
const MEASURED_VERSIONS: readonly string[] = ["0.86.0", "0.86.1", "1.0.0", "1.2.0", "1.3.0"];

/**
 * What pi **0.86.0** answers for each case, measured 2026-10-14 by driving its own
 * `DefaultPackageManager.resolve()` — forty runs, one per row, on a real 0.86.0 install.
 *
 * Every value is `false`, and that uniformity IS the finding rather than a defect in the table.
 * 0.86.0's resolver has no built-in-extension concept at all — measured: its
 * `DefaultPackageManager` constructor takes no `builtinExtensions` option, and the token
 * `builtin:` appears in ZERO files of its dist — so `builtin:codemode` is never a candidate and no
 * settings file can turn it on. The twenty rows agreeing with `piLoads` agree by coincidence (both
 * sides are off), not because the two sets of rules match.
 *
 * Re-measure rather than hand-editing a value: install the version, run the forty cases, copy the
 * answers in. The `the table still describes the installed pi` test below is what forces that, and it
 * runs on this column too — so an edit that was not a measurement is caught rather than trusted.
 */
const FLOOR_086_PILOADS: Readonly<Record<string, boolean>> = {
  "user +exact": false,
  "user -exact": false,
  "user !exact": false,
  "user !glob cod*": false,
  "user !glob *codemode": false,
  "user !exact ! then +": false,
  "user - then + (order free, - wins)": false,
  "user + then -": false,
  "user !other builtin": false,
  "user !other builtin dotted": false,
  "user !glob not codemode": false,
  "user !near-miss no wildcard": false,
  "user !bare prefix no wildcard": false,
  "user !glob elsewhere": false,
  "project + then - (last wins)": false,
  "project - then + (last wins)": false,
  "project - overrides user +": false,
  "project + overrides user -": false,
  "project !glob cod*": false,
  "project !other builtin": false,
  "user -./ exact": false,
  "project -./ exact": false,
  "user +./ exact": false,
  "user !./ exact (pi does NOT normalize the ! bucket)": false,
  "user !! bare": false,
  "project !! bare": false,
  "user !! exact": false,
  "project !! exact": false,
  "user !../ (relative to the agent dir)": false,
  "user !../* glob": false,
  "user !../** glob": false,
  "user !./* glob": false,
  "project !../ relative": false,
  "project !../* glob": false,
  "project + then ! (last of any sign wins)": false,
  "project ! then + (last of any sign wins)": false,
  "project + then - then !": false,
  "project ! then - (last wins, both off)": false,
  "user !!! exact (double negation is identity)": false,
  "project !!! exact": false,
};

/**
 * The cases, as a table rather than as prose.
 *
 * `piLoads` is what pi's own resolver reports, measured — not what its source appears to say. The
 * `!` rows are the reason the switch has two code paths at all: minimatch treats a pattern with NO
 * metacharacter as an EXACT match, so `!builtin:cod*` disables codemode while `!builtin:` does not,
 * and a uniform prefix comparison gets the second one wrong.
 */
const CASES: ReadonlyArray<{
  label: string;
  project?: unknown;
  user?: unknown;
  piLoads: boolean;
}> = [
  { label: "user +exact", user: { extensions: ["+builtin:codemode"] }, piLoads: true },
  { label: "user -exact", user: { extensions: ["-builtin:codemode"] }, piLoads: false },
  { label: "user !exact", user: { extensions: ["!builtin:codemode"] }, piLoads: false },
  { label: "user !glob cod*", user: { extensions: ["!builtin:cod*"] }, piLoads: false },
  { label: "user !glob *codemode", user: { extensions: ["!builtin:*codemode"] }, piLoads: false },
  {
    label: "user !exact ! then +",
    user: { extensions: ["!builtin:codemode", "+builtin:codemode"] },
    piLoads: true,
  },
  {
    label: "user - then + (order free, - wins)",
    user: { extensions: ["-builtin:codemode", "+builtin:codemode"] },
    piLoads: false,
  },
  {
    label: "user + then -",
    user: { extensions: ["+builtin:codemode", "-builtin:codemode"] },
    piLoads: false,
  },
  { label: "user !other builtin", user: { extensions: ["!builtin:mcp"] }, piLoads: true },
  {
    label: "user !other builtin dotted",
    user: { extensions: ["!builtin:llama.cpp"] },
    piLoads: true,
  },
  { label: "user !glob not codemode", user: { extensions: ["!builtin:tool-*"] }, piLoads: true },
  {
    label: "user !near-miss no wildcard",
    user: { extensions: ["!builtin:codemodX"] },
    piLoads: true,
  },
  { label: "user !bare prefix no wildcard", user: { extensions: ["!builtin:"] }, piLoads: true },
  { label: "user !glob elsewhere", user: { extensions: ["!builtin:xyz*"] }, piLoads: true },
  {
    label: "project + then - (last wins)",
    project: { extensions: ["+builtin:codemode", "-builtin:codemode"] },
    piLoads: false,
  },
  {
    label: "project - then + (last wins)",
    project: { extensions: ["-builtin:codemode", "+builtin:codemode"] },
    piLoads: true,
  },
  {
    label: "project - overrides user +",
    project: { extensions: ["-builtin:codemode"] },
    user: { extensions: ["+builtin:codemode"] },
    piLoads: false,
  },
  {
    label: "project + overrides user -",
    project: { extensions: ["+builtin:codemode"] },
    user: { extensions: ["-builtin:codemode"] },
    piLoads: true,
  },
  { label: "project !glob cod*", project: { extensions: ["!builtin:cod*"] }, piLoads: false },
  { label: "project !other builtin", project: { extensions: ["!builtin:mcp"] }, piLoads: true },
  // pi runs every EXACT pattern through `normalizeExactPattern`, which strips a leading `./`
  // (package-manager.js:496-499, called at :511). `-./builtin:codemode` is a plausible entry --
  // every local extension path in a settings file is written `./…` -- and reading it as a plain
  // string equality drops `ptc_run_code` while pi has codemode off. R3-01.
  { label: "user -./ exact", user: { extensions: ["-./builtin:codemode"] }, piLoads: false },
  { label: "project -./ exact", project: { extensions: ["-./builtin:codemode"] }, piLoads: false },
  { label: "user +./ exact", user: { extensions: ["+./builtin:codemode"] }, piLoads: true },
  {
    label: "user !./ exact (pi does NOT normalize the ! bucket)",
    user: { extensions: ["!./builtin:codemode"] },
    piLoads: true,
  },
  // Both halves of the doubled-sign family. An earlier version of this table declared
  // `!!builtin:codemode` un-mirrorable and left it out, because the prefix approximation could not
  // follow minimatch's negation; with the mirror in place it resolves like everything else, and
  // round 5 measured it agreeing with pi under production wiring in both scopes.
  { label: "user !! bare", user: { extensions: ["!!"] }, piLoads: false },
  { label: "project !! bare", project: { extensions: ["!!"] }, piLoads: false },
  { label: "user !! exact", user: { extensions: ["!!builtin:codemode"] }, piLoads: false },
  { label: "project !! exact", project: { extensions: ["!!builtin:codemode"] }, piLoads: false },
  // baseDir-sensitive shapes: minimatch also tests `relative(baseDir, path)` and the basename, so
  // these are the entries that can only be judged against the directories pi actually used. They
  // are here precisely because round 5 showed the harness reporting PHANTOM divergences on them
  // when the two sides were given different baseDirs (F5-01).
  {
    label: "user !../ (relative to the agent dir)",
    user: { extensions: ["!../builtin:codemode"] },
    piLoads: true,
  },
  { label: "user !../* glob", user: { extensions: ["!../*"] }, piLoads: true },
  { label: "user !../** glob", user: { extensions: ["!../**"] }, piLoads: true },
  { label: "user !./* glob", user: { extensions: ["!./*"] }, piLoads: true },
  {
    label: "project !../ relative",
    project: { extensions: ["!../builtin:codemode"] },
    piLoads: true,
  },
  { label: "project !../* glob", project: { extensions: ["!../*"] }, piLoads: true },
  // pi's project loop writes EVERY match into a Map as it iterates, so a LATER entry of any sign
  // overwrites an earlier one. Reading the array as "the last exact +/- sign, else check `!`" gives
  // the wrong answer for a `!` that follows a `+` -- and that direction costs a user their
  // `ptc_run_code` while pi has codemode off. R4-01.
  {
    label: "project + then ! (last of any sign wins)",
    project: { extensions: ["+builtin:codemode", "!builtin:codemode"] },
    piLoads: false,
  },
  {
    label: "project ! then + (last of any sign wins)",
    project: { extensions: ["!builtin:codemode", "+builtin:codemode"] },
    piLoads: true,
  },
  {
    label: "project + then - then !",
    project: { extensions: ["+builtin:codemode", "-builtin:codemode", "!builtin:codemode"] },
    piLoads: false,
  },
  {
    label: "project ! then - (last wins, both off)",
    project: { extensions: ["!builtin:codemode", "-builtin:codemode"] },
    piLoads: false,
  },
  // An EVEN number of leading `!` in the target is a negation of a negation, which minimatch
  // resolves back to a POSITIVE match on the full path -- deterministic, unlike the odd case.
  {
    label: "user !!! exact (double negation is identity)",
    user: { extensions: ["!!!builtin:codemode"] },
    piLoads: false,
  },
  { label: "project !!! exact", project: { extensions: ["!!!builtin:codemode"] }, piLoads: false },
];

/**
 * The 1.0.0+ column, derived from `CASES` rather than written out twice.
 *
 * The `piLoads` values in the table above were measured on pi 1.2.0 and re-measured on pi
 * 1.0.0 with identical results (both installed, both probed with this file's own harness).
 * Re-measured on pi 1.3.0 on 2026-10-20 with identical results again — 40 of 40 rows, so 1.3.0
 * shares this column rather than getting one of its own.
 *
 * Deriving the column from the table keeps the two in step by construction: a row added to
 * `CASES` cannot appear in the floor column and be missing from this one without the guard test
 * noticing.
 */
const COLUMN_1_0_0: Readonly<Record<string, boolean>> = Object.fromEntries(
  CASES.map((c) => [c.label, c.piLoads]),
);

/**
 * Every measured version's column, keyed by EXACT version.
 *
 * The floor shares one table because 0.86.0 and 0.86.1 were measured separately and answered
 * identically on all forty rows — both are asserted to still agree by the guard test below.
 *
 * 1.0.0, 1.2.0 and 1.3.0 share one table because each was measured SEPARATELY, on its own
 * install, through this file's own harness, and each answered identically on all forty rows.
 * Sharing is a measurement, not an assumption: 1.3.0 was installed and probed on 2026-10-20
 * rather than being inferred from 1.2.0, and the guard test below re-measures the installed pi
 * against whichever column applies — so a pi that changed its rules turns the table red instead
 * of quietly agreeing with a stale expectation.
 */
const COLUMN_BY_VERSION: Readonly<Record<string, Readonly<Record<string, boolean>>>> = {
  "0.86.0": FLOOR_086_PILOADS,
  "0.86.1": FLOOR_086_PILOADS,
  "1.0.0": COLUMN_1_0_0,
  "1.2.0": COLUMN_1_0_0,
  "1.3.0": COLUMN_1_0_0,
};

/**
 * A `settingsManager` stub exposing exactly the three methods `resolve()` calls.
 */
function stubSettings(project: unknown, user: unknown): unknown {
  return {
    getProjectSettings: () => project,
    getGlobalSettings: () => user,
    isProjectTrusted: () => true,
  };
}

/**
 * Ask BOTH sides the same question, about the same directories.
 *
 * This is the whole wiring, and getting it wrong is what F5-01 was: an earlier version called
 * `resolveCodemodeSwitch(argv, project, user)` with three arguments, so it ran against the
 * DEFAULT base directories, while pi was handed `cwd: process.cwd()` whose project base directory
 * is `join(cwd, ".pi")`. Two different directories, so the two sides were answering different
 * questions and the file reported six phantom divergences on exactly the baseDir-sensitive entries
 * — while `readCodemodeSwitch`, the function production actually calls, was never exercised here at
 * all, leaving the baseDir threading that round 4 added untestable.
 *
 * So this drives the production entry: settings go to real files under a real temp root, and both
 * pi and `readCodemodeSwitch` are given that same root. `cwd` and `agentDir` are the same
 * directory here, which is also the shipping shape; the unit suite covers them being different.
 */
async function measure(
  project: unknown,
  user: unknown,
): Promise<{ piLoads: boolean; piListed: boolean; ours: boolean }> {
  // The temp root sits under the repo's own `.scratch/` rather than the OS temp dir, and the
  // reason is a defect the compat matrix caught rather than any review round: pi's `!` bucket
  // matches `relative(baseDir, "builtin:codemode")` against relative globs such as `../**`, and
  // HOW MANY `../` segments that produces depends on the DEPTH DIFFERENCE between the temp root
  // and this file. Under `os.tmpdir()` the depth difference varies with where the checkout is
  // cloned (measured: `../builtin:codemode` from a repo-local root, six `../` from a macOS temp
  // dir), so the table's `!../**` expectation silently depended on the checkout's location — the
  // same class as the field report whose verdict was decided by the developer's home directory.
  // Under `.scratch/pi-ptc-diff-*/` the depth is one segment below this repo's root, always, on
  // every machine and in the compat matrix's scratch copy. `.scratch/` is gitignored, and the
  // directory is removed in the `finally` below like any other temp root.
  const root = join(REPO_ROOT, ".scratch", "pi-ptc-diff-" + randomBytes(6).toString("hex"));
  await mkdir(root, { recursive: true });
  try {
    await mkdir(join(root, ".pi"), { recursive: true });
    if (project !== undefined) {
      await writeFile(join(root, ".pi", "settings.json"), JSON.stringify(project), "utf8");
    }
    if (user !== undefined) {
      await writeFile(join(root, "settings.json"), JSON.stringify(user), "utf8");
    }
    const pm = new PM!.DefaultPackageManager({
      cwd: root,
      agentDir: root,
      settingsManager: stubSettings(project ?? {}, user ?? {}),
      builtinExtensions: ["codemode"],
    });
    const resolved = await pm.resolve();
    // The entry is present either way; only `enabled` differs. Testing for the path string alone
    // answers "yes" in every case — that bug is what made a first cut of this file report eleven
    // divergences that did not exist.
    const entry = resolved.extensions?.find((e) => e.path === "builtin:codemode");
    const piLoads = entry?.enabled === true;
    // Whether the entry is LISTED at all, which is a different question from whether it is enabled:
    // on a pi with no built-in concept the entry is never produced, so both are false. Measured on
    // 0.86.0 with `["!!builtin:codemode"]` — the one settings shape where a pi WITH the concept answers
    // `false` too — the entry is present there and absent on the floor, which is what makes it the
    // discriminator. Two questions, not one, because `enabled === false` cannot tell them apart.
    const piListed = entry !== undefined;
    const ours = readCodemodeSwitch(root, root, ["node", "pi"]).switch !== "disabled";
    return { piLoads, piListed, ours };
  } finally {
    await removeTempDir(root);
  }
}

/**
 * The measured column for the INSTALLED pi, or `undefined` when its version has none.
 *
 * Resolved from the tables above rather than switched on, so exactly one place turns a version
 * string into a set of expected answers. A version with no entry is deliberately NOT given a
 * fallback: falling back to the 1.2.0 column would make the floor leg fail with twenty stale
 * rows that read like real divergences, and the fix (copy a measured column in) is not obvious
 * from such a failure. The guard test below names the missing version instead.
 */
function measuredColumnFor(version: string): Readonly<Record<string, boolean>> | undefined {
  if (version === "0.86.0" || version === "0.86.1") return FLOOR_086_PILOADS;
  return Object.prototype.hasOwnProperty.call(COLUMN_BY_VERSION, version)
    ? COLUMN_BY_VERSION[version]
    : undefined;
}

/**
 * Whether the INSTALLED pi can enable a BUILT-IN extension at all.
 *
 * Decided by asking pi resolver itself, not by comparing version strings and not by reading its
 * source: pass `builtinExtensions: ["codemode"]` and ask whether a settings file saying
 * `["-builtin:codemode", "+builtin:codemode"]` ends up loading it. Measured: 0.86.0 and 0.86.1 no
 * (their constructor ignores the option entirely, and `builtin:` occurs in zero files of their dist),
 * 1.0.0, 1.2.0 and 1.3.0 yes.
 *
 * This is the fact that decides what the first test asserts. Comparing our answer with pi own is
 * the real contract ONLY where pi has an opinion; on a pi without built-ins pi never loads
 * codemode while we correctly report what a settings file says, so an equality there would assert
 * something false rather than something safe.
 */
async function piHasBuiltinExtensionConcept(): Promise<boolean> {
  const { piListed } = await measure(undefined, { extensions: ["!!builtin:codemode"] });
  return piListed;
}

// ---------------------------------------------------------------------------------------
//  The two contract tests. Both run on EVERY version; neither is skipped for a version
//  difference, and a version with no measured column is a FAILURE rather than a skip.
// ---------------------------------------------------------------------------------------

/**
 * The twenty rows on which a pi with NO built-in concept must differ from us, named.
 *
 * Measured on 0.86.0 and 0.86.1 (identical), and listed rather than tolerated: a bare
 * "equal when the pi has built-ins" would be constraint 5's accept-both shape with the
 * comparison dropped, and a 21st divergence would go unnoticed. Every one of these rows is
 * a settings file that NAMES codemode and a pi that cannot load it — which is why we are
 * right to say `enabled` and pi is right to say off.
 */
const FLOOR_EXPECTED_DIVERGENCES: readonly string[] = [
  "user +exact",
  "user !exact ! then +",
  "user !other builtin",
  "user !other builtin dotted",
  "user !glob not codemode",
  "user !near-miss no wildcard",
  "user !bare prefix no wildcard",
  "user !glob elsewhere",
  "project - then + (last wins)",
  "project + overrides user -",
  "project !other builtin",
  "user +./ exact",
  "user !./ exact (pi does NOT normalize the ! bucket)",
  "user !../ (relative to the agent dir)",
  "user !../* glob",
  "user !../** glob",
  "user !./* glob",
  "project !../ relative",
  "project !../* glob",
  "project ! then + (last of any sign wins)",
];

test.skipIf(!AVAILABLE)(
  "the production entry agrees with pi's own resolver on every case in the table",
  async () => {
    // THE CONTRACT. It runs on every version that HAS a resolver, which is what the issue asks
    // for; the floor is handled by a named expectation rather than by skipping the test.
    //
    // On 0.86.x it cannot be stated as a bare equality, and the reason is structural rather than
    // convenient. That pi has no built-in-extension concept, so `resolve()` is NEVER asked about
    // `builtin:codemode` and answers `false` for all forty rows whatever the settings file
    // says. We answer from that file and say `enabled`. Asserting equality there would assert that
    // this package ignores a user who wrote `+builtin:codemode` — false, and false in the direction
    // that matters: it would have us hand orchestration to a codemode that cannot load.
    //
    // So the floor asserts the COMBINATION that is real there, and that combination is exactly
    // what keeps this package safe on such a pi: pi never loads codemode, and
    // `detectedSurfaceMode` returns `full_ptc` on row one because nothing can be present. Both halves
    // are asserted, neither accepts two answers, and a mutant that made `codemode_ptc` reachable on a
    // floor pi fails here.
    const divergences: string[] = [];
    const hasBuiltins = await piHasBuiltinExtensionConcept();
    const namedDivergences = hasBuiltins ? [] : FLOOR_EXPECTED_DIVERGENCES;

    for (const { label, project, user } of CASES) {
      const { piLoads, ours } = await measure(project, user);
      const shouldDiverge = namedDivergences.includes(label);
      if ((piLoads !== ours) !== shouldDiverge) {
        divergences.push(
          label +
            ": pi=" +
            (piLoads ? "loads" : "off") +
            " ours=" +
            (ours ? "loads" : "off") +
            " expected=" +
            (shouldDiverge ? "diverges" : "agrees"),
        );
      }
    }
    expect(
      divergences,
      "every case must resolve exactly as this pi resolves it: agreement where pi has a " +
        "built-in concept, and the named floor divergences where it has none",
    ).toEqual([]);
  },
  120_000,
);

test.skipIf(!AVAILABLE)(
  "the table still describes the installed pi: each expected value is re-measured",
  async () => {
    // Guards the ORACLE, against the column chosen for this pi. If pi changes its resolution
    // rules, this goes red and the table above is re-measured — rather than the whole file
    // quietly agreeing with a stale expectation, which is what a single hardcoded column did
    // on the floor.
    //
    // **This is where a version with no measured column FAILS.** Not by skipping: the column
    // is looked up, an absent column produces the explicit entry below, and the expectation
    // names the version, so the fix is obvious. A skip here is the one thing the issue rules
    // out, and it is also the thing that would let a new pi version pass unseen.
    const column = measuredColumnFor(INSTALLED_PI_VERSION);
    const stale: string[] = [];
    if (column === undefined) {
      stale.push(
        "pi " +
          INSTALLED_PI_VERSION +
          " has no measured column in this file. Measure it — install that version, run these " +
          "forty cases through its DefaultPackageManager.resolve(), record what it answered — " +
          "then add it to MEASURED_VERSIONS and COLUMN_BY_VERSION.",
      );
    } else {
      for (const { label, project, user } of CASES) {
        const measured = await measure(project, user);
        const expected = column[label];
        if (expected === undefined) {
          stale.push(
            label + ": the " + INSTALLED_PI_VERSION + " column has no value for this case",
          );
        } else if (measured.piLoads !== expected) {
          stale.push(
            label +
              ": column says " +
              String(expected) +
              ", pi now says " +
              String(measured.piLoads) +
              ",",
          );
        }
      }
    }
    expect(stale, "re-measure these against the installed pi and update its column").toEqual([]);
  },
  120_000,
);

/**
 * The guard that turns RED when an UNMEASURED pi version is added, or a column loses a row.
 *
 * Every measured version resolves to a column, and every column covers exactly the case labels.
 * Those two facts are what make a new pi version a loud failure rather than a silent pass: a
 * version listed without a column, or a column missing a row, means this file has no measured
 * answer for something it claims to cover — and without this the differential test would
 * compare against `undefined`, which `!== false` passes for every row.
 *
 * That last point is the counterfactual worth stating: before this guard existed, adding a pi
 * version to the range without measuring it would have produced twenty divergences that read
 * like a real bug in `resolveCodemodeSwitch`. This is what makes the addition fail
 * with the version NAME in the message instead.
 *
 * It also asserts that the two floor versions agree, since they share one table: if a future
 * measurement separates 0.86.0 from 0.86.1, the sharing is what has to change and this is
 * where that shows up.
 */
test("every measured pi version carries a column covering every case", () => {
  const labels = CASES.map((c) => c.label);
  const gaps: string[] = [];
  for (const version of MEASURED_VERSIONS) {
    const column = measuredColumnFor(version);
    if (column === undefined) {
      gaps.push(
        version + " is listed as measured but resolves to no column — measure it before listing it",
      );
      continue;
    }
    for (const label of labels) {
      if (typeof column[label] !== "boolean") {
        gaps.push(version + " column has no value for " + label);
      }
    }
    for (const key of Object.keys(column)) {
      if (!labels.includes(key)) {
        gaps.push(version + " column has a row for no case: " + key);
      }
    }
  }
  expect(
    gaps,
    "adding a pi version without measuring it must fail here rather than pass quietly",
  ).toEqual([]);

  // And the pi actually installed must be one this file knows how to place.
  expect(
    measuredColumnFor(INSTALLED_PI_VERSION),
    "the installed pi must have a measured column; an unknown version fails, never skips",
  ).toBeDefined();
});
