/**
 * The site's checks, declared once.
 *
 * This list used to live inline in `run-checks.mjs`, which is the only reason it moved. The
 * counterfactual harness needs the same list to answer a question `run-checks.mjs` cannot: which
 * gates has nobody ever tried to break. A second copy of that list in a *gate-verification* tool is
 * a liability — add a sixth check to `run-checks.mjs` and a hardcoded copy silently keeps saying
 * "no counterfactual yet for: check-a, check-b", omitting the new gate entirely, so the harness
 * reports itself complete while a gate goes unproven. That is the failure this repository keeps
 * paying for in other places: a duplicate of a fact that rots without anyone noticing.
 *
 * Importing it here rather than parsing `run-checks.mjs` is deliberate. `run-checks.mjs` runs all
 * five checks in its top level, so importing it to read the list would run the whole gate suite as
 * a side effect of asking a question about it.
 *
 * Kept in `run-checks.mjs` order, which is also the order they run and the order the README table
 * lists them in.
 */

export const CHECKS = [
  ["documented claims", "check-doc-claims.mjs"],
  ["projection coverage", "check-projection-coverage.mjs"],
  ["landing page tool names", "check-landing-tool-names.mjs"],
  ["internal links", "check-internal-links.mjs"],
  ["landing style scope", "check-style-scope.mjs"],
];

/** Just the script filenames, for callers that have no use for the human labels. */
export const CHECK_SCRIPTS = CHECKS.map(([, script]) => script);