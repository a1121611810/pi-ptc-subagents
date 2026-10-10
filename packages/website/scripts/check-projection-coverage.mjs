#!/usr/bin/env node
/**
 * Gate: every reader-facing document is either projected onto the site or excused, with a reason.
 *
 * ADR-0037 records that the projection is an explicit list rather than a directory walk, and
 * gives the reason: adding a page should be "a decision rather than an accident". This gate is
 * what makes that sentence true. Without it the decision is made by whoever happens to remember,
 * which is nobody: a new document under `docs/usage/` joins the repository, does not join the
 * site, and nothing says so.
 *
 * ## Why the scope is two directories and not all of `docs/`
 *
 * This repository holds 87 markdown files under `docs/`. Four are projected. The rest are
 * deliberately not: ADRs are a maintainer-facing record whose audience is already on GitHub
 * (ADR-0037), and research, reviews, prototypes, specs and agent docs are internal evidence.
 * Asserting "everything is projected" would be a wrong requirement.
 *
 * So the reader-facing surface is declared by location — `docs/*.md` and `docs/usage/*.md` — and
 * everything else is accounted for by directory, each with a stated reason. The reasons are the
 * point: an exclusion without one is how a document stays invisible by accident, which is the
 * drift this check exists to catch. It is the same contract `EXTERNAL_VOCABULARY` uses in
 * `tests/doc-integrity.test.ts`.
 *
 * It also catches the two silent directions: a projected source that has been deleted, and an
 * exclusion for a document that no longer exists.
 *
 * Exit code is 1 with every unaccounted path named. The resolved count is printed so a run with
 * nothing to report is distinguishable from a run that looked at nothing.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const DOCS = join(REPO_ROOT, "docs");
const MANIFEST = join(HERE, "..", "docs", "projected.json");

/** Reader-facing locations. A new file in either must be projected or excused. */
const READER_FACING = [
  { dir: DOCS, label: "docs/*.md" },
  { dir: join(DOCS, "usage"), label: "docs/usage/*.md" },
];

/** Top-level documents that are reader-facing by location but not for the site, each with why. */
const FILE_EXCLUSIONS = new Map([
  [
    "docs/testing-constraints.md",
    "the testing discipline for contributors working on this repository; it constrains how a " +
      "change is verified rather than how the package is used",
  ],
]);

/** Directory trees under `docs/` that are accounted for wholesale, each with why. */
const DIRECTORY_EXCLUSIONS = new Map([
  ["docs/adr", "architecture decision records — a maintainer-facing history whose audience is on GitHub (ADR-0037)"],
  ["docs/agents", "how this repository's own engineering skills are wired; of no use to a reader of the package"],
  ["docs/prototypes", "throwaway design evidence, kept as the record of a decision rather than as documentation"],
  ["docs/research", "surveys, upstream audits and measurements; inputs to decisions, not documentation"],
  ["docs/reviews", "per-change review ledgers; a process record rather than documentation"],
  ["docs/specs", "written specifications kept with the repository history"],
]);

/** List .md files directly in a directory (non-recursive: the roots above are the whole claim). */
function mdFiles(dir, acc = []) {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) continue;
    if (entry.endsWith(".md")) acc.push(full);
  }
  return acc;
}

function repoRelative(path) {
  return relative(REPO_ROOT, path).split(sep).join("/");
}

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function main() {
  if (!existsSync(MANIFEST)) {
    console.error(`✗ no projection manifest at ${repoRelative(MANIFEST)}`);
    console.error("  This gate reads what `project-docs.mjs` projected, so it runs after it.");
    process.exit(1);
  }

  const projected = new Set(
    JSON.parse(readFileSync(MANIFEST, "utf8")).projected.map((entry) => entry.source),
  );

  const readerFacing = [];
  for (const root of READER_FACING) {
    if (!existsSync(root.dir)) continue;
    for (const file of mdFiles(root.dir)) readerFacing.push(repoRelative(file));
  }

  const unaccounted = [];
  for (const doc of readerFacing.sort(byName)) {
    if (projected.has(doc)) continue;
    if (FILE_EXCLUSIONS.has(doc)) continue;
    unaccounted.push(doc);
  }

  // A projected source that no longer exists leaves the build reading a deleted file's worth of
  // intent; `project-docs.mjs` would already fail on it, so this only names the other direction.
  const vanished = [...projected].filter((source) => !existsSync(join(REPO_ROOT, source)));

  // An exclusion for a document that is gone is a stale record. It is how the *next* document
  // ends up excused by accident.
  const staleFiles = [...FILE_EXCLUSIONS.keys()].filter((p) => !existsSync(join(REPO_ROOT, p)));
  const staleDirs = [...DIRECTORY_EXCLUSIONS.keys()].filter((p) => !existsSync(join(REPO_ROOT, p)));

  if (unaccounted.length > 0 || vanished.length > 0 || staleFiles.length > 0 || staleDirs.length > 0) {
    if (unaccounted.length > 0) {
      console.error(
        `✗ ${unaccounted.length} reader-facing document(s) are neither projected nor excused:\n`,
      );
      for (const doc of unaccounted) console.error(`   ${doc}`);
      console.error(
        "\n  Add it to DOCUMENTS in project-docs.mjs to put it on the site, or to\n" +
          "  FILE_EXCLUSIONS here with a reason if the site should not carry it.",
      );
    }
    if (vanished.length > 0) {
      console.error(`\n✗ ${vanished.length} projected source(s) no longer exist:`);
      for (const doc of vanished.sort(byName)) console.error(`   ${doc}`);
    }
    if (staleFiles.length > 0 || staleDirs.length > 0) {
      console.error("\n✗ exclusions name paths that no longer exist:");
      for (const p of [...staleFiles, ...staleDirs].sort(byName)) console.error(`   ${p}`);
      console.error("  Delete them in the same change that removed the path.");
    }
    process.exit(1);
  }

  const accounted = readerFacing.length - unaccounted.length;
  console.log(
    `✓ projection coverage — ${accounted}/${readerFacing.length} reader-facing document(s) ` +
      `accounted for (${projected.size} projected, ${FILE_EXCLUSIONS.size} excluded), ` +
      `${DIRECTORY_EXCLUSIONS.size} director(ies) excluded wholesale`,
  );
}

main();
