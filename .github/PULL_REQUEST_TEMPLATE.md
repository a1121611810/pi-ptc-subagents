## What this changes

<!-- One or two sentences. If it changes what the model sees, say so explicitly. -->

## Why

<!-- The situation that made this necessary, not a restatement of the diff. -->

Closes #

## The gate

<!-- Tick what you ran. CI runs the first three; the last is on you. -->

- [ ] `pnpm run typecheck && pnpm run lint && pnpm run fmt:check && pnpm run build && pnpm test`
- [ ] `pnpm run verify:dist` — required if this touches rendering, the worker, or the bindings
- [ ] Added or updated a test whose failure path produces a visible error, not silence

## Docs

- [ ] The change is reflected in `docs/adr/`, `docs/usage/`, or `CHANGELOG.md`
- [ ] `CONTEXT.md` has an entry for any new domain term, matching the constant in `src/` exactly
- [ ] Any `file:line` citation I added points inside the file it names

## Notes for the reviewer

<!-- Anything you want looked at twice, or a decision you were unsure about. -->
