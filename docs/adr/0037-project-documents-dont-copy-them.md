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

### Amended 2026-10-10: there is no `editLink`, and that is the decision working

This record originally left out one consequence of projecting rather than copying, and the omission
shipped. The site configured VitePress's `editLink` so every page would offer "Edit this page". VitePress
substitutes a page's **source path** into that pattern, and a projected page's source path is a file in
the site's own generated tree. Every projected page therefore linked to `docs/docs/install.md` — a path
that exists in neither the repository nor the site. All four were dead; the build was green throughout,
because neither VitePress's dead-link check nor this record's rule was looking at an absolute URL.

`editLink` is removed rather than corrected. Three alternatives were tried or considered:

- **Write each projected file at its own repository path** and control the route with frontmatter
  `slug`. Measured, not assumed: VitePress 1.6.4 **ignores the `slug` frontmatter here**, so routes
  stayed at `/docs/usage/surface` and every curated route became a dead link. The build caught it.
- **Keep it and fix the pattern's prefix.** Even corrected, `:path` yields `docs/install.md`, which is
  not where the repository keeps the document.
- **Accept repository-shaped URLs** (`/docs/how-to-install`, `/docs/usage/surface`). Rejected: that
  makes a published URL depend on where a file happens to sit in the repository, so reorganising
  `docs/` would silently move public URLs.

Removing it is also the honest answer, not a workaround. An "edit this page" link on a projected page
points at a file that **must not be edited**, because the repository copy is the only authoritative
one (that is this record's whole point). The affordance is already served correctly by the
"generated from" banner, which names the true repository path instead of a derived one.

`check-internal-links.mjs` now resolves repository-absolute links (`blob|edit|tree/main/<path>`) against
the working tree, so this class of defect fails the site's build rather than reaching a reader.

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
