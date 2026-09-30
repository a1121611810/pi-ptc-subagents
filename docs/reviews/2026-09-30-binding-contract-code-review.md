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

**The cause was never established, and the first account of it in this ledger was wrong.**
Round 3 put the hoist back exactly as it was at 368d046 and the suite stayed green, which
rules out the stated reason: there was one scan, in one test, not two scans in two
assertions. What the hoist actually does is move that one scan out of the timed body --
the body now runs in 1-2ms and the scan happens at import, outside the per-test timeout
window. The outcome is good and three consecutive full-suite runs are green with the
default timeout kept, but that is **green by measurement, cause unestablished**, not a
closed finding. The flake was load-dependent: the same test was observed at 5646ms under a
fully parallel run and at 857-1985ms on three others, and nobody has explained the spread.
If it comes back, that spread is the thing to look at.

### Round 2 closure

All blocking findings fixed. Final mutation proof, each run against the suite and reverted:

| mutation                                   | result    |
| ------------------------------------------ | --------- |
| an unbound name documented in the contract | 1 failed  |
| a required-parameter re-declaration        | 2 failed  |
| a note for a binding that does not deviate | 2 failed  |
| unmodified tree                            | 28 passed |

Full gate green: typecheck, lint, fmt:check, build, 832 tests, verify:dist 29 checks.

## Round 3 (delta over 6768efb)

Standards 8 findings, 0 blocking. Spec 8 findings, 3 blocking. The headline is not a new defect but a correction to this
ledger, so it is recorded first.

### The correction

R2-S6's account of the doc-integrity timeout was fabricated. This record claimed two assertions
each rebuilt a Set over the corpus. There was one scan, in one test. Putting the hoist back
exactly as it was at 368d046 leaves the suite green, which is the counterfactual this record's
own closure discipline requires. The hoist does one real thing -- it moves the scan out of the
timed body into import, which is outside the per-test window -- and the row is now marked
**green by measurement, cause unestablished**. The flake was load-dependent (5646ms once,
857-1985ms on three later runs) and the spread is unexplained. That is what the next reader needs,
not a cause story that was never measured.

| #    | finding                                                                                                                                                                                                                                                                                  | evidence                                                                  | disposition                                                                                                                                                                                                                                                           |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R3-1 | The argument guard enforced neither its scope nor its types: a closed list of nine type names plus backtick-only scanning missed interface-typed, byte-array and callback signatures, and bare-prose ones. It also regressed against round 1, where a tab-indented signature was caught. | Standards: five measured misses, all green                                | fixed: the pattern is structural -- a parenthesised name-colon run -- and the scan covers the whole emitted text. All five now go red, including the tab case. The module header states the one form that is not caught and why it is not what the decision is about. |
| R3-2 | R2-S6's stated cause was false.                                                                                                                                                                                                                                                          | Standards: reverting the hoist is green                                   | corrected above; the row is reclassified, not closed.                                                                                                                                                                                                                 |
| R3-3 | The hoisted Set sat before the extractor, contradicting its own comment, and only survived on function hoisting.                                                                                                                                                                         | Standards: converting the extractor to a const arrow kills the whole file | fixed: the block is below the extractor, and the comment says why it is there rather than why it was moved.                                                                                                                                                           |
| R3-4 | The write test's two paths were both successes, under a blocking-level rule that wants success and failure. pi's write into a missing directory resolves rather than rejecting.                                                                                                          | Standards measurement                                                     | fixed: the missing-directory path is pinned, and the comment names it as the one a pi bump would flip.                                                                                                                                                                |
| R3-5 | notedBindingsDeviating was a key extractor wearing the name of a decision.                                                                                                                                                                                                               | reading                                                                   | fixed: renamed to notedBindingNames, and the deviation claim moved onto the literal it is compared with.                                                                                                                                                              |
| R3-6 | The vocabulary test claimed to keep the argument guard from being blinded; the guard never reads the vocabulary.                                                                                                                                                                         | Standards: whitelisting a signature does not change the guard's result    | fixed: restated as what it checks -- no parameter declaration may sit in the whitelist.                                                                                                                                                                               |
| R3-7 | The record said the shortest note was 41 characters; it is 39.                                                                                                                                                                                                                           | measured: 39, 69, 72, 133                                                 | fixed.                                                                                                                                                                                                                                                                |

### Round 3 closure

| mutation                                     | result    |
| -------------------------------------------- | --------- |
| an interface-typed signature in the contract | 3 failed  |
| a bare-prose `tools.read(path: string)` call | 1 failed  |
| unmodified tree                              | 28 passed |

Full gate green: typecheck, lint, fmt:check, build, 832 tests, verify:dist 29 checks.

### Round 3 Spec axis (delta over 6768efb, 8 findings, 3 blocking)

Run against the same commit as the Standards axis. Its sharpest result was a counterexample to a
claim in the round-1 table above, recorded here rather than edited there.

| #     | finding                                                                                                                                                                                                                                                            | evidence                                                | disposition                                                                                                                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R3-S1 | The floor counterfactual compared a local literal against a constant and never touched the module, so deleting the real budget assertions left the suite green. This is round-1 S-5, recorded above as fixed by deletion; the test had been reworded, not deleted. | Spec: deleting both real budget assertions, 28/28 green | fixed: withinBudget is one predicate; the guard and the counterfactual both call it, and the counterfactual now also covers the ceiling, which the spec names and no test exercised.           |
| R3-S2 | The array-of-blocks counterfactual asserted on a local string and duplicated the guard, so deleting the real assertion left it passing.                                                                                                                            | Spec: delete the real assertion, 28/28 green            | fixed: statesContentIsArrayOfBlocks is the shared predicate.                                                                                                                                   |
| R3-S3 | The argument guard read only backticked tokens, so a bare-prose `Args: read(path).` shipped green; the record's documented scope limit was attributed to the other guard, which is why the hole read as closed.                                                    | Spec: twice, 28/28 green                                | fixed: a second, structural pattern catches the untyped form without matching the contract's own `tools.<name>(args)` or `Promise.all(...)`. See the Standards table above for the typed form. |
| R3-S4 | The record said the shortest note was 41 characters (it is 39) and concluded the headroom covered no note; 40 characters of headroom covers exactly one.                                                                                                           | Spec: measured                                          | fixed, with the arithmetic stated rather than rounded toward the comfortable answer.                                                                                                           |
| R3-S5 | The record's 382-token before-figure is the current description minus the block, not the pre-change description, which is 402. The difference is the clause this change was supposed to fold away.                                                                 | Spec: `git show 2074832`                                | fixed: 402 to 672, 72% gross and 67% net, with the subtraction trap named.                                                                                                                     |
| R3-S6 | The spec's decision-encoding block has drifted from what ships: six facts have no basis in the spec text.                                                                                                                                                          | Spec line-by-line                                       | **not a code fix.** The divergence is the spec owner's to close, and nothing in the tree contradicts itself because the module is the only literal.                                            |
| R3-S7 | The round-2 header claimed nine Spec findings while the table recorded one, so the other eight were unauditable.                                                                                                                                                   | Spec                                                    | corrected below.                                                                                                                                                                               |

### Corrections to the round-1 table

Two dispositions in round 1 were over-claimed and are corrected rather than quietly dropped:

- **S-5** said the floor counterfactual was deleted. It was reworded into the same shape, and the flaw
  survived two more rounds. Closed this round, against the counterfactual now calling withinBudget.
- **P-6** said every counterfactual applies the real guard's predicate. Two of six did not. The
  claim held for the four name and key-set cases, which is why rounds 1 and 2 both believed it.

### Round 3 closure

| mutation                                  | result    |
| ----------------------------------------- | --------- |
| interface-typed signature in the contract | 3 failed  |
| bare-prose tools.read(path: string) call  | 1 failed  |
| the real block grown past the ceiling     | 1 failed  |
| unmodified tree                           | 28 passed |

The ceiling row is the one that settles S-5: the real block is bounded by something that fires
when it grows, not by a counterfactual comparing a stub to a constant.
