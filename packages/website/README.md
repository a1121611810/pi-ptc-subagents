# pi-ptc-subagents — the site

The published site is <https://a1121611810.github.io/pi-ptc-subagents/>. It is a second workspace
member in this repository, not part of the npm package: nothing in `dist/` comes from it, and
ADR-0036 keeps it out of the root lint and format gate for the same reason — coupling "can this
package be published" to "does a Vue template parse" is a release ceremony carrying a second
project's failures.

This file is the operational reference for it. The decisions live in `docs/adr/0036`, `0037` and
`0038`; this is what exists now and what to do when it goes red.

## The checks

All five run from the site's own runner. None of them runs in the root release chain.

| Check | What it catches | What turns it red |
| --- | --- | --- |
| `check-doc-claims.mjs` | Prose in the projected documents describing code that no longer exists | A default moves, a literal is reworded, a key is renamed — 19 bindings over 4 documents, each anchored to a named constant rather than a text search |
| `check-projection-coverage.mjs` | A reader-facing document that is neither projected onto the site nor excused | A new document under `docs/*.md` or `docs/usage/*.md` that nobody decided about; an exclusion naming a path that no longer exists; a projected source that was deleted |
| `check-landing-tool-names.mjs` | A tool name the landing page shows that the package does not register, or one nobody decided to show | A registered tool landing in neither `MUST_APPEAR` nor `DECLARED_ABSENT`; a `DECLARED_ABSENT` entry naming a tool that has since been removed; a retired name — one this package renamed away — still on the page |
| `check-internal-links.mjs` | A link that leaves the site, including repository links whose file is not there | A root-relative `href` in the built HTML pointing at a page that was not built; a `/blob/`, `/edit/` or `/tree/` link whose target is missing from the working tree |
| `check-style-scope.mjs` | The landing stylesheet restyling the documentation pages | A rule touching VitePress's own shell without the landing scope; the scope anchor renamed so it matches nothing; the anchor leaking onto a documentation page |

`check-external-links.mjs` is **not** in that table because it is not a gate. It reports, never
exits non-zero, and is never wired into CI: a check against someone else's host fails on their
outage and on bot protection. Run it by hand when you want to know.

## Where the checks run

This is the part that surprises people.

| Path | Trigger | What runs |
| --- | --- | --- |
| Pull request (`.github/workflows/website.yml`) | `pull_request` | The same build, as the same command: `pnpm --filter website run build`. This is what makes a red check visible before the merge instead of after it |
| Site deployment (`.github/workflows/pages.yml`) | push to `main` | The build is the gate: the five checks run as part of `pnpm --filter website run build`, before anything is uploaded |
| npm release (`.github/workflows/publish.yml`) | push of a `v*` tag | The root release chain, then `check-published-manifest.mjs` reading back what the registry actually serves |
| Repository metadata (`.github/workflows/ci.yml`) | push to `main` only | `check-repo-metadata.mjs` — the About panel's description, topics and homepage against the manifest |

**The pull request runs the same command the deploy does, not a subset of it.** Until 2026-10-12 it
ran nowhere — the five checks executed only in `pages.yml`, so a pull request that turned one of
them red merged cleanly and the failure surfaced afterwards as a failed deploy
([#174](https://github.com/a1121611810/pi-ptc-subagents/issues/174)). Both sides now invoke
`pnpm --filter website run build` rather than a merge-side selection, because two sets — one
guarding a merge, one guarding a deploy — can drift apart, and a drift is worse than the gap it
replaced: it is silent, it reinstates the original bug for whichever check fell out, and it does so
while every gate stays green. `tests/site-checks-on-pr.test.ts` holds both properties in place.

**Do not narrow the `pull_request` trigger with `paths:`.** `check-doc-claims.mjs` binds 19
documented claims to named constants in `src/`, so a pull request that changes
`src/runtime/limits.ts` and nothing under `packages/website/` can still turn a site check red. A
filter scoped to the site would skip exactly that class of drift, and skip it silently.

## Running them locally

```bash
pnpm --filter website run build
```

That projects the documents, builds the site, and runs all five checks.

`pnpm --filter website run check` runs the checks alone, and **four of the five need something
`build` produces**:

| Check | Needs | Because |
| --- | --- | --- |
| `check-projection-coverage.mjs` | `pnpm --filter website run project` | it reads the manifest `project-docs.mjs` writes, and `docs/` is gitignored |
| `check-landing-tool-names.mjs` | the built landing page | it reads the emitted HTML |
| `check-internal-links.mjs` | the build output | it resolves links against the pages that were actually built |
| `check-style-scope.mjs` | the build output | it checks the scope anchor against the built pages |

On a freshly cloned repository that has never been built, running `check` therefore turns **four** of
the five red and leaves only `check-doc-claims.mjs` green. That is a missing build, not four broken
checks — but it reads exactly like four broken checks, which is why `build` is the command above and
`check` is the one to reach for afterwards.

## Adding a check

1. Write the script under `packages/website/scripts/`, named `check-<what-it-catches>.mjs`. The root
   `scripts/` is for release and metadata checks and is not on this path — a script left there is
   never found by the runner.
2. Add it to `CHECKS` in `packages/website/scripts/checks.mjs`. That is the list
   `run-checks.mjs` runs and the list the counterfactual harness reads, so there is one place and a
   new gate cannot be half-registered. Importing `run-checks.mjs` to read the list instead would run
   all five checks as a side effect of asking about it.
3. **Add it to the table in "The checks"**, so the name is in that table's two content columns.
   `tests/website-readme-consistency.test.ts` enforces the **name**, in both directions — the runner
   invoking a check this file does not name fails, and this file naming a check the runner does not
   invoke fails. It reads only that one section and only the name column: the other two columns, and
   every other table in this file that happens to mention a check, are kept true by a reviewer, not
   by a check.
4. **Prove the new gate has teeth.** `node packages/website/scripts/counterfactuals/run.mjs` breaks
   each gate in a throwaway copy and requires it to go red; a gate with no case is listed as
   unproven, so adding a gate here without adding its case shows up on the next run rather than never.
   It needs the site built, and it is not part of `pnpm test` — nothing in this repository's test
   suite rewrites source files, and a run killed halfway would leave a modified tree behind.

## Deliberate boundaries

Not gaps. Do not "fix" them without reading the reason.

- **Outbound links are reported, never gated.** The reason is real but was not recorded anywhere
  until 2026-10-12, which is why a later reader could cite a decision record that never made this
  boundary. It now lives here.
- **The site is excluded from the repository's root lint and format gate** (ADR-0036). The formatter
  aborts the whole tree on a malformed HTML file, and the site is the only part of the tree that
  owns HTML on purpose.
- **The site deploys on every push to `main`, not on release tags** (ADR-0038). Its content is a
  rendering of the working tree, so a tag-triggered deploy would answer "how do I use this" with
  instructions from weeks ago.
