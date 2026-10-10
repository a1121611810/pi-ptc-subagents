#!/usr/bin/env node
/**
 * Gate: every tool name the landing page shows must be a tool this package
 * actually registers.
 *
 * The failure this prevents is specific and has already happened in this
 * repository's history: the README said one number of tools, the code shipped
 * another, and nothing objected until a release check caught it. A marketing
 * page is a worse place for that drift than a README, because a visitor has no
 * way to check.
 *
 * What it reads, and why:
 *   - the BUILT landing page, not the Vue source. The claim the reader sees is
 *     the rendered one; asserting on the template would miss anything a build
 *     step injects.
 *   - the `name:` property of each tool definition under src/. That literal is
 *     where registration actually happens — it is the same place
 *     `scripts/verify-dist-render.mjs` reads its set from, at the other end of
 *     the pipeline. Comments are stripped first, so prose that merely names a
 *     tool cannot make this pass.
 *
 * It is NOT a check that the landing page is factually complete. A page that
 * forgot to mention a tool passes. That gap is deliberate and recorded as
 * out-of-scope in the spec (#144); this catches the dangerous direction, where
 * the page advertises something that does not exist.
 *
 * Exit code is 1 on any claim without a registration, and the unbacked names
 * are printed — a silent pass here would be indistinguishable from a pass.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const SRC_DIR = join(REPO_ROOT, 'src');
const BUILT_INDEX = join(HERE, '..', '.vitepress', 'dist', 'index.html');

/** Names the landing page may use as a family, e.g. `ptc_task_*`. */
const WILDCARD = /\*$/;

/** Recursively list .ts files under a directory. */
function tsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Strip comments before matching. Without this, a doc comment that quotes a
 * tool name would register as a registration and the gate would stop meaning
 * anything — it would pass on prose alone.
 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
}

/** The set of tool names this package defines. */
function registeredToolNames() {
  const names = new Set();

  // Style 1 — the name inline in the tool definition object:
  //   name: "ptc_run_code"
  const inline = /\bname:\s*"(ptc_[a-z0-9_]+)"/g;

  // Style 2 — the name behind a constant, which is how `ptc_child_report`
  // registers: `name: CHILD_REPORT_TOOL_NAME` over
  // `export const CHILD_REPORT_TOOL_NAME = "ptc_child_report"`. Scanning only
  // style 1 was a real bug here: it found six tools and silently omitted a
  // seventh that the page was entitled to name. The constant's declaration is
  // the registration site in this shape.
  //
  // This widens the accepted set, which is the safe direction: a tool name
  // that is declared but not wired up would pass this gate, whereas a tool
  // that IS wired up but missed here would fail it and cry wolf.
  const viaConstant = /\b[A-Z][A-Z0-9_]*\s*=\s*"(ptc_[a-z0-9_]+)"/g;

  for (const file of tsFiles(SRC_DIR)) {
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const pattern of [inline, viaConstant]) {
      for (const match of source.matchAll(pattern)) names.add(match[1]);
    }
  }
  return names;
}

/**
 * Every `ptc_*` token visible in the rendered page, wildcards included.
 *
 * The trailing boundary is a negative lookahead rather than `\b`: a `\b` after
 * an optional `*` backtracks — for `ptc_task_*` the engine drops the `*`, finds
 * a word boundary between `_` and `*`, and reports the family as the truncated
 * name `ptc_task_`. The gate caught that on its first run.
 */
function claimedToolNames(html) {
  const text = html.replace(/<[^>]*>/g, ' ');
  const claims = new Set();
  for (const match of text.matchAll(/\b(ptc_[a-z0-9_]+\*?)(?![a-z0-9_])/g)) {
    claims.add(match[1]);
  }
  return claims;
}

/**
 * Deterministic ordering. A bare `.sort()` orders by UTF-16 code unit, and
 * `localeCompare` orders by the reader's locale — neither is what a gate's
 * output should depend on, since a diffable log that reorders under a different
 * machine is a log people stop reading.
 */
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function main() {
  let built;
  try {
    built = readFileSync(BUILT_INDEX, 'utf8');
  } catch {
    console.error(`✗ no built landing page at ${relative(REPO_ROOT, BUILT_INDEX)}`);
    console.error('  This gate reads the build output, so it runs after `vitepress build`.');
    process.exit(1);
  }

  const registered = registeredToolNames();
  const claims = [...claimedToolNames(built)].sort(byName);

  if (claims.length === 0) {
    console.error('✗ the landing page names no tools at all — the gate has nothing to check.');
    console.error('  That means the extraction broke, not that the page is honest.');
    process.exit(1);
  }

  const unbacked = claims.filter((claim) =>
    WILDCARD.test(claim)
      ? ![...registered].some((name) => name.startsWith(claim.slice(0, -1)))
      : !registered.has(claim)
  );

  if (unbacked.length > 0) {
    console.error('✗ the landing page advertises tools this package does not register:\n');
    for (const claim of unbacked) console.error(`   ${claim}`);
    console.error(`\n  registered: ${[...registered].sort(byName).join(', ')}`);
    process.exit(1);
  }

  console.log(
    `✓ landing page tool names — ${claims.length} claim(s) checked against ` +
      `${registered.size} registered tool(s)`
  );
  for (const claim of claims) console.log(`    ${claim}`);
}

main();
