# Code review - binding contract (ADR-0024), rounds 1-2

Date: 2026-09-30. Skill: `code-review` (Standards + Spec axes), one round, two
parallel sub-agents plus a parent-led doc batch. Scope: `git diff HEAD~1...HEAD` at review
time, i.e. the binding-contract change (commit 969c91e), reviewed against issue #82.

Health gate: CodeGraph 94 files / 1753 nodes / 10411 edges; ocr 1.12.10; whole-tree rule-coverage
gate clean. CodeGraph had not re-indexed the new exports, so blast radius used the grep fallback
with untruncated counts, as the skill requires.

| axis      | findings | blocking |
| --------- | -------- | -------- |
| Standards | 13       | 2        |
| Spec      | 14       | 5        |

## Closure discipline

A row is closed only where a named test was shown to go **red** when the fix was reverted, by
running the mutation rather than by reading the code. Three guards in the first cut were _false
passes_ - a plausible wrong implementation satisfied them - and establishing that is the
substance of this round.

## Round 1 findings

| #    | finding                                                                                                                                         | evidence                                                                                         | disposition                                                                                                             |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| S-1  | The no-argument-table guard filtered the module's export **identifiers**, so a text edit was invisible.                                         | Standards mutation: appended a re-declared `read` signature to the block; full suite 830 passed. | fixed: the guard reads the emitted text. Re-mutation turns it red.                                                      |
| S-2  | ADR-0024 cited the parity audit, which was untracked - a dead link in a fresh clone, carrying the load-bearing A4 claim.                        | `git ls-files docs/research/` returned nothing for it.                                           | fixed: the audit is committed with this change, and the A4 claim is restated as narrowed rather than closed.            |
| S-3  | `estimateContractTokens` was exported with one grep hit (its own definition) and a comment justifying a consumer that does not exist.           | grep count 1                                                                                     | fixed: deleted, with `CHARS_PER_TOKEN`.                                                                                 |
| S-4  | `NOTED_BINDING_NAMES` was exported for nobody; the test already derived the same thing.                                                         | grep count 3, zero production consumers                                                          | fixed: deleted; the test derives the key set.                                                                           |
| S-5  | The floor counterfactual was arithmetic on a literal that never touched the module.                                                             | unchanged under a 5000-token block                                                               | fixed: deleted; the floor assertion on the real block is what makes a stub fail.                                        |
| S-6  | The argument-table fixture was hand-invented and misstated the installed pi: `edit` takes an edits array, `grep` has no include.                | read of pi 0.86.1 dist                                                                           | fixed: built from the real tool factories instead.                                                                      |
| S-7  | The budget constants had no anchor in the record, so editing the ceiling to 1000 kept the suite green.                                          | reading                                                                                          | fixed: the floor is in ADR-0024 section 5 and both numbers are pinned by a test that names the record.                  |
| S-8  | The only-transformation sentence omitted that the wrapper also drops usage and terminate.                                                       | src/runtime/bindings.ts                                                                          | fixed: the module and the glossary now say rewrap and name the dropped fields.                                          |
| P-1  | The no-unbound-name guard iterated the already-bound names, so an unbound name was structurally invisible.                                      | mutation: inserted a `web_search` token; suite stayed 26/26 green.                               | fixed: the guard reads the contract's own tokens against a literal of non-binding vocabulary. Re-mutation turns it red. |
| P-2  | No guard for the other direction: `read` was bound and undocumented, and an eighth builtin would ship silently.                                 | evaluating the shipped predicate                                                                 | fixed: a test asserts the unnamed set is exactly the single entry `read`, so a new binding forces a decision.           |
| P-3  | ADR-0024 and CONTEXT.md both asserted the guards of P-1 and P-2 as fact.                                                                        | reading                                                                                          | fixed: both describe the two directions that exist, including which binding is covered without being named.             |
| P-4  | The catchability clause was deleted rather than folded in.                                                                                      | grep for the old wording returned 0 hits in src                                                  | fixed: the contract now says to wrap the call, naming both forms.                                                       |
| P-5  | The `edit` note promised an optional field as always present.                                                                                   | pi's own edit type                                                                               | fixed: the note promises the two fields pi guarantees. Re-mutation turns a test red.                                    |
| P-6  | The counterfactual block asserted properties of locally built strings, true by construction; skipping the five real guards left it fully green. | Standards skip-and-run                                                                           | fixed: every case applies the same predicate the real guard uses, to a mutated string.                                  |
| P-7  | The test header claimed nothing reaches into the module while twelve tests read it.                                                             | reading                                                                                          | fixed: the header states the seam and what the guards are written against.                                              |
| P-8  | The record's percentages had no in-repo source, and the obvious denominator inverts the conclusion.                                             | Standards measurement of the registered description                                              | fixed: the record states the per-surface figures and which denominator the single-digit reading uses.                   |
| P-9  | The A4 claim was a mis-claim: A4 asks for a system-prompt SDK section with an argument map, which this record declines.                         | the audit's own text                                                                             | fixed: restated as narrowed, with the three parts left open named.                                                      |
| P-10 | The re-measurement was owed with no issue number, which the wiring rule calls invalid debt.                                                     | reading                                                                                          | fixed: the limitation cites issue #87.                                                                                  |
| P-11 | The CHANGELOG omitted the fourth absent field.                                                                                                  | reading                                                                                          | fixed.                                                                                                                  |

## Escalations

Blocking findings that hit a blocking-level rule were re-checked by the parent with the
mutation runs quoted above rather than by a second model pass: S-1, S-2, P-1, P-2, P-4, P-5.

## Round 1 outcome

All blocking findings and the high-value judgement findings fixed. 835 tests green (831 passing,
4 skipped); typecheck, lint, fmt:check, build and verify:dist all green. The three guards that
were false passes are now mutation-proven.

One consequence worth recording: growing the normative corpus by roughly 250 lines pushed the
full-corpus doc-integrity scan past vitest's 5s default under parallel load. The assertion was
left alone and given an explicit budget, the way the pty-driven suites state theirs.

Cross-references: issue #82 (spec), #84 and #85 (the code tickets this change closes), #87
(the owed re-measurement).

## Round 2 (delta over 368d046)

Standards 10 findings (2 blocking), Spec 9 findings (1 blocking). The two axes agreed on the
headline: **one of the three round-1 guards was still a false pass**, and the round-1 fix had
introduced two of its own problems.

| #      | finding                                                                                                                                                             | evidence                                                            | disposition                                                                                                                                                                                                                                                                         |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2-S1  | The record's measured constants were stale by one edit: 282/654/71% against an actual 290/672/76%, and the block sat 10 tokens under the ceiling without saying so. | Standards measurement with the estimator the paragraph itself names | fixed: the record states 290/672/76% and says outright that the headroom no longer covers a future note.                                                                                                                                                                            |
| R2-S2  | The argument-shape regex required an **optional** parameter, so the canonical trimmed re-declaration was invisible.                                                 | Spec mutation: appended a required-only signature; 27/27 green      | fixed: the optional marker is now optional in the pattern. Re-mutation turns it red, and the counterfactual now exercises both forms.                                                                                                                                               |
| R2-S3  | REACHABLE_BINDING_NAMES was a new export with one grep hit -- the same dead-export shape S-3/S-4 had just removed.                                                  | grep count 1                                                        | fixed: deleted.                                                                                                                                                                                                                                                                     |
| R2-S4  | Routing the coverage guard's oracle through that export moved the judgement into the module under test, regressing P-1's fix.                                       | Standards working-tree note                                         | fixed: BOUND_NAMES is derived from the real binding table again, with a comment saying why it must not come from the contract module.                                                                                                                                               |
| R2-S5  | The key-set counterfactual compared a mutated map against the untouched original -- true in both worlds -- and needed a cast to get past the new key type.          | Standards: predicate never runs                                     | fixed: the guard is now a named predicate, the counterfactual applies it, and the cast is gone.                                                                                                                                                                                     |
| R2-S6  | The 30s doc-integrity timeout was unsupported: the test measures 90ms isolated, so 30s is 333x the cost and would hide a real 300x regression.                      | Standards timing measurement                                        | fixed: reverted to the default. The one observed 5.6s timeout under a fully parallel suite is recorded below as a flake, not papered over.                                                                                                                                          |
| R2-S7  | The delta had relaxed the never-undefined assertion, so a rewording that dropped that half would pass.                                                              | Standards: old string still matched                                 | fixed: the full phrase is asserted again, across the line break.                                                                                                                                                                                                                    |
| R2-S8  | The write note says always but was backed by one happy path.                                                                                                        | reading                                                             | fixed: the test pins both paths of the IO boundary, a new file and an overwrite.                                                                                                                                                                                                    |
| R2-S9  | The record's closing sentence about hand-maintained lists sat directly under two bullets that are hand-maintained literals.                                         | reading                                                             | fixed: the record now says the literals are test expectations and states the two real scope limits of the first guard.                                                                                                                                                              |
| R2-S10 | The parity audit's appendix pointed at uncommitted /tmp artifacts that ADR-0024 now leans on.                                                                       | reading                                                             | fixed: a reproducibility note says the sub-reports were scratch and names the public sources that do pin the claims.                                                                                                                                                                |
| R2-P2  | The unbound-name guard reads only the contract slice -- 43% of what the model is sent.                                                                              | Standards: an unbound name in the surrounding preamble stays green  | accepted as a documented scope limit rather than widened: the record and the glossary now say the guard covers backticked tokens inside the block, and both name bare prose as outside it. Widening would need a vocabulary for the whole description, which is a different design. |

### The flake we did not paper over

Growing the normative corpus by roughly 250 lines made this test exceed vitest's 5s default
at 5646ms in a full-suite parallel run. Isolated it measured 90ms, so the first budget this record
set (30s) was 333x the real cost and would have let a genuine regression pass; it is reverted.

The revert alone was not enough -- the timeout came back on the next full-suite run, so it was
never a one-off. The cause was in the test: two assertions each built their own Set over the whole
corpus. The Set is now built once at module scope, after the extractor that produces it, and each
assertion filters it. The default timeout is kept, and three consecutive full-suite runs are green,
so the fix is at the cause rather than in the budget.

### Round 2 closure

All blocking findings fixed. Final mutation proof, each run against the suite and reverted:

| mutation                                   | result    |
| ------------------------------------------ | --------- |
| an unbound name documented in the contract | 1 failed  |
| a required-parameter re-declaration        | 2 failed  |
| a note for a binding that does not deviate | 2 failed  |
| unmodified tree                            | 28 passed |

Full gate green: typecheck, lint, fmt:check, build, 832 tests, verify:dist 29 checks.
