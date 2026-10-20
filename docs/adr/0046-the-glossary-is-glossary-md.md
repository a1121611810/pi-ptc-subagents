***

status: accepted (2026-10-20)

# The domain glossary is `GLOSSARY.md`

## Context

This repository's glossary was named `CONTEXT.md` from the day it was created
(2026-09-21, alongside the wayfinder map) until this record. The name was not
chosen — it was inherited. `docs/agents/domain.md` was scaffolded by the
`setup-matt-pocock-skills` skill as a verbatim copy of that skill's seed
template, and the template said `CONTEXT.md` because that is what the upstream
harness said in August 2026.

The upstream harness renamed the convention on 2026-08-15 (`mattpocock/skills`
commit `d80fa0f4`, "rename CONTEXT.md/CONTEXT-MAP.md convention to
GLOSSARY.md/GLOSSARY-MAP.md"), across 32 files: the `domain-modeling` skill,
the `setup-matt-pocock-skills` seed template, the `GLOSSARY-FORMAT.md` format
spec, and the `triage` / `wait-what` / `ask-matt` / `tdd` skills that read
the glossary.

The skills self-update; the file they wrote does not. The scaffold taken here
came from a copy of the seed template that predates the rename, and
`docs/agents/domain.md` still carried it afterwards — byte-identical to the
pre-rename upstream template, which is how the staleness was confirmed rather
than assumed. The installed skills are on the new convention: fifteen of the
files in the installed skill set name `GLOSSARY.md`.

The cost of leaving it is a live fork, not a cosmetic mismatch:

- `domain-modeling` says "If no `GLOSSARY.md` exists, create one when the first
  term is resolved". In this repository that creates a SECOND glossary beside a
  92-term one.
- `triage` calls `domain-modeling` in its fourth step, and `grill-with-docs`
  drives the same skill, so both reach the same fork.
- `wait-what` re-pitches "using the ubiquitous language from `GLOSSARY.md`"
  and would find nothing to use.

The mismatch was already visible in a session: the `domain-modeling` skill
loaded here describes `GLOSSARY.md` throughout, and the only things saying this
repository's glossary is called something else were `docs/agents/domain.md`
and `AGENTS.md` — the stale artefacts. An agent that did not read those first
would have created the second glossary.

The upstream harness did the same rename in its own repository
(`mattpocock/course-video-manager`, 2026-10-07, "docs: rename CONTEXT.md to
GLOSSARY.md"): `git mv`, content unchanged, every live reference updated, no
stub left behind, and no historical document rewritten. That is the shape this
record adopts.

## Decision

The domain glossary is `GLOSSARY.md` at the repository root. `CONTEXT.md` does
not exist, and is kept neither as a stub nor as an alias.

- **The file moves; its content does not.** `git mv CONTEXT.md GLOSSARY.md`
  with no edit to the text. The glossary's content is this repository's own
  house style, not the upstream format spec's — see "What this does not
  decide".
- **Every live pointer moves in the same commit.** `AGENTS.md`,
  `CONTRIBUTING.md`, `docs/agents/domain.md` (replaced with the current
  upstream seed template, which is the same file with the eight names
  changed), the doc-integrity gate's scan surface
  (`tests/doc-integrity.test.ts`, which names the file in `ROOT_DOCS`,
  `SYMBOL_SCAN_ROOT_DOCS` and its own root-file check), the OCR project
  rules, this repository's `code-review` skill, the website's link-rewriting
  rule in `packages/website/scripts/project-docs.mjs`, the ADRs, the specs,
  the usage docs, `docs/testing-constraints.md`, and the code comments that
  point at the glossary.
- **Historical documents are not rewritten.** `docs/research/**`,
  `docs/reviews/**` and `CHANGELOG.md` are snapshots of what was true when
  they were written, and a snapshot edited to match the present is not a
  snapshot. The upstream harness's own rename did not touch them either. A
  reader who meets `CONTEXT.md` in one of those files finds this record.
- **One command is left as it was.** `docs/adr/README.md` records a past
  check as `git diff --name-only e768bde~1 1113680 -- CONTEXT.md`. That
  pathspec is resolved against the trees at those commits, where the file WAS
  named `CONTEXT.md`; rewriting it to `-- GLOSSARY.md` would make the command
  return empty for a different reason, which would falsify the claim it
  supports. The sentence around it now says so, and points here.
- **The website's two references move with it.** The projected-document rule
  that turns `../../CONTEXT.md` into a repository URL becomes
  `../../GLOSSARY.md`, and the absolute URL in
  `packages/website/docs/background-dispatch.md` becomes
  `.../blob/main/GLOSSARY.md`, so a reader following it does not get a 404.

## What this does not decide

The upstream `GLOSSARY-FORMAT.md` says "Keep definitions tight. One or two
sentences max" and "Only include terms specific to this project's context.
General programming concepts (timeouts, error types, utility patterns) don't
belong even if the project uses them extensively."

This repository's glossary has never followed that, and does not start now.
`CONTRIBUTING.md` requires the opposite: a term's definition "must match the
constant in `src/` word for word", and the glossary carries ADR
cross-references, the count of every field, and the value of every default.
Entries like `PTC error kind`, `truncation contract` and `ULID` are exactly
what the upstream spec would exclude; they are here because the glossary was
using those words without defining them, and a glossary that names a concept
the repository ships but never defines is the gap an audit of this file
found. The format spec is the upstream skill's guide, not this repository's
gate — the gate is `tests/doc-integrity.test.ts`, and this rename does not
change it.

## Consequences

- The installed skills and this repository agree on one filename. A
  `domain-modeling` run here edits the glossary that already exists instead of
  creating a second one.
- `docs/agents/domain.md` is a verbatim copy of the current upstream seed
  template again, so the next change to that template can be applied by
  copying rather than by hand. It is a copy, and it will drift again — the
  thing to watch is the fork, not the drift.
- One installed file still names the old one: a local `_shared/grill-to-retro.md`
  (not an upstream file) tells the `grill-to-retro` and `loop-to-retro`
  skills to read `CONTEXT.md`. Its own preamble resolves it, in the sentence
  above the bullet: "The repo already carries its rules, and they outrank
  anything in this file", and it then lists `docs/agents/domain.md` and
  `AGENTS.md` among the rules it defers to. Both now name `GLOSSARY.md`.
- The public repository's `CONTEXT.md` URL stops resolving. That is the one
  externally visible cost, and it is the cost the upstream harness's own
  repository paid on the same day.

## Reopen triggers

- The upstream harness renames the convention again. The reasoning applies in
  reverse: the skills decide the filename, and the repository follows.
- A second context appears here. Then `GLOSSARY-MAP.md` is the upstream's name
  for the map, and each context carries one `GLOSSARY.md`.

## Verification

- `tests/doc-integrity.test.ts` — the gate's scan surface names the new file,
  and the link that points at it (`docs/usage/bgdispatch.md` links
  `../../GLOSSARY.md`) resolves.
- The site's own five checks (`pnpm --filter website run build`), including
  the link rewrite for `../../GLOSSARY.md` and the dead-link check VitePress
  fails the build on.
- The full repository gate: `typecheck`, `lint`, `fmt:check`, `build`, the
  test suite, and `verify:dist`.

## See also

- ADR-0010 — the mode the glossary's `narrowing mode` entry describes.
- ADR-0015 — the truncation contract the glossary names.
- ADR-0037 — the website's rule for turning a repository-relative link into a
  repository URL, which this rename moves.
