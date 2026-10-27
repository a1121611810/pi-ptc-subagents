# pi-ptc-subagents — the site

The published site is <https://a1121611810.github.io/pi-ptc-subagents/>. It is a second workspace
member in this repository, not part of the npm package: nothing in `dist/` comes from it, and
the root lint and format gate ignore it for the same reason — coupling "can this package be
published" to "does a Vue template parse" is a release ceremony carrying a second project's
failures. The same exclusion applies to the root `build`/`check` recursion
(`--filter=!@pi-ptc/website` in the root scripts), so a red site can never block the npm
release chain.

This file is the operational reference for it. The decisions live in ADR-0018 (current series,
recording this restore) and 旧 ADR-0036 / 0037 / 0038 (the original site series, archived on
`backup/main-legacy-20261026`); this is what exists now and what to do when it goes red.

## The checks

All four run from the site's own runner. None of them runs in the root release chain.

| Check | What it catches | What turns it red |
| --- | --- | --- |
| `check-projection-coverage.mjs` | A reader-facing document that is neither projected onto the site nor excused | A new `*.md` in `docs/` or `packages/routes/docs/routes/` that nobody decided about; an exclusion naming a path that no longer exists; a projected source that was deleted |
| `check-landing-tool-names.mjs` | A tool name the landing page shows that the code does not register, or one nobody decided to show | A registered `ptc_*` / `pi_task_*` / `web_ds_*` landing in neither `MUST_APPEAR` nor `DECLARED_ABSENT`; a `DECLARED_ABSENT` entry naming a name that has since been removed |
| `check-internal-links.mjs` | A link that leaves the site, including repository links whose file is not there | A root-relative `href` in the built HTML pointing at a page that was not built; a `/blob/`, `/edit/` or `/tree/` link whose target is missing from the working tree |
| `check-style-scope.mjs` | The landing stylesheet restyling the documentation pages | A rule touching VitePress's own shell without the landing scope; the scope anchor renamed so it matches nothing; the anchor leaking onto a documentation page |

`check-external-links.mjs` is **not** in that table because it is not a gate. It reports, never
exits non-zero, and is never wired into CI: a check against someone else's host fails on their
outage and on bot protection. Run it by hand when you want to know.

Two checks from the old site did not come back with the restore, on purpose:

- `check-doc-claims.mjs` bound 19 prose claims to named constants in the old single-package
  `src/`. That source tree is gone, and the rewrite's model-facing prose already has its own
  gates in `tests/route-registry-gates.test.mjs`. If human-facing usage documents appear under
  `docs/usage/`, reintroduce this gate bound to the new constants.
- The two meta-tests (`tests/site-checks-on-pr.test.ts`, `tests/website-readme-consistency.test.ts`)
  were written against the old vitest stack and are not ported to the current `node:test` suite
  yet. The properties they held — same command on PR and deploy, README table matches the runner
  list — are conventions this README records; port them when the site next changes shape.

## Where the checks run

This is the part that surprises people.

| Path | Trigger | What runs |
| --- | --- | --- |
| Pull request (`.github/workflows/website.yml`) | `pull_request` | The same build, as the same command: `pnpm --filter @pi-ptc/website run build`. This is what makes a red check visible before the merge instead of after it |
| Site deployment (`.github/workflows/pages.yml`) | push to `main` | The build is the gate: the four checks run as part of `pnpm --filter @pi-ptc/website run build`, before anything is uploaded |
| npm release (`.github/workflows/publish.yml`) | push of a `v*` tag | The root release chain — the site is excluded from it (旧 ADR-0036) |

**The pull request runs the same command the deploy does, not a subset of it.** On the old site,
until 2026-10-12, the checks ran nowhere except `pages.yml`, so a pull request that turned one of
them red merged cleanly and the failure surfaced afterwards as a failed deploy
([#174](https://github.com/a1121611810/pi-ptc-subagents/issues/174)). Both sides invoke
`pnpm --filter @pi-ptc/website run build` rather than a merge-side selection, because two sets —
one guarding a merge, one guarding a deploy — can drift apart, and a drift is worse than the gap
it replaced: it is silent, it reinstates the original bug for whichever check fell out, and it
does so while every gate stays green.

**Do not narrow the `pull_request` trigger with `paths:`.** `check-landing-tool-names.mjs` reads
`packages/routes/src/registry.ts`, so a pull request that changes that file and nothing under
`packages/website/` can still turn a site check red. A filter scoped to the site would skip
exactly that class of drift, and skip it silently.

## Running them locally

```bash
pnpm --filter @pi-ptc/website run build
```

That projects the documents, builds the site, and runs all four checks.

`pnpm --filter @pi-ptc/website run check` runs the checks alone, and **all four need something
`build` produces**:

| Check | Needs | Because |
| --- | --- | --- |
| `check-projection-coverage.mjs` | `pnpm --filter @pi-ptc/website run project` | it reads the manifest `project-docs.mjs` writes, and `packages/website/docs/` is gitignored |
| `check-landing-tool-names.mjs` | the built landing page | it reads the emitted HTML |
| `check-internal-links.mjs` | the build output | it resolves links against the pages that were actually built |
| `check-style-scope.mjs` | the build output | it checks the scope anchor against the built pages |

On a freshly cloned repository that has never been built, running `check` therefore turns
**all four** red. That is a missing build, not four broken checks — but it reads exactly like
four broken checks, which is why `build` is the command above and `check` is the one to reach
for afterwards.

## Adding a check

1. Write the script under `packages/website/scripts/`, named `check-<what-it-catches>.mjs`. The root
   `scripts/` is for release and metadata checks and is not on this path — a script left there is
   never found by the runner.
2. Add it to `CHECKS` in `packages/website/scripts/checks.mjs`. That is the list
   `run-checks.mjs` runs and the list the counterfactual harness reads, so there is one place and
   a new gate cannot be half-registered. Importing `run-checks.mjs` to read the list instead would
   run all four checks as a side effect of asking about it.
3. **Add it to the table in "The checks"**, so the name is in that table's two content columns.
   (The old repository had a test enforcing this; it is not ported yet — see above. Keep the
   table true by hand.)
4. **Prove the new gate has teeth.** `node packages/website/scripts/counterfactuals/run.mjs` breaks
   each gate in a throwaway copy and requires it to go red; a gate with no case is listed as
   unproven, so adding a gate here without adding its case shows up on the next run rather than
   never. It needs the site built, and it is not part of `pnpm test` — nothing in this
   repository's test suite rewrites source files, and a run killed halfway would leave a modified
   tree behind.

## What the site publishes

- The seven route booklets under `packages/routes/docs/routes/` — the model-facing prose single
  source (ADR-0013), which doubles as the usage documentation. Projected, not copied.
- `docs/pi-version-matrix.md`, the measured pi compatibility matrix. Projected.
- The two living status panoramas (`docs/prototypes/ptc-runtime-status.html`,
  `docs/prototypes/dispatch-engine-status.html`), copied verbatim into `public/status/`. They
  are complete HTML documents with their own styles; the site adds nothing to them.

Everything projected or copied is generated by `scripts/project-docs.mjs` at build time and
gitignored. There is no committed copy and nothing to keep in sync: the only way to change what
the site says about a dispatch door is to edit its booklet in the repository (旧 ADR-0037).

## Deliberate boundaries

Not gaps. Do not "fix" them without reading the reason.

- **Outbound links are reported, never gated.** The reason is real but was not recorded anywhere
  until 2026-10-12, which is why a later reader could cite a decision record that never made this
  boundary. It now lives here.
- **The site is excluded from the repository's root lint and format gate** (旧 ADR-0036). The
  formatter aborts the whole tree on a malformed HTML file, and the site is the only part of the
  tree that owns HTML on purpose. The root `build`/`check` recursion excludes it the same way.
- **The site deploys on every push to `main`, not on release tags** (旧 ADR-0038). Its content is
  a rendering of the working tree, so a tag-triggered deploy would answer "how do I use this"
  with instructions from weeks ago.
