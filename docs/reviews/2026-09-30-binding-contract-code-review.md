# Code review - binding contract round 1 (ADR-0024)

Date: 2026-09-30. Skill: `code-review` (Standards + Spec axes), one round, two
parallel sub-agents plus a parent-led doc batch. Scope: `git diff HEAD~1...HEAD` at review
time, i.e. the binding-contract change (commit 969c91e), reviewed against issue #82.

Health gate: CodeGraph 94 files / 1753 nodes / 10411 edges; ocr 1.12.10; whole-tree rule-coverage
gate clean. CodeGraph had not re-indexed the new exports, so blast radius used the grep fallback
with untruncated counts, as the skill requires.

| axis | findings | blocking |
|---|---|---|
| Standards | 13 | 2 |
| Spec | 14 | 5 |

## Closure discipline

A row is closed only where a named test was shown to go **red** when the fix was reverted, by
running the mutation rather than by reading the code. Three guards in the first cut were *false
passes* - a plausible wrong implementation satisfied them - and establishing that is the
substance of this round.

## Round 1 findings

| # | finding | evidence | disposition |
|---|---|---|---|
| S-1 | The no-argument-table guard filtered the module's export **identifiers**, so a text edit was invisible. | Standards mutation: appended a re-declared `read` signature to the block; full suite 830 passed. | fixed: the guard reads the emitted text. Re-mutation turns it red. |
| S-2 | ADR-0024 cited the parity audit, which was untracked - a dead link in a fresh clone, carrying the load-bearing A4 claim. | `git ls-files docs/research/` returned nothing for it. | fixed: the audit is committed with this change, and the A4 claim is restated as narrowed rather than closed. |
| S-3 | `estimateContractTokens` was exported with one grep hit (its own definition) and a comment justifying a consumer that does not exist. | grep count 1 | fixed: deleted, with `CHARS_PER_TOKEN`. |
| S-4 | `NOTED_BINDING_NAMES` was exported for nobody; the test already derived the same thing. | grep count 3, zero production consumers | fixed: deleted; the test derives the key set. |
| S-5 | The floor counterfactual was arithmetic on a literal that never touched the module. | unchanged under a 5000-token block | fixed: deleted; the floor assertion on the real block is what makes a stub fail. |
| S-6 | The argument-table fixture was hand-invented and misstated the installed pi: `edit` takes an edits array, `grep` has no include. | read of pi 0.86.1 dist | fixed: built from the real tool factories instead. |
| S-7 | The budget constants had no anchor in the record, so editing the ceiling to 1000 kept the suite green. | reading | fixed: the floor is in ADR-0024 section 5 and both numbers are pinned by a test that names the record. |
| S-8 | The only-transformation sentence omitted that the wrapper also drops usage and terminate. | src/runtime/bindings.ts | fixed: the module and the glossary now say rewrap and name the dropped fields. |
| P-1 | The no-unbound-name guard iterated the already-bound names, so an unbound name was structurally invisible. | mutation: inserted a `web_search` token; suite stayed 26/26 green. | fixed: the guard reads the contract's own tokens against a literal of non-binding vocabulary. Re-mutation turns it red. |
| P-2 | No guard for the other direction: `read` was bound and undocumented, and an eighth builtin would ship silently. | evaluating the shipped predicate | fixed: a test asserts the unnamed set is exactly the single entry `read`, so a new binding forces a decision. |
| P-3 | ADR-0024 and CONTEXT.md both asserted the guards of P-1 and P-2 as fact. | reading | fixed: both describe the two directions that exist, including which binding is covered without being named. |
| P-4 | The catchability clause was deleted rather than folded in. | grep for the old wording returned 0 hits in src | fixed: the contract now says to wrap the call, naming both forms. |
| P-5 | The `edit` note promised an optional field as always present. | pi's own edit type | fixed: the note promises the two fields pi guarantees. Re-mutation turns a test red. |
| P-6 | The counterfactual block asserted properties of locally built strings, true by construction; skipping the five real guards left it fully green. | Standards skip-and-run | fixed: every case applies the same predicate the real guard uses, to a mutated string. |
| P-7 | The test header claimed nothing reaches into the module while twelve tests read it. | reading | fixed: the header states the seam and what the guards are written against. |
| P-8 | The record's percentages had no in-repo source, and the obvious denominator inverts the conclusion. | Standards measurement of the registered description | fixed: the record states the per-surface figures and which denominator the single-digit reading uses. |
| P-9 | The A4 claim was a mis-claim: A4 asks for a system-prompt SDK section with an argument map, which this record declines. | the audit's own text | fixed: restated as narrowed, with the three parts left open named. |
| P-10 | The re-measurement was owed with no issue number, which the wiring rule calls invalid debt. | reading | fixed: the limitation cites issue #87. |
| P-11 | The CHANGELOG omitted the fourth absent field. | reading | fixed. |

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

