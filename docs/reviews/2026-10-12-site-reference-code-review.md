# Review — the site got an operational reference, and a gate to keep it true

Date: 2026-10-12. Fixed point: `bca51cb` (main) to `f2b9b1c`. Spec: issue #170; tickets #171–#174,
three closed, #174 deliberately left open. Branch: `docs/site-reference`.

Two rounds. The first found one blocking defect and the second found no blocking defect but caught a
regression the first round's own fix introduced — recorded here because that is the part a ledger is
for: the second finding is only visible because the first finding was real.

## What was reviewed

The site runs five checks, and two of them appeared in zero markdown files in this repository. This
change adds the operational reference that lists them, a pointer to it from the root agent file, and
a test requiring the reference and the runner to name the same checks. Diff: three files, two
markdown and one test.

OCR's selection layer could not see any of it — `.md` resolves to nothing and `tests/**` is excluded
by path — so the review enumerated the paths itself and ran `doc-sync`'s eight items by hand.

## Findings ledger

### R-s1 — the README's count was measured on the wrong state

|                    |                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Found**          | Spec axis, round 1. The README said "three of the five checks turn red without a build". On a freshly cloned repository — which is where a reader of that section is — **four** turn red, because `packages/website/` is gitignored: without `pnpm --filter website run project` there is no projection manifest, and `check-projection-coverage.mjs` is red for a reason the section never mentioned. |
| **Why it matters** | That section exists so a first-time reader does not read a missing build as broken checks. It made exactly that error, one check worse. It also contradicted the README's own preceding sentence, which says `build` projects the documents.                                                                                                                                                           |
| **Evidence**       | `git archive HEAD` into a throwaway export (no `dist/`, no `docs/`), then the runner: `site checks — 5 run, 1 green, 4 not green`. Adding only `packages/website/docs/` back yields three, so both measurements were true of their own state; only one describes the state the section is about.                                                                                                       |
| **Closure**        | `f2b9b1c`. The count is four, and the README now names which artifact each of the four needs instead of stating a number a reader has to trust. **Counterfactual:** on a fresh export the runner reports `4 not green`, which is the sentence's claim. Re-verified independently by round 2.                                                                                                           |

### R-s2 — a gate failure escaped as a node stack trace, again

|                    |                                                                                                                                                                                                                                                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Found**          | Round 1's measurement exposed it: `check-style-scope.mjs` reported its missing build output as a raw node stack. **This repository already recorded that exact failure shape as R-w3 and fixed it — in `check-doc-claims.mjs`, one hour earlier.** The fix was written in a new gate immediately afterwards and did not carry it over. |
| **Why it matters** | A stack trace names neither the check nor the remedy. It is the shape `docs/reviews/2026-10-11-website-gap-closure-code-review.md` says a gate must never produce, and it is reachable by anyone who follows the README's local-run section in the documented order.                                                                   |
| **Closure**        | `f2b9b1c` plus round 2's finding below. Now a gate message naming the missing path, the failing syscall, and the command that produces it. **Counterfactual:** build output absent, empty, and present-as-a-file were each exercised; all three print a message and exit 1. No stack is reachable.                                     |

### R-s3 — the round 1 fix weakened the guard it was fixing (found by round 2)

|                    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Found**          | Round 2, on the fix commit. `f2b9b1c` added a second table — which artifact each check needs — and that table repeats four of the five script names. The consistency test's extractor matched **table rows anywhere in the file**, so the count it saw went from 5 to 9. Deleting a row from "The checks" table no longer turned anything red: the name survived in the other table.                                                                                                                     |
| **Why it matters** | The gate existed to make one specific table impossible to falsify. A fix for an unrelated sentence in the same file silently disabled it, and **no test went red** — the guard degraded rather than failed. This is the failure mode the extractor comment already warned about and did not prevent.                                                                                                                                                                                                     |
| **Evidence**       | Extraction with the test's own extractors: pre-fix 5 rows and deleting a main-table row is caught; post-fix 9 rows and the same deletion is **not** caught. Measured both, in both directions.                                                                                                                                                                                                                                                                                                           |
| **Closure**        | This commit. Extraction is scoped to the `## The checks` section, and two counterfactuals were added: one that puts the same names in a second section and proves the first deletion is still caught, one that proves a missing section extracts empty rather than scanning the file. **Counterfactual:** deleting the `check-style-scope.mjs` row from the main table now fails **two** assertions — the floor and the runner/README direction. Verified on the real file, then reverted byte-for-byte. |

### R-s4 — a guard that reported a pass it had not earned

|                    |                                                                                                                                                                                                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Found**          | Round 2, recorded as pre-existing rather than introduced here: with a build output holding only `index.html`, the gate printed `✓ … on none of the 0 doc page(s)` and exited 0. "The scope anchor is absent from the documentation pages" had been verified against zero documentation pages. |
| **Why it matters** | A green check that checked nothing is the exact class this repository keeps meeting — a dead `.VPDocSider` rule, a five-runner that ran four, an extractor that read both sides as empty.                                                                                                     |
| **Closure**        | This commit. A build output with fewer than five documentation pages fails with a message saying why a pass there would be for the wrong reason. **Counterfactual:** a `dist/` holding `index.html` and nothing else now exits 1. Exercised on a throwaway export.                            |

## Also fixed, not findings

- The README's add-a-check step said `scripts/`, which is ambiguous between the repository root's
  release scripts and the site's own. It now names the path the runner actually resolves against.
- That step claimed the third step is enforced "in both directions", which invites a reader to assume
  the table's content columns are checked too. They are not, and the README now says which columns
  are kept true by a reviewer rather than by a check.

## Why round 2 reviewed a delta

Round 2 read only `4ef1a6d..f2b9b1c`. Re-reviewing the original change would have re-derived the
corrected count as a fresh finding against a file that no longer said it, and the round-1 closure
evidence is the measurement itself — reproducible on a throwaway export by anyone who wants to check
it. A round that produces findings only in its own output is the signal to stop; this one advanced.

## What is still open, on purpose

- **The site's five checks never run on a pull request.** Found while writing the README, measured,
  filed as **#174**, and deliberately not fixed _in this change_. Changing which workflows run where
  is a different change with a different risk, and folding it in would make this one unreviewable.
  **— closed 2026-10-12 in `c43b7c8`, on branch `ci/site-checks-on-pr`.** `.github/workflows/website.yml`
  runs `pnpm --filter website run build` on `pull_request`: the same command `pages.yml` runs, so
  the merge-gating and deploy-gating sets are equal by construction rather than by a second gate
  that would need its own counterfactual. **Counterfactual:** deleting `website.yml` turns
  `tests/site-checks-on-pr.test.ts` red (`a pull request runs the same site build the deploy runs`,
  expected 0 workflows to run the site build on a pull_request) — which is this finding stated as a
  test. `tests/website-readme-consistency.test.ts` sits here for the placement reason this ledger
  argued earlier, and that argument is unaffected by the fix: the site runner is still a deploy-path
  tool. **Not yet run by a real runner** — the workflow has never executed on GitHub.
- **No test pins any website gate's failure message.** That is this repository's recorded position
  for these gates: counterfactuals are kept as records rather than as tests that rewrite `src/`.
