# Review — `bash` becomes an opt-in binding (#73)

Date: 2026-10-13 → 2026-10-14. Branch: `feat/bash-opt-in-binding`. Fixed points: `156ce7a` (v2.1.0)
→ `521ff53` → `b0d9598` → `3dc1c3d` → `577e379`. Spec: issue #73 (parent spec #72). Decision record:
[ADR-0040](../adr/0040-bash-is-an-opt-in-binding.md).

Four rounds. **Rounds 1 and 2 found defects in the deliverable. Round 3 found defects only in round
2's own fix output, and round 3's fix round changed no observable behaviour at all** — which
`AGENTS.md` names as a stop signal rather than a reason for another round. That shape is the thing
worth keeping from this review, so it is written down before the findings.

## What was reviewed

Removing `bash` from the default PTC binding surface behind an explicit per-install opt-in. It is a
small code change — a filter, a chokepoint, a config key — and almost all the difficulty was
elsewhere: `bash` reaches a model-written program through several model-visible surfaces at once, and
every one of them is a place where the code could be right and the prose wrong.

The gate sits in `resolveBindingNames` (`src/tools/common.ts`), the single read point feeding both
the binding table and the model-facing binding list. `createBuiltinBindings` keeps a second,
independent gate for callers that build a table without going through the chokepoint.
`BUILTIN_BINDING_NAMES` stays the full seven-name known set — `dispatcher.ts:569` ships it as the
worker's `bindingCandidates`, and the worker installs a throwing stub per unbound candidate, which is
what makes the refusal actionable.

## Findings ledger

### R-1 — the model-facing description still offered `bash`

|             |                                                                                                                                                                                                                                                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Found**   | Round 1, blocking. `src/tools/run-code.ts`'s `DESCRIPTION` — a static, model-visible string — enumerated all seven bindings by name, including `bash`. The binding table no longer contained it. A model reading the description would call `tools.bash` and be refused. No call site and no grep pointed at it: it is a bare constant. |
| **Why**     | ADR-0005 §2 already warns that a narrowed surface with stale prose is the failure. It happened one layer out, where every wiring review was looking at parameters instead.                                                                                                                                                              |
| **Closure** | `b0d9598`: rewritten to describe the rule rather than the roster. **Counterfactual:** two pin tests added — one asserts no opt-in name appears as a callable `tools.<name>(`, the other that every callable it does show is bound by default.                                                                                           |

### R-2 — the value link from config file to announcement was held by nothing

|             |                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Found**   | Round 2, blocking. The grant travelled `readOptInBindingsConfig` → extension closure → `describeEntry` → `resolveBindingNames(base, optIns)`, six hops in `src/index.ts`. Only two were held by tests. Neutralising it — `const optInBindings = []` at the extension entry — left the entire suite identical to baseline. The tools received the value too, but on the PTC line a default session needs none, so discarding it narrowed the announcement and widened nothing. |
| **Closure** | `3dc1c3d`: `tests/ptc-mode.test.ts > a granted opt-in reaches the mode-entry announcement, not just the binding table`. Asserted on the **announcement** because the binding table cannot tell the difference. **Counterfactual:** neutralising the grant at the extension entry turns this test red, and it is the only test that does.                                                                                                                                      |

### R-3 — the guard written for R-2 could not see the mutation it was written for

|             |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Found**   | Round 3, blocking. `3dc1c3d`'s fix was a source-scan invariant over every binding-list call site. It asserted `argCount(site) > 1`. But `describeEntry`'s opt-ins parameter is the **third** one, so deleting it still left two arguments and the check passed; and substituting `[]` left the count untouched at every site — including the exact neutralisation R-2 had been measured with. The invariant was green on half the sites it named, and green for the wrong reason on the rest. |
| **Closure** | `577e379`: per-callee argument minimum (`resolveBindingNames` ≥ 2, `describeEntry` ≥ 3) plus `EMPTY_GRANT` rejection at that position, so deletion **and** substitution are both caught. **Counterfactual:** substitution at the `/ptc status` line, deletion at a `describeEntry` site, deletion at a `resolveBindingNames` site, and the `new Set()` spelling each turn it red. All four were run.                                                                                          |

### R-4 — the comment stripper that guarded the wiring scan could be fooled by a trailing comment

|             |                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Found**   | Round 3, blocking. `strippedSource` was two regexes; the line-comment one required `//` at the start of a line. Replacing `getOptInBindings,` with `getBindingSourceNames, // TODO: getOptInBindings` left the suite green — the exact shape the docstring said it existed to prevent. `tests/config-read-points.test.ts` already carried a correct four-state scanner, and the new helper was a regression against it. |
| **Closure** | `577e379`: `maskSource` extracted to `tests/helpers/source-mask.ts` and shared by both fixtures. **Counterfactual:** the trailing-comment substitution turns the registration test red.                                                                                                                                                                                                                                 |

### R-5 — the "three distinct failure sentences" assertion was satisfied by `mkdtemp`

|             |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Found**   | Round 3, blocking. `readDefaultModeConfig` names the file it choked on, and each iteration got its own `makeTempDir()`, so three sentences differed whether or not they came from three branches. Replacing all three bodies with JSON arrays — one branch, three times — left the test green. The comment claimed the assertion was "what stops that silent collapse from coming back".                                                                                                                                  |
| **Closure** | `577e379`: the temp path is erased before the comparison, and doing so **refuted the claim it was making**: array, scalar and `null` share one sentence, because the reader handles them in a single conditional. That is correct product behaviour, so the test now asserts the real shape — two sentences, with the trio asserted to _share_ one — and gains a `JSON null` body, the only one that reaches the `parsed === null` disjunct. **Counterfactual:** collapsing all four bodies onto one branch turns it red. |

### R-6 — two read points in the project rule file were stale, in the sentence a previous round edited

|             |                                                                                                                                                                                                                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Found**   | Round 3, blocking. `3dc1c3d` corrected four of the five citations in one line of `.opencodereview/rules/ptc-config-wiring.md` and left two: `ptc-mode.ts:41` resolved to a module-header prose comment, `common.ts:124` to a ULID validation line. Neither is a read point. `tests/doc-integrity.test.ts` asserts four only over `docs/**` and `src/**`, so nothing turns red. |
| **Closure** | `577e379`: `ptc-mode.ts:1309` and `common.ts:152`, each verified by opening the line. **Counterfactual:** opening either line shows `new Set(BUILTIN_BINDING_NAMES)` / `BUILTIN_BINDING_NAMES.filter(` respectively.                                                                                                                                                           |

### R-7 — `ptc_workflow`'s description was reworded and left unpinned

|             |                                                                                                                                                                                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Found**   | Round 3, non-blocking but real. `3dc1c3d` fixed the workflow description's wording for exactly the reason `tests/binding-policy.test.ts` exists, and pinned only `ptc_run_code`'s. Restoring the old wording — "mirror the session's enabled tools", the shape ADR-0040 calls the defect — left every suite green. |
| **Closure** | `577e379`: both descriptions run through the same checks, plus a new one that pins the narrowing sentence itself, because the existing checks cannot tell the two wordings apart. **Counterfactual:** restoring the round-2 wording turns it red.                                                                  |

## Claims that were false, and stayed false for a round

Three separate times, a comment asserted a measurement that no one had taken, and the assertion was
the thing under review:

1. `tests/extension.test.ts` claimed that removing the wiring "left the whole suite green — measured,
   not assumed". It had not; round 2 found four tests that do catch it.
2. Round 2's correction claimed **four** tests go red. Measuring the four named files found **two**.
   Round 3 corrected the correction, with the scope stated rather than implied.
3. `argCount`'s docstring promised to ignore "commas nested in brackets **or strings**" while the
   loop tracked brackets only. `f(a, "x, y")` counted 3 arguments, so a call passing one real
   argument and a comma-bearing string satisfied a `> 1` check.

All three are the same shape, and none of them was caught by a gate: `doc-integrity` audits claims it
can recognise a _shape_ for, and these were correct-shaped prose with wrong numbers. A scanner cannot
tell a comment from a fact.

## Anchors

- **Round 2** — `scripts/PROTOTYPE-optin-e2e.sh`, two arms against a real `pi` 1.1.0 subprocess with
  a real model, differing only in `~/.pi/agent/ptc.json`. 2/2: `tools.bash` refused without the
  opt-in, actually executed with it. The suite drives the binding table directly; this asked a model
  to call the binding.
- **Round 4** — the same prototype re-run against the rebuilt `dist/`: **2/2 arms matched**. Without
  `ptc.json` the model was refused `bash` and told what _was_ bound (`read`, `edit`, `write`,
  `pi.dispatch`); with `{ "optInBindings": ["bash"] }` the same program executed and returned the
  run-unique marker. Green.

## Where this stopped, and why

Round 3's findings were all in round 2's fix output, and round 3's **fix round changed no observable
behaviour** — a module comment, a rule-file line number, one ADR quote, and a great deal of test
code. `AGENTS.md` is explicit that a round producing only records and tests is a signal to stop, not
a round to build on, and the defect class had been measured: three consecutive rounds found the same
thing, which is a guard that passes for a reason other than the defect it names, and the fourth round
is the one that would start manufacturing coverage for correct code.

The reviewer here is also the fixer, so "no findings" was never available as a stopping signal on its
own. What settled it was the anchor and the absence of a behaviour change, not a clean round.
