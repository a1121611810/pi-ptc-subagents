# Contributing

Thanks for considering a contribution. This file is short on purpose: everything below is a
command you can run, not a policy you have to interpret.

## The gate your PR has to pass

CI runs three workflows on every pull request, and all three must be green:

| Check  | What it runs                                        |
| ------ | --------------------------------------------------- |
| `CI`   | `pnpm run fmt:check`                                |
| `Lint` | `pnpm run lint`                                     |
| `Test` | `pnpm run typecheck`, `pnpm run build`, `pnpm test` |

Run the whole thing locally before you push — it is the same release gate, and it is what a
release is cut from:

```bash
pnpm install --frozen-lockfile
pnpm run typecheck && pnpm run lint && pnpm run fmt:check \
  && pnpm run build && pnpm test && pnpm run verify:dist
```

Two things about that list are easy to miss:

- **`build` runs before `test`, and it is not optional.** `tests/tool-visibility.test.ts` loads
  the _built_ `dist/index.js` under a real `pi`. Running the tests against a clean checkout with
  no `dist/` fails with "the probe never observed a provider request", which says nothing about
  your change.
- **`pnpm run verify:dist` is not in CI today, but run it anyway.** It is the only check that
  exercises the published artifact. A change can pass every test and still fail here — a feature
  once passed three review rounds and 696 tests, then broke `verify:dist` on the built bundle.
  If your change touches rendering, the worker, or the bindings, that failure is real.

## House style

The repository carries its own rules in [`AGENTS.md`](./AGENTS.md), and they are the short version
of "what a reviewer here will ask". Three that change what you write:

- **The docs are not optional.** A behaviour change without the matching note in
  `docs/adr/` or `CONTEXT.md` is an incomplete change. `CONTEXT.md` is the glossary; if you
  introduce a new domain term, it gets an entry, and its definition must match the constant in
  `src/` word for word.
- **Tests must be falsifiable.** See [`docs/testing-constraints.md`](./docs/testing-constraints.md).
  The short version: a test that would still pass if you deliberately broke the implementation in
  a way that satisfies the assertion is not testing anything. New tests must cover the failure
  path, and the failure path must produce a visible error rather than silence.
- **Cite `file:line` only where it is checked.** `tests/doc-integrity.test.ts` asserts that
  relative links in `docs/**` resolve, and that `file:line` references in the _normative_ docs
  land inside the file they name. `docs/research/**` and `docs/reviews/**` are historical
  snapshots: their line numbers are allowed to drift, and asserting on them would be noise.

## Review

Every PR needs one approving review, and the maintainer is the only approver. The maintainer can
also push straight to `main` and merge without review — that is deliberate, so small fixes do
not have to go through a PR. If you have push access, the same applies to you: you cannot merge
your own PR without an approval from someone else.

## Reporting a problem instead of fixing it

Open an issue. For anything that looks like a security problem, do **not** open a public issue —
see [SECURITY.md](./SECURITY.md).

## Code of conduct

[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) applies everywhere in this repository, including
issues, PRs, and review discussion.
