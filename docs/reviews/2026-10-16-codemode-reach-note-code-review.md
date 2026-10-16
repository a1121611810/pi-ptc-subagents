# Code review — the codemode-reach note (issue #200)

Date: 2026-10-16. Skill: `code-review` (Standards + Spec axes; two parallel read-only
sub-agents, plus the host agent's own doc-sync pass). Scope is the **uncommitted working
tree vs `HEAD` = `8d582b4`** (v3.3.0) on branch `fix/codemode-dispatch-reach` — the change
implements issue #200 and was rebased onto v3.3.0 before round 1. Spec source: GitHub issue
#200 (body + triage agent brief), injected into OCR as `--background-file` (trimmed to
3 055 chars; the untrimmed thread exceeded the 8 000-char hard limit).

Deliverable under review: 6 files, +58/−1 — `src/tools/common.ts` (the new
`PTC_BINDING_REACH_NOTE`), `src/tools/run-code.ts` and `src/tools/workflow.ts` (both splice
it into their descriptions), the two test files, `CHANGELOG.md`. After round 1 the
deliverable was 7 files (+73/−1) — the `docs/adr/0024-…` figure update F5/S2 produced;
round 2's record corrections bring the tracked diff to **+79/−1**, still the same seven
files, plus this ledger staged alongside them.

## Health gate

- CodeGraph: 166 files / 3 538 nodes / 14 290 edges. OCR v1.12.11.
- Whole-tree `src/*.ts` rule coverage: `SYSTEM-ONLY: []`.
- `ocr delegate preview` is ref-based and cannot see uncommitted work, so the five
  OCR-eligible files were passed explicitly to `ocr delegate rule` — the same route this
  repository documents for `tests/**`.
- **Attribution correction:** the three `src/tools/*.ts` files resolve to
  `ptc-bgdispatch-contract.md` (`merge_system_rule: true`), **not** the `general.md`
  catch-all the Spec brief claimed. The Spec axis re-resolved and applied the correct card;
  no finding came out of it.

## Anchor

The A/B real-pi run recorded on #200: same model (`deepseek/deepseek-flash`), same prompt,
same harness, one run per arm, isolated `PI_CODING_AGENT_DIR`. Unpatched: the first
`codemode` script calls `tools["pi.dispatch"]` at sandbox level; the run executes
`ptc_run_code` 0 times — the model _is_ shown the nested-tool declaration (`declare const
tools: { ptc_run_code(…)`, in the transcript), so the gap was the connection, not the
silence — and it settles on `ptc_subagent` ×5. Patched: the first script calls
`tools.ptc_run_code` with the binding used inside the program — sandbox-level attempts 0,
executions 2, fallback 0. Transcripts `/tmp/spike200-base.jsonl`, `/tmp/spike200-run.jsonl`.
This round's fixes touch comments, tests and one ADR figure — no product behaviour — so the
anchor carries. The patched arm was re-run against the frozen `dist/`
(`/tmp/spike200-round1-anchor.jsonl`, exit 0, 46.8 s wall): the first script's
`tools["pi.dispatch"]` sits **inside** the inner program and the sandbox-level call is
`tools.ptc_run_code`; its result carries three `fulfilled` children, each with
`readOnly: "strict"`, and the run makes 0 `ptc_subagent` calls.

## Round 1 findings and dispositions

| #     | Axis      | Sev          | Finding                                                                                                                                                                                                | Evidence                                                                                                         | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----- | --------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1    | Standards | **blocking** | the working tree held 4 undeclared files — citation resyncs in `docs/research/**` and `docs/reviews/**`, +17/−17 — written by the host agent before the round                                          | `git status --porcelain` showed 10 modified files against a declared 6                                           | **FIXED by reverting them.** `tests/doc-integrity.test.ts:20-30` declares `docs/research/**` and `docs/reviews/**` **historical snapshots** whose `file.ts:123` is "correct when written, and drift is the expected behaviour, not a defect", and the #199 precedent re-pinned only gate-policed (normative) citations. (That file's header also records "240 of the repo's 248 `file:line` citations live in them"; round 3's re-count did not confirm that ratio — 2 178/1 827/87 raw across all docs — and the revert does not rest on it: the ground is the scope rule, not the count.) Counterfactual: the four files present in the tree (before) vs absent (after).                                                                                                                                                                                                                                                                                                                                                                                           |
| F3/S1 | both      | non-blocking | the note's content pin covered four tokens only; an inverted-but-token-complete rewrite stayed green, so the issue's positive half was unpinned                                                        | mutation run (below)                                                                                             | **FIXED, with a correction recorded by round 2**: three assertions added — `` `pi.dispatch` ``, `/reaches it by calling/`, `/using the binding inside the program/`. Counterfactual (a) **executed and re-quoted**: the constant becomes, in full, ``A `codemode` script cannot call the parallel binding directly: `pi.dispatch` is never in that script's own tool table, on any surface. A script sees `ptc_run_code` or `ptc_workflow` never in that script tool table either.`` → **one test red, two assertions red** (the first reported is `states the positive half: the way out is a call`), the four original assertions stay green. Counterfactual (b): dropping only the operative clause turns one red — `states where the binding is used: inside the program`. **Scope of the fix, per round 2:** these pins catch deletions and rewordings; a token-preserving inversion is _not_ caught (four paraphrases measured green), so polarity is anchored by the A/B run, not by this test. No further pins were added — chasing that class is unbounded. |
| F4    | Standards | non-blocking | the `common.ts` doc comment pointed at `docs/research/` (a directory), not at the record                                                                                                               | —                                                                                                                | **FIXED**: the comment now names `docs/research/dispatch-loop-e2e-spike-20261016.md`. No `file:line` was added, so doc-integrity assertion 4 is untouched.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| F5/S2 | both      | non-blocking | ADR-0024 records the registered `ptc_run_code` description at **672** estimated tokens; the note adds 242 characters (240-char sentence + separator) ≈ 61 tokens                                       | reconstruction from source reproduced the ADR's own note lengths (39/69/72/133) exactly, so only the note is new | **FIXED**: the ADR carries a dated paragraph now — ≈733 today, and the floor/ceiling bound the contract block alone, not the prose around it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| F2    | Standards | non-blocking | the `S1/A1/B3 parentTaskId` ledger row's two numbers point at the option-plumbing lines (`options: PtcRunCodeToolOptions = {}`), not the `parentTaskId` forward (`run-code.ts:201`, `workflow.ts:277`) | the same mismatch existed pre-diff at `:158`/`:258`                                                              | **recorded, not chased** — a snapshot imprecision that predates this diff; fixing it is ledger archaeology outside this change's scope.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

Closure discipline (AGENTS.md): a fix counts as closed only when reverting it turns a
**named** test red. F3/S1's counterfactual was executed and quoted above. F1, F4 and F5/S2
are documentation findings whose counterfactual is the before-state named in each row
(they are not test-visible by construction).

## Gate on the frozen tree

`typecheck` ✓ · `oxlint` 0 warnings / 0 errors ✓ · `fmt:check` ✓ · `build` ✓ · tests
**1303 passed / 6 skipped (1309), 74 files** ✓ · `verify:dist` **29/29** ✓ · coverage
91.19% stmts. `doc-integrity` 24/24 (assertion 4's baseline untouched — no new in-repo
`file:line` citation was added).

## Round 2 (delta over the round-1 fixes)

Reviewer: one read-only sub-agent, briefed adversarially. Delta reviewed: the three new
assertions, the comment reword, the ADR paragraph, this ledger. Findings: **1 blocking, 4
non-blocking** — all five in round 1's own output; the round-2 reviewer confirmed no
product file changed behaviour.

| #    | Sev          | Finding                                                                                                                                                                                                                                                           | Disposition                                                                                                                                                                                                                                |
| ---- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R2-1 | **blocking** | this ledger's mutation-(a) quote reproduced as six failing assertions, not one — the quoted string was a fragment (second sentence only, backticks dropped), so the recorded counterfactual could not be re-run as written                                        | **FIXED**: the mutation was re-run faithfully; the F3/S1 row now quotes the full constant and states "one test red, two assertions red". The correction is recorded, as AGENTS.md requires.                                                |
| R2-2 | non-blocking | the pins are closed for deletions and rewordings, but four token-preserving _inversions_ still pass; the test comment implied inversion was covered                                                                                                               | **FIXED by correcting the claim, not by adding pins**: the test comment and the F3/S1 row now say polarity is anchored by the A/B run. Judgement accepted — a fourth test-only round on a docs change is the anti-pattern AGENTS.md names. |
| R2-3 | non-blocking | the ADR paragraph's "≈733" was derived by addition from a figure that had itself drifted: measured live **2957 chars / 740 tokens**, without the note **2715 / 679** (not 672 — the 2026-10-13 bash-opt-in rewrite moved those lines); "moved once" was wrong too | **FIXED**: the paragraph now carries the measured numbers for both tools and says to re-measure rather than add.                                                                                                                           |
| R2-4 | non-blocking | this ledger said "7 files, +70/−1"; the tree was +73/−1 (measured before its own last edit)                                                                                                                                                                       | **FIXED**: stated as +73/−1 for the round-1 freeze; the tracked diff after round 2's own corrections is **+79/−1** (measured after the last edit this time).                                                                               |
| R2-5 | non-blocking | "`ptc_run_code` appears 0 times in the run" was false as written (30 string occurrences in the model-facing nested-tool declaration); the true claim is 0 _executions_                                                                                            | **FIXED**: the anchor paragraph now says "executes `ptc_run_code` 0 times" and records that the model _was_ shown the declaration — the gap was the connection, not the silence.                                                           |

Round-2 gate on the corrected tree: `typecheck` ✓ · `oxlint` 0/0 ✓ · `fmt:check` ✓ ·
`build` ✓ · tests **1303 passed / 6 skipped (1309)** ✓ · `verify:dist` **29/29** ✓.

Staging: at round-2 time the index held the pre-fix six files while the ADR paragraph, the
three assertions and the comment reword were unstaged and this ledger was untracked — a
plain `git commit` would have landed a tree none of these rounds reviewed. The deliverable
and this ledger are staged together now.

## Round 3 (verification of the corrected record)

Reviewer: one read-only sub-agent, asked one question — do the corrected claims reproduce?
Method note: it did not run vitest (that would rewrite `coverage/`) and measured the
registered descriptions through the real registration path (`node
--experimental-strip-types` importing `tests/helpers/ptc.ts`).

**All seven items reproduce**: the four description figures (2957/740, 2715/679, 242/61,
2698/675); mutation (a) → 2 red of 7 with the same first-reported assertion; mutation (b) →
1 red; the counts (+79/−1 for the seven tracked files, 168/−1 staged, and the +58/−1
opening figure recoverable byte-for-byte from dangling blobs); the anchor table (base 3/0/5
plus 30 string occurrences, patched 3/2/0, re-run 1/1/0 with three `fulfilled` `strict`
children); the four snapshot files identical to `HEAD`; and the round-2 table's five rows.
One sub-figure — "exit 0, 46.8 s wall" for the round-1 anchor — is bracketed rather than
exact: the transcripts record no exit code, and the file mtimes give ≈47 s.

Findings: **0 blocking, 2 non-blocking**, both record-only.

| #      | Sev          | Finding                                                                                                                                                                                            | Disposition                                                                                                                                                                                |
| ------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F-R3-1 | non-blocking | the F1 row repeated `tests/doc-integrity.test.ts`'s header count ("240 of 248") as fact; a re-count does not confirm that ratio (2 178/1 827/87 raw)                                               | **FIXED**: the row now attributes the figure to that file's header, records that round 3's re-count did not confirm it, and states that the revert rests on the scope rule, not the ratio. |
| F-R3-2 | non-blocking | the F3/S1 row quoted the full mutated constant inside a single-backtick span that contained backticks, so a reader copying from the rendered view got a different string than the one that was run | **FIXED**: the quote now uses a double-backtick span; its content is unchanged.                                                                                                            |

Round 3's own discipline note: every verdict was a reproduction, the two findings are record
polish, and a round whose remaining findings are record polish is a signal to stop.

## Stop

Stopped after round 3, by the repository's own conditions (AGENTS.md, "Stopping a review
loop"): rounds 2 and 3 produced **no change in product behaviour** — their fixes were a
comment, a test comment, an ADR figure and this ledger — and round 3's findings were
record-only. The round-1 anchor (a real A/B run) is green on the frozen artifact. A fourth
round would be a generator, not a detector.
