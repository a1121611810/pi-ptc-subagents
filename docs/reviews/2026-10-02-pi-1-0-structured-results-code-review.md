# Review rounds 1-2 — pi 1.0.0 upgrade + codemode structured results

Date: 2026-10-02. Fixed point: `9384dbf` (v1.2.1), all changes uncommitted at review time.
Axes: Standards + Spec, per `.agents/skills/code-review/SKILL.md`.

## What was reviewed

Three things shipped together, which is why one ledger covers them:

1. `devDependencies` moved from pi 0.86.1 / 0.87.0 to 1.0.0.
2. The PTC binding wrapper translates pi 1.0.0's new non-throwing `isError` channel back into the
   rejection ADR-0024's contract promises.
3. The four model-facing tools declare `outputSchema` + `structuredContent` for codemode scripts
   (ADR-0028), and the surface detection gained a second probe (ADR-0027).

## Tooling state during this round

- Whole-tree OCR rule coverage: **passing**, zero `SYSTEM-ONLY`. All five changed `src/` files
  resolve to `project` rules.
- CodeGraph index is **stale** (`.codegraph/codegraph.db` mtime Sep 29 vs sources Oct 2) and
  `codegraph callers` returns "not found" for pre-existing symbols too, so Audit 1 fell back to
  grep with untruncated counts. Not a finding against this change; recorded so the next round does
  not treat the CodeGraph output as coverage it is not.
- The escalated `ocr review` path the skill mandates for blocking-grade findings **could not run**:
  it resolves `rule.json`'s `rule` field relative to the rule file's own directory
  (`.opencodereview/.opencodereview/rules/…`), while `ocr delegate` resolves it relative to the repo
  root. It emits `WARNING: rule file not found` per rule on stderr and still exits 0 — a silent
  degradation to system rules, the same class AGENTS.md records for the 7 unanchored `src/` files.
  **Open, not fixed here**: the fix belongs in the project's OCR setup or the skill, and both are
  outside this change. Verified by re-running with an absolute-path rule copy, which loaded every
  project rule and produced zero warnings.
- `ocr review --from X --to HEAD` resolves an empty range when the work is uncommitted, so it
  selects nothing. The review below was done by sub-agents reading the working tree directly.

## Findings

| id    | severity | axis      | evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----- | -------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1-01 | HIGH     | both      | `src/mode/ptc-mode.ts:305-311` resolved the user `extensions` array with the project's last-match-wins rule. pi uses `isEnabledByOverrides` there (`package-manager.js:742`, `:523-540`), which assigns through `!`→`+`→`-` buckets so `-` outranks `+` regardless of position. User `["-builtin:codemode","+builtin:codemode"]` resolved `enabled` where pi resolves `disabled` — handing orchestration to a codemode that is not loading, the exact failure ADR-0027 exists to prevent. | **Fixed.** Split into `switchFromProjectExtensions` (last-match-wins) and `switchFromUserExtensions` (bucket assignment). Both rules pinned separately in `tests/unit/codemode-switch.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| R1-02 | MEDIUM   | Spec      | `tests/ptc-mode.test.ts:159,179,196,213,230` called `readSurfaceModeConfig` without the third `codemodeSwitch` argument, so they read the developer's real settings. Two assert `"subagents"` and would go red on a checkout that disables `codemode`.                                                                                                                                                                                                                                    | **Fixed, after proving it was real.** With `cwd` pointed at a temp dir holding `.pi/settings.json` = `{"extensions":["-builtin:codemode"]}`: omitted arg resolved `"full"` / `{switch:"disabled",source:"project"}`, explicit `ABSENT_SWITCH` resolved `"subagents"` / `{switch:"absent",source:"default"}`. All five sites now pass the seam; `:230` additionally needed a presence, so it takes `PRESENT_CODEMODE`. No assertion was weakened.                                                                                                                                                                                                         |
| R1-03 | MEDIUM   | Standards | `bindingFailureMessage`'s two branches (tail slice at 2000 chars, empty-text fallback) had **no** test; flipping `slice(-N)` to `slice(0, N)` turned nothing red. Violates `docs/testing-constraints.md` #1.                                                                                                                                                                                                                                                                              | **Partly fixed, remainder booked.** The tail slice is pinned: a >5000-char non-zero exit drives the real `bash` binding and the test asserts the chosen leading marker is gone and the trailing one survives; the mutation was run and turned exactly that test red. The **empty-text fallback is unreachable** — `bash` is the only one of the seven builtins that sets `isError` (`core/tools/bash.js:300`) and it appends its status sentence unconditionally — so it is left untested on purpose rather than tested by fabricating the tool result it exists to constrain. Recorded at the branch in `src/runtime/bindings.ts` and in the test file. |
| R1-04 | LOW      | Standards | `tests/binding-contract.test.ts:462-464` said "The binding re-throws whatever the tool threw". False on 1.0.0, where `bash` sets `isError` and the binding composes its own message.                                                                                                                                                                                                                                                                                                      | Fixed — comment rewritten.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| R1-05 | LOW      | Standards | ADR-0027 claimed "last match wins" for both settings files, and claimed an unrecognised glob "is visible as a resolved `source`". The first was the root cause of R1-01; the second is false — an unrecognised pattern resolves identically to an unconfigured pi and no notice mentions it.                                                                                                                                                                                              | Fixed — ADR rewritten with the two-function table, and the glob limit now states plainly that it is silent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| R1-06 | LOW      | Standards | ADR-0028's "a script and the transcript agree" holds for keys, not values: `error_message` / `stop_reason` are raw while the text block runs `sanitizeText`.                                                                                                                                                                                                                                                                                                                              | Fixed — the claim is now scoped, with the reason raw was chosen.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| R1-07 | LOW      | Standards | `readCodemodeSwitch` is called with `process.cwd()`, not pi's `DefaultPackageManager.cwd`.                                                                                                                                                                                                                                                                                                                                                                                                | **Explicitly booked.** Traced: `DefaultResourceLoader` applies `resolvePath(options.cwd)`, whose `baseDir` defaults to `process.cwd()`, so they coincide for the shipping CLI and diverge only for an SDK embedder passing an explicit different `cwd` — which an extension cannot observe. Recorded in ADR-0027 rather than claimed covered.                                                                                                                                                                                                                                                                                                            |
| R1-08 | NIT      | Spec      | ADR-0028 cited `execute.js:257-258`; the quoted line is on 258-259 (`toScriptValue` opens at 256).                                                                                                                                                                                                                                                                                                                                                                                        | Fixed before round 2, during the host doc-sync pass.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## R1-01 closed against the real host, not only against our own test

The regression is a disagreement with pi, so the closure is a differential rather than a green
suite. Input: a user `settings.json` whose `extensions` is `["-builtin:codemode",
"+builtin:codemode"]` — the array where the two scopes' rules disagree.

| side                         | answer                                                                      |
| ---------------------------- | --------------------------------------------------------------------------- |
| real pi 1.0.0                | `codemode` **not loaded** (absent from `getAllTools()`)                     |
| this package, after the fix  | registers `ptc_run_code` + `ptc_workflow` (`full`) — matches                |
| this package, before the fix | would have resolved `enabled` and registered only `ptc_subagent` — diverges |

Read straight off a real `pi -p` run with that settings file, not inferred from pi's source.

## Counterfactual evidence

Each behavioural fix was mutated and the suite re-run, per `docs/testing-constraints.md` #5:

| mutation                                                                  | result                                           |
| ------------------------------------------------------------------------- | ------------------------------------------------ |
| R1-01's user array read with an early return instead of bucket assignment | the new user-precedence test goes red            |
| R1-01's user array read with last-match-wins                              | the same test goes red (verified before the fix) |

The R1-01 fix took two attempts, and the first one is worth recording: the initial green attempt
used early `return`s in the bucket order `!`→`+`→`-`, which is right until both `+` and `-` are
present — then it returned at `+` and never read `-`. A counterfactual that merely reordered the
early returns went **green**, which is the signal that the test was not discriminating. Replacing
early returns with assignment made the test bite.

## Verification beyond the suite

Real pi 1.0.0, `--tools …,codemode,…`, the package loaded from `dist/`:

- `tools.ptc_task_list({limit:5})` inside a codemode script returned
  `{"gotObject":true,"count":0,"tasksIsArray":true,"keys":["count","tasks"]}` — an **object**, not
  the text `(no background tasks)`.
- `tools.ptc_subagent({background:true, …})` returned
  `{"status":"background","hasTaskId":true,"taskIdType":"string","hasExitCode":false,"keys":["status","task_id"]}`
  — the ULID arrives as a value, and `Object.hasOwn(h,"exit_code") === false` proves the optional key
  is genuinely **absent** in the real sandbox rather than null.

Also measured, not assumed: `bash` on 1.0.0 resolves with `isError: true` on a non-zero exit
(`core/tools/bash.js:284-299`), which is what R2's `isError` translation exists for.

---

## Round 2 — delta over the fixes

The round-2 reviewer obtained ground truth by **driving pi 1.0.0's real
`DefaultPackageManager.resolve()` from a stub `settingsManager`** and running the same settings
arrays through `resolveCodemodeSwitch` — a measured comparison rather than a reading of pi's source:

| case                           | pi 1.0.0 enabled  | ours                |                      |
| ------------------------------ | ----------------- | ------------------- | -------------------- |
| project `[-,+]` / `[+,-]`      | true / false      | enabled / disabled  | last-wins preserved  |
| user `[-,+]` / `[+,-]`         | false / false     | disabled / disabled | `-` beats `+`        |
| user `[+,+]`, `[!,+]`, `[-,!]` | true, true, false | same                |                      |
| project `[-]` with user `[+]`  | false             | disabled            | project scope wins   |
| non-array `extensions`         | throws            | `absent`            | deliberate fail-safe |

**Regressions: none.** R1-01 through R1-08 all hold as disposed.

### What round 2 changed

Round 2 found no product-behaviour defect. Its four findings were a comment, two citations, and
test strength, and it reported the defect class in its delta as exhausted. Two of them were closed
by work that ran concurrently with it — the `!`-glob limit, which round 2 measured as a divergence
(`pi` false, ours `absent`) and which is now fixed rather than booked:

| finding | severity | disposition                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2-01   | LOW      | The docblock claimed our `absent` was "the same answer pi reaches" for an unmatched pattern; pi's own resolver refutes that. **Closed** — the block was rewritten, and the `!` bucket now matches pi's `minimatch` behaviour by comparing the pattern's literal prefix (`excludesCodemode`). Both directions pinned: `!builtin:cod*` / `!builtin:*codemode` / `!builtin:` disable; `!builtin:mcp` / `!builtin:llama.cpp` / `!builtin:tool-*` do not. |
| R2-02   | LOW      | The tail-slice test pinned truncation _direction_ but not the cap _magnitude_ — measured: `FAILURE_MESSAGE_MAX_CHARS = 200` left it green. **Closed** with a boundary pair. The retained length is asserted as a literal (`"bash failed: ".length + "…".length + 2000`), and a second test asserts a ~1 KB failure is not truncated at all. Both counterfactuals run: cap 200 → 2 red, cap 1000 → 2 red.                                             |
| R2-03   | NIT      | The `!`-glob limit was recorded on the user side only, though pi globs it on both. **Closed** — `excludesCodemode` is shared by both scope functions and the project docblock records it.                                                                                                                                                                                                                                                            |
| R2-04   | NIT      | Citations `:523-540` / `:531-540` over-run by one line (539 is the closing brace, 540 the next JSDoc). **Closed** — corrected to `:523-539` in the source and in ADR-0027.                                                                                                                                                                                                                                                                           |

### Stopping

Round 2's own verdict was **product-behaviour changes = no**, and its 12-case measurement closes the
class it was chasing. Per this repository's own stopping rule — a round that produces only records,
comments and extra tests is a signal to stop, not a round to build on — the loop ends here rather
than manufacturing a third round whose only possible output is more coverage of correct code.

What is deliberately left open, and why:

- **The `ocr review` rule-path defect** (see Tooling, above). It is pre-existing, lives in the
  project's OCR setup or the skill, and fixing it is outside this change. Recorded, not silently
  dropped.
- **The stale CodeGraph index.** `codegraph callers` cannot resolve symbols, so Audit 1 ran on grep.
  Recorded so the next round does not mistake CodeGraph output for coverage it is not.
- **The unreachable empty-text branch** of `bindingFailureMessage`, unpinned on purpose, with the
  measurement that proves it unreachable written at the branch.

---

## Round 3 — confirmation, and a defect the round-2 fix introduced

Round 2's verdict was "stop". The parent kept going anyway, to confirm rather than assume, and built
the oracle round 2 had only sketched: a **differential** that drives pi 1.0.0's real
`DefaultPackageManager.resolve()` from a stub `settingsManager` and compares it case by case
against `resolveCodemodeSwitch`. It is now a committed test,
`tests/unit/codemode-switch-differential.test.ts`, and it is what caught the next defect.

### R2-01's own fix was over-corrected

Round 2's fix compared a `!` entry's **literal prefix** against `builtin:codemode` for every `!`
entry. That is wrong for a pattern with no metacharacter: **minimatch treats those as an EXACT
match, not a prefix match.**

| user `extensions`        | pi        | before the fix | after    |
| ------------------------ | --------- | -------------- | -------- |
| `["!builtin:cod*"]`      | off       | off            | off      |
| `["!builtin:*codemode"]` | off       | off            | off      |
| `["!builtin:"]`          | **loads** | **off** ❌     | loads ✅ |
| `["!builtin:codemodX"]`  | loads     | loads          | loads    |

So a user who wrote `!builtin:` — intending to exclude some other bare entry — would have silently
lost `ptc_run_code` even though pi loads codemode. Fixed by splitting the rule: no metacharacter →
equality; metacharacter present → literal-prefix comparison, which remains the conservative
`disabled` direction for genuine globs.

**The test had encoded the bug.** The first version of the glob test asserted `!builtin:` disables
codemode, and it passed, because implementation and expectation were wrong in the same direction.
Two errors cancelling is why a green suite said nothing here. The expectation was moved to the
"must not disable" list with the measurement written next to it.

### The harness was wrong first

The first run of that differential reported **eleven** divergences, including the most basic case.
They were not real. `resolve()` returns each entry with an `enabled` flag, and the entry is present
either way — checking `JSON.stringify(paths).includes("builtin:codemode")` therefore answers "yes"
in every case. The oracle was the buggy artifact. Had it been reported as-is it would have
manufactured a fake finding set larger than anything in round 1.

A 22-case table run on the corrected oracle: **0 divergences** after the fix, 1 before it.

### Standing oracle

`tests/unit/codemode-switch-differential.test.ts` has two tests: one compares our resolver to pi's
on 20 cases, the other **re-measures the table's own expected values** so that a future pi release
changing the rules turns the file red instead of letting it agree with a stale expectation. It is
`skipIf`-guarded because `DefaultPackageManager` is pi-internal and not in its `exports` map; the
module is loaded at module scope so the test bodies contain no early return, because a bare `return`
makes vitest record a PASS — the false pass this repository has shipped before.

Both mutations re-confirm it bites: restoring the uniform prefix rule fails on
`user !bare prefix no wildcard`, and restoring last-match-wins for the user array fails on
`user - then + (order free, - wins)`.

---

## Round 3 — the round that refused to stop

Round 2 said "stop". This round ran anyway, with a standing instruction to answer one question with
evidence rather than assume the answer. It swept **98 cases** where round 1 and round 2 had used
dozens, and found two defects the fixes before it had introduced or missed. Work is **not** complete.

### R3-01 (MEDIUM) — `-./builtin:codemode` dropped `ptc_run_code`

pi runs every EXACT pattern through `normalizeExactPattern`, which strips a leading `./`
(`package-manager.js:496-499`, called at `:511`). Our comparison was `entry === "-builtin:codemode"`
on the raw string. So:

| entry                                        | pi  | before                    | after                  |
| -------------------------------------------- | --- | ------------------------- | ---------------------- |
| `["-./builtin:codemode"]` (user and project) | off | `absent` → `subagents` ❌ | `disabled` → `full` ✅ |

This is R1-01's failure mode reached through a plausible typo: every local extension path in a
settings file is written `./…`. `normalizeExactTarget` reproduces pi's normalization, and is
applied to the `+` / `-` buckets **only** — measured, because pi does NOT normalize the `!` bucket,
so `!./builtin:codemode` excludes nothing.

### R3-02 (LOW) — a doubled sign

`["!!"]` is deterministic in pi (a negation of an empty pattern matches everything) and is now
handled. `["!!builtin:codemode"]` is **not mirrorable**: minimatch also tests
`relative(baseDir, path)`, so its answer moves with the install. Two measurements disagreed — one
harness on `/tmp` reported `off`, one on the repo reported `loads` — and the reason is the harness's
own `agentDir`, not a bug in either. It is **absent from the differential table** rather than pinned
to one machine, and the reason is written at the table.

### R3-03/04/05 (LOW/NIT) — statements that were false

- The `excludesCodemode` docblock claimed the over-match was "bounded by construction". It is not:
  seven measured patterns are read as excluding where pi does not. The cost of each is a `full`
  surface where pi would have said `subagents` — a tool the model keeps rather than loses — and the
  docblock now says so, naming the shape of the over-matching patterns.
- ADR-0027 still described the pre-fix behaviour ("a `!builtin:cod*` user loses `ptc_run_code`
  again, silently"). Rewritten.
- A test named "a `!` glob aimed at some OTHER builtin" had accumulated two non-other-builtin
  cases. Renamed to what it actually asserts.

### The oracle earned its keep

The differential test is what found all of the above, and it found R3-01 in the same shape as R1-01
— the same failure mode through a different door. Three defects in this class across three rounds
is the argument for keeping it rather than deleting it after it went quiet.

### Two process defects, recorded because they cost more than the findings

- **A text replacement that omitted the closing `*/` swallowed the rest of the file.** The
  symptom was `TS1160: Unterminated template literal` reported at EOF, three hundred lines from the
  actual edit, and `25 test files failed`. The comment-scanner I used to check for this was itself
  wrong — it read the regex literal `/[*?[{()|]/` as a block-comment opener — so its "balanced"
  verdict was not evidence.
- **Restoring a `cp` backup after a counterfactual reverted a different fix.** The backup was taken
  before the `./`-normalization edit, and the restore after an unrelated mutation silently undid it.
  The test caught it, but only because the differential table had the case in it.
- **`dist/` was stale**, so the five e2e tests in `tests/tool-visibility.test.ts` failed for a
  reason that had nothing to do with the source. A rebuild cleared it. Any e2e that loads `dist/`
  needs the build in the same breath as the test.

---

## Round 4 — the reviewer said "stop approximating", and was right

Round 4 swept **412 cases** and reported 24 divergences, in two clusters:

- **R4-01 (HIGH)** — project scope ignored `!` position. pi's project loop writes every match into a
  `Map` as it iterates, so the last entry of _any_ sign wins; the code read "the last exact `+`/`-`,
  else look for a `!`", so `["+builtin:codemode", "!builtin:codemode"]` came out `enabled` where pi
  says `disabled`. Costful: the user loses `ptc_run_code` with no orchestrator.
- **R4-02/03/04 (LOW)** — nested negations handled only at exactly `!!`; `\` missing from the
  metacharacter set; and the "seven over-matching patterns" figure was wrong (ten measured, three
  unnamed).
- **R4-05 (LOW)** — the booking that `!!builtin:codemode` is un-mirrorable was over-broad: it is
  baseDir-dependent in _user_ scope but stable-off in _project_ scope.

### The judgement that ended the class

The reviewer's own closing read is the finding worth keeping: the `!` bucket is a **continuum, not
a finite set**, and four rounds had produced four costful defects inside it while the root
approximation stood. Adding case 5 would have bought a longer list. So the approximation was
removed rather than extended.

`resolveCodemodeSwitch` now calls the same `minimatch` pi calls, through the same
`matchesAnyPattern` / `normalizeExactPattern` helpers, with pi's own `baseDir` for each scope
(`join(cwd, ".pi")` for project — pi 1.0.0's `CONFIG_DIR_NAME`, verified by importing it — and
`agentDir` for user). Cost: one small dependency pi already pins. Benefit: the file got **shorter**,
and the behaviour stops being a claim about pi and becomes a copy of it.

| measurement                          | prefix approximation | exact mirror                                 |
| ------------------------------------ | -------------------- | -------------------------------------------- |
| 192-case sweep, costful direction    | 3 divergences        | **0**                                        |
| 192-case sweep, over-match direction | 8 divergences        | **0**                                        |
| round-4 reviewer's 412-case sweep    | 24 divergences       | not re-run; the class it belonged to is gone |

### Verified end to end on real pi 1.0.0

Eight reachable cells, each read off a live `pi -p` run with that settings file:

| `extensions`              | pi    | this package |
| ------------------------- | ----- | ------------ |
| `[]` (unset)              | loads | `subagents`  |
| `["-builtin:codemode"]`   | off   | `full`       |
| `["+builtin:codemode"]`   | loads | `subagents`  |
| `["-./builtin:codemode"]` | off   | `full`       |
| `["!!"]`                  | off   | `full`       |
| `["!!!builtin:codemode"]` | off   | `full`       |
| `["!builtin:cod*"]`       | off   | `full`       |
| `["!builtin:"]`           | loads | `subagents`  |

Eight of eight, zero disagreement.

### What the rounds cost, since that is the record worth keeping

Four rounds, four costful defects in one class, each found by a different method: reading pi's
source (R1-01), building a differential (R1-01's mirror case), sweeping widely (R3-01, R4-01), and
being asked to attack the stated guarantee rather than confirm it (R4-02). The first two rounds
believed they were done. **The class was not exhausted; it was approximated**, and no amount of
reviewing an approximation finds the end of it — only removing the approximation does.

---

## Round 5 — the mirror holds, and the oracle was measuring the wrong thing

Verdict: **`class closed = yes`**, 0 regressions. The mirror is faithful — `toPosixPath`,
`normalizeExactPattern` and `matchesAnyExactPattern` are byte-equivalent to pi's; the `SKILL.md`
branch is provably dead for a path like `builtin:codemode` (its `basename` is that same string on
posix and win32, so `isSkillFile` is constant false); `applyAutoloadDisabledPatterns`' `Map.set`
overwrite is reproduced by last-match-wins; `isEnabledByOverrides`' three assignments are
reproduced by three assignments with no early returns.

The parent's own measurements, not repeated here: 368 cases × 2 base directories = 736 comparisons,
0 divergences; 8/8 reachable cells verified against a live `pi -p`; the full gate green.

### F5-01 (MEDIUM) — the standing oracle was wired differently from production

This is the round's real finding, and it is about the _instrument_, not the product. The differential
test called `resolveCodemodeSwitch(argv, project, user)` with **three** arguments, so it ran against
the default base directories, while the same file handed pi `cwd: process.cwd()` — whose project base
directory is `join(cwd, ".pi")`. Two different directories, so the two sides were answering
different questions, and `readCodemodeSwitch` — the function production actually calls — was never
exercised in that file at all. The baseDir threading that round 4 added as load-bearing had no test
that could have caught it.

Fixed: both sides are now given the same temp root, through **the production entry**. Settings go to
real files under that root; pi and `readCodemodeSwitch` are both pointed at it. Counterfactual, to
show the fix bites — reverting the call to the three-argument form brings the phantom divergences
straight back (`user !! exact: pi=off ours=loads`). Six baseDir-sensitive entries were added to the
table for the same reason: they are the ones that can only be judged against the directories pi
actually used.

### F5-02 (LOW) — one deliberate divergence from the copy

pi's `getOverridePatterns` calls `.startsWith` on every entry, so a non-string in a hand-edited
`extensions` array throws a `TypeError` and pi never starts. The port skips such entries instead.
Measured: `extensions: [42]` throws in pi, resolves here. Diverging in the safe direction, and
copying it would turn a malformed settings file into a package that cannot load at all. Recorded at
the function rather than papered over, because a silent difference inside something documented as a
copy is exactly what costs a round.

### F5-03 (LOW) — a booking the mirror outgrew

The table still declared `!!builtin:codemode` un-mirrorable and left it out, on the grounds that the
prefix approximation could not follow minimatch's negation. With the mirror in place it resolves
like everything else, and round 5 measured it agreeing with pi in both scopes. The case is back in
the table and the note says why it left.

## Stopping

This is the criterion this repository already records, met: **the defect class is closed by
construction, not by an exhausted case list.** Rounds 4 and 5 changed no product behaviour — round
5's three findings are one instrument defect, one deliberate divergence now written down, and one
stale note. The mirror removed the continuum rather than enumerating it, and the standing oracle now
runs the production path, so the next pi release is caught by the suite rather than by a review.

Still open, deliberately, and recorded above rather than dropped: the `ocr review` rule-path defect,
the stale CodeGraph index, and the unreachable `bindingFailureMessage` branch.
