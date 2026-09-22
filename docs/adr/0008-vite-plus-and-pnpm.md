# Toolchain: adopt `vite-plus` (`vp`) and `pnpm`, staged

This repo already runs on oxc's lower-layer stack — `rolldown` for bundling, `oxlint` for linting, `oxfmt` for formatting. `vite-plus` (`vp`, VoidZero) is the unified entry point that bundles that exact oxc stack plus `vitest`, `tsdown`, and Vite Task, behind a single `devDependency`. This ADR records moving the repo onto `vp` and `pnpm` as a deliberate, **staged** migration so each phase is independently reversible.

Status: accepted (2026-09-22). Driver: toolchain modernisation; no external mandate. Repo is private — downstream (`pi install npm:pi-ptc-subagents`) sees no change.

## Phases

The migration runs in two independent, individually-revertible phases. Each phase commits and is allowed to ship on its own.

### Phase 1 — `pnpm`

Switch the package manager only.

- Add `packageManager: "pnpm@…"` (pinned to the version `pnpm --version` reports on the dev box at the time of the switch).
- Delete `package-lock.json`; commit `pnpm-lock.yaml`. `pnpm import` from the npm lockfile, then a clean `pnpm install`, so the lockfile is pnpm's own — not a transliteration.
- CI: `actions/setup-node` keeps working (it detects `packageManager`); switch `cache: npm` → `cache: pnpm` and `npm ci` → `pnpm install --frozen-lockfile` in `.github/workflows/ci.yml` and `.github/workflows/oxlint.yml`.
- `package.json` scripts keep calling the same binaries (`rolldown`, `oxlint`, `oxfmt`, `tsc`, `node --test`) — phase 1 changes **nothing** about scripts.
- README's `npm install`/`npm run …` examples stay; add a `pnpm install`/`pnpm …` line beside each (same as the npm, pnpm, yarn, bun examples already used by `vp`'s docs).

Phase 1 ships when: `pnpm install --frozen-lockfile` is green on a clean checkout and CI is green on `main`.

### Phase 2 — `vite-plus`

Only after phase 1 is green.

- `pnpm add -D vite-plus` (project-local entry; no global `vp` install).
- Replace direct binary calls in scripts with `vp` subcommands for the tasks `vp` subsumes. The intended mapping, pending a phase-2 ticket that diffs the actual outputs:

  | Current                          | Phase-2 replacement                                                                |
  | -------------------------------- | ---------------------------------------------------------------------------------- |
  | `rolldown -c rolldown.config.ts` | `vp pack` (library publish)                                                        |
  | `oxlint` / `oxlint --fix`        | `vp lint`                                                                          |
  | `oxfmt` / `oxfmt --check`        | `vp fmt`                                                                           |
  | `tsc --noEmit`                   | `vp check --typecheck` (or kept direct, see below)                                 |
  | `node --test`                    | kept direct (`vp test` is Vitest-backed — not used here; see "Out of scope" below) |

  Phase 2 only commits a given replacement when `vp <task>` produces the same output (`dist/index.js` + `dist/index.d.ts` for build, identical diagnostics for lint/fmt) on this repo. Until verified, the old direct call stays and `vp` is a parallel entry that CI does not yet invoke.

- `package.json#gets.overrides`: alias `vite` → `@voidzero-dev/vite-plus-core@latest`, pin `vitest` to `vp --version`'s reported vitest. This keeps a single Vitest internals copy for any transitive consumer; without the pin, a future dep could split the runner state.
- CI: switch from `actions/setup-node` to `voidzero-dev/setup-vp@v1` (commit SHA pinned, per the `vp` docs).

Phase 2 ships when: the four `vp` tasks above produce byte-identical (or behaviour-identical, for the lint/fmt cases) results, CI is green, and `dist/index.js` + `dist/index.d.ts` match the phase-1 artefact.

## Considered options

- **Single-shot migration (npm → pnpm + vp in one commit)** — failed fast on any of four failure modes (lockfile transliteration drift, `vp` not yet producing identical `dist/`, CI overrides misapplied, peer-dep resolution shift). Rejected 2026-09-22.
- **Phase 2 with `vp` first, then `pnpm`** — `vp`'s docs assume `pnpm install -D vite-plus` and the lockfile override semantics; doing `vp` on `npm` works but obscures the override story. Phase order matches the doc flow.
- **Skip phase 2 entirely — keep rolldown / oxlint / oxfmt direct** — rejected 2026-09-22. The point of this ADR is to consolidate; if phase 1 alone were sufficient, no ADR would be needed.
- **Move to `vitest` via `vp test`** — out of scope. `node --test` is one script call (`node --test tests/**/*.test.ts`) with zero deps; swapping to Vitest means changing `tests/**/*.test.ts`'s `import { test, expect } from "node:test"` lines plus a Vitest runtime dep, and the project's test surface is small (the `scripts/test.mjs` wrapper says "no test files yet — nothing to run"). Revisit when the first Vitest-shaped test lands.

## Consequences

- Phase 1: zero downstream-visible change. `pi install npm:pi-ptc-subagents` behaviour is identical; `package.json#pi.extensions` is untouched.
- Phase 2: zero downstream-visible change _if_ `vp pack` reproduces `rolldown -c rolldown.config.ts`'s output. The `rolldown.config.ts` file stays as the `vp pack` configuration surface until `vp` proves it can be deleted without an artefact diff; until then it is the source of truth and `vp pack` is expected to honour it.
- Project-local `vp` install means contributors don't need a global `vp` — `pnpm exec vp …` (or `npx vp …`) is enough. README will spell this out.
- The `packageManager` field pins the version; `corepack` on Node ≥ 22.19 (the `engines` floor) handles it without a global install.

## Reopen triggers

- Phase 1: any of `pnpm install --frozen-lockfile` failing on a fresh checkout, CI's `cache: pnpm` not firing, or a peer-dep resolution change that shifts `dist/index.js`'s externalised modules. Revert: re-introduce `package-lock.json` from the prior commit, undo the CI `cache:`/`npm ci` lines.
- Phase 2: `vp pack` produces a `dist/index.js` or `dist/index.d.ts` that differs from the rolldown artefact (size, sourcemap layout, externals list, or `exports` field reachability). Revert: keep `rolldown` in `devDependencies`, restore the prior `build` script, drop `vite-plus` from `devDependencies`. The phase-2 diff stays in git history so the revert is one commit.
- `vp` upstream ships a breaking change to `vp pack`'s output shape: re-derive the `rolldown.config.ts` analogue inside `vp`'s config and revisit.

## Addendum (2026-09-22) — Phase 2 outcome

Phase 1 shipped at `98a6591` (CI green on `main`). Phase 2 was attempted the same day and the criterion in "Phases" failed for every candidate script. Findings, per task, with `vite-plus@0.3.3` as the toolchain under test:

### Build — `vp pack` vs `rolldown -c rolldown.config.ts`

First attempt: a `vite.config.ts#pack` block mirroring the rolldown config, with `output.entryFileNames: "[name].js"` to try to force `.js` extension, produced `dist/index.mjs` + `dist/index.d.mts` (+ sourcemaps). The "Build: not swapping" outcome recorded below was right about the result but wrong about the cause: it blamed tsdown's format→extension rule, when the real reason is that tsdown bypasses rolldown's `outputOptions.entryFileNames` for ESM/CJS and runs its own extension resolution in `src/features/output.ts:resolveChunkFilename`, which pins ESM→`.mjs` and DTS→`.d.mts` whenever `platform: "node"`.

Second attempt (after re-reading the tsdown docs and the source): the `outExtensions` callback on tsdown's `UserConfig` overrides that table on a per-format basis. With:

```ts
outExtensions: ({ format }) =>
  format === 'es' ? { js: '.js', dts: '.ts' } : undefined,
```

`vp pack` produces output **byte-identical** to `rolldown -c rolldown.config.ts`:

```
dist/index.js        54,831 B  (rolldown: 54,831 B)
dist/index.js.map   117,476 B  (rolldown: 117,476 B)
dist/index.d.ts      9,563 B   (rolldown: 9,563 B)
dist/index.d.ts.map  1,084 B   (rolldown: 1,084 B)
```

`diff -q` against the rolldown baseline: all four files identical. Externals (`@earendil-works/*`, `typebox`, `node:*`) preserved. Full primary-source chain and reproducer captured in `docs/research/vp-pack-js-output.md`. **Build: criterion met.**

### Lint — `vp lint` vs `oxlint`

`vp lint` warns `note: You are running vp lint as a Vite+ built-in command` and proceeds. On the current codebase (clean) both exit 0 with no diagnostics, so the outputs are equivalent **today**. The criterion that bites is forward-looking: `vp toolchain` reports vp's bundled oxlint at `1.83.0`; `devDependencies` carries `oxlint@1.85.0` (chosen specifically for the `type-aware` lint commit `585cebb`). Migrating `lint` to `vp lint` would silently downgrade the lint to 1.83.0, losing type-aware diagnostics on future PRs. Same concern for `vp fmt` (`oxfmt@0.68.0` bundled vs `0.70.0` direct). **Lint + Fmt: not swapping** — version regression in capability is exactly the kind of "different output" the criterion catches.

### Typecheck — `vp check --typecheck` vs `tsc --noEmit`

`vp check --typecheck` invokes the project-local `tsc` against the same `tsconfig.json`. Same TypeScript version, same flags, same diagnostics. The swap would be safe. But it would also be unremarkable: `pnpm run typecheck` (`tsc --noEmit`) is already the simplest possible incantation, and routing it through `vp` adds one process for no behavioural benefit. **Typecheck: not swapping** — meets the criterion but offers no value.

### Net outcome (post-second-attempt)

`vite-plus@0.3.3` is installed as a devDependency. The build script switches to `pnpm exec vp pack`, driven by `vite.config.ts#pack` with the `outExtensions` callback above. `rolldown.config.ts` is removed (no longer the source of truth, and `vp pack` is now proven equivalent). Lint, fmt, and typecheck scripts stay direct (`oxlint`, `oxfmt`, `tsc --noEmit`) for the same version-regression reason as before.

### Revisit criteria for lint + fmt + typecheck

Re-attempt the lint/fmt/typecheck swaps when **all** of these are true:

1. `vite-plus`'s bundled oxlint reaches `>=1.85.0` (matches our direct version) — so `vp lint` is no longer a regression.
2. `vite-plus`'s bundled oxfmt reaches `>=0.70.0` — same reason.

Typecheck (`vp check --typecheck`) has been verified to be safe (uses local `tsc` against `tsconfig.json`); it's still not swapped because routing it through `vp` adds one process for no behavioural benefit. Revisit if `vp check` ever becomes a single entry for both lint and typecheck.
