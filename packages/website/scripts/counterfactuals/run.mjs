#!/usr/bin/env node
/**
 * Counterfactuals for the site's checks: break one thing, require the gate to notice.
 *
 * ## Why this is a script a person runs, and not a test
 *
 * Every gate in this directory's sibling `scripts/` was verified the same way — change the thing it
 * is supposed to police, watch it go red, put it back. Those scripts lived in a temporary directory
 * and were never committed, so the evidence went with them. If a gate later stops having teeth —
 * not crashing, just passing when it should not — there is no way to re-establish that it ever did.
 *
 * That is not hypothetical in this repository. Three separate times in one week a record said a
 * check was doing something it was not:
 *
 *   - a rule targeting a class the framework had renamed, hiding nothing on any page;
 *   - an extractor that read both sides of a comparison as the same, because a new table repeated
 *     the names it was already reading;
 *   - a guard on a variable that was a truthy string literal, so its message could never print.
 *
 * None of them was found by a test. Each was found by a person breaking something on purpose.
 *
 * **Why it is not in `pnpm test`:** no test in this repository rewrites source files, and a process
 * killed mid-run would leave a modified tree behind. This copies the repository to a temporary
 * directory and mutates **that**, so an interrupted run costs nothing.
 *
 * ## How it decides it has proved anything
 *
 * A harness that reports green without having mutated anything is worse than no harness, because it
 * is indistinguishable from a gate that stopped working. Three properties, each checkable:
 *
 *   1. every case must actually change a file — the runner reports the byte delta and refuses a
 *      case whose mutation was a no-op;
 *   2. every case must be run against the **unmutated** copy first, so a gate that is already red
 *      is reported as such instead of being credited with catching the mutation;
 *   3. a gate with no case is listed as unproven. Three of the five have one; two do not, and
 *      saying so is the point.
 *
 * ## Running it
 *
 *     node packages/website/scripts/counterfactuals/run.mjs            # all cases
 *     node packages/website/scripts/counterfactuals/run.mjs <gate>     # one gate
 *
 * The site must have been built — three of the five gates read the build output, and copying a
 * missing one would make every case fail for the wrong reason. That is checked up front, by name.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECK_SCRIPTS } from '../checks.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SITE = join(HERE, '..', '..');
const REPO_ROOT = join(SITE, '..', '..');

/**
 * One case = one mutation = one expectation.
 *
 * `mutate` receives the throwaway directory and returns a one-line description of what it changed.
 * It must change bytes; the runner measures the tree before and after and rejects a no-op, because a
 * case that mutates nothing and passes proves exactly nothing.
 */
const CASES = [
  {
    gate: 'check-landing-tool-names.mjs',
    name: 'the landing page advertises a tool this package does not register',
    mutate(dir) {
      const file = join(dir, 'packages', 'website', '.vitepress', 'dist', 'index.html');
      const before = read(file);
      write(file, before.replace('</body>', '<code>ptc_not_a_real_tool</code></body>'));
      return 'added `ptc_not_a_real_tool` to the built landing page';
    },
  },
  {
    gate: 'check-internal-links.mjs',
    name: 'a link points at a page that was never built',
    mutate(dir) {
      const file = join(dir, 'packages', 'website', '.vitepress', 'dist', 'index.html');
      const before = read(file);
      write(file, before.replace('</body>', '<a href="/pi-ptc-subagents/docs/nope">x</a></body>'));
      return 'added a root-relative href to a route that is not built';
    },
  },
  {
    gate: 'check-style-scope.mjs',
    name: 'the landing stylesheet restyles the docs shell without its scope',
    mutate(dir) {
      const file = join(dir, 'packages', 'website', '.vitepress', 'theme', 'landing.css');
      const before = read(file);
      write(file, `${before}\n.VPNav { display: none !important; }\n`);
      return 'added an unscoped `.VPNav` override to the landing stylesheet';
    },
  },
  {
    gate: 'check-doc-claims.mjs',
    name: 'a documented default no longer matches the constant',
    mutate(dir) {
      // `dispatch-concurrency-default` binds `DEFAULT_CONFIG.dispatchConcurrency` to the sentence
      // "`dispatchConcurrency` — default 8" in `docs/usage/bgdispatch.md`. Changing the default is
      // the drift a reader would actually hit: the prose keeps describing the previous number.
      //
      // The first attempt at this case mutated `maxOutputBytes`, which no binding covers. The
      // mutation changed real bytes, the gate stayed green, and the harness reported it as NOT
      // CAUGHT rather than as a pass — which is the whole reason this runner checks that the gate
      // was already red on an unmutated copy and refuses to credit a case that hit nothing.
      const file = findFirst(dir, 'src/runtime/limits.ts');
      const before = read(file);
      const next = before.replace(/^(\s*)dispatchConcurrency: 8,$/m, '$1dispatchConcurrency: 9,');
      if (next === before) throw new Error('counterfactual did not match: no dispatchConcurrency default');
      write(file, next);
      return 'changed DEFAULT_CONFIG.dispatchConcurrency, which the documentation quotes';
    },
  },
  {
    gate: 'check-projection-coverage.mjs',
    name: 'a reader-facing document is neither projected nor excused',
    mutate(dir) {
      const file = join(dir, 'docs', 'usage', 'counterfactual-probe.md');
      write(file, '# A reader-facing document nobody decided about\n\nBody.\n');
      // Re-run the projection so the gate sees a file the manifest does not account for. Writing
      // the file alone would not be enough: the gate reads the manifest, not the directory.
      spawnSync(process.execPath, [join(dir, 'packages', 'website', 'scripts', 'project-docs.mjs')], {
        cwd: dir,
        encoding: 'utf8',
      });
      return 'added a document under docs/usage/ without projecting or excusing it';
    },
  },
];

// ── helpers ──────────────────────────────────────────────────────────────────────────────────

const read = (file) => readFileSync(file, 'utf8');
const write = (file, content) => writeFileSync(file, content);

function findFirst(dir, rel) {
  const full = join(dir, rel);
  if (!existsSync(full)) throw new Error(`counterfactual expected a file that is not there: ${rel}`);
  return full;
}

/**
 * A content hash of every file under `dir`.
 *
 * This started out as a total byte count, which is a **wrong** change detector and was caught by
 * the harness itself: a mutation turning `dispatchConcurrency: 8` into `9` changes real content and
 * not one byte of length, so the runner reported "the mutation changed no bytes" for a mutation
 * that worked. A length is not an identity; hash the contents.
 *
 * `ignore` is a set of directory names to prune at any depth. Scanning the real repository needs it:
 * `node_modules` is 492 MB of files that no counterfactual can plausibly mutate and that a stray
 * background install would otherwise turn into a false "the repository changed" — a harness that
 * cries wolf about its own safety check stops being read. Symlinks are hashed by path without being
 * followed, so the set of them is still covered.
 */
function treeDigest(dir, ignore = new Set()) {
  const hash = createHash('sha256');

  const walk = (current) => {
    const found = [];
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) found.push([join(current, entry.name), null]);
      else if (entry.isDirectory()) {
        if (ignore.has(entry.name)) continue;
        found.push(...walk(join(current, entry.name)));
      } else if (entry.isFile()) found.push([join(current, entry.name), null]);
    }
    return found;
  };

  for (const [file] of walk(dir).sort()) {
    hash.update(file.slice(dir.length));
    hash.update(readFileSync(file));
  }
  return hash.digest('hex');
}

/**
 * A throwaway copy: tracked files, plus the build output and the projected documents.
 *
 * Both extra pieces are gitignored build products, so `git archive` alone would hand every case a
 * copy in which three of the five gates are red for a missing build — a case that then "passes"
 * because it was already broken.
 */
function makeWorkdir() {
  const dir = mkdtempSync(join(tmpdir(), 'ptc-site-counterfactual-'));
  const archive = spawnSync('git', ['archive', 'HEAD'], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 });
  if (archive.status !== 0) throw new Error(`git archive failed: ${archive.stderr?.toString().trim()}`);
  spawnSync('tar', ['-x', '-C', dir], { input: archive.stdout, stdio: ['pipe', 'ignore', 'pipe'] });
  cpSync(join(SITE, '.vitepress', 'dist'), join(dir, 'packages', 'website', '.vitepress', 'dist'), {
    recursive: true,
  });
  cpSync(join(SITE, 'docs'), join(dir, 'packages', 'website', 'docs'), { recursive: true });
  return dir;
}

function runGate(dir, gate) {
  const run = spawnSync(process.execPath, [join(dir, 'packages', 'website', 'scripts', gate)], {
    cwd: dir,
    encoding: 'utf8',
  });
  return { code: run.status, out: `${run.stdout ?? ''}${run.stderr ?? ''}`.trim() };
}

// ── main ────────────────────────────────────────────────────────────────────────────────────

const only = process.argv[2];
const selected = only ? CASES.filter((c) => c.gate === only) : CASES;

if (only && selected.length === 0) {
  console.error(`✗ no counterfactual for ${only}. Known gates: ${[...new Set(CASES.map((c) => c.gate))].join(', ')}`);
  process.exit(1);
}

if (!existsSync(join(SITE, '.vitepress', 'dist', 'index.html'))) {
  console.error(
    '✗ the site has not been built.\n\n' +
      '  Three of the five gates read the build output, and every case would otherwise fail for\n' +
      '  the missing build rather than for its mutation. Run `pnpm --filter website run build` first.',
  );
  process.exit(1);
}

/** Directories pruned when hashing the real repository; see `treeDigest`. */
const REPO_SCAN_IGNORE = new Set(['.git', 'node_modules']);

const before = treeDigest(REPO_ROOT, REPO_SCAN_IGNORE);
let failed = 0;
let proved = 0;

console.log(`site counterfactuals — ${selected.length} case(s)\n`);

for (const testCase of selected) {
  const label = `${testCase.gate} · ${testCase.name}`;

  // Property 2: the unmutated copy must be green, or this case cannot be credited.
  const clean = makeWorkdir();
  const cleanRun = runGate(clean, testCase.gate);
  rmSync(clean, { recursive: true, force: true });
  if (cleanRun.code !== 0) {
    failed += 1;
    console.log(`── ${label}`);
    console.log(`   ✗ the gate was already red on an unmutated copy, so this case proves nothing:`);
    console.log(`${cleanRun.out.split('\n').map((l) => `     ${l}`).join('\n')}`);
    console.log('');
    continue;
  }

  const work = makeWorkdir();
  let what;
  try {
    const digestBefore = treeDigest(work);
    what = testCase.mutate(work);
    if (treeDigest(work) === digestBefore) {
      throw new Error('the mutation changed no bytes');
    }
  } catch (error) {
    failed += 1;
    rmSync(work, { recursive: true, force: true });
    console.log(`── ${label}`);
    console.log(`   ✗ the mutation itself failed: ${error.message}`);
    console.log('');
    continue;
  }
  const mutated = runGate(work, testCase.gate);
  rmSync(work, { recursive: true, force: true });

  if (mutated.code === 0) {
    failed += 1;
    console.log(`── ${label}`);
    console.log(`   ✗ NOT CAUGHT — the gate still exits 0 after: ${what}`);
    console.log('');
  } else {
    proved += 1;
    const headline = mutated.out.split('\n')[0].slice(0, 96);
    console.log(`── ${label}`);
    console.log(`   ✓ caught (exit ${mutated.code}) — ${what}`);
    console.log(`     ${headline}`);
    console.log('');
  }
}

// Property 3: a gate with no case is visibly unproven. Read the list from `checks.mjs` — the same
// module `run-checks.mjs` runs — so a gate added there shows up here as unproven the day it is
// added, instead of never.
const uncovered = CHECK_SCRIPTS.filter((g) => !CASES.some((c) => c.gate === g));
if (uncovered.length > 0 && !only) {
  console.log(`no counterfactual yet for: ${uncovered.join(', ')}`);
  console.log('These gates are unproven by this harness. That is a gap, not a pass.\n');
}

// Property 4: the repository must be exactly as we found it.
const after = treeDigest(REPO_ROOT, REPO_SCAN_IGNORE);
if (after !== before) {
  failed += 1;
  console.log('✗ the repository changed during this run. A counterfactual must leave it untouched.');
}

if (failed > 0) {
  console.error(`✗ ${failed} of ${selected.length} counterfactual(s) did not hold`);
  process.exit(1);
}

console.log(`✓ all ${selected.length} counterfactual(s) held; the repository is unchanged`);
