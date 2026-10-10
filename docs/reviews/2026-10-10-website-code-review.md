# Review — the project site, from pipeline to published links

Date: 2026-10-10. Fixed point: `8da2f6a` (first merge of the feature) through `46753d2`. Spec:
issue #144; six tickets #145–#150, all closed.

Two rounds. Round 1 reviewed the shipped site and the whole feature diff. Round 2 was a delta over
round 1's fix, as the skill requires. **Round 3 was not run** — see "Why this stopped".

## What was reviewed

| Commit    | PR   | Ticket                                                     |
| --------- | ---- | ---------------------------------------------------------- |
| `e768bde` | #151 | #145 pipeline: workspace member, Pages workflow, deploy    |
| `1075124` | #152 | #146 landing page + `ptc_*` tool-name gate                 |
| `8da2f6a` | #153 | #147 document projection, internal-link gate, README links |
| —         | —    | #148 About panel (repository metadata, no commit)          |
| `1113680` | #154 | #149 `package.json` homepage                               |
| `ecf49fe` | #155 | #150 ADR-0036 / 0037 / 0038                                |
| `77fc8c4` | #156 | round 1 fix                                                |
| `46753d2` | #157 | round 2 fix                                                |

## Findings ledger

### R-w1 — every projected page linked "edit this page" at a path that exists nowhere

|                           |                                                                                                                                                                                                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Found**                 | On the deployed site, crawling the four projected routes. Not visible in the diff.                                                                                                                                                                                                                                        |
| **Evidence**              | `/docs/install` → `.../edit/main/docs/docs/install.md`; same shape on all four. Every one 404s. Zero occurrences of `edit/main/` should exist.                                                                                                                                                                            |
| **Why nothing caught it** | VitePress's dead-link check resolves only links _inside_ the site. `check-internal-links.mjs` reconciled only root-relative hrefs against built routes. An absolute URL pointing into the repository was invisible to both. The build was green throughout.                                                               |
| **Root cause**            | VitePress substitutes a page's **source path** into `editLink.pattern`. A projected page's source path is a file in the site's own generated tree — gitignored, holding nothing anyone can commit. The pattern's `docs/` prefix was applied on top, doubling it.                                                          |
| **Closure**               | `77fc8c4`. Closed by removing `editLink`, not by correcting it. **Counterfactual:** re-injecting the exact historical URL into the built HTML turns `check-internal-links.mjs` red with `exit 1` and names both the missing path and the page it was linked from. Reverted after.                                         |
| **Also measured**         | The obvious fix was tried first and failed on measurement: writing each projected file at its repository path and routing by frontmatter `slug` — **VitePress 1.6.4 ignores that `slug`**, routes stayed at `/docs/usage/surface`, and every curated route became a dead link. Recorded in ADR-0037 so nobody retries it. |

### R-w2 — the gate added in R-w1 passed links that left the repository

|                    |                                                                                                                                                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Found**          | Delta review of `77fc8c4`'s own diff.                                                                                                                                                                                                                                                       |
| **Evidence**       | `existsSync(join(REPO_ROOT, target))` follows `..` out of the repo. A link to `blob/main/../../../../etc/hosts` reported `32 repository link(s) resolved, nothing dangling`, **exit 0** — proven before fixing, not assumed.                                                                |
| **Why it matters** | A false pass in the gate whose entire purpose is removing false passes. The way in is the hand-written landing page, which the projection's containment check does not cover.                                                                                                               |
| **Closure**        | `46753d2`. Containment is checked before the filesystem is touched, using the rule `project-docs.mjs` already applies. **Counterfactual:** the escaping link went from exit 0 to exit 1; the original `docs/docs/install.md` stays red; a real file still passes. All three reverted after. |

## Stopping decision

Round 3 was not run. Two of the three stopping conditions hold:

- **The class is measured to exhaustion.** Every link the live site emits falls into one of four
  classes, and each is assigned: root-relative (gated against built routes), repository-absolute
  (gated against the working tree, with containment), in-page anchors (same-page reference, out of
  scope by definition), external (not checkable from a build — documented in the gate's header).
  A crawl of all five live pages found **77 distinct links, 34 gated, 43 out of scope**, with zero
  unclassified.
- **Verified end to end against the deployed artifact.** All five routes return 200 with a
  cache-buster. Zero `edit/main/` occurrences remain. Of the four genuinely external links, three
  resolve 200; `npmjs.com` returns 403 to this machine (bot protection) and is recorded as
  unverifiable from here rather than as passing.

A round 3 would be a delta over a 12-line change with two verified counterfactuals. Its expected
yield is records, not behaviour — which this repository's own guidance treats as the signal to stop.

## Defects caught _during_ the build, before review

These were found by gates and counterfactuals at build time, and are recorded in their tickets. They
are listed because the pattern is the point: **in seven of nine cases, the evidence that something
was wrong came from running something, not from reading the code.** The two that did not are the
missed constant-registered tool (found by reading the registration sites) and the false claim about
VitePress's dead-link check (found by noticing the landing page's 404 despite a green build).

| Defect                                                                              | What caught it                                                                                           |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Landing page rendered blank with a green build, 200s, and text in the DOM           | A screenshot. Nothing else could see it.                                                                 |
| Tool-name gate truncated `ptc_task_*` to `ptc_task_` via `\b` backtracking          | A counterfactual on a wildcard name                                                                      |
| Tool-name gate missed `ptc_child_report` (registered via a constant)                | Reading the registration sites, not the `name:` fields                                                   |
| Claim "VitePress fails the build on a dead link, so a broken link cannot ship"      | **It was wrong** — that check ignores `href`s written in a Vue template. Written into the gate's header. |
| A counterfactual that "passed" with exit 1                                          | Reading the error: `ReferenceError: existsSync is not defined`, not the gate blocking                    |
| Projection's existence check failed on correct content (`../../CONTEXT.md`)         | The build, on real input                                                                                 |
| `git checkout` reverted config written in the same ticket                           | Explicit `git add` on a known file list                                                                  |
| `programmable-tool-calling` published as a topic; the manifest says `programmatic-` | Comparing read-back topics against `package.json` keywords                                               |
| `oxfmt` aborts the whole tree on a malformed `.html` (exit 2)                       | A probe file — now measured into ADR-0036                                                                |

## Known gaps carried forward, deliberately not closed here

- **About description ↔ `package.json` description can drift.** They match today. No gate notices a
  future rewording: `EXTERNAL_VOCABULARY`-style precedent does not exist for it, `tests/` contains
  no `api.github.com` reference, and the check would be the repo's first network-dependent assertion.
- **The tool-name gate is one-directional.** A page that _invents_ a `ptc_*` name fails the build; a
  page that _omits_ one does not.
- **`homepage` reaches npm only at the next publish.** Published `2.0.2` still carries the old value.
  Criterion 3 of #149 is therefore recorded as unmet, not ticked.
- **`npmjs.com` is unreachable from this machine** (403 with and without a browser UA), so the npm
  page's _rendering_ was never observed here.
- **External links are not gated.** A deliberate boundary with a stated reason, not an oversight.
