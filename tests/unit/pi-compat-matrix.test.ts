/**
 * Guards for scripts/pi-compat-matrix.mjs — the script's OWN invariants, not a run of it.
 *
 * The matrix installs a full dependency tree per pi version, so it is a script a human runs
 * (`pnpm run compat:pi`), never part of the default gate; these tests therefore pin what a run
 * DEPENDS ON without executing one. Every assertion here traces to a failure the first real runs
 * produced (each is named in the comment carrying it) — the file exists so that editing the copy
 * list, the version list, or the hermetic env silently cannot reintroduce them.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const SCRIPT_PATH = join(import.meta.dirname, "..", "..", "scripts", "pi-compat-matrix.mjs");
const REPO_ROOT = join(import.meta.dirname, "..", "..");
const script = readFileSync(SCRIPT_PATH, "utf8");
const rootPackage = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
  peerDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};

/**
 * The LOWER BOUND of the declared peer range, extracted by PARSING the range string.
 *
 * The drift guard below is only meaningful if it parses the range rather than looking for a
 * substring of it: a containment check would keep passing after `peerDependencies` moved to a
 * different floor, which is precisely the drift being guarded against. So this reads the operator
 * off the front of each branch and returns the version that follows it — which is the lower bound
 * for every operator this package has ever declared (`>=X`, `^X`, `~X` and a bare `X` all
 * have X as their smallest satisfying version).
 *
 * OR-ed ranges (`>=0.86.0 || ^1.0.0`) take the SMALLEST satisfying branch, so widening the range
 * in either direction cannot silently move the floor the guard compares against.
 *
 * Returns `null` for anything not modelled here (`>`, `<`, `|`, spaces, `x` wildcards, hyphen
 * ranges). That is deliberate: the caller then FAILS LOUDLY rather than comparing against a
 * guessed floor. A silently mis-parsed range is the exact failure this test exists to catch, so
 * forcing a human decision beats guessing.
 */
function peerRangeFloor(range: string): string | null {
  const branches = range.split("||").map((branch) => branch.trim());
  const parsed = branches.map((branch) => {
    const m = /^(>=|\^|~)?v?(\d+)\.(\d+)\.(\d+)$/.exec(branch);
    return m ? `${m[2]}.${m[3]}.${m[4]}` : null;
  });
  if (parsed.some((version) => version === null)) return null;
  return (
    parsed
      .filter((version): version is string => version !== null)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0] ?? null
  );
}

test("the default version list covers the declared peer range and is well-formed", () => {
  // Ordering, non-emptiness and uniqueness only. Whether the list reaches the floor is the drift
  // guard's job below, which is an EQUALITY check — see there for why that one is separate.
  const range = rootPackage.peerDependencies?.["@earendil-works/pi-coding-agent"];
  expect(range, "the package declares a pi peer range").toBeDefined();
  const match = /PI_COMPAT_VERSIONS = \[([^\]]*)\]/.exec(script);
  expect(match, "PI_COMPAT_VERSIONS is defined as an array literal").not.toBeNull();
  const versions = (match![1] ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^"|"$/g, ""))
    .filter((s) => s.length > 0);
  expect(versions.length, "the list is non-empty").toBeGreaterThan(0);
  expect(new Set(versions).size, "the list has no duplicate version").toBe(versions.length);
  const sorted = [...versions].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  expect(versions, "the list is ascending, so the report reads oldest to newest").toEqual(sorted);
});

test("DRIFT GUARD: the matrix's oldest version IS the peer range's lower bound", () => {
  // The anti-drift claim of #196. It deliberately does NOT accept `oldest >= floor` and does NOT
  // match the floor as a substring of the range: either would still be green after
  // `peerDependencies` moved to `>=0.99.0`, which is exactly the drift. The floor is PARSED out
  // of package.json and required to EQUAL the matrix's oldest entry, so moving EITHER side — the
  // peer floor, or the list — turns this red.
  //
  // Counterfactual (measured, reported on #196): editing `peerDependencies` to ">=0.99.0" and
  // leaving PI_COMPAT_VERSIONS alone fails here with oldest="0.86.0" vs floor="0.99.0".
  const range = rootPackage.peerDependencies?.["@earendil-works/pi-coding-agent"];
  expect(range, "the package declares a pi peer range").toBeDefined();
  const floor = peerRangeFloor(range!);
  expect(floor, 'the peer range ("' + range + '") parses to a lower bound').not.toBeNull();

  const match = /PI_COMPAT_VERSIONS = \[([^\]]*)\]/.exec(script);
  expect(match, "PI_COMPAT_VERSIONS is defined as an array literal").not.toBeNull();
  const versions = (match![1] ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^"|"$/g, ""))
    .filter((s) => s.length > 0);

  expect(
    versions[0] ?? "",
    "the oldest measured version must equal the parsed peer floor (" + floor + ")",
  ).toBe(floor);
  expect(versions, "the peer floor is actually in the measured list").toContain(floor);
});

test("the floor parser is pinned, so the drift guard cannot pass on a mis-parse", () => {
  // The guard above trusts `peerRangeFloor`, so the parser is pinned against literal range
  // strings — the semver operators themselves are the source of truth, not a round trip through
  // the parser. Changing the regex (e.g. dropping the `^` anchor, or letting a stray space pass)
  // fails one of these.
  expect(peerRangeFloor(">=0.86.0")).toBe("0.86.0");
  expect(peerRangeFloor("^0.86.0")).toBe("0.86.0");
  expect(peerRangeFloor("~1.0.0")).toBe("1.0.0");
  expect(peerRangeFloor("1.0.0")).toBe("1.0.0");
  expect(peerRangeFloor(">=1.2.3")).toBe("1.2.3");
  // OR-ed ranges resolve to the SMALLEST satisfying branch, so widening cannot move the floor up.
  expect(peerRangeFloor(">=0.86.0 || ^1.0.0")).toBe("0.86.0");
  expect(peerRangeFloor("^1.0.0 || >=0.86.0")).toBe("0.86.0");
  // Forms this parser does not model must be REJECTED (null), never approximated: comparing the
  // guard against a guessed floor is the drift it exists to catch.
  expect(peerRangeFloor(">0.86.0")).toBeNull();
  expect(peerRangeFloor(">=0.86.0 <2.0.0")).toBeNull();
  expect(peerRangeFloor("0.86.x")).toBeNull();
  expect(peerRangeFloor("")).toBeNull();
});

test("the copy list carries every path the suite reads outside src and tests", () => {
  // Each of these is a measured failure, not a guess: doc-integrity walks docs/ AND resolves
  // commit SHAs through .git AND needs .codegraph/.gitignore for its unique-basename baseline;
  // ocr-anchor-coverage reads .opencodereview/; action-sha-consistency and site-checks-on-pr
  // read .github/workflows; bgdispatch's harness asserts package.json's name; README.md links
  // LICENSE. Dropping any one turned a specific test red in the first matrix run.
  for (const needed of [
    ".git",
    ".codegraph/.gitignore",
    ".opencodereview",
    ".github",
    "docs",
    "LICENSE",
    "README.md",
    "AGENTS.md",
    "package.json",
    "scripts",
    "pnpm-workspace.yaml",
  ]) {
    expect(script, "COPY_PATHS includes " + needed).toContain('"' + needed + '"');
  }
  // And the lockfile must be ABSENT: a copied lockfile re-pins the transitive pi family and the
  // version under test never actually installs (the MCP_TYPESCRIPT_PREAMBLE failure).
  expect(script, "COPY_PATHS does not carry pnpm-lock.yaml").not.toMatch(/"pnpm-lock\.yaml"/);
});

test("the run is hermetic: agent dir and home are redirected, and the scratch is cleaned", () => {
  // pi's getAgentDir falls back to the home directory, so an unredirected HOME makes the matrix
  // measure the developer's ~/.pi instead of the version under test — the same shape as the
  // field-report test that was decided by whoever ran it.
  expect(script, "PI_CODING_AGENT_DIR is set per run").toContain("PI_CODING_AGENT_DIR");
  expect(script, "HOME is set per run").toContain("HOME: hermeticHome");
  expect(script, "the scratch root is removed in a finally").toMatch(/finally[\s\S]*rmSync\(root/);
});

test("a failing step fails the script, and the report is per-step", () => {
  // A matrix that exits 0 with a red row is worse than no matrix: the CI wrapper and the human
  // both read the exit code. The per-step rows are what make a floor failure readable as
  // "this pi cannot support it" instead of "we regressed".
  expect(script, "the exit code reflects the step count").toContain(
    "process.exit(failed === 0 ? 0 : 1)",
  );
  expect(script, "rows are reported per step, not aggregated").toContain(
    'row.ok ? "  pass  " : "  FAIL  "',
  );
  expect(script, "a failing step prints its tail").toMatch(/if \(!row\.ok\)/);
});

test("the transitive pi family is pinned to the version under test", () => {
  // pi-coding-agent@1.0.0 imports MCP_TYPESCRIPT_PREAMBLE from pi-codemode; that export is gone
  // in pi-codemode@1.2.0. Without pinning the transitive set, pnpm resolves the newest pi-codemode
  // under an older pi and the scratch fails on an import the real repo never sees.
  expect(script, "PI_TRANSITIVE_PACKAGES is declared").toContain("PI_TRANSITIVE_PACKAGES");
  expect(script, "pi-codemode is pinned").toContain('"@earendil-works/pi-codemode"');
  expect(script, "pi-agent-core is pinned").toContain('"@earendil-works/pi-agent-core"');
  // And the pin goes to pnpm-workspace.yaml, because pnpm v10+ ignores package.json overrides
  // inside a workspace (measured: the package.json block was written and pi-codemode@1.2.0
  // still installed).
  expect(script, "overrides are written to pnpm-workspace.yaml").toContain("pnpm-workspace.yaml");
  expect(script).toMatch(/ws\.trimEnd\(\) \+/);
});

test("build runs before tests, because tool-visibility drives the built dist", () => {
  // Measured: with tests before build, tool-visibility failed with "the probe never observed a
  // provider request" — it spawns real pi against dist/index.js, which does not exist yet.
  const buildIndex = script.indexOf('version + " build"');
  const testsIndex = script.indexOf('version + " tests"');
  expect(buildIndex, "a build step exists").toBeGreaterThan(-1);
  expect(testsIndex, "a tests step exists").toBeGreaterThan(-1);
  expect(buildIndex, "build is ordered before tests").toBeLessThan(testsIndex);
});

test("the script is wired as a package script but stays out of the default gate", () => {
  // The gate this repo runs on every PR is prepublishOnly + CI; the matrix multiplies the gate by
  // the matrix length, so it must be invocable on demand without being mandatory. Both halves are
  // pinned: present in scripts, absent from prepublishOnly.
  expect(rootPackage.scripts?.["compat:pi"], "compat:pi exists").toBe(
    "node scripts/pi-compat-matrix.mjs",
  );
  expect(
    rootPackage.scripts?.prepublishOnly ?? "",
    "the default gate does not run the matrix",
  ).not.toContain("compat:pi");
});
