# Test runner: adopt Vitest 4 across all `tests/`, retire `node --test`

ADR-0008 §Phases left Vitest deliberately out of scope ("test surface is small … Revisit when the first Vitest-shaped test lands"). That criterion has now been met — the test surface has grown from zero to nine files and 1,732 LOC, all written against `node:test`'s `test`/`expect` API. The trigger is therefore the size and shape of the surface, not specific Vitest features used inside it: at this scale the maintenance cost of two runners (the `node --test` path in `scripts/test.mjs` and the implicit Vitest tooling `vp` ships) is larger than the migration cost of one. This ADR records the move and supersedes the Vitest deferral in ADR-0008 §Phases / §Considered options. ADR-0008's addendum gains a one-line pointer back here.

Status: accepted (2026-09-22). Ticket: #25. Branch: `vitest/T1-adr-0009`. Repo is private — `pi install npm:pi-ptc-subagents` sees no downstream surface change.

## Decision

Full migration to Vitest 4 across all nine test files. Specifically:

- **Entry point** — `"test"` script becomes `"pnpm exec vp test --run --coverage"` (the `vp` subcommand bundled in `vite-plus@0.3.3`; see ADR-0008 §Phases 2). `--run` makes the run command a one-shot, matching the CI invocation; `--coverage` is the default for `pnpm test` so contributors notice cost regressions on PR review. Coverage provider: `v8`. Threshold values are decided in `vitest/G1` (numbers out of scope for this ADR) and recorded in `vitest.config.ts`.

- **Vitest version pin** — `package.json#devDependencies.vitest: "^4.1.11"` (the version `vite-plus@0.3.3` bundles, per `pnpm exec vp vue vite --version` or `vp toolchain`). Originally written as `pnpm.overrides.vitest`, but pnpm 12 moved settings (including overrides) to `pnpm-workspace.yaml`; under pnpm 12.5.1 the `package.json#pnpm.overrides` block is silently ignored (WARN at install time). The Vitest run-time path is the same regardless — vitest is the top-level devDep the tests import from. `@vitest/coverage-v8@^4.1.11` is pinned the same way for the v8 provider.

- **Separate config** — `vitest.config.ts` at the repo root, distinct from `vite.config.ts`. The build (`vp pack`) and the test runner (`vp test`) share the Vite engine, but their configs do not: the build needs `outExtensions` for ADR-0008 §Addendum's byte-identical `dist/` criterion, while the runner needs the `test` block plus coverage settings. Merging them couples two independently-revertible decisions and obscures which config owns what. The split is deliberate.

- **Explicit imports** — every test file imports `describe`, `it`, `expect` from `'vitest'`. No globals (`describe`, `it`, `expect` are **not** enabled via `vitest.config.ts#test.globals`). Explicit imports match the existing `node:test` import shape (`import { test, describe } from "node:test"`) so the diff is local and reviewable, and they make the runner dependency visible at the file head — a reviewer who greps `from 'vitest'` sees the entire coupling in one screen.

- **Local iteration scripts** — `test:watch` → `pnpm exec vp test`, `test:ui` → `pnpm exec vp test --ui`. Both go through `vp`, so contributors use the same runner binary and the same devDep-pinned Vitest as CI. No direct `vitest` binary call in `package.json`.

- **`scripts/test.mjs` retired** — the wrapper is deleted. It was a one-line shim around `node --test` that existed when ADR-0008 was written because there were no test files yet (`scripts/test.mjs`'s own header: "no test files yet — nothing to run"). The wrapper is no longer needed; deleting it removes a path that bypasses the Vitest runner.

- **CI** — drop the `--experimental-strip-types` references from CI invocations (Node's strip-types flag was only needed for the `node --test`-on-`.ts` path, and Vitest's TS transform handles that path natively via `vite-plus`). Recorded in `vitest/T5`.

- **Exit-code parity** — `prepublishOnly` (`npm run typecheck && npm run lint && npm run fmt:check && npm run test && npm run build`) is unchanged. `pnpm test`'s exit code remains the gate; `vitest/T2` verifies that `vp test --run --coverage` returns non-zero on a deliberate `expect.fail` and zero on green, matching `node --test`'s semantics.

## Consequences

- **`package.json`** — `"test"` rewritten; `test:watch` and `test:ui` added; `vitest` and `@vitest/coverage-v8` added as direct devDependencies. All other scripts (`build`, `typecheck`, `lint`, `lint:fix`, `fmt`, `fmt:check`, `prepublishOnly`) untouched. Owner: `vitest/T2` (scripts) + `vitest/T4` (devDeps).
- **`pnpm-lock.yaml`** — `vitest@4.1.11` and `@vitest/coverage-v8@4.1.11` resolved as direct top-level deps. The `vite-plus@0.3.3` transitive copy of `vitest` is deduped (same version). Owner: `vitest/T2` + `vitest/T4`.
- **`vitest.config.ts`** — new file at repo root, separate from `vite.config.ts`. Coverage, thresholds, and any environment-specific test config live here. Owner: `vitest/T3`.
- **`tests/**/*.test.ts`** — all nine files: `import { test, describe } from "node:test"` → `import { describe, it, expect } from 'vitest'`. Function-level API change: `test` becomes `it` (Vitest's `test` is also exported, but `it` matches the `it.each`/`it.skip` style the suite already uses informally; the rename is mechanical). One test file (`tests/dispatcher.test.ts`) recently added an overlap-invariant wait (commit `5ad624a`) — that logic is unchanged; only the imports and the assertion API change. Owner: `vitest/T4`.
- **`scripts/test.mjs`** — deleted. Vitest is the sole gate. Owner: `vitest/T4`/`vitest/T5`.
- **CI** — `.github/workflows/ci.yml` (and any sister workflow that ran `node --test`) loses `--experimental-strip-types`; the runner step calls `pnpm test` directly. Coverage report becomes a CI artefact. Owner: `vitest/T5`.
- **README** — the `npm test` / `pnpm test` example gains a `pnpm test:watch` / `pnpm test:ui` line beside it (same shape as ADR-0008 §Phases 1's pnpm/npm/yarn/bun examples). Owner: `vitest/T5`.
- **Cross-link to ADR-0008** — ADR-0008 §Addendum gains a one-line cross-link to this ADR, replacing the language in ADR-0008 §Phases / §Considered options that put Vitest out of scope. Owner: `vitest/T5`.
- **Downstream (`pi install npm:pi-ptc-subagents`)** — zero change. The published artefact is `dist/index.js` + `dist/index.d.ts`; tests do not flow to downstream.

### Considered options (and why rejected)

- **Runner replacement only — keep `node:test`'s API surface, run via Vitest's `--node-test` flag.** Rejected. Vitest 4 dropped first-class `node:test` interop; the `--node-test` path is no longer a supported migration route. Keeping the API surface would also mean inheriting `node:test`'s gaps (no native coverage UX, no UI mode, no snapshot, no `expect.soft`) while adding a Vitest install we would not use. The whole point of moving to Vitest is to use Vitest.

- **Side-by-side opt-in — Vitest available, but `pnpm test` still uses `node --test`.** Rejected. Two runners means two import surfaces (`from 'node:test'` vs `from 'vitest'`), two coverage configurations, and two sets of flags to remember. The split would also let `node --test` bypass the versioned Vitest CI runs, and a future transitive dep that requires Vitest internals could see the un-pinned version. The version-pinned direct devDep is only meaningful when Vitest is the sole runner.

- **`vp test` without coverage config — adopt the runner, defer coverage.** Rejected. Coverage is part of the destination, not a follow-on: ADR-0008 §Addendum already lists coverage as a `vp toolchain`-adjacent concern, and Vitest's v8 provider is a one-line config. Deferring it would mean a second ADR-cycle to add it; doing it now is cheaper than later. Threshold *values* are deferred to `vitest/G1` because they depend on measured baseline, but the *gate itself* lands now.

## Reopen triggers

- A test file needs a Vitest feature that the migration does not surface (e.g. `vi.mock`, snapshot, `expect.soft`) — record it in this ADR's "Consequences" and bump `vitest/T2`/`T3` as needed; no separate ADR unless the shape of the runner changes.
- Vitest 5 ships a breaking change that requires rewriting imports — record the migration in a follow-up ADR (000X), keep `vitest.config.ts` as the single config surface.
- A new sibling test framework (e.g. for a non-Node target) is added — supersede this ADR; the same "single runner per language target" principle applies.

## Revert path

Single-commit revert. `git revert` of this ADR's commit (and the commits `vitest/T2`/`T3`/`T4`/`T5`/`T6` add on the same branch) restores the working tree to the pre-Vitest state: `scripts/test.mjs` is back, the imports are back to `from "node:test"`, `vitest.config.ts` is gone, `vitest`/`@vitest/coverage-v8` are gone from `devDependencies`, and the `"test"` script is back to `node scripts/test.mjs`. CI's `--experimental-strip-types` flags come back. ADR-0008 §Addendum's cross-link to this ADR is removed, and ADR-0008 §Considered options regains the Vitest deferral language. ADR-0008 itself is untouched in revert; only this ADR and its companions go away.

## Addendum (2026-09-22) — corrections

The chart session's first-pass ADR-0009 (commit `1f798b2`) recorded the Vitest version pin as `package.json#pnpm.overrides.vitest`. That location is a **no-op under pnpm 12.5.1** — pnpm 12 moved settings (including overrides) to `pnpm-workspace.yaml`; the `package.json#pnpm` block is silently ignored at install time (WARN: `"The 'pnpm' field in package.json is no longer read by pnpm"`). The `vitest/T6` follow-up fixed three things at once:

1. **Removed the `pnpm.overrides` block** from `package.json`. The override was redundant once `vitest` was a direct devDep (added by `vitest/T4` so the test imports resolve under pnpm's strict `node_modules` layout), and it was a no-op even when redundant.
3. **Updated this ADR's text** above: every `pnpm.overrides.vitest` reference is now `devDependencies.vitest`; the version pin's role is the same.
4. **`vitest.config.ts` left out of `tsconfig.json#include`** (TS 7 `isolatedDeclarations` rejects `defineConfig({...})`'s return-type inference; vitest still reads the file at startup). Revisit if the export pattern is changed (e.g. `satisfies UserConfigExport`) or if `isolatedDeclarations` is dropped.

Net effect: the migration is correct, the lockfile is unchanged (vitest@4.1.11 was already transitively pinned via `vite-plus@0.3.3`; the override was never doing anything), and `pnpm install` no longer emits the WARN.

## Addendum (2026-09-22) — cross-link

ADR-0008 §Addendum gains, at its end: "Vitest adoption recorded in [ADR-0009](./0009-vitest-adoption.md); the deferral in ADR-0008 §Phases / §Considered options is superseded by that ADR." Owner: `vitest/T5`.
