# Code review ledger: surface mode (ADR-0025)

Feature commit: `429f98c`. Round 1 is a review of that one commit; round 2 is a delta over
the fix commit that follows it. Two axes ran in parallel (Standards, Spec) over the same
range `001d702...429f98c`.

Both axes independently ran the whole-tree release gate and reported it green. That is
recorded here not as evidence of quality but as evidence of the gap: every blocking finding
below is a test that could not fail, and none of them made a single one of those 857 tests
turn red. A green suite and a test with teeth are different things, and the first round of
this change could not tell them apart.

| id     | sev      | finding                                                                                                                                                                                                                                                                         | disposition | closed by                                                                                                                                          |
| ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1     | blocking | The production read path `readSurfaceModeConfig(getAgentDir())` had NO test. `tests/helpers/ptc.ts` pinned `surfaceMode` unconditionally, so `options.surfaceMode === undefined` was unreachable from every test. Mutating the call to a hardcoded `"full"` left 857/857 green. | fixed       | `surfaceMode: "from-file"` escape hatch + 3 tests in `tests/extension.test.ts`                                                                     |
| S2     | blocking | `tests/tool-visibility.test.ts` spawned real pi with `...process.env`, so it inherited the developer's real `~/.pi/agent/ptc.json`. With a `surfaceMode: off` file set, 3/3 failed. The one test that could have caught S1 was the one the feature broke.                       | fixed       | probe writes a ptc.json and passes `PI_CODING_AGENT_DIR`                                                                                           |
| S3     | high     | `tests/unit/ptc-subagent.test.ts` shipped a fresh F2 (`if (message !== "") { expect }`) that `findF2` cannot see: its regex only matches `status                                                                                                                                | result      | response                                                                                                                                           | outcome` in the condition. | fixed | the accept-both was replaced by an unconditional spawn assertion |
| S4     | high     | The background-handle return was deletable in full and stayed green. `HANDLE_TEXT` had no assertion anywhere.                                                                                                                                                                   | fixed       | the spawn test now asserts `content[0].text` contains the id and `details.status`                                                                  |
| S5     | high     | `expect(h.deps.taskRegistry).toBe(h.registry)` compared two locals built by its own fixture. Mutating `getDispatchDeps?.() ?? {}` to `{}`, so background tasks would vanish from `ptc_task_list`, stayed green.                                                                 | fixed       | replaced by `h.lifecycle.spawned.length === 1` on a recording lifecycle                                                                            |
| S6     | medium   | A non-object `ptc.json` degraded to a silent default: the test asserted only the surface, never `source` or `error`. Mutating the branch to `source: "default"` stayed green.                                                                                                   | fixed       | the loop now asserts `source === "invalid"` and the message names the JSON object                                                                  |
| S7     | medium   | `findF2`'s keyword list is the hole S3 walked through.                                                                                                                                                                                                                          | OPEN        | a keyword-independent rule needs its own counterfactual run over 49 files before it can ship; not attempted in a fix commit                        |
| S8     | medium   | `.opencodereview/rules/ptc-bgdispatch-contract.md` item 9 stated the always-on registration rule with no `off` carve-out, so a future reviewer would raise a false blocker.                                                                                                     | fixed       | the rule now names the exception and cites ADR-0025                                                                                                |
| S9     | medium   | The F4 desync was half-fixed and the note recording the gap was itself false on arrival.                                                                                                                                                                                        | fixed       | `AGENTS.md` (both lists), the OCR rule, the fixture header and `docs/testing-constraints.md`                                                       |
| S10    | low      | "the eight test files" was four, in two comments.                                                                                                                                                                                                                               | fixed       | reworded                                                                                                                                           |
| S11    | low      | `sessionDir?` on `CreatePtcSubagentToolOptions` had no caller; the comment also claimed omission keeps the foreground shape, which it does not.                                                                                                                                 | fixed       | the option was deleted rather than wired                                                                                                           |
| S12    | low      | `AnyTool` was declared twice, byte-identical.                                                                                                                                                                                                                                   | OPEN        | importing the one in `ptc-task.ts` would couple the two tool modules; left for a separate change                                                   |
| S13    | low      | A test named "a surfaceMode key of null is absent, not invalid" wrote a file with no key at all.                                                                                                                                                                                | fixed       | renamed                                                                                                                                            |
| S14    | low      | `details.status = "background"` is a label outside ADR-0022's six-state vocabulary.                                                                                                                                                                                             | OPEN        | deliberately kept: the alternative is a handle whose `details` carries no status at all. Recorded here as a known vocabulary split                 |
| P1     | blocking | The ptc_subagent IO boundary had one direction. An always-refusing `execute` passed all 4 tests in the file and the full 857-test suite.                                                                                                                                        | fixed       | spawn direction asserted unconditionally                                                                                                           |
| P2     | blocking | The schema test compared the schema to itself: `tool.parameters` IS `DISPATCH_PARAMETERS`. Adding a field to `DispatchInput` left 4 passed.                                                                                                                                     | fixed       | a compile-time `SchemaKeys` vs `TypeKeys` assertion                                                                                                |
| P3     | major    | The agent fixture was a developer file, not one pi ships. With a fresh `HOME` the depth test silently took the unknown-agent path.                                                                                                                                              | OPEN        | the host registry does not see a markdown written into a temp dir, so a project-scoped fixture is not available; recorded rather than papered over |
| P4     | major    | ADR-0025 cited a prompt-byte figure that appears in no file in the repo except that one line.                                                                                                                                                                                   | fixed       | the number was removed from the record and from the derived CONTEXT.md sentence                                                                    |
| P5     | moderate | A malformed file produced two byte-identical warnings, one from each reader parsing the same file.                                                                                                                                                                              | fixed       | the surface error is reported only when it differs from the mode error                                                                             |
| P6     | moderate | The `off` briefing assertion was made by handler count, which cannot distinguish no-handler from a-handler-that-injects-nothing.                                                                                                                                                | OPEN        | behaviour is verified by runtime probe; the stronger assertion is not written                                                                      |
| P7     | moderate | ADR-0025 decision 6, a one-sentence brief per surface, is implemented by a second-order route, not as written.                                                                                                                                                                  | OPEN        | the record should be amended to describe the route actually taken                                                                                  |
| P8-P11 | low      | No renderer on `ptc_subagent`; `callId: 0` hardcoded; `options.surfaceMode` a seam the spec never asked for.                                                                                                                                                                    | OPEN        | outside the spec's scope, recorded                                                                                                                 |

## Counterfactuals re-run after the fixes

Each of these was executed, not reasoned about. A cell that says green is a finding that was
still open at the time it was measured.

| mutation                                                      | before                      | after                    |
| ------------------------------------------------------------- | --------------------------- | ------------------------ |
| the factory's read of the agent dir -> a hardcoded full       | 857 of 857 green            | 1 failed                 |
| `execute` throws unconditionally, a tool that can never spawn | 4 of 4 green                | 2 failed                 |
| a field added to `DispatchInput` only                         | 4 passed, build clean       | build error              |
| the background-handle return deleted from `subagent.ts`       | green                       | the spawn test now fails |
| `PI_CODING_AGENT_DIR` holding a surfaceMode off file          | 3 failed in tool-visibility | 3 passed                 |

## Still open, and why it was not fixed in this commit

- **P3**: the depth and concurrency paths have no test that reaches them. They need a real pi
  install and a real registered agent, which is exactly the seam `tests/tool-visibility.test.ts`
  already owns. The honest next step is a probe extension, not another mock.
- **S7**: the F2 detector's keyword list. Widening it needs a false-positive count over 49 test
  files first, per the rule that ships in this repo: a checker that cries wolf on real files is
  worse than no checker.
- **P7**: ADR-0025 decision 6 describes a brief the code does not write. Either implement it or
  amend the record; a record that describes a mechanism the code does not have is worse than one
  that never claimed it.

## Round 2 (delta `429f98c...d1c2824`, then the fix commit below)

Both axes re-ran the round-1 counterfactuals rather than reading the rows. Round 1's three
blocking closures **VERIFIED**: S1 (hardcoded surface -> red), P1 (always-refusing tool -> 2
red), P2 (a type-only field -> build error). P5 and S2 verified at the seam the reviewer could
reach, with the note that `ctx.ui.notify` emits nothing in `--print`, so the real-pi variant
of that check does not exist.

### R2-1 [HIGH, FIXED] the S1 fix introduced a regression

Making the stub's pin conditional turned an unspecified surface into a real read. With
`PI_CODING_AGENT_DIR` holding `surfaceMode: off`, the full suite went from **4 failures at
`429f98c` to 31** across seven files. The pin is unconditional again, except for the explicit
`from-file` escape hatch, and `tests/unit/extension-background.test.ts` -- which calls
`ptcSubagents(api)` directly rather than through the stub -- now pins too. Re-measured: **856
passed** with the hostile dir, same as with a clean environment.

Lesson worth keeping: a seam added to make one path observable must not become the default for
every other path. The pin is the default; the escape hatch is the exception.

### R2-2 [HIGH, OPEN] foreground `ptc_subagent` has no concurrency gate

`src/runtime/dispatch.ts:1020` is the only `tryAcquire` in the dispatch path and it is inside
the **background** branch. The one foreground gate is `src/runtime/dispatcher.ts:698`, which
belongs to the program call site; `ptc_subagent` calls `dispatch()` directly and bypasses it.
Measured: a foreground call with every slot held proceeds instead of being refused.

This violates issue #88's testing decision (a refusal that does not -- depth exceeded,
**concurrency saturated**, unknown agent) and ADR-0025's Consequences (the depth and
concurrency rules are enforced in one place, which is the point of decision 7). It is a
defect in the pre-existing `dispatch()` contract that a new call site exposed, not something
this change introduced -- but this change is what made it reachable.

**Not fixed here, and that is a judgment call worth reviewing.** The fix is to move the
foreground acquire into `dispatch()` and drop the dispatcher's duplicate, so one owner gates
the rule. That is a hot-path refactor of the slot accounting for both call sites at once, and
doing it at the end of this change without the ability to run the benchmark again would trade
a recorded defect for an unmeasured one. The diagnosis and the recommended fix are both
specific enough to act on.

### R2-3 [MEDIUM, FIXED] the F4 sync claim was itself wrong

`docs/testing-constraints.md:151` said the sync was complete while the line above it still
said the OCR rule carries F1/F2/F3, and three more sites (`test-discipline.md`'s missing F4
section, `test-discipline-oracle.md:45,51`, `general.md:169`) still list F1/F2/F3 only. The
paragraph now names each site and says which are done and which are deliberately not: the F4
section in `test-discipline.md` would have to cite an instance, and the only real one so far
is this ledger.

### R2-4 [MEDIUM, FIXED] deleting `sessionDir` orphaned its JSDoc and erased a real divergence

The comment then stacked on `getDispatchDeps`, still claiming "absent keeps the foreground
shape", which is not what absence does. Removing it also removed the only written trace of a
real behavioural difference: the binding forwards `context.sessionDir` into the DispatchContext
(`bindings.ts:303` to `dispatcher.ts:739`), so `pi.dispatch` background children get
ADR-0022's R1 session triple and `ptc_subagent` background children do not. The extension
does hold the dir at session start (`src/index.ts:522`), and a value-typed option could never
have carried it -- only a getter could. Recorded here rather than wired, because wiring it is
a behaviour change to background children that belongs in its own commit.

### R2-5 [LOW/MED, FIXED] the recording kept the handle and dropped the request

`RecordingLifecycle` stored only the `ChildHandle`, so two plausible-wrong implementations
stayed green on the full 860-test suite: dropping the `parentTaskId` spread, and running the
child in `process.cwd()` instead of the call's cwd. The same shape S5 flagged, in new
clothing. It now records `(argv, opts)`, and the spawn test asserts the child's cwd and that
the registry record's `parentTaskId` is the process's own task. Both mutations are red; the
parent one was re-measured after the fix at **1 failed**.

### R2-6 to R2-10 [LOW, FIXED]

`CONTEXT.md` still carried the derived `340 extra prompt bytes` after P4 removed the absolutes,
so P4 was half-closed on its own criterion. The ADR sentence P4 edited was left ungrammatical
-- `fmt:check` does not cover `.md`, which is why it took two review rounds to die. A dead
dynamic import shadowed a static one. `stubFromAgentDir` leaked its temp dir. The
`surfaceMode` option added to `capturePayload` had no caller and is left in place, unused,
because deleting it would remove the seam a future probe test needs.

### The meta-discipline fixture and the compile-time assertion

`_SchemaMatchesType` sits at module scope, so `findF4` never sees it and the fixture agrees
(5 passed, 49 files). It has **no runtime witness**: neither vitest nor the meta fixture can
observe it, so it exists only inside `tsc --noEmit`. That is sound here because typecheck is
the first step of the release gate, and the mutation proves it bites, but it should not be
described as a test.
