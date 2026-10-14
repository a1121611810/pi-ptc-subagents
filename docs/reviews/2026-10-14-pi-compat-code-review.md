# Review — pi 1.2.0 compatibility work (#189, #190, #191)

Date: 2026-10-14. Fixed point: `695d2ba` (post-v3.0.0). Scope: `695d2ba...be7c423` plus the
uncommitted working tree. Spec: issue #189 (parent), #190 / #191 (tickets). Decision record:
[docs/agents/pi-compat-matrix.md](../agents/pi-compat-matrix.md).

Two review axes (Standards, Spec), two rounds, and both axes found the same class of defect:
**the release gate was green while the change was under-tested.** That is the finding this file
is really about, so it is written first.

## The shape of round 1

The whole-tree release gate (`typecheck` / `lint` / `fmt:check` / `build` / `vp test --run --coverage`
/ `verify:dist`) passed with 1222 tests. Both axes independently reported blocking findings that
**no gate can see**, and they were all one shape: a code path or a comment asserting something
that a mutation disproves. Measured on real pi trees, not inferred:

| finding            | mutation                                        | gate result   |
| ------------------ | ----------------------------------------------- | ------------- |
| X1 / S-1 / S-03    | exit-0 close carrying a truncation warning      | green         |
| X2 / S-02          | foreground `stderr: stderrText` → `undefined`   | green         |
| X3 / S-01          | remove the `~` and `~/` rewrites                | green         |
| B2 / SPEC-1 / S-04 | delete the whole `bindings.ts` catch            | green (48/48) |
| B1                 | remove the 0.86.1 leg from the matrix allowlist | green         |

Four of those five are the same defect: **tests that pass whether the feature works or not.**

## Ledger

| id            | finding                                                                                                                                                              | evidence                                                                                                                                                                                                                                                              | disposition                                                                                                                                                                                                                                              | closed by                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| X1            | The foreground and background paths labelled the SAME exit-0 close differently, and three comments asserted an invariant the code order contradicted.                | Both axes executed it: foreground `"dispatch produced no final text"`, background `"child response was truncated…"`; `task-registry.ts` claimed "the exit-0 branch above returns first" while it sat below. Production-reachable via the only `resolve-exit` emitter. | Fixed by guarding the pump's computation on `exitCode !== 0`, which makes all three comments true at once.                                                                                                                                               | `src/runtime/dispatch.ts`                                    |
| X2            | The foreground's `stderr:` forwarding had no test — mutating it to `undefined` left all 52 dispatch-helper tests green.                                              | Spec axis counterfactual.                                                                                                                                                                                                                                             | Fixed: a test drives the production close path.                                                                                                                                                                                                          | `tests/dispatch-helpers.test.ts`                             |
| X3            | `normalizePatternPath`'s `~` and `~/` branches had zero coverage: removing both left 37+2 tests green.                                                               | Spec axis counterfactual, real pi trees.                                                                                                                                                                                                                              | Fixed.                                                                                                                                                                                                                                                   | `tests/unit/codemode-switch.test.ts`                         |
| B1            | The 0.86.1 throw-path leg was never in the matrix's `VERSION_SENSITIVE_TESTS`, so the doc's "pass (throw channel)" had no execution behind it.                       | Lead reproduced the absence by grep.                                                                                                                                                                                                                                  | Fixed: added to the allowlist, plus an entry guard (`exit 2`, naming the file) and a three-state report row where a skipped leg prints `SKIPPED - NOT A PASS`.                                                                                           | `scripts/pi-compat-matrix.mjs`                               |
| B2            | The catch had no production-level pin, and the test that claimed to cover it asserted `fromThrow).toBe(fromIsError)` — the same pure function called twice.          | Lead reproduced: removing the catch left 48/48 green.                                                                                                                                                                                                                 | Fixed with a real reject path (`ls` on a missing name). **The fixer also measured that `isError` arrived in 0.99.0 and only `bash` moved onto it** — so my "dead code on 1.0.0+" comment was false, and the catch covers four builtins on every version. | `tests/bindings.test.ts`, comment corrected in `bindings.ts` |
| X5            | Three records claimed the empty-message branch was "unreachable" / "NOT covered" / "deliberately left untested"; the new test had already covered it.                | Standards axis.                                                                                                                                                                                                                                                       | Both stale claims corrected to state the real reachability.                                                                                                                                                                                              | `src/runtime/bindings.ts`, `tests/binding-contract.test.ts`  |
| SPEC-4        | `dist-surface-decision.test.ts` asserted `expect(["full","subagents"]).toContain(got)` — accept-both (F1) — while its own comment claimed it excluded a third value. | Spec axis.                                                                                                                                                                                                                                                            | Replaced with two assertions that exclude the alternatives one at a time.                                                                                                                                                                                | `tests/unit/dist-surface-decision.test.ts`                   |
| SPEC-5        | Seven matrix guards assert the script's source text contains a string; a path named only in a comment would pass.                                                    | Spec axis; the axis also confirmed it DOES catch real removals (Lead reproduced: deleting `.opencodereview` from `COPY_PATHS` turned it red).                                                                                                                         | Kept as a guard, recorded as characterization — it pins the script's shape, not the script's behaviour.                                                                                                                                                  | accepted with counterfactual                                 |
| STD-5         | User-visible changes with no CHANGELOG entry and no ledger row.                                                                                                      | Standards axis.                                                                                                                                                                                                                                                       | Fixed: `## [Unreleased]` with Changed / Added / Documentation, plus version links.                                                                                                                                                                       | `CHANGELOG.md`                                               |
| STD-1 / STD-2 | `fmt:check` red; `pnpm-lock.yaml` carrying 12 unrelated deletions (left by a killed mutation run).                                                                   | Standards axis, confirmed by Lead.                                                                                                                                                                                                                                    | `oxfmt` applied; lockfile restored.                                                                                                                                                                                                                      | working tree                                                 |

## What this review changed about how the work is done

1. **A skipped test is not a passing test.** The matrix now reports the version-specific legs as a
   third state. Before this, a green row could mean "the leg never ran".
2. **A pure function's unit tests say nothing about whether it is wired.** The catch's four tests
   were green with the catch deleted. The tests that count drive the real binding table.
3. **The comment asserting an invariant is a claim, not decoration.** Three of them were wrong,
   and the only reason is that measurement contradicted them.

## Round 2 — the five blocking items, verified closed

Every item below was re-checked by mutating the code the fix guards and watching a NAMED test turn
red. A fix without that evidence is not a closure (see `AGENTS.md`, review discipline), so the
counterfactual is the record:

| item              | mutation                           | result                                                                           |
| ----------------- | ---------------------------------- | -------------------------------------------------------------------------------- |
| X1 pump guard     | drop `exitCode === 0 ? …`          | RED — `an exit-0 close with a truncation warning … is NOT labelled a truncation` |
| X1 registry order | move the `stderrDiagnostic` branch | RED (already pinned)                                                             |
| X2 forwarding     | `stderr: stderrText` → `undefined` | RED — `exit 1 + pi's truncation line …`                                          |
| X3 tilde rewrite  | delete the `~` branch              | RED — `a bare ~ becomes the home directory` + 2 differential tests               |
| B1 allowlist      | delete the entry                   | the matrix refuses to run and names the file (`exit 2`)                          |
| B2 catch          | delete the whole catch             | RED — `the real binding table caps a builtin that REJECTS`                       |

A second pass over X1 found one more gap of the same kind: the pump's new guard existed but no
test failed without it. It does now (row 1), which is why the row is in this table rather than
assumed.

## Open, deliberately

- **`peerDependencies` still declares `>=0.86.0` while the measured capability floor is 0.99.0.**
  `docs/agents/pi-compat-matrix.md` records the measurement and names narrowing a product decision
  the script deliberately does not make. It stays open until a human decides.
- **The matrix probe scripts live under `.scratch/`** (gitignored), so a clone cannot re-run the
  210 measurements the document cites. Tracked rather than moved, because the scripts are
  throwaway by construction.
