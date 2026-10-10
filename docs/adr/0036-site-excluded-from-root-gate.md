# The site is excluded from the repository's root lint and format gate

status: accepted (2026-10-10)

## Context

`packages/website/` is a second workspace member in a repository whose release gate is one command
chain: `prepublishOnly` runs `typecheck && lint && fmt:check && build && test && verify:dist`. Every
step scopes to `src/` and `tests/` — the npm package's own source. The site is not part of that
package; it is not in `files`, and nothing in `dist/` comes from it.

Two of those steps reach the site anyway, because they walk the working tree rather than a configured
scope. `oxlint` and `oxfmt` both descend into nested directories, so before
`.oxfmtrc.json` and `.oxlintrc.json` were amended, adding the site added its `.html` and `.ts` files to
the repository-wide formatter and linter.

## The measurement that decided it

`oxfmt` does not merely format HTML in this repository. **It parses HTML, and a malformed HTML file
anywhere in the tree fails the whole check with a hard error rather than a formatting complaint.**

Measured on 2026-10-10 at `1113680`, with a throwaway file at `docs/adr/_probe_malformed.html` — a
nested directory that no `ignorePatterns` entry covers, standing in for any HTML the site might own:

```
$ printf '<html><body><div class="x\n<p>unclosed <span>\n</body>\n' > docs/adr/_probe_malformed.html
$ pnpm exec oxfmt --check

  x SyntaxError: Unexpected character "EOF" (4:1)
  | [docs/adr/_probe_malformed.html]
  |   2 | <p>unclosed <span>
  | > 4 |
Error occurred when checking code style in the above files.
EXIT CODE: 2
```

Exit code **2**, not 1. This matters because the gate's contract is "non-zero means stop", and a
hard error is not the failure anyone reviewing a formatting diff expects: it names a parser
`SyntaxError` and says nothing about formatting. One unparseable page in a directory nobody is
editing can block a release of the package. (The probe file was removed; `git status` confirms the
tree is clean.)

The other two steps never reach the site, and this is configuration rather than accident:

| Step        | Scope                                      | Reaches `packages/website/`? |
| ----------- | ------------------------------------------ | ---------------------------- |
| `typecheck` | `tsconfig.json` `include: ["src","tests"]` | no                           |
| `test`      | vitest `include: ["tests/**/*.test.ts"]`   | no                           |
| `oxlint`    | walks the tree                             | **yes**                      |
| `oxfmt`     | walks the tree                             | **yes**                      |

## Decision

**`packages/website/**` and `docs/prototypes/**` are added to `ignorePatterns` in `.oxlintrc.json` and
`.oxfmtrc.json`.** The repository's release gate continues to assert what the npm package publishes.

This is not tidiness. The exclusion is required because the formatter's failure mode on HTML is a
whole-tree abort, and the site is the only part of the tree that owns HTML on purpose. Including it
would couple "can this package be published" to "does a Vue component's template parse".

`docs/prototypes/**` is excluded for the same reason and one more: it holds the four landing-page
variants from the prototype, which are historical evidence rather than shipped code.

## The site's own gate is separate, and it is not weaker

Exclusion is not permission. The site carries three of its own checks, wired into its own build so
that publishing the site is what runs them:

- `check-landing-tool-names.mjs` — reads the **built** HTML and compares every `ptc_*` name on the
  landing page against the names actually registered in `src/`. A page that invents a tool name
  fails the build.
- `check-internal-links.mjs` — reads the built output and reconciles every root-relative `href`
  against the routes that were actually built.
- `vitepress build` itself, which fails on dead links in projected markdown.

Two locale-dependent `.sort()` calls found in the site during the work were **fixed, not
suppressed**. A locale-independent ordering rule was chosen and the reasoning is in the code. Nothing
in the site was silenced to make the gate pass; there is no site-local lint suppression file.

## What this does not decide

- The tool-name check is **one-directional**. A page that _invents_ a tool name turns the build red;
  a page that _omits_ one does not. Narrowing it from a whitelist to a two-way set comparison is not
  done here.
- Nothing checks that the **prose** in `docs/` matches the code. The projected documents are checked
  for structure, not for accuracy.
- The prototype HTML under `docs/prototypes/**` is excluded from formatting, so it is also excluded
  from any future root-wide HTML gate. It is one-time evidence on a branch that does not merge.

## Why not keep the site in the gate and format it properly

Because the gate's meaning is "this package is safe to publish", and a VitePress source tree is not
part of the package. Widening `prepublishOnly` to cover a directory that ships nothing would make the
release ceremony carry a second project's failures. The site's own build is already a required step
of publishing the site — that is the gate that belongs to it.

## What would retire this

If the site ever became **version-specific documentation** — pages pinned to a released version,
dead links triaged against the API surface of that version rather than of `main` — the calculus
changes. Version-specific docs are versioned content, and a versioned artifact's gate is exactly the
kind this repository already runs. Nothing about the site's current content requires that.
