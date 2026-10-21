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
 * It checks four directions, not one.
 *
 * 1. **Nothing invented.** Every name in the package's own naming families the
 *    page shows must be registered, or be a name somebody declared is not a
 *    tool of this package. A visitor has no way to check a landing page, so
 *    advertising something that does not exist is the dangerous direction.
 * 2. **Nothing required is missing.** Every entry in MUST_APPEAR must appear on
 *    the built page, so a redesign that quietly drops a tool fails the build.
 * 3. **Nothing is unaccounted for.** Every registered `ptc_*` must be in
 *    MUST_APPEAR **or** DECLARED_ABSENT, so adding a tool fails until someone
 *    says which side it is on.
 * 4. **Nothing retired is still advertised.** A name this package renamed away
 *    is not a tool any more, and a page that still shows it teaches an API
 *    that no longer exists. This is direction 1 with a message that says what
 *    to write instead — the failure names the replacement, not just the dead
 *    name.
 *
 * Direction 3 is what this gate was missing, and it is deliberately **not**
 * "the page must list every tool". `ptc_child_report` is what a dispatched
 * child uses to return its report (ADR-0032); no reader of this package calls
 * it. A literal two-way set comparison would have demanded the page mention
 * it, encoding a wrong requirement as a check. The partition enforces the
 * thing that actually drifts instead: a new tool nobody decided to advertise.
 *
 * Exit code is 1 on any failure, and every failure names what to change. A
 * silent pass here would be indistinguishable from a pass.
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

/**
 * The name families this package registers — and the one shape it used to.
 *
 * `ptc_*` is the long-standing family. `pi_task_*` arrived with ADR-0052, which renamed the two
 * task doors to `pi_task_ptc` (the PTC door, a binding inside a program) and `pi_task_codemode`
 * (the codemode door, a registered tool). Both share the prefix, so the page can claim the family
 * the same way it claims `ptc_task_*`.
 *
 * ADR-0052 also retired the PTC door's OLD name, `pi.dispatch` — and the dot in it is exactly
 * why this gate stayed blind to it. `pi.dispatch` matched neither family, so the page could name a
 * door the package had renamed away and this check still reported "8 claim(s) against 8
 * registered tool(s)" and passed. The dotted shape is therefore part of the family now: a name in
 * it is a claim, and a claim has to be backed by the source or declared below.
 *
 * The family is anchored on this package's own prefixes (`ptc_`, `pi_task_`, `pi.`). It is NOT
 * "any dotted word": the built page carries VitePress's own inline scripts, whose payloads are
 * full of names like `document.documentElement` and `navigator.platform`, and a family that
 * matched those would turn the gate into noise. `pi.` is the prefix this package's doors live
 * under, so it is the prefix worth watching.
 *
 * The PTC door is a BINDING rather than a registered pi tool, and this check does not know the
 * difference: it reads the name out of the source, and the source declares it in a constant. That
 * is the same looseness the `viaConstant` style already has (it accepts "a name behind a
 * constant" without proving the constant is wired to a tool), and the consequence is the same one
 * the check already accepts: a name on the page is checked for being backed by the source, not
 * for being a tool.
 */
const NAME_FAMILY = "(?:(?:ptc|pi_task)_[a-z0-9_]+|pi\\.[a-z0-9_]+)";

/**
 * Names this package has used and retired, and what replaced them.
 *
 * This is not the mechanism that turns them red — the widened family above already does that,
 * because a retired name is a name the source does not define. This map is here so the failure
 * message can name the replacement instead of only the dead name, which is what "every failure
 * names what to change" asks for: the reader of the message learns `pi_task_ptc`, not a list of
 * names that does not contain it.
 */
const RETIRED_NAMES = new Map([
  [
    "pi.dispatch",
    "`pi_task_ptc` (ADR-0052 renamed the two task doors to the shared `pi_task_` prefix)",
  ],
]);

/**
 * Names the landing page may mention that this package does NOT register, each with its reason.
 *
 * The reason is not decoration, and neither is the entry. The widened family above treats every
 * `pi.`-shaped name on the page as a claim, and a claim has to be accounted for — so a name this
 * package does not own has to be declared here, with a reason, rather than left to be noticed by
 * whoever reads the failure next. An allowance without one is how an invented name stays invisible.
 *
 * The dotted names in this package's own prefixes are the ones that need a decision. Names in
 * somebody else's namespace (`navigator.platform`, `document.documentElement`) are not claims at
 * all — the family does not reach them, so they are not listed here.
 */
const NOT_A_TOOL_NAMES = new Map([
  [
    "pi.extensions",
    "pi's own manifest field, not a name this package registers; the install note says " +
      "`pi` reads the `pi.extensions` manifest",
  ],
]);

/**
 * What the landing page is required to show.
 *
 * A trailing `*` is a family claim and covers every registered name under it, so
 * `ptc_task_*` stands for `ptc_task_list`, `ptc_task_output` and `ptc_task_stop`
 * without listing them twice. Removing one of the three from the page does **not**
 * fail the build; removing the family claim does. `pi_task_*` is the same kind of claim
 * over the two doors.
 */
const MUST_APPEAR = ["ptc_run_code", "ptc_task_*", "ptc_workflow", "pi_task_*"];

/**
 * Registered tools the landing page deliberately does not mention, each with its reason.
 *
 * The reason is not decoration. An exclusion without one is how a tool stays invisible by
 * accident, which is the drift this partition exists to prevent — so a future maintainer can
 * tell "we decided this" from "nobody has looked".
 */
const DECLARED_ABSENT = new Map([
  [
    "ptc_child_report",
    "the child-side contract a dispatched task calls to return its report (ADR-0032); no reader " +
      "of the package calls it, and the landing page advertises the parent-side surface",
  ],
]);

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
  const inline = new RegExp(`\\bname:\\s*"(${NAME_FAMILY})"`, "g");

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
  //
  // The type annotation is part of the shape: the three task tools declare
  // `export const PTC_TASK_LIST_TOOL_NAME: string = "ptc_task_list";`, and a
  // pattern that insists on `NAME =` therefore missed two of the three. The
  // one it did see (`ptc_task_stop`) it saw through an unrelated constant
  // (`STOP_CALLER_FALLBACK`), which is how the miss stayed invisible for as
  // long as it did: the page named a tool the gate had never actually read
  // out of the source. The optional group below accepts `NAME = "…"` and
  // `NAME: <type> = "…"` alike; the type text may not contain `=` or `;`, so
  // it cannot run past the assignment.
  //
  // ADR-0052 widened the family from `ptc_` to `ptc_` or `pi_task_`, because
  // the two task doors are named `pi_task_ptc` and `pi_task_codemode` and the
  // page shows them. A pattern that only knew `ptc_` would have read the
  // page as claiming nothing about the doors, and the retired `ptc_subagent`
  // row would have gone unnoticed.
  const viaConstant = new RegExp(
    `\\b[A-Z][A-Z0-9_]*(?:\\s*:\\s*[^=;\\n]+)?\\s*=\\s*"(${NAME_FAMILY})"`,
    "g",
  );

  for (const file of tsFiles(SRC_DIR)) {
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const pattern of [inline, viaConstant]) {
      for (const match of source.matchAll(pattern)) names.add(match[1]);
    }
  }
  return names;
}

/**
 * Every token in the package's name families visible in the rendered page, wildcards included.
 *
 * The trailing boundary is a negative lookahead rather than `\b`: a `\b` after
 * an optional `*` backtracks — for `ptc_task_*` the engine drops the `*`, finds
 * a word boundary between `_` and `*`, and reports the family as the truncated
 * name `ptc_task_`. The gate caught that on its first run.
 */
function claimedToolNames(html) {
  const text = html.replace(/<[^>]*>/g, ' ');
  const claims = new Set();
  const claim = new RegExp(`\\b(${NAME_FAMILY}\\*?)(?![a-z0-9_])`, "g");
  for (const match of text.matchAll(claim)) {
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

  // Direction 4 — a retired name the page still shows. Checked before the generic
  // "not registered" failure so the message names the replacement: the reader learns
  // what to write, not only what to delete.
  const retired = claims.filter((claim) => RETIRED_NAMES.has(claim));

  if (retired.length > 0) {
    console.error('✗ the landing page names tools this package retired:\n');
    for (const claim of retired) console.error(`   ${claim} — use ${RETIRED_NAMES.get(claim)}`);
    console.error(
      '\n  The name is gone from the source, so the page is teaching an API that no longer\n' +
        '  exists. Rename it on the page, or — if the package really does have this name\n' +
        '  again — take it out of RETIRED_NAMES here in the same change.',
    );
    process.exit(1);
  }

  // Direction 1 — a name the page shows that the source does not define.
  //
  // A name in NOT_A_TOOL_NAMES is accounted for and passes; it is a mention, not a claim.
  const unbacked = claims.filter((claim) => {
    if (NOT_A_TOOL_NAMES.has(claim)) return false;
    return WILDCARD.test(claim)
      ? ![...registered].some((name) => name.startsWith(claim.slice(0, -1)))
      : !registered.has(claim);
  });

  if (unbacked.length > 0) {
    console.error('✗ the landing page advertises tools this package does not register:\n');
    for (const claim of unbacked) console.error(`   ${claim}`);
    console.error(`\n  registered: ${[...registered].sort(byName).join(', ')}`);
    console.error(
      '\n  A name is either a tool this package registers, or a name somebody declared as\n' +
        '  not one of ours (NOT_A_TOOL_NAMES in this script, with a reason). A name nobody\n' +
        '  decided about is the drift this check exists to catch.',
    );
    process.exit(1);
  }

  // Direction 2 — a required name the page stopped showing.
  const missing = MUST_APPEAR.filter(
    (required) =>
      !claims.some((claim) =>
        WILDCARD.test(required)
          ? claim === required || claim.startsWith(required.slice(0, -1))
          : claim === required,
      ),
  );

  if (missing.length > 0) {
    console.error('✗ the landing page no longer shows a tool it is required to show:\n');
    for (const name of missing) console.error(`   ${name}`);
    console.error(
      '\n  Either the page should name it, or it is no longer required — in which case it\n' +
        '  comes out of MUST_APPEAR here. Removing it from the page and from MUST_APPEAR in\n' +
        '  the same change is a decision; removing it from the page alone is drift.',
    );
    process.exit(1);
  }

  // Direction 3 — a registered tool that neither set accounts for.
  const unaccounted = [...registered]
    .filter(
      (name) =>
        !DECLARED_ABSENT.has(name) &&
        !MUST_APPEAR.some((required) =>
          WILDCARD.test(required) ? name.startsWith(required.slice(0, -1)) : name === required,
        ),
    )
    .sort(byName);

  if (unaccounted.length > 0) {
    console.error(
      `✗ ${unaccounted.length} registered tool(s) are neither required on the landing page ` +
        `nor declared absent:\n`,
    );
    for (const name of unaccounted) console.error(`   ${name}`);
    console.error(
      '\n  A new tool has to be decided: add it to MUST_APPEAR to advertise it, or to\n' +
        '  DECLARED_ABSENT with a reason if the page should not mention it. Both are\n' +
        '  decisions; landing in neither is the drift this check exists to catch.',
    );
    process.exit(1);
  }

  // An exclusion naming a tool that no longer exists is a stale record, not a spare.
  const stale = [...DECLARED_ABSENT.keys()]
    .filter((name) => !registered.has(name))
    .sort(byName);

  if (stale.length > 0) {
    console.error('✗ DECLARED_ABSENT names tools this package does not register:\n');
    for (const name of stale) console.error(`   ${name}`);
    console.error(
      '\n  The tool was removed or renamed. Delete the exclusion in the same commit that\n' +
        '  removed the tool — a spare exclusion hides the next rename.',
    );
    process.exit(1);
  }

  // An allowance naming a name this package DOES register is a stale record, not a spare.
  // The exclusion above is stale the other way round — it names a tool that is gone.
  const staleAllowance = [...NOT_A_TOOL_NAMES.keys()]
    .filter((name) => registered.has(name))
    .sort(byName);

  if (staleAllowance.length > 0) {
    console.error('✗ NOT_A_TOOL_NAMES names tools this package does register:\n');
    for (const name of staleAllowance) console.error(`   ${name}`);
    console.error(
      '\n  The allowance is now wrong: the package registers this name, so the page may\n' +
        '  show it as a tool. Delete the allowance in the same change that registered it —\n' +
        '  a spare allowance hides the next rename.',
    );
    process.exit(1);
  }

  // A retired name the source defines again is not retired. The same staleness rule as the
  // allowance above, on the other registry: the record has to follow the source.
  const revived = [...RETIRED_NAMES.keys()].filter((name) => registered.has(name)).sort(byName);

  if (revived.length > 0) {
    console.error('✗ RETIRED_NAMES names tools this package does register:\n');
    for (const name of revived) console.error(`   ${name}`);
    console.error(
      '\n  The name is back in the source, so it is not retired. Delete the entry in the\n' +
        '  same change that brought the name back.',
    );
    process.exit(1);
  }

  const toolClaims = claims.filter((claim) => !NOT_A_TOOL_NAMES.has(claim));

  console.log(
    `✓ landing page tool names — ${toolClaims.length} tool claim(s) against ${registered.size} ` +
      `registered tool(s), ${claims.length - toolClaims.length} declared non-tool mention(s); ` +
      `${MUST_APPEAR.length} required, ${DECLARED_ABSENT.size} declared absent, 0 unaccounted`,
  );
  for (const claim of claims) {
    console.log(
      NOT_A_TOOL_NAMES.has(claim) ? `    ${claim}  (not a tool of this package)` : `    ${claim}`,
    );
  }
}

main();
