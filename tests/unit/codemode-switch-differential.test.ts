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
 * ## Why it is skipped rather than allowed to fail
 *
 * `DefaultPackageManager` is pi's INTERNAL module and is not in its `exports` map, so it has to be
 * reached by a path built from the package root. That path can stop existing when pi restructures —
 * a `skipIf` is the right response, following the precedent in `tests/ocr-anchor-coverage.test.ts`
 * for tooling that may not be present. A skip here is a **loss of coverage, never a false pass**:
 * `test.skipIf` reports SKIPPED, which is visibly different from green, and the cases below are
 * ALSO pinned by `tests/unit/codemode-switch.test.ts` with literals read off this same table.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { readCodemodeSwitch } from "../../src/mode/ptc-mode.ts";
import { makeTempDir, removeTempDir } from "../helpers/ptc.ts";

/**
 * `dist/core/package-manager.js` inside the installed pi, or `undefined` when it is not there.
 *
 * Walked up from this file rather than resolved through the package's `exports` map, for two
 * reasons: the map does not expose this internal module, and the package is ESM-only so
 * `require.resolve` on its main entry fails outright ("No \"exports\" main defined").
 */
function packageManagerPath(): string | undefined {
  let dir = import.meta.dirname;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(
      dir,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "core",
      "package-manager.js",
    );
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
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
): Promise<{ piLoads: boolean; ours: boolean }> {
  const root = await makeTempDir("pi-ptc-diff-");
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
    const piLoads =
      resolved.extensions?.find((e) => e.path === "builtin:codemode")?.enabled === true;
    const ours = readCodemodeSwitch(root, root, ["node", "pi"]).switch !== "disabled";
    return { piLoads, ours };
  } finally {
    await removeTempDir(root);
  }
}

test.skipIf(!AVAILABLE)(
  "the production entry agrees with pi's own resolver on every case in the table",
  async () => {
    const divergences: string[] = [];
    for (const { label, project, user } of CASES) {
      const { piLoads, ours } = await measure(project, user);
      if (piLoads !== ours) {
        divergences.push(
          `${label}: pi=${piLoads ? "loads" : "off"} ours=${ours ? "loads" : "off"}`,
        );
      }
    }
    expect(divergences, "every case above must resolve the way pi resolves it").toEqual([]);
  },
  120_000,
);

test.skipIf(!AVAILABLE)(
  "the table still describes pi: each expected value is re-measured, not trusted",
  async () => {
    // Guards the oracle itself. If pi changes its resolution rules, this goes red and the table
    // above is re-measured — rather than the whole file quietly agreeing with a stale expectation.
    const stale: string[] = [];
    for (const { label, project, user, piLoads } of CASES) {
      const measured = await measure(project, user);
      if (measured.piLoads !== piLoads)
        stale.push(`${label}: table says ${piLoads}, pi now says ${measured.piLoads}`);
    }
    expect(stale, "re-measure these against the installed pi and update the table").toEqual([]);
  },
  120_000,
);
