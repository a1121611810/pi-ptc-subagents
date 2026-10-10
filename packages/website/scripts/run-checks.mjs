#!/usr/bin/env node
/**
 * Run every site check, then report all of them together.
 *
 * These four checks are **independent**: each reads the build output and compares it against
 * something else (the source, the projection manifest, the registered tools, the working tree).
 * None is a precondition for another. They were chained with `&&`, which meant the first red gate
 * hid the other three — so a developer fixing them one run at a time discovered one per run, and
 * a change that broke two gates looked like it had broken one.
 *
 * `prepublishOnly` uses `&&` and is right to: typecheck gates lint, which gates build. That is a
 * dependency chain. This is not.
 *
 * Output is passed through verbatim, in order, so a reader sees each check's own verdict and its
 * own message. The exit code is non-zero if any check failed — including one that could not run,
 * which is not a pass.
 */

import { spawnSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");

const CHECKS = [
  ["documented claims", "check-doc-claims.mjs"],
  ["projection coverage", "check-projection-coverage.mjs"],
  ["landing page tool names", "check-landing-tool-names.mjs"],
  ["internal links", "check-internal-links.mjs"],
];

const results = [];
let failed = 0;

for (const [label, script] of CHECKS) {
  const path = join(HERE, script);
  const run = spawnSync(process.execPath, [path], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (run.error) {
    failed += 1;
    results.push({ label, code: -1, out: `could not run ${script}: ${run.error.message}` });
    continue;
  }

  const code = run.status ?? -1;
  if (code !== 0) failed += 1;
  results.push({ label, code, out: `${run.stdout ?? ""}${run.stderr ?? ""}`.trimEnd() });
}

console.log(`site checks — ${CHECKS.length} run, ${CHECKS.length - failed} green, ${failed} not green\n`);
for (const { label, code, out } of results) {
  console.log(`── ${label} ${"─".repeat(Math.max(0, 58 - label.length))} ${code === 0 ? "green" : "RED (exit " + code + ")"}`);
  if (out) console.log(out.split("\n").map((l) => `   ${l}`).join("\n"));
  console.log("");
}

if (failed > 0) {
  const names = results.filter((r) => r.code !== 0).map((r) => r.label);
  console.error(
    `✗ ${failed} of ${CHECKS.length} site checks not green: ${names.join(", ")}` +
      `  (${relative(REPO_ROOT, HERE)})`,
  );
  process.exit(1);
}

console.log(`✓ all ${CHECKS.length} site checks green`);
