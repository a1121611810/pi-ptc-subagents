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
 * is indistinguishable from a gate that stopped working. Four properties, each checkable:
 *
 *   1. every case must actually change a file — the runner hashes the tree before and after and
 *      refuses a case whose mutation was a no-op;
 *   2. every case must be run against the **unmutated** copy first, so a gate that is already red
 *      is reported as such instead of being credited with catching the mutation;
 *   3. a gate with no case is listed as unproven, and the list of gates is read from `checks.mjs`
 *      rather than written here, so a gate added there shows up as unproven the day it is added;
 *   4. the repository must be unchanged when the run finishes — same paths, same kinds, same
 *      contents, same symlink targets.
 *
 * Property 3 currently has nothing to print: all four gates have a case. It was not written
 * speculatively — this file started with three cases, and the missing ones were what made property 3
 * worth having. Adding a fifth gate to `checks.mjs` by hand and re-running was how it was checked:
 * `no counterfactual yet for: check-fifth.mjs`, as it should be.
 *
 * Every case runs against a copy of **your working tree**, not of `HEAD`. That is deliberate and it
 * was wrong first: `git archive HEAD` meant a gate you had just broken in your working tree still
 * reported as having caught its mutation. The whole question here is whether the gate in front of
 * you has teeth.
 *
 * ## Running it
 *
 *     node packages/website/scripts/counterfactuals/run.mjs            # all cases
 *     node packages/website/scripts/counterfactuals/run.mjs <gate>     # one gate
 *
 * The site must have been built — three of the four gates read the build output, and copying a
 * missing one would make every case fail for the wrong reason. That is checked up front, by name.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
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
    gate: 'check-projection-coverage.mjs',
    name: 'a reader-facing document is neither projected nor excused',
    mutate(dir) {
      const file = join(dir, 'docs', 'counterfactual-probe.md');
      write(file, '# A reader-facing document nobody decided about\n\nBody.\n');
      // No re-projection step, and the comment that used to justify one was wrong. The gate
      // enumerates the reader-facing roots itself and compares that list against the manifest,
      // so writing the file is sufficient: measured, file-only goes red (exit 1), while re-running
      // `project-docs.mjs` alone changes nothing at all. An earlier version ran it anyway and threw
      // the result away — a broken projection step reported nothing, which is constraint #3's
      // silent failure.
      return 'added a document under docs/ without projecting or excusing it';
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
 * A content hash of everything under `dir`.
 *
 * This started out as a total byte count, which is a **wrong** change detector and was caught by
 * the harness itself: a mutation turning `dispatchConcurrency: 8` into `9` changes real content and
 * not one byte of length, so the runner reported "the mutation changed no bytes" for a mutation
 * that worked. A length is not an identity; hash the contents.
 *
 * Four corrections after review, all of them about things this first version claimed or missed:
 *
 * - **Directories are hashed, not just files.** Creating an empty directory was invisible, so
 *   "byte-identical" was really "same non-empty path set with the same contents".
 * - **Entries are separated.** Concatenating path and content with no delimiter hashes
 *   `["ab", "c"]` and `["a", "bc"]` identically.
 * - **Symlinks are hashed as links, never followed.** An earlier comment claimed this and the code
 *   did the opposite: `readFileSync` resolves the target, so editing a file outside the tree changed
 *   the digest, and a regular file and a symlink to an identical file hashed the same. The link
 *   target and the entry's kind both go into the hash now.
 * - **`ignore` prunes by relative path**, and is deliberately narrow. `node_modules` is 492 MB that
 *   no counterfactual can plausibly mutate; `coverage/` is a test artifact. `.git/objects` is pruned
 *   but **the rest of `.git` is not** — `.git/hooks` is exactly where a mutation that reached here
 *   would do damage, and pruning all of `.git` left that reachable. Cost of hashing the rest of
 *   `.git` is tens of files.
 */
function treeDigest(dir, ignore = new Set()) {
  const hash = createHash('sha256');
  const pruned = (rel) => [...ignore].some((p) => rel === p || rel.endsWith(`/${p}`));

  const walk = (current) => {
    const found = [];
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        const rel = relative(dir, full).split(sep).join('/');
        if (pruned(rel)) continue;
        found.push([full, 'dir', '']);
        found.push(...walk(full));
      } else if (entry.isSymbolicLink()) {
        found.push([full, 'link', readlinkSync(full)]);
      } else if (entry.isFile()) {
        found.push([full, 'file', readFileSync(full)]);
      }
    }
    return found;
  };

  for (const [path, kind, content] of walk(dir).sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    hash.update(path.slice(dir.length));
    hash.update('\0');
    hash.update(kind);
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * Directories no counterfactual can mutate, pruned from the copy and from the digest.
 * `.codegraph` holds the local codegraph index and a live daemon socket (`daemon.sock`); copying
 * a socket trips cpSync ("Unreachable code"), and its log/db files change while a run is in
 * progress, which would falsely trip property 4. None of it is source a gate could police.
 */
const SKIP_COPY = new Set(['.git', 'node_modules', 'coverage', '.pnpm-store', '.codegraph']);

/**
 * A throwaway copy of **your working tree**.
 *
 * This used to be `git archive HEAD`, which measured the *committed* tree. That is the wrong tree:
 * the question this harness answers is "does the gate in front of me still have teeth", and the gate
 * in front of me is the one in the working tree, not the one from the last commit. Measured: with
 * `check-style-scope.mjs`'s own detection disabled in the working tree and uncommitted, the harness
 * still reported `✓ caught` and exited 0. Copying the working tree also brings the build output and
 * the projected documents along for free — they are gitignored, so `git archive` never had them and
 * every case was running against a tree where three of five gates were red for a missing build.
 *
 * `.git` is skipped because a copy of the object store is not what is being measured, and
 * `node_modules` because it is 492 MB. Everything else, including uncommitted work, is copied.
 */
function makeWorkdir() {
  const dir = mkdtempSync(join(tmpdir(), 'ptc-site-counterfactual-'));
  try {
    cpSync(REPO_ROOT, dir, {
      recursive: true,
      dereference: false,
      filter: (src) => !SKIP_COPY.has(basename(src)),
    });
  } catch (error) {
    // A copy that half-succeeded is worse than none: it would look like a clean starting point.
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`could not copy the working tree into ${dir}: ${error.message}`);
  }
  return dir;
}

/**
 * Run one gate and report how it ended.
 *
 * A gate that died on a signal returns `status: null`, and `null !== 0` used to read as "caught" —
 * so an OOM-killed or SIGSEGV'd gate was credited with detecting the mutation and the harness exited
 * 0, printing `✓ caught (exit null)`. A crash is not a detection. `run.error` is the same case for
 * "never managed to run at all".
 */
function runGate(dir, gate) {
  const run = spawnSync(process.execPath, [join(dir, 'packages', 'website', 'scripts', gate)], {
    cwd: dir,
    encoding: 'utf8',
  });
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
  if (run.error) return { code: null, out: out || run.error.message, died: run.error.message };
  if (run.status === null) {
    return { code: null, out: out || '(no output)', died: `killed by signal ${run.signal}` };
  }
  return { code: run.status, out, died: null };
}

// ── main ────────────────────────────────────────────────────────────────────────────────────

const only = process.argv[2];
const selected = only ? CASES.filter((c) => c.gate === only) : CASES;

if (only && selected.length === 0) {
  console.error(`✗ no counterfactual for ${only}. Known gates: ${[...new Set(CASES.map((c) => c.gate))].join(', ')}`);
  process.exit(1);
}

// Both required inputs, named, before any workdir is created. A missing one used to surface as an
// ENOENT stack trace from deep inside `cpSync`, after a temporary directory had already been made —
// so a plain mistake reported as a crash and leaked the directory behind it.
const REQUIRED_INPUTS = [
  [join(SITE, '.vitepress', 'dist', 'index.html'), 'the built landing page',
    'Run `pnpm --filter website run build` first.'],
  [join(SITE, 'docs'), 'the projected documents',
    'Run `pnpm --filter website run project` first, or the site build, which does it for you.'],
];
const missing = REQUIRED_INPUTS.filter(([path]) => !existsSync(path));
if (missing.length > 0) {
  console.error('✗ the site is not in a state this harness can measure.\n');
  for (const [, what, fix] of missing) console.error(`  missing ${what} — ${fix}\n`);
  console.error('  Three of the five gates read the build output, so every case would otherwise fail\n');
  console.error('  for the missing input rather than for its mutation.\n');
  process.exit(1);
}

/** Pruned when hashing the real repository; see `treeDigest` for why `.git` is only half-pruned. */
const REPO_SCAN_IGNORE = new Set(['node_modules', 'coverage', '.pnpm-store', '.codegraph', '.git/objects']);

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

  if (mutated.died) {
    // A gate that crashed did not detect anything. Counting it as a catch is the one false pass
    // this harness exists to avoid, so it is named as what it is.
    failed += 1;
    console.log(`── ${label}`);
    console.log(`   ✗ the gate did not finish — ${mutated.died}. A crash is not a detection:`);
    console.log(`${mutated.out.split('\n').map((l) => `     ${l}`).join('\n')}`);
    console.log('');
  } else if (mutated.code === 0) {
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
