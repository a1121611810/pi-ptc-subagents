# Re-measurement: does the binding contract remove the shape errors?

Date: 2026-09-30. Closes the debt recorded in ADR-0024 section "Known limitations" and
tracked as issue #87.

## What was measured, and against what

The harness itself lives outside this repository, as the parity audit's does: it is a pty
driver plus a scoring oracle, not a project artefact. The numbers below are quoted in full so
this note stands without it; re-deriving them needs the harness and a live pi install with
credentials.

The same pty-driven TUI harness (`bench_tui.py`), the same eight tasks, the same two reps,
the same scoring oracle. Two arms only: `tui-ctl` (pi alone) and `tui-ptc` (pi with this
extension, `/ptc on`, the narrowed loadout). 16 runs per arm, 32 total.

The third arm from the first report, `tui-cmonly`, is deliberately not repeated. It was already
shown to be a mislabelled duplicate of `cm-on` rather than a separate condition, and repeating a
cell that is not a real cell would only pad the table.

**Precondition checked before the run:** the contract text is present in the built
`dist/index.js` that the harness loads. An earlier probe reported it missing; that was a
case-mismatched probe against text assembled from a lines array, not a build problem. The
verbatim block was dumped out of `dist/index.js` and confirmed.

## Result

| metric                 | arm         | before            | after   |
| ---------------------- | ----------- | ----------------- | ------- |
| exact match            | tui-ctl     | 15/16             | 13/16   |
| exact match            | tui-ptc     | 10/16             | 11/16   |
| mean f1                | tui-ctl     | 0.994             | 0.913   |
| mean f1                | tui-ptc     | 0.886             | 0.922   |
| context tokens, median | tui-ctl     | 7,490             | 9,747   |
| context tokens, median | tui-ptc     | 36,669            | 8,360   |
| wall clock, median     | tui-ctl     | 18.5s             | 17.8s   |
| wall clock, median     | tui-ptc     | 35.1s             | 20.0s   |
| turns, median          | tui-ptc     | 8                 | 2       |
| cost, arm total        | tui-ptc     | $0.1101           | $0.0407 |
| **shape errors**       | **tui-ptc** | **31 in 16 runs** | **0**   |

## Reading it honestly

**What the data supports.** The measured crash classes are gone. `files is not iterable`,
`content.split is not a function` and `content.slice is not a function` each appear in 0 of 16
runs after, against 5, 2 and 2 occurrences before. The correct access pattern
`result.content[0].text` appears in 16 of 16 runs. The context cost of PTC mode fell from a
36,669 median to 8,360 -- a 77% reduction -- and median turns from 8 to 2, which is what one
would expect if programs stopped needing a repair turn per shape mistake.

**What the data does not support.** A quality improvement. Exact match went 10/16 to 11/16, and
the control arm moved 15/16 to 13/16 in the same window. A one-run move in each direction is
inside the noise this harness produces, and 16 runs per arm is not enough to resolve a single
task either way. The honest statement is that crashes were eliminated and the cost of using
PTC mode collapsed; the quality claim stays unmade.

That the control arm also drifted is the reason this is not written as a clean win. Control
context rose 30% and control f1 fell, with nothing in the control arm changed. Treat +/-2 exact
matches and +/-30% context as the yardstick for anything read out of this table.

**The one remaining program failure is not a shape error.** In `tui-ptc-T3-0` the model wrote a
bootstrap shim mapping binding names to `globalThis['tool_' + n]`, which does not exist, and
crashed with `globalThis[n] is not a function`. That is pitfall #1 -- a name that is not a
builtin -- which the tool description already warned about, and the run recovered and scored
exact. It is counted as a program failure but not as a shape error.

**One residual wrong-field access.** `tui-ptc-T4-0` wrote `(grep.matches || [])`. The wrong field
is still in the model's head, but it was written defensively and did not fail the run. This is
the clearest evidence that what changed is the consequence of the mistake, not the mistake.

## Limitations of this measurement

- **Correlation, still.** This is one change and one re-run against a recorded baseline, with no
  seed control and 16 runs per arm. The mechanism is visible in the programs themselves -- they
  now use the declared shape and stop -- which is stronger than a bare correlation, but a single
  arm cannot separate the contract's effect from anything else that moved between the two dates.
- **The before sessions were overwritten.** The harness reuses one home directory per
  arm/task/rep and wipes it, so re-running the same cells replaced the recorded sessions. The
  before crash count above is the one recorded in the first report, not a re-count through the
  script used for the after column. A same-session re-count of the baseline is not possible
  without re-running the pre-change build, and this record does not claim otherwise.
- **Cost is a real number here only in the sense that both arms were priced the same way.** The
  pty runs share a provider and a model; the dollar figures are the session's own accounting.
- The harness scores a final answer against a ground truth per task. It does not measure whether
  a program was _elegant_, only whether the run got the right answer.
- **The `after` arm predates the move of the dispatch concurrency gate.** Both arms above were
  taken while `dispatchConcurrency` was a per-run cap enforced at the dispatcher's call site. A
  later change (review round 4) moved the acquire into `dispatch()`, so that one session counter
  now serves foreground and background alike. The numbers in this note are not re-read here and
  nothing in them is retracted; this is a timing fact, not a re-interpretation. What it leaves
  unrecorded: **the note observes no fan-out either way.** The mechanism it does record — programs
  adopting the declared result shape and stopping — involves no `pi.dispatch` fan-out, so the gate
  move has no path into the measured effect. Whether any of the eight tasks issued enough concurrent
  dispatches to reach the cap at all (that is, whether any single program had 8 or more `pi.dispatch`
  calls in flight) is **not recorded** in this note or observable in the numbers above. A reader
  treating the table as post-gate evidence is reading it as something it is not; a reader wanting to
  know whether the gate can explain any part of the collapse still has to go measure it.

## What this does to ADR-0024

The record's Known limitations said: "Nothing here measures whether the model _uses_ the
declaration... until it lands, this record's claim is that the text is correct, not that it
helped." That is now answered, and the reopen trigger for runtime flattening is not met: the
crashes the flattening was meant to prevent did not persist once the shape was declared.

The trigger in the record reads "if the re-measurement shows crashes persist despite a correct
declaration". They do not persist. The flattening decision stays deferred.
