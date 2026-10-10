# The site projects the repository's documents; it stores no copies

status: accepted (2026-10-10)

## Context

The site has two kinds of content, and conflating them is the mistake this record prevents.

One kind is **the site's own**: a hand-written landing page. It exists nowhere else and is authored
in place, at `packages/website/index.md` plus the `Landing.vue` component behind it.

The other kind is **the repository's documentation**: `docs/how-to-install.md`, `docs/usage/surface.md`,
`docs/usage/bgdispatch.md`, `docs/usage/structured-results.md`. These are already plain markdown that
renders as-is. The obvious move is to copy them into the site's source tree, and it is the wrong one.

A copy is a second source of truth that no gate compares. It goes stale on the day it is created and
says nothing when it does: the site would keep serving correct-looking prose describing an interface
that changed last month, and nothing in the build would notice. That failure is worse than having no
site, because it looks like documentation.

The alternative is the one used here and by the upstream harness this decision was checked against
(`deepseek-ai/deepseek-harness`, `website/docs.ts`, which projects repository markdown into routes
and lets `pnpm run website:build` double as the dead-link check).

## Decision

**The site's document pages are projected at build time from files in the repository. No copy is
committed.**

`packages/website/scripts/project-docs.mjs` runs first in `pnpm --filter website run build`. It reads
the four source documents, rewrites their links, and writes them into `packages/website/docs/` — a
directory that is **gitignored** and regenerated from scratch on every build. The only committed page
under `packages/website/` is the hand-written `index.md`.

The rule that follows from this: **if a sentence on the site needs changing, the fix goes in
`docs/`, never in the site's tree.** The projected pages carry a visible "generated from" marker so a
reader who wants to change something knows where the source is.

### Link rewriting, and why each shape is handled differently

Projected markdown contains links written for GitHub's renderer, not VitePress's. Three shapes occur:

| Source shape       | Becomes                                              | Why                                                                                            |
| ------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `../adr/NNNN-x.md` | absolute `github.com/…/blob/main/docs/adr/NNNN-x.md` | ADRs are **not** projected. They link back to the repository, where they are edited.           |
| `../../CONTEXT.md` | absolute URL to `CONTEXT.md`                         | Same, for the glossary.                                                                        |
| `./sibling.md`     | a site-internal route                                | Both documents are projected, so a site route is correct and keeps navigation inside the site. |
| anything else      | **left exactly as written**                          | See below.                                                                                     |

**Rewriting a link to an absolute URL removes it from VitePress's dead-link check**, because that
check only resolves links inside the site. So the projection validates existence _before_ rewriting:
`resolve`/`relative` arithmetic against the repository root, and a missing target throws and fails the
build. A dead ADR link cannot be published by this path.

The last row is deliberate. An unrecognised relative shape is **not** guessed at and **not** dropped;
it is passed through unchanged so that VitePress's own dead-link check resolves it, and the build
fails if it cannot. The alternative — a permissive fallback that emits a best guess — trades a loud
build failure for a quiet wrong link.

### One correction made during the work

The first implementation resolved repository-relative paths by stripping `../` and prefixing `docs/`.
That is wrong for exactly the case above: `../../CONTEXT.md` from `docs/usage/` lands at the
**repository root**, but stripping and prefixing produced `docs/CONTEXT.md`, which does not exist — and
the build failed on correct content. The path arithmetic was replaced with real `resolve()` and
`relative()` against the repository root, plus an explicit rejection of anything resolving outside it.

## What this does not decide

- **Prose accuracy is not gated.** The projection guarantees a page mirrors its source file. It does
  not guarantee the source file is _true_. Nothing compares `docs/usage/*.md` against the code it
  describes.
- The projection is an **explicit list** of four source documents, not a directory walk. A new file
  under `docs/usage/` does not join the site automatically. That is intentional — it makes adding a
  page a decision rather than an accident — but it means the list can drift out of date unnoticed.
- ADR content is deliberately absent from the site. A reader looking for a decision's reasoning
  leaves the site and lands on GitHub. Accepted: ADRs are a maintainer-facing record whose audience is
  already on GitHub.

## Why not symlinks, and not a docs-as-a-submodule arrangement

Symlinks are not portable through GitHub Pages' build, and they make "which file is the source"
answerable in two ways depending on the reader's filesystem. A build-time projection has one answer
that does not depend on the viewer.

## What would retire this

If the site ever needs **content that is not in the repository** — a landing page section with prose
the repository has no reason to hold, or marketing copy — the projection would need a documented
escape hatch, and the first thing that would break is this record's core rule ("no copies"), because
the escape hatch _is_ a copy with better manners. The rule is worth re-arguing at that point rather
than working around quietly.
