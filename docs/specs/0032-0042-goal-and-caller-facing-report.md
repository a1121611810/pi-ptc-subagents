# Spec — Dispatch `goal` and a caller-facing child report

Map: [#208](https://github.com/a1121611810/pi-ptc-subagents/issues/208)
Status: **draft** — decisions frozen from the map; items marked `TBD` need a human call before implementation.

## Problem Statement

A dispatched child is a fresh pi subprocess. The only **task content** it receives from the parent is `task`; the rest of what it is told is policy (depth budget, read-only tier, report contract) rather than why the work exists.

`src/runtime/dispatch.ts` tells it, in the child's own system prompt (the `<pi-ptc-context>` block):

> "You cannot see that session's conversation and you cannot ask it anything, so if the task you were given is underspecified, say which part is underspecified and answer the rest rather than inventing the missing context."

That sentence is honest, and it is also the whole of the child's context. A child asked to "check whether the retry path is safe" cannot know that the parent is preparing a release, or that a previous child already ruled out the obvious explanation. It either guesses or half-answers.

The return path has a mirrored gap. The **child report** (ADR-0032) carries four things: `summary`, `findings[{what, evidence}]`, `files_touched`, `usage`. All four describe the child's own world — what it did, what it found, what it touched, what it cost. **None of them says what the result means for the caller.** The parent must infer that from `findings`, or re-read the prose.

A second, narrower problem: `summary` is specified as "one line, your own words, of what it concluded". A conclusion is not an interpretation. "The lock is acquired twice on retry" is a conclusion; "you should not ship this until the retry path is serialized" is what the caller needs.

## Solution

Two independent changes, each decided by its own pre-registered experiment.

### 1. `goal` — a caller-supplied reason

`pi.dispatch` and `ptc_subagent` gain one optional parameter:

```
goal?: string
```

It carries **the parent's intent for this dispatch slice** — why this task was cut out — not the full conversation and not the user's original request. It reaches the child as its own prompt block, `<pi-ptc-goal>`, separate from the host's `<pi-ptc-context>` policy block.

The child is told, in that block, that the task remains the deliverable and the goal is not authority to change it. That sentence is the whole of the "no product judgment" boundary: the child gets context to execute better, not a mandate to re-litigate the task.

`goal` is **orthogonal to `childReport`**. An agent that opts out of the report contract still receives the goal, because the two switches answer different questions (output contract vs input context).

### 2. The experiment

Both changes are decided by measurement, not argument.

- **`summary` shape** — a pre-registered three-arm experiment (A / B / **C calibration**). C replaces the report content with another task's report, so "neither arm beats noise" has an observable trigger. Full design: `docs/research/wayfinder-209-ab-harness-design.md`.
- **`goal` usefulness** — **E3** (G0 / G1 / **G2 placebo**) runs **first**: a negative result removes §1 and the whole T4 task corpus, while a negative E1 only removes one field. Full design: [#217](https://github.com/a1121611810/pi-ptc-subagents/issues/217).

E3's task corpus is deliberately ambiguous by construction. If a task already says what to check, the goal cannot help, and the experiment measures nothing.

## User Stories

1. As a parent model, I want to tell a child **why** its task exists, so that the child can resolve ambiguities the task text leaves open without inventing context.
2. As a parent model, I want the child's report to tell me **what the result means for my work**, so that I do not have to re-derive the implication from a findings list.
3. As a parent model, I want the child to say when the goal and the task disagree, so that I learn my own slice was mis-scoped instead of silently receiving a task-shaped answer to a different question.
4. As an agent-definition author, I want the report opt-out to keep meaning **only** the report contract, so that turning it off does not silently also remove my child's context.
5. As a maintainer, I want the shape decision to come from a measured comparison, so that "prose reads better" is not settled by whoever argues last.
6. As a maintainer, I want the experiment to be executable without a human at a terminal, so that it can run across the supported pi version range.
7. As a maintainer, I want a pre-registered "cut both" outcome, so that a difference between arms is never mistaken for value.
8. As a maintainer, I want `goal` validated against a **placebo**, so that "extra context helps" is never reported as "the intent helps".
9. As a maintainer, I want the `goal` experiment to run before the summary experiment, so that a negative result removes work instead of leaving it built.

> **Updated 2026-10-19.** The summary-shape arms (formerly D4–D7) and the provenance fields of
> ADR-0042 were built and measured. Neither survived: the summary shape did not improve a
> parent's judgement, and the provenance enum collapsed to a single label. Both are removed.
> This spec now covers `goal` and the experiment that validated it.

## Implementation Decisions

### D1 — `goal` is optional, and the tool description says when to use it

`goal?: string` on `DISPATCH_PARAMETERS` (`src/runtime/bindings.ts`). Both `pi.dispatch` and `ptc_subagent` inherit it — `src/tools/subagent.ts` imports the same object, and a test pins the two key sets equal.

No length bound. The caller already paid for the text in its own context; a rejection branch here is a new failure mode with no observed trigger.

Not persisted on `TaskRecord`. The caller wrote it and still holds it; unlike `usage`, it is not a host-measured fact that exists nowhere else.

Tool description adds one clause: pass `goal` when the task involves judgment or trade-offs. Without it the parameter is never used.

### D2 — `goal` reaches the child as a separate block, after the policy block

`appendDepthHint` (`src/runtime/dispatch.ts`) gains a `goal` option and appends, after `<pi-ptc-context>`:

```
<pi-ptc-goal>
Background from the caller: why this task was dispatched.

{{goal}}

The task you were given is the deliverable. This goal is context for doing it
well, not authority to change it. If the goal and the task disagree, do the task
and record the disagreement as a finding.
</pi-ptc-goal>
```

- Empty or absent `goal` → the block is omitted entirely. An empty block reads as "there is content but it was withheld".
- `<` and `>` in the value are escaped. The risk is not a malicious caller; it is a model writing XML-looking prose that breaks the block boundary.
- **Both call sites must pass it**: `dispatch()` (foreground) and `dispatchBackground()` (background), both in `src/runtime/dispatch.ts`. The line numbers are deliberately omitted — they moved twice while this change was being written, and they will move again. A one-sided wiring fails silently, splitting the experiment's own data.

### D3 — `goal` is orthogonal to `childReport`

`isReportContractOn(agent)` continues to gate **only** `CHILD_REPORT_PROMPT_CLAUSE` and the report tool in `childToolList`. No new `goal: false` switch. The privacy boundary is the caller's: if an agent must not see a goal, the caller must not pass one.

### D4 — E3, the experiment that decided `goal`

- **E3 `goal` validation** — three arms: **G0** (no goal), **G1** (real goal), **G2** (**placebo goal**: same length, plausible, does not disambiguate). Run **before E1**, because a negative result removes D1–D3 and the whole T4 corpus.
- **T4 task class** — intent-sensitive tasks: the `task` text is deliberately ambiguous, the `goal` disambiguates it, and the check only passes if the child resolved the right aspect. At least 6 samples. Without this class the experiment measures nothing.
- **E1 behavior A/B** — all 15 published pi versions from `0.86.0` to `1.3.0`; staged E1a (1.0.0, 50 blocks) → E1b (per version, 10 blocks) → E1c (reversals, 50 blocks); capability cohorts G1–G4 for descriptive pooling.
- **E2 compatibility & render** — all 15 versions; TUI render check only.
- **Instruments** — E1 and E3 use **RPC** (`pi --mode rpc`); compliance gate uses the canned provider; TUI uses tmux.
- **Statistics** — three pre-specified pairwise comparisons, **mid-P McNemar**, **Holm** at α = 0.05, minimum 6 discordant pairs, fixed 50 blocks.
- **Cut-both trigger (E1)** — neither A nor B beats C; or A vs B differs while neither beats C.
- **Cut-goal trigger (E3)** — G1 does not beat **both** G0 and G2. If G1 beats G0 but not G2, keep `goal` but rewrite its framing: what was measured is "background helps", not "intent helps".
- **No-regression rule** — a confirmed qualitative interaction means ship the arm that does not regress on any supported version; if both regress somewhere, cut both.
- **Cost note** — E3 and E1 are each ≈1 050 runs; running both is ≈2 100, about 26 hours serial or 7 hours at 8-way parallelism.

## Testing Decisions

All tests satisfy the six constraints in `docs/testing-constraints.md`.

| #    | Test                                                                                               | Counterfactual that must turn it red |
| ---- | -------------------------------------------------------------------------------------------------- | ------------------------------------ |
| T-1  | Both `appendDepthHint` call sites emit the same `<pi-ptc-goal>` block for one `DispatchInput.goal` | Wire only one site                   |
| T-2  | A goal containing `</pi-ptc-goal>` does not close the block early                                  | Skip escaping                        |
| T-3  | An absent/empty goal omits the block entirely                                                      | Emit an empty block                  |
| T-4  | An agent with `childReport: false` still receives the goal block                                   | Couple it to `isReportContractOn`    |
| T-5  | `DISPATCH_PARAMETERS` and `ptc_subagent`'s parameter keys stay equal with `goal` added             | Add it to one                        |
| T-10 | `TaskRecord` carries no `goal` field                                                               | Persist it                           |

T-1 and T-4 are the two that fail **silently** if wrong; they get explicit `expect` on the prompt text, not on a count.

## Out of Scope

- Deleting the losing arm, or deleting `goal` after a negative E3. Both are implementation acts after the experiments, not part of this spec.
- Removing the summary-arm switch — tracked as TBD 5, but the removal is the implementation act, not this spec.
- `goal` inheritance across `dispatch depth`. Each dispatch carries its own `goal`; this spec defines the single-call contract only.
- Version-gated schemas. Rejected in [#216](https://github.com/a1121611810/pi-ptc-subagents/issues/216).
- Changing `findings`, `files_touched`, or `usage`.
- The `ptc_workflow` surface. It shares bindings but has no dispatch parameter of its own.

## Further Notes

### TBD before implementation

1. Arm A's phrase "what they should do with it" may induce advice rather than interpretation. Review after the pilot.
2. Arm B may need a third field if the pilot shows caveats being folded into `conclusion`. Do not add it pre-emptively — that would break the information-equality rule in D4.
3. `summary` has no explicit render bound today. Add one only if the pilot shows unbounded growth.
4. The task corpus' pilot exclusion thresholds (≥0.9 / ≤0.1 pass rate) are untested. They may remove too many samples.
5. The summary-arm switch must be removed when the experiment ends. Track it so it does not become permanent.

### Documents this spec changes

- `CONTEXT.md` — add `goal`; amend `child report` for the new `summary` semantics.
- `docs/adr/0032-child-report.md` — amend for the two-arm summary contract.

### The question E3 answers

Whether `goal` improves outcomes at all. It is the one claim in this spec that was argued rather than measured, and E3 exists to settle it: G0 / G1 / **G2 placebo**.

If G1 does not beat **both** G0 and G2, `goal` is cut here rather than shipped on the strength of the argument. A negative result is a recorded finding, not a wasted effort — it removes D1–D3 and the T4 corpus before they are built.

The subtler outcome matters too: if G1 beats G0 but not G2, what was measured is _background helps_, not _intent helps_. Keeping the parameter with that finding would make its description a lie, so the framing is rewritten instead.

## Source documents

- Map: [#208](https://github.com/a1121611810/pi-ptc-subagents/issues/208)
- Decisions: [#209](https://github.com/a1121611810/pi-ptc-subagents/issues/209), [#210](https://github.com/a1121611810/pi-ptc-subagents/issues/210), [#211](https://github.com/a1121611810/pi-ptc-subagents/issues/211), [#212](https://github.com/a1121611810/pi-ptc-subagents/issues/212), [#213](https://github.com/a1121611810/pi-ptc-subagents/issues/213), [#214](https://github.com/a1121611810/pi-ptc-subagents/issues/214), [#215](https://github.com/a1121611810/pi-ptc-subagents/issues/215), [#216](https://github.com/a1121611810/pi-ptc-subagents/issues/216), [#217](https://github.com/a1121611810/pi-ptc-subagents/issues/217)
- Design: `docs/research/wayfinder-209-ab-harness-design.md`
- Prompt draft: `docs/research/wayfinder-213-prompt-contract-draft.md`
- Task corpus: `docs/research/wayfinder-214-task-corpus-draft.md`
- ADR-0032 — child report
- ADR-0028 — structured result
- ADR-0041 — read-only tier
- `docs/testing-constraints.md`
