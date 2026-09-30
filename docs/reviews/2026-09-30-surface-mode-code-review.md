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

## Round 3 (delta `c108b7e...7f05d3e`, fix commit `846aee6`)

Round 3 covered the codemode-detection change, and the feature commit is part of this record's
scope: it is the change whose default flip made R2-2 reachable in the first place. Both axes ran
the whole-tree release gate independently and reported it green. Every blocking finding below is
a test that could not fail, or a promise a record made that the code did not keep -- the same two
shapes as rounds 1 and 2.

### R3-1 [BLOCKING, FIXED] foreground `ptc_subagent` had no concurrency gate

Carried from R2-2, which round 2 recorded rather than fixed. The Spec axis measured it rather
than reading the ledger: with every slot held, a foreground call **reached the spawn site** and
reported `failed to spawn pi: spawn pi ENOENT`, not a concurrency refusal. Depth and background
gates fired in the same harness, so this was a true negative and not a blind spot.

The gate moved into `dispatch()`'s foreground branch and the dispatcher's duplicate went away.
Keeping both would have charged every foreground dispatch two slots -- `tryAcquire` has no dedup
for the anonymous form -- and halved effective concurrency. The foreground reservation is
anonymous because a keyed holder would be actively wrong: `createPtcSubagentTool` hardcodes
`callId: 0`, so two concurrent calls would share a token and the second would refuse spuriously.

Counterfactuals, both measured: gate removed -> 1 failed; pre-spawn release removed -> 1 failed.
The second is the one worth having -- a missing release there would not fail any single-call test,
it would just shrink the pool until a session slowly stopped being able to dispatch.

**Stated consequence, not a side effect — and, as first written here, mis-cited.** The program
path's foreground calls now spend the session counter rather than a per-run one, so two concurrent
programs that could each have 8 in flight share 8. The suite is green, but this is a real reduction
in effective foreground concurrency and it belongs in the record rather than in a reviewer's memory.

> **Round 4 correction (DOC-TRUTH).** The original text said this "is what ADR-0022 §9 already asks
> for". It does not. §9 was titled _Concurrency and depth caps: unchanged from ADR-0016_ and said
> nothing whatever about counter scope, and the ADR it names as unchanged says the cap is
> **per-run** — the opposite of what happened. The claim removed a real trade-off behind a citation
> that could not support it. §9 is retitled and amended, and ADR-0016 §2 carries a round-4 amendment
> of its own.

> **The decision, on its own merits.** One cap with one owner beats two counters that can disagree.
> Before this change the session held two notions of "how many pi subprocesses is this session
> running" — a per-run one for the program path and a session one for background — and nothing
> reconciled them, so the two could each be individually correct and jointly wrong. The move into
> `dispatch()` makes `dispatchConcurrency` a number about a session rather than about a run, which
> is also the only reason the knob now provably works: the counter that enforces the cap is the one
> built from the value, so setting the value changes the behaviour (measured: 2 → 2, where the
> session counter previously ignored the setting entirely).
>
> **What it costs, measured rather than asserted.** 24 concurrent foreground calls against a real
> fake-`pi` spawn, before vs after:
>
> | scenario                                                    | before                              | after                                          |
> | ----------------------------------------------------------- | ----------------------------------- | ---------------------------------------------- |
> | (a) one program, 24 concurrent foreground                   | 8 spawned / 16 capped               | 8 / 16 — unchanged                             |
> | (b) two concurrent programs, 24 each                        | 8 + 8 = 16                          | 8 total                                        |
> | (c) 8 live background children + one program, 24 foreground | 8 foreground spawned (16 in flight) | 0 foreground spawned (8 total, all background) |
> | `runPtcProgram({config:{dispatchConcurrency:2}})`           | 2 spawned                           | 8 — the setting stopped taking effect          |
> | `createBackgroundTaskRuntime({concurrency:2})`              | ignored                             | 2 — the only live control                      |
>
> The original paragraph cited only the (b) shape. Row (c) is the one a reader needs and it is the
> one the first account left out: a program sharing a session with eight live background children
> can be refused **every** foreground slot, and the refusal is a hard reject with no queue, so
> nothing waits. Row (a) is why this survived three review rounds — the common case did not move.
>
> **One row of this table is not settled, and the corrected documents do not lean on it.** The
> `runPtcProgram({config:{dispatchConcurrency:2}})` row reads "2 configured, 8 dispatched", but a
> static read of the wiring does not obviously produce that: `dispatcher.ts:709` hands the binding
> `options.dispatchDeps?.slots ?? dispatchSlots`, and `dispatchSlots` IS built from
> `config.dispatchConcurrency` — so a `runPtcProgram` call passing no `dispatchDeps` should still
> get 2. The 8 is what `dispatch()` falls back to (`FALLBACK_DISPATCH_SLOTS`, `dispatch.ts:120`)
> when it is handed no `slots` at all, which is a direct `dispatch()` call, or a `ptc_subagent` call
> made without deps. The doc half therefore states the _mechanism_ — the session counter is supplied
> ahead of the per-run one, so a `runPtcProgram` override sizes a counter a pi session never
> reaches — rather than this row's number, and the row is left here as this review's own record.
> Whoever owns the next harness run should re-derive it and say which call site produced the 8.

### R3-2 [BLOCKING, FIXED] the one end-to-end proof of the headline feature was vacuous

Both axes found this independently, and the Standards axis falsified the test's own comment with
a mutation: neutering the probe (`CODEMODE_PROBE_PATHS = []`) left it **passing**. The comment
said "if the probe stops working, the two runs agree and this goes red"; the code asserted the
opposite, because when the runs agreed it re-asserted the sibling test's expected set.

The fix agent then found the reason the test could never have caught it, which also corrects the
review's premise: **the pi the e2e suite spawns is the repo's own pinned 0.86.1 from
node_modules/.bin, not the user's 0.99.1**, and 0.86.1 ships no codemode at all. The subagents
branch had never been reached -- not in CI, not anywhere. A registry oracle measured against that
pi is permanently stuck on the "no codemode" side, which is why the first cut of the fix also
passed under the mutation.

The test now asserts against pi's own registry (a second probe extension reads `getAllTools()` at
`session_start`) and pins both branches on two different pis. Measured after: neutered probe ->
1 failed; probe forced to always-present -> 1 failed on the sibling.

### R3-3 [HIGH, FIXED] four tests inherited the machine, and their names asserted a replaced rule

The malformed-file cases called `readSurfaceModeConfig(dir)` with no presence argument, so the real
probe ran against vitest's argv. Change the default argument to `present: true` and all four go
red. Their names -- "falls back to full" -- directly contradicted ADR-0026 decision 5, which
replaced the constant with the detected default. Presence is now passed explicitly in each, both
branches are asserted, and the names match the record.

### R3-4 [HIGH, FIXED] a new e2e test timed out twice

The only test in its file without a timeout override, doing two real pi spawns on vitest's 5000 ms
default. Measured 4400 ms under parallel load, with `Test timed out in 5000ms` observed twice. All
five tests in that file now carry `120_000`. This also explains a delta a reviewer saw in a
hostile-agent-dir comparison and correctly declined to call a settings leak.

### R3-5 [MEDIUM, FIXED] production and doc drift

The probe result was carried on `SurfaceModeConfig.codemode` and read by nothing, so the ADR's
stated remedy for the silent-fallback failure mode was unwired -- it now reports at session start,
silent on the healthy case. `FALLBACK_SURFACE_MODE` was a dead export whose comment claimed
callers; it is now `detectedSurfaceMode`'s false branch, because the new notice has to name the
resolved default. The `presence` default parameter was eager, so the probe ran even when the user
had set the key -- measured, one `argv[1]` read before and zero after. And several comments, a
CHANGELOG line that still called `full` "the default" twenty lines below the entry that changed
it, and two `loader.js` line citations that pointed at jiti setup rather than the
`initializeExtension` catch.

### R3-6 [MAJOR, FIXED] the probe cannot see the two ways pi withholds a tool it has on disk

Found by accident, by the agent fixing R3-2, and it is a hole in the feature's core design rather
than a test defect. The probe walks the filesystem, so under `--no-extensions` or
`--exclude-tools codemode` it answers `present`, the surface becomes `subagents`, and pi
registers no such tool -- a subagent front with no orchestrator. The ADR-0025 decision-4 warning
cannot catch it: it asks whether codemode is ACTIVE, and with the tool absent both questions are
false for the same reason.

`session_start` now cross-checks the filesystem answer against `pi.getAllTools()` -- the one place
both are available, since the listing is a `notInitialized` stub during loading -- and warns when
they disagree. Counterfactual: forcing the registry check to always pass turns the new test red.

### Still open after round 3

- **S7 / R2-1 shape**: `findF2`'s keyword list cannot see `if (message !== "") { expect }`. The
  test that had it is fixed; widening the detector needs a false-positive count over 49 files
  first, per the rule that ships here.
- **R2-4**: a `ptc_subagent` background child gets no ADR-0022 session triple, because the
  binding forwards `context.sessionDir` into the DispatchContext and this tool does not. Wiring
  it is a behaviour change to background children and belongs in its own commit.
- **`src/index.ts:381`**: the always-on registration comment claims the tools survive every mode
  loadout. True for `builtins-only`, false for `all-but-ptc`, which is not the shipped strategy.
- **Issue #88's body** still states the pre-ADR-0026 defaults in four places.

## Round 4 (delta `846aee6...HEAD`, docs-only fix pass)

Round 4 is a **DOC-TRUTH** round: the code side of the concurrency-gate change is being fixed in
`src/index.ts` and `src/runtime/dispatch.ts` by another agent, and this pass is the documentation
half. The theme is the same in both halves — a measurement exists that the shipped documentation
does not reflect, and one record cites another record for a claim that record does not make. Each
row below names the file and line it was found at and the line the fix landed on, so the next
round does not have to re-derive them.

| id   | sev      | finding                                                                                                                                                                                                                                                                                                                                                                                                                    | evidence                                                                                                                                                                                                                               | disposition                                                                                                                                                                                                                                                             |
| ---- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R4-1 | blocking | Ten shipped lines state the cap is **per-run**. `docs/adr/0016-ptc-dispatch-binding.md` §2 ("the 9th concurrent `pi.dispatch` from one run"), `docs/adr/0022-background-dispatch.md` §9 and "deliberately don't add" 2, `docs/adr/0025` item 1 and Consequences, `docs/usage/bgdispatch.md` Limits, `README.md:77` and `:114`, `CONTEXT.md:231,247`, and the `dispatchConcurrency` doc comment in `src/runtime/limits.ts`. | The gate moved into `dispatch()`, so one session counter now serves every front. Measured rows (a)-(c) in the R3-1 correction above.                                                                                                   | **fixed** — ADR-0016 §2 + a round-4 amendment; ADR-0022 §9 retitled and amended; ADR-0025, bgdispatch Limits, README, CONTEXT and the `limits.ts` comment all rewritten.                                                                                                |
| R4-2 | blocking | R3-1 cited ADR-0022 §9 for a claim §9 does not make.                                                                                                                                                                                                                                                                                                                                                                       | §9 is titled _unchanged from ADR-0016_ and is silent on counter scope; ADR-0016 §2 says **per-run**.                                                                                                                                   | **fixed** — the R3-1 paragraph carries an explicit round-4 correction, the decision is restated on its own merits, and the full measured table replaces the one shape the first account cited.                                                                          |
| R4-3 | high     | The knob is named in no document.                                                                                                                                                                                                                                                                                                                                                                                          | `createBackgroundTaskRuntime({concurrency})` is the only construction of the live counter (`src/index.ts`, `src/runtime/background-runtime.ts:505`); `grep -c` over `docs/`, `README.md` and `CONTEXT.md` returned 0 before this pass. | **fixed** — named in the README dispatch section and in `docs/usage/bgdispatch.md` Limits, both stating that it governs both fronts, not background alone.                                                                                                              |
| R4-4 | blocking | ADR-0026 called the `ui.notify`-is-TUI-only problem "inherited rather than introduced". True of the ADR-0025 decision-4 warning, **false** of the two notices ADR-0026 itself adds.                                                                                                                                                                                                                                        | 0 bytes on stdout and 0 on stderr across three `--print` runs that each emit one.                                                                                                                                                      | **fixed** — ADR-0026 Consequences and the README now state that the gap is new, give the measurement, and name where a `--print` user actually meets it (this README is the only channel).                                                                              |
| R4-5 | medium   | ADR-0026 has no numbered decision for the `session_start` cross-check against `pi.getAllTools()` — the fix for the `--no-extensions` hole R3-6 found — and Consequences says the probe result "is read exactly once" when there are two readers.                                                                                                                                                                           | R3-6's fix landed in `src/index.ts`; ADR-0026 decisions stop at 7.                                                                                                                                                                     | **fixed** — added as **decision 8**, Consequences corrected to two readers, and `--no-extensions` added to the README's "Where it does not run" list (it is the one flag that actually yields a subagent front with no orchestrator).                                   |
| R4-6 | medium   | `docs/research/ptc-binding-contract-re-measurement-20260930.md` records 2 median turns and an 8,360 median context cost with no note that its _after_ arm predates the cap move.                                                                                                                                                                                                                                           | The note's own limitations list covers correlation and the overwritten before-sessions, but not this.                                                                                                                                  | **fixed** — a note added saying the numbers were taken before the cap moved, that the recorded mechanism involves no fan-out, and that whether any of the eight tasks fanned out at or above the cap is unrecorded. The numbers are neither restated nor reinterpreted. |
| R4-7 | medium   | ADR-0026, `README.md:214-220` and this ledger all assert the user **sees** the notice.                                                                                                                                                                                                                                                                                                                                     | A pty capture showed neither the notice nor a control marker. The TUI quits on stdin EOF before a toast paints, so the reviewer's harness is the limitation rather than the code — unproven, not refuted.                              | **weakened, mechanism kept** — the claims now say the notice is issued through the documented TUI channel and that no test observes it end to end through a real TUI. Nothing deleted.                                                                                  |

### Still open after round 4

- **R4-7, unclosed by design.** "A user sees the surface-mode notice in a real pi TUI" is now
  recorded as unmeasured rather than fixed. Closing it needs a harness that holds stdin open long
  enough for a toast to paint; that is a test-writing job, not a docs job, and the honest state of
  the claim is now written down in three places.
- **R4-1 / R4-2, second consumers swept — one stale citation left, and it is out of scope.** A
  repo-wide sweep for the per-run claim across `docs/`, `README.md` and `CONTEXT.md` found no
  further normative statement to correct: `docs/specs/0020-0021` says nothing about concurrency,
  `docs/agents/` is about tooling, and every remaining hit is either an amendment this pass wrote
  or a historical snapshot that is correct as a record of its time
  (`docs/reviews/2026-09-24-bgdispatch-code-review.md` R-M3). The one file still describing the old
  wiring is **`.opencodereview/rules/ptc-config-wiring.md:43`**, which lists `dispatcher.ts:455`
  among the read points of `dispatchConcurrency`; the session counter is supplied ahead of that one,
  so the row overstates where the value is read. Reported, not edited — it is outside this pass's
  write scope. Its sibling `ptc-bgdispatch-contract.md:56` already requires the quota to be
  session-scoped, so the rules do not contradict the corrected records; they carry one stale
  citation between them.

## Round 4 (delta `7f05d3e...846aee6`, fix commit below)

Round 4 reviewed the round-3 fixes. Both axes ran the whole-tree gate independently and reported
it green. Two of the three blocking findings were **regressions the round-3 fix introduced**, which
is the fourth time in five rounds that fixing a false pass produced a new one. Both were found by
mutation, not by reading.

### R4-1 [BLOCKING, FIXED] the fix for the missing gate introduced a slot leak

The new acquire sits before an `await writePromptToTempFile` and a `buildArgv` that can both
throw, and neither path reaches the Promise whose `finalize` is the one release. Measured against
the pre-round-3 base: a TMPDIR pointed at a file (mkdtemp -> ENOTDIR) left `slots.active` at 1
where the old dispatcher's unconditional `finally` returned it. The rejection is pre-existing; the
**leak** is new, and the severity driver is that this counter is the SESSION one -- eight such
failures and the session can never dispatch again. That is the same class of bug R4-1's own fix
was for, which is the part worth remembering: the region between an acquire and its release owns
its own cleanup, and adding a release in one place does not add one in the others.

### R4-2 [BLOCKING, FIXED] the e2e proof was vacuous again, on a whole class of machines

Round 3's replacement asked pi's own registry, which was right. But `findRealPi()` returned the
first executable named `pi` outside a `node_modules/.bin`, without checking it was a pi or that it
had codemode. Measured: probe neutered AND a no-codemode pi first on PATH -> the test still
**passed**; a stray non-pi executable named `pi` first -> it failed in 89 ms blaming the harness.
The comment's claim that the fallback "is not a skip" held for `undefined` and not for a
successfully resolved wrong binary.

The fix surveys the candidates and keeps the first that answers `hasCodemode: true` from its own
registry; a candidate that cannot answer is recorded and stepped over, so it can no longer decide
the answer by being first. With no codemode pi anywhere the subagents half is `skipIf`'d with a
named reason and the full-surface half still runs.

### R4-3 [BLOCKING, FIXED] a `[FIXED]` row with nothing holding it

R3-1 claimed the dispatcher's duplicate gate "went away" was fixed. It was not: re-adding a
foreground acquire at the call site left the **full suite green**, and so did restoring the exact
pre-round-3 split. Structurally the dispatcher-level tests drive a stand-in binding and never see
`dispatch()`'s acquire, while the subagent tests bypass the dispatcher.

Now a black-box test: a real program, the real binding, `dispatchConcurrency: 4`, six concurrent
foreground dispatches. HEAD admits 4 and launches 4 children; the duplicate restored admits 2 and
the whole suite goes red at exactly that test. The round-3 `[FIXED]` was an over-claim and this
row is the first thing in the ledger to say so about itself.

### R4-4 [BLOCKING, FIXED] ten shipped lines stated the old cap, and a record mis-cited another

Measured before/after with a real spawn: one program is unchanged at 8; two concurrent programs go
16 -> 8; a program sharing a session with 8 live background children goes from 8 foreground
spawned to **zero**. That last one is not a rounding difference, and ten lines across ADR-0016,
ADR-0022, ADR-0025, `docs/usage/bgdispatch.md`, README and CONTEXT still said the cap was
per-run. All corrected, with the table.

The R3-1 line "that is what ADR-0022 §9 already asks for" was a mis-citation: §9 is titled
"unchanged from ADR-0016" and says nothing about counter scope, and the ADR it names as unchanged
says the cap is per-run. The decision now stands on its own merits -- one cap with one owner
cannot disagree with itself -- and the mis-citation is recorded as one rather than quietly fixed.

**A correction to that finding, and it matters.** The review reported `dispatchConcurrency: 2`
granting 2 before and 8 after, i.e. a dead knob. That is a half-truth: there is no session-level
source for this key at all. `resolveConfig` takes a programmatic override, `runPtcProgram({config})`
is a library option, and the extension never passes one -- so in a session the value was 8 before
and is 8 after. What changed is that the number now comes from one place instead of two. A library
caller that does pass a config has its per-run counter shadowed by the session counter, and that
shadowing is the decision rather than an accident. The normative docs state the mechanism; the
disputed number stays in the ledger with the discrepancy spelled out.

### R4-5 [BLOCKING, FIXED] the `--print` gap is new here, not inherited

ADR-0026 called the `ui.notify`-is-TUI-only problem "inherited rather than introduced". True of
the ADR-0025 decision-4 warning; false of the two notices this feature adds. Measured: 0 bytes on
stdout and 0 on stderr across three `--print` runs that each emit one. For a print user the README
is the only channel, and that is now stated where they meet it.

### R4-6 [MEDIUM, FIXED] the mirror case the cross-check missed

The `getAllTools()` cross-check handled the over-estimate (`--no-extensions`) and not the
under-estimate: a pi that restructures its `dist` answers `not-found` while pi plainly registers
codemode, and the session then registers our orchestrator _beside_ a live one -- the exact
duplicate surface this setting exists to remove -- under an `info` notice calling it "the safe
direction, not an error". Both directions are handled now; counterfactual forces the check to
always pass and the test goes red.

### Also closed

A vacuous `spawnCount` assertion (the foreground path never touches the injected mock) replaced by
a real recording-`pi` count plus the contrast case that makes the count mean something, and a
third mutation -- a "late gate" that returns the right refusal but spawns first -- that catches a
bug the first two would not. The stub gained a way to express registered-but-inactive, which is
the state `codemode` actually ships in. Two stale comments in `dispatch.ts` and two doc claims no
test observes were weakened to what is established.

### Still open after round 4

- The foreground branch spawns through a module-level lifecycle, so its spawn cannot be injected;
  the tests observe a real child process through a recording `pi` on PATH instead. The production
  seam (`deps.lifecycle ?? DISPATCH_LIFECYCLE` in the foreground branch too) is a one-line
  change that would make those tests fast and PATH-free, and it is not taken here.
- No test observes either notice end to end through a real pi TUI. A pty capture showed neither the
  notice nor a control marker -- though the TUI quits on stdin EOF before a toast paints, so the
  reviewer's harness is the limitation, not the code. Recorded as unverified rather than as a claim.
- `findF2`'s keyword list still cannot see `if (message !== "") { expect }`; the test that had it
  is fixed, widening the detector needs a false-positive count over 50 files first.
- A `ptc_subagent` background child gets no ADR-0022 session triple, because the binding forwards
  `context.sessionDir` and this tool does not. Wiring it is a behaviour change to background
  children and belongs in its own commit.
- `.opencodereview/rules/ptc-config-wiring.md:43` still lists the dispatcher's per-run counter as
  a read point of `dispatchConcurrency`; the session counter is supplied ahead of it.
- `src/index.ts:381`'s always-on registration comment claims the tools survive every mode loadout
  -- true for `builtins-only`, false for `all-but-ptc`, which is not the shipped strategy.
