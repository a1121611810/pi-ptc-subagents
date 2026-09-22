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

`vp pack` is a tsdown wrapper. With a `vite.config.ts#pack` block mirroring the rolldown config (`entry: ["./src/index.ts"]`, `format: ["esm"]`, `sourcemap: true`, `dts: { sourcemap: true }`, `platform: "node"`, `external: [/^node:/, "@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "typebox"]`), and `output.entryFileNames: "[name].js"` to force `.js` extension, the resulting dist files are still named:

```
dist/index.mjs       54,832 B   (baseline: dist/index.js    54,831 B)
dist/index.mjs.map  117,477 B   (baseline: dist/index.js.map 117,476 B)
dist/index.d.mts     9,564 B    (baseline: dist/index.d.ts  9,563 B)
dist/index.d.mts.map 1,085 B    (baseline: dist/index.d.ts.map 1,084 B)
```

tsdown's format → extension rule pins ESM to `.mjs` and DTS to `.d.mts`. The size delta is one byte per file (likely an artifact header). Either way, the **filenames diverge** from what `package.json#exports` / `main` / `types` point to (`./dist/index.js`, `./dist/index.d.ts`), which is a downstream-visible change. The ADR criterion was "produces the same output (`dist/index.js` + `dist/index.d.ts` for build)" — output filenames are part of "the same output." `vp pack` does not pass.

A rename step (`mv dist/index.mjs dist/index.js && mv dist/index.d.mts dist/index.d.ts`) would close the gap, but that puts a post-step in front of `vp pack`, which defeats the point of replacing `rolldown -c`. **Build: not swapping.**

### Lint — `vp lint` vs `oxlint`

`vp lint` warns `note: You are running vp lint as a Vite+ built-in command` and proceeds. On the current codebase (clean) both exit 0 with no diagnostics, so the outputs are equivalent **today**. The criterion that bites is forward-looking: `vp toolchain` reports vp's bundled oxlint at `1.83.0`; `devDependencies` carries `oxlint@1.85.0` (chosen specifically for the `type-aware` lint commit `585cebb`). Migrating `lint` to `vp lint` would silently downgrade the lint to 1.83.0, losing type-aware diagnostics on future PRs. Same concern for `vp fmt` (`oxfmt@0.68.0` bundled vs `0.70.0` direct). **Lint + Fmt: not swapping** — version regression in capability is exactly the kind of "different output" the criterion catches.

### Typecheck — `vp check --typecheck` vs `tsc --noEmit`

`vp check --typecheck` invokes the project-local `tsc` against the same `tsconfig.json`. Same TypeScript version, same flags, same diagnostics. The swap would be safe. But it would also be unremarkable: `pnpm run typecheck` (`tsc --noEmit`) is already the simplest possible incantation, and routing it through `vp` adds one process for no behavioural benefit. **Typecheck: not swapping** — meets the criterion but offers no value.

### Net outcome

`vite-plus@0.3.3` is installed as a devDependency to keep the option open and to make the comparison reproducible from this commit. None of the `npm run` scripts change. CI does not invoke `vp`. The migration stopped at Phase 1.

### Revisit criteria

Re-attempt Phase 2 when **all** of these are true:

1. `vite-plus`'s bundled oxlint reaches `>=1.85.0` (matches our direct version) — so `vp lint` is no longer a regression.
2. `vite-plus`'s bundled oxfmt reaches `>=0.70.0` — same reason.
3. tsdown (or vp's wrapper around it) exposes a stable option to write ESM with a `.js` extension **without** a post-step, **or** the project is willing to update `package.json#exports` / `main` / `types` to point at `.mjs` / `.d.mts`.

Until then, `rolldown -c rolldown.config.ts`, `oxlint`, `oxfmt`, and `tsc --noEmit` stay as the direct entries — exactly the shape Phase 1 left them in.
