#!/usr/bin/env node
/**
 * pi compatibility matrix — run this repo's gate against more than one pi.
 *
 * The package declares `peerDependencies: { "@earendil-works/pi-coding-agent": ">=0.86.0" }`
 * while `devDependencies` pins `^1.0.0`, so the default gate measures exactly one point of a
 * range whose two ends are both live claims: the floor, because a user on an older pi installs
 * anyway, and the ceiling, because this repo's stated policy is to track new pi releases. This
 * script measures the ends. It is NOT part of `pnpm test` — each version needs its own install
 * (a full dependency tree per version, ~30-60 s each), which would multiply every contributor's
 * gate by the matrix length for coverage the pinned version already provides.
 *
 * ## What it does, per version
 *
 * 1. Builds a scratch copy of the repo under the OS temp dir. The copy is COMPLETE on purpose —
 *    the suite reads repo-root files the source does not (`tests/doc-integrity.test.ts` walks
 *    `docs/` and resolves citations through `git ls-files` and the commit SHAs in
 *    `docs/reviews/`; `tests/ocr-anchor-coverage.test.ts` reads `.opencodereview/`;
 *    `tests/action-sha-consistency.test.ts` and `tests/site-checks-on-pr.test.ts` read
 *    `.github/workflows/`; `tests/e2e/bgdispatch.test.ts` asserts `package.json`'s `name`).
 *    Measured on 2026-10-14: dropping any of `.git`, `.codegraph/.gitignore`, `LICENSE`,
 *    `docs/`, `.opencodereview/`, `.github/` or `AGENTS.md` turns specific tests red, and a
 *    `package.json` rewritten through JSON.parse/Stringify breaks `oxfmt --check` (key order)
 *    and `release-path-smoke-guard` — so the copy is `cp -R` of a fixed list, byte-for-byte.
 * 2. Rewrites the three `@earendil-works/*` devDependencies to the version and installs with
 *    `--no-frozen-lockfile` (the point is a different resolution than the pin).
 * 3. Runs, in order: `tsc --noEmit`, `oxlint`, `oxfmt --check`, a version-sensitive test subset
 *    (or the whole suite with `--full`), `vp pack`, and `verify-dist-render`.
 * 4. Reports PER STEP, not as one pass/fail, so a failure on one version is legible as
 *    "this pi does not support it" instead of "we regressed". As of 2026-10-14 the floor itself
 *    is green: this package typechecks on 0.86.0 (0 errors), on 0.86.1 (0) and on 0.99.0 (0), so
 *    no step is expected to fail. The capability gap is real but lives BELOW typecheck — pi 0.86.x
 *    has no `ToolDefinition.outputSchema`, no `ToolExposure` and no `isError` channel (all
 *    arrived in 0.99.0; see ADR-0028 and ADR-0025), which is why the throw-path leg below is the
 *    one row that reads `skip` rather than `pass` on the upper versions. A version row that
 *    cannot even install is still reported, never silently skipped.
 *
 * ## Usage
 *
 *   node scripts/pi-compat-matrix.mjs                 # the default list below
 *   node scripts/pi-compat-matrix.mjs 1.2.0           # one version
 *   node scripts/pi-compat-matrix.mjs 0.86.0 1.2.0 --full
 *
 * Adding a version when pi ships one: add it to PI_COMPAT_VERSIONS. The floor stays — it is the
 * claim `peerDependencies` makes, and the one this script exists to test.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The matrix. Order matters for the report only; every entry is measured independently.
 *
 * - 0.86.0 — the LITERAL lower bound of `peerDependencies` (`">=0.86.0"`), so the matrix
 *   measures the claim the package makes rather than a stand-in for it. 0.86.0 is published on
 *   npm (checked 2026-10-14: the 0.8x/0.9x series is 0.80.1 … 0.86.0, 0.86.1, 0.87.0, 0.87.1,
 *   0.99.0 …), which is why the list can name it directly.
 * - 1.0.0 — the `devDependencies` pin at the time this script was written.
 * - 1.2.0 — an intermediate, kept so a bisect between the 1.0.0 and 1.3.0 legs can say WHICH
 *   release changed a behaviour rather than only that something did.
 * - 1.3.0 — the newest release (published 2026-10-19; checked on npm 2026-10-20) and the
 *   `devDependencies` pin as of 2026-10-20. Move this forward (and add intermediates when a
 *   bisect would help) as pi ships.
 *
 * The oldest entry is tied to the peer range's lower bound by
 * `tests/unit/pi-compat-matrix.test.ts`, which PARSES that bound out of package.json and
 * requires equality — so bumping `peerDependencies` without adding the matching leg here turns
 * that test red rather than silently widening what the matrix claims to cover.
 */
const PI_COMPAT_VERSIONS = ["0.86.0", "1.0.0", "1.2.0", "1.3.0"];

/** The three packages whose devDependency is rewritten per version. */
const PI_PACKAGES = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-tui",
];

/**
 * Tests whose subject is the INSTALLED pi rather than this repo's logic in isolation: the
 * codemode probes (filesystem layout, switch resolution, MCP auto-enable evidence), the binding
 * contract (which is third-party facts about pi's tools), and the two that drive a real pi
 * process. The remaining suite is version-insensitive — it stubs pi or tests pure modules — so
 * running it per version would spend minutes re-proving the same thing. `--full` runs
 * everything anyway.
 */
const VERSION_SENSITIVE_TESTS = [
  "tests/unit/codemode-switch.test.ts",
  "tests/unit/codemode-switch-differential.test.ts",
  "tests/unit/codemode-activation.test.ts",
  "tests/unit/codemode-mcp-evidence.test.ts",
  "tests/unit/codemode-mcp-drift-notice.test.ts",
  "tests/unit/codemode-presence-crosscheck.test.ts",
  "tests/unit/surface-subagents-execution-layer.test.ts",
  "tests/binding-contract.test.ts",
  "tests/binding-policy.test.ts",
  "tests/bindings.test.ts",
  "tests/ptc-mode.test.ts",
  "tests/skills-section.test.ts",
  "tests/extension.test.ts",
  "tests/tool-visibility.test.ts",
  "tests/dispatcher.test.ts",
  "tests/dispatch-helpers.test.ts",
  "tests/unit/dispatch-wiring.test.ts",
  "tests/unit/pi-compat-matrix.test.ts",
  // The 0.86.1 leg's guard (spec #189 User Story 6): a thrown bash failure's rejection is capped.
  // It was NOT here before, so `compat:pi` never ran it and the capability table's "pass (throw
  // channel)" row had no execution behind it. Being in the list is necessary but NOT sufficient:
  // on any pi whose bash resolves through isError the file's first test skipIf's itself, so the
  // list membership alone would still hide a silent skip. The throw-path verdict step below is
  // what makes the report honest about it.
  "tests/unit/bash-throw-cap-0861.test.ts",
];

/**
 * The guard whose reachability is VERSION-DEPENDENT, and the one test inside it that actually
 * measures something. It skipIf's itself out of existence on any pi whose bash resolves
 * failures through `isError` (pi >= 0.99.0), so on 1.0.0 / 1.2.0 the file contributes 1 pass
 * + 1 skip and the cap is NEVER exercised. Measured 2026-10-14 on the pinned 1.0.0 tree:
 * `numPendingTests: 1`, the cap assertion reported status "skipped".
 *
 * Named here, and asserted by the guard at the bottom of this file, because list membership is
 * the exact thing that went missing before: with this file outside VERSION_SENSITIVE_TESTS,
 * `compat:pi` never ran it at all and docs/agents/pi-compat-matrix.md still recorded a
 * "pass (throw channel)" row for 0.86.x. Nothing in a green matrix run contradicted that
 * row, because nothing in the run touched it.
 */
const THROW_PATH_TEST = "tests/unit/bash-throw-cap-0861.test.ts";

/** The title of the assertion inside that file that measures the cap. */
const THROW_PATH_ASSERTION =
  "a thrown bash failure's rejection is capped: head dropped, exit code kept";

/** Everything the suite touches outside `src/` and `tests/`. See the doc comment above. */
const COPY_PATHS = [
  "scripts",
  "package.json",
  "tsconfig.json",
  "vite.config.ts",
  "vitest.config.ts",
  ".oxlintrc.json",
  ".oxfmtrc.json",
  "AGENTS.md",
  "GLOSSARY.md",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "docs",
  ".gitignore",
  ".codegraph/.gitignore",
  ".opencodereview",
  ".github",
  "packages",
  "pnpm-workspace.yaml",
  // The git DIRECTORY, not a checkout: doc-integrity resolves the commit SHAs its ledger cites
  // through the real history, and `git ls-files` feeds the basename-resolution baseline.
  ".git",
  // pnpm-lock.yaml is deliberately ABSENT. The matrix's whole point is a different resolution
  // than the pin: a copied lockfile re-pins pi-codemode@1.0.0 under pi-coding-agent@1.2.0 (or the
  // reverse), and the overrides written below never take effect — measured, the first run with a
  // copied lockfile installed pi-codemode@1.2.0 under pi 1.0.0 and skills-section.test.ts died on
  // MCP_TYPESCRIPT_PREAMBLE. `pnpm install --no-frozen-lockfile` regenerates the resolution the
  // rewritten devDependencies and overrides ask for.
];

/** One step of one version's run. */
function run(label, command, args, cwd, env) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 15 * 60_000,
  });
  const ok = result.status === 0;
  return {
    label,
    ok,
    tail: ok
      ? (result.stdout ?? "").trimEnd().split("\n").slice(-2).join("\n")
      : [result.stdout ?? "", result.stderr ?? ""]
          .join("\n")
          .trimEnd()
          .split("\n")
          .slice(-12)
          .join("\n"),
  };
}

/**
 * The transitive @earendil-works/* packages pi-coding-agent itself imports. They release in
 * lockstep with the three top-level ones, and pi 1.0.0's codemode/tool.js imports
 * MCP_TYPESCRIPT_PREAMBLE from pi-codemode - an export REMOVED in pi-codemode 1.2.0 (measured:
 * the matrix's first run resolved pi-codemode@1.2.0 under pi-coding-agent@1.0.0 and both
 * skills-section.test.ts and verify-dist-render died on the missing export, while the real repo
 * passed because pnpm-lock pins pi-codemode@1.0.0 alongside it). Pinning all of them to the same
 * version reproduces what the lockfile does.
 */
const PI_TRANSITIVE_PACKAGES = [
  "@earendil-works/pi-codemode",
  "@earendil-works/pi-mcp",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-telemetry",
];

/**
 * Rewrite the three pi devDependencies to `version` and pin the transitive set with it.
 *
 * The transitive pin goes through pnpm.overrides, which the real package.json does not carry -
 * the repo pins these through its own lockfile. JSON round-tripping is safe here because this
 * field exists only for pnpm to read: the ROOT package.json is copied verbatim and only this
 * SCRATCH copy gains the field, and no test compares the scratch's package.json byte-for-byte.
 */
function rewriteDevDeps(root, version) {
  const path = join(root, "package.json");
  const source = readFileSync(path, "utf8");
  let rewritten = source;
  for (const pkg of [...PI_PACKAGES, ...PI_TRANSITIVE_PACKAGES]) {
    // Whether the entry was FOUND, and whether the text CHANGED, are two different questions.
    // The first is what this loop needs; the second is what it used to ask, and asking the second
    // made the script unable to measure the version the repo currently pins: replacing `1.3.0`
    // with `1.3.0` leaves the text identical, so a MATCH was reported as "no devDependency entry
    // matched" — measured 2026-10-20, when `compat:pi 1.3.0` aborted on exactly that message
    // with the pin already at 1.3.0. Asking "did the regex match" instead says what it means:
    // the entry is there and has been rewritten to the requested version.
    const pattern = new RegExp('("' + pkg + '":\\s*")\\^?[0-9]+\\.[0-9]+\\.[0-9]+"');
    const matched = pattern.test(rewritten);
    rewritten = rewritten.replace(pattern, "$1" + version + '"');
    if (!matched && source.includes('"' + pkg + '"')) {
      throw new Error('no devDependency entry matched for "' + pkg + '"');
    }
  }
  // pnpm v10+ reads overrides from pnpm-WORKSPACE.yaml (this repo is a workspace), not from
  // package.json - measured: an overrides block written into the scratch's package.json was
  // ignored and pi-codemode@1.2.0 still installed under pi 1.0.0. So the pin goes into the
  // workspace file the scratch copies, appended as YAML. The package.json keeps only the three
  // top-level rewrites and gains no overrides field at all.
  const wsPath = join(root, "pnpm-workspace.yaml");
  let ws = readFileSync(wsPath, "utf8");
  if (!/^overrides:/m.test(ws)) {
    const entries = [...PI_PACKAGES, ...PI_TRANSITIVE_PACKAGES]
      .map((pkg) => '  "' + pkg + '": ' + version)
      .join("\n");
    ws =
      ws.trimEnd() +
      "\n\n# Written by scripts/pi-compat-matrix.mjs: pin the @earendil-works/* family to ONE\n# version, reproducing what the repo's own lockfile does.\noverrides:\n" +
      entries +
      "\n";
    writeFileSync(wsPath, ws);
  }
  writeFileSync(path, rewritten);
}

/** Build one scratch root for one version. Returns the directory. */
function materializeScratch(repoRoot, version) {
  const root = mkdtempSync(join(tmpdir(), "pi-compat-" + version + "-"));
  for (const rel of COPY_PATHS) {
    const from = join(repoRoot, rel);
    if (!existsSync(from)) throw new Error("expected repo path is missing: " + rel);
    cpSync(from, join(root, rel), { recursive: true, verbatimSymlinks: true });
  }
  cpSync(join(repoRoot, "src"), join(root, "src"), { recursive: true, verbatimSymlinks: true });
  cpSync(join(repoRoot, "tests"), join(root, "tests"), { recursive: true, verbatimSymlinks: true });
  rewriteDevDeps(root, version);
  return root;
}

/**
 * Does the INSTALLED pi resolve bash failures through `isError`? Decided by reading the
 * installed artifact, never by comparing version strings - the same oracle the guard test
 * uses, so the report and the test cannot disagree about which leg is reachable. `undefined`
 * means the artifact could not be read, which is NOT the same as "no isError channel".
 */
function bashUsesIsErrorChannel(root) {
  const bashJs = join(
    root,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "core",
    "tools",
    "bash.js",
  );
  if (!existsSync(bashJs)) return undefined;
  return readFileSync(bashJs, "utf8").includes("isError: true");
}

/**
 * Decide what the throw-path leg actually DID on this version, and report it as its own row.
 *
 * The matrix's single `vitest --run` invocation cannot answer this question. `skipIf` inside
 * the guard is swallowed by a green suite, so a passing `tests` step says nothing about whether
 * the cap was measured at all - which is precisely how a "pass (throw channel)" row survived
 * in the docs with no execution behind it. This re-runs ONLY the guard file with
 * `--reporter=json` and reads that one assertion's real status out of the machine report:
 * measured execution, not an inference from an exit code.
 *
 * Three outcomes, deliberately three. F4 discipline: a skip must never print as a pass.
 *
 * - passed  - the cap assertion executed and passed. Only this reads as a pass.
 * - skipped - the installed pi resolves bash failures through `isError`, so the throw path
 *              does not exist there and the assertion skipIf'd itself out. Reported as its own
 *              labelled state; it is NOT a pass and does not turn the run red, because a pi
 *              that cannot express the failure mode is not a regression in this package.
 * - failed  - the assertion ran and failed, or the report could not be read. Either way the
 *              leg is UNMEASURED, which is exactly the state that used to hide here.
 */
function throwPathRow(version, root, env) {
  const reportPath = join(root, "throw-path-report.json");
  const result = spawnSync(
    join(root, "node_modules", ".bin", "vitest"),
    [
      "--run",
      "--reporter=default",
      "--reporter=json",
      "--outputFile.json=" + reportPath,
      THROW_PATH_TEST,
    ],
    { cwd: root, env: { ...process.env, ...env }, encoding: "utf8", timeout: 15 * 60_000 },
  );

  const usesIsError = bashUsesIsErrorChannel(root);
  let reach =
    usesIsError === true
      ? "pi " +
        version +
        " resolves BASH failures through the isError channel, so the bash throw path is unreachable there" +
        " (the other builtins still reject on every version, and the cap covering them is pinned by" +
        " tests/bindings.test.ts in the default gate)"
      : usesIsError === false
        ? "pi " + version + " has no isError channel in bash, so the throw path is reachable"
        : "the installed pi's dist/core/tools/bash.js could not be read, so the channel is unknown";

  let status;
  try {
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const file = (report.testResults ?? []).find((f) => f.name.endsWith(THROW_PATH_TEST));
    const assertion = (file?.assertionResults ?? []).find((a) => a.title === THROW_PATH_ASSERTION);
    status = assertion?.status;
    if (status === undefined) {
      status = "failed";
      throw new Error(
        `ran, but no assertion titled "${THROW_PATH_ASSERTION}" appeared in the report`,
      );
    }
  } catch (error) {
    status = "failed";
    reach = error.message + ` (vitest exit ${result.status ?? "signal"})`;
  }

  return {
    label: version + " throw-path leg (capped bash rejection)",
    ok: status !== "failed",
    throwPath: status,
    tail:
      status === "passed"
        ? "pass - the cap was measured and held: " + reach
        : status === "skipped"
          ? "SKIPPED - NOT A PASS: " +
            reach +
            `. ${THROW_PATH_TEST} reports 1 passed + 1 skipped here; the cap is measured by the 0.86.x leg instead`
          : "UNMEASURED - " + reach,
  };
}

/** Run one version end to end. Returns the per-step rows. */
async function measureVersion(repoRoot, version) {
  const rows = [];
  let root;
  try {
    root = materializeScratch(repoRoot, version);

    const pnpm = (bin) => join(root, "node_modules", ".bin", bin);

    rows.push(
      run(
        version + " install",
        "pnpm",
        ["install", "--no-frozen-lockfile", "--ignore-scripts"],
        root,
      ),
    );
    const installed = existsSync(join(root, "node_modules", "@earendil-works", "pi-coding-agent"));
    if (!installed) {
      rows.push({
        label: version + " install",
        ok: false,
        tail: "pi-coding-agent not present after install",
      });
      return rows;
    }
    const pkgJson = JSON.parse(
      readFileSync(
        join(root, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
        "utf8",
      ),
    );
    const gotVersion = pkgJson.version;
    rows.push({
      label: version + " resolved-version",
      ok: gotVersion === version,
      tail: "pi-coding-agent resolved to " + gotVersion,
    });
    if (!gotVersion.startsWith(version)) return rows;

    // Hermetic environment: the probes read <agentDir>/settings.json and mcp.json, and pi's own
    // getAgentDir falls back to the home directory — both must point at directories this script
    // owns, or the matrix measures the developer's machine.
    const hermeticAgentDir = join(root, "empty-agent-dir");
    const hermeticHome = join(root, "empty-home");
    const env = {
      PI_CODING_AGENT_DIR: hermeticAgentDir,
      HOME: hermeticHome,
    };

    rows.push(run(version + " typecheck", pnpm("tsc"), ["--noEmit"], root, env));
    rows.push(run(version + " lint", pnpm("oxlint"), [], root, env));
    rows.push(run(version + " fmt:check", pnpm("oxfmt"), ["--check"], root, env));
    // The build runs BEFORE the tests on purpose: `tests/tool-visibility.test.ts` spawns a real pi
    // against the built `dist/index.js`, so a missing or stale dist reads as "the probe never
    // observed a provider request" — measured, that is exactly what the first matrix run reported
    // before this ordering was fixed. Measured 2026-10-14.
    rows.push(run(version + " build", pnpm("vp"), ["pack"], root, env));
    rows.push(
      run(
        version + " tests",
        pnpm("vitest"),
        ["--run", ...(process.argv.includes("--full") ? [] : VERSION_SENSITIVE_TESTS)],
        root,
        env,
      ),
    );
    // Its own step, right after the suite: this is the row that states whether the 0.86.1 leg's
    // cap was MEASURED on this version or merely present in the test list.
    rows.push(throwPathRow(version, root, env));
    rows.push(
      run(
        version + " verify:dist",
        process.execPath,
        ["scripts/verify-dist-render.mjs"],
        root,
        env,
      ),
    );
  } finally {
    if (root !== undefined && !process.env.PI_COMPAT_KEEP) {
      rmSync(root, { recursive: true, force: true });
    } else if (root !== undefined) {
      console.log("kept scratch: " + root);
    }
  }
  return rows;
}

// --- entry -----------------------------------------------------------------

/**
 * Startup guard, in the script rather than only in the test suite, because the suite cannot see
 * this failure mode: `tests/unit/pi-compat-matrix.test.ts` parses this file's source for string
 * literals, and a THROW_PATH_TEST constant is a string literal it will find whether or not the
 * constant is wired into the list. This is the check that fails when the two drift apart, which
 * is the actual B1 defect (a documented leg with no execution behind it).
 */
if (!VERSION_SENSITIVE_TESTS.includes(THROW_PATH_TEST)) {
  console.error(
    "pi compat matrix: " + THROW_PATH_TEST + " is missing from VERSION_SENSITIVE_TESTS.",
  );
  console.error("  Its cap guard would never run, so no version leg would measure it.");
  console.error("  Add it to VERSION_SENSITIVE_TESTS - this is a measured failure, not a guess.");
  process.exit(2);
}

const repoRoot = new URL("..", import.meta.url).pathname;
const versions = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const list = versions.length > 0 ? versions : PI_COMPAT_VERSIONS;

const allRows = [];
for (const version of list) {
  process.stdout.write("measuring pi " + version + " ...\n");
  const rows = await measureVersion(repoRoot, version);
  allRows.push({ version, rows });
}

let failed = 0;
let skipped = 0;
for (const { version, rows } of allRows) {
  console.log("\n=== pi " + version + " ===");
  for (const row of rows) {
    // Three renderings, never two. A row whose throwPath is "skipped" gets its own marker and
    // its reason printed on EVERY run, so green output can never be read as "the cap was
    // measured here" - that misreading is what let a throw-channel row sit in the docs with no
    // execution behind it. Its tail prints unconditionally (a passing row's does not), because
    // the reason a leg is inert is exactly what a reader of this report needs to know.
    if (row.throwPath === "skipped") {
      skipped += 1;
      console.log("  skip  " + row.label);
      for (const line of row.tail.split("\n")) console.log("        " + line);
      continue;
    }
    console.log((row.ok ? "  pass  " : "  FAIL  ") + row.label);
    if (!row.ok) {
      failed += 1;
      for (const line of row.tail.split("\n")) console.log("        " + line);
    }
  }
}

console.log(
  "\n" +
    (failed === 0
      ? "pi compat matrix: all steps passed across " + allRows.length + " version(s)"
      : "pi compat matrix: " +
        failed +
        " failing step(s) across " +
        allRows.length +
        " version(s)") +
    (skipped === 0
      ? ""
      : `; ${skipped} throw-path leg(s) SKIPPED (not passing) - the cap is measured only where pi throws, i.e. the 0.86.x legs`),
);
process.exit(failed === 0 ? 0 : 1);
